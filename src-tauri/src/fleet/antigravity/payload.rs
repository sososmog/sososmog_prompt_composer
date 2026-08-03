//! Antigravity 的 step blob 解析。方案见 `docs/agent-fleet-antigravity.md` §1.4。
//!
//! ## 为什么不解 protobuf
//!
//! `steps.metadata` / `steps.step_payload` 是 protobuf 二进制，但**不引 prost、
//! 不写 .proto**：没有公开 schema，字段号靠逆向，上游改一版就全错，而且**错得
//! 静默**（解出一个合法但错位的字段，比解析失败糟得多）。
//!
//! 改用内容驱动的抽取：blob 里有一段完整的 JSON 明文（Antigravity 自己塞进去的
//! 工具入参），把它捞出来按白名单取字段。失败是显式的——取不到就是 `None`。
//!
//! ## 为什么读 `metadata` 列而不是 `step_payload`
//!
//! **这一条是实测打过脸的，不是审美选择。** `metadata` 的内容就是 `step_payload`
//! 里那个 per-step 子消息（实测 `metadata` 恒为 `step_payload` 的子串，偏移 7），
//! 但 `step_payload` 还额外裹了一大堆东西——包括**别的步骤的历史上下文**
//! （见过 `Summary of the trajectory so far:` 后面整段引用早先的工具调用）。
//!
//! 拿整个 `step_payload` 扫 JSON，会捞到**属于另一个步骤**的工具入参：
//!
//! | 扫描范围 | 有 JSON 的步骤 | 其中带 toolSummary |
//! |---|---|---|
//! | `step_payload`（错） | 1846 / 2752 = 67.1% | 1843（**多出来的都是别人的**） |
//! | `metadata`（对） | 922 / 2752 = 33.5% | 922（**922/922 全部自洽**） |
//!
//! 覆盖率从 67% 掉到 33.5% 不是退步：掉掉的那些本来就是串台的数据，
//! 而 `metadata` 这一列的 922 条里**每一条**都带自己的 toolSummary，
//! 一条不差。这个 100% 自洽正是"范围对了"的证据。
//!
//! ## 隐私
//!
//! ⚠️ **blob 里有整个文件的内容。** 实测 `write_to_file` 那类步骤的 JSON 带
//! `CodeContent`（正在写入的源码全文）和 `ArtifactMetadata.Summary`。
//! 所以这里**只按白名单取三个字段**，绝不把整个 JSON 对象往上传。

use serde_json::Value;

use crate::fleet::types::truncate_text;

/// 从一个 step 的 blob 里抽出来的东西。全部字段都可能缺——缺就是缺，不猜。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StepInfo {
    /// 工具名，如 `run_command`。见 [`tool_name_before`] 的取法与限制。
    pub tool: Option<String>,
    /// 人话活动摘要。取 `toolSummary`，退到 `toolAction`。
    ///
    /// 这是本方案白捡的东西：Antigravity 自己写给它的 UI 看的一句话
    /// （实测 `Find log date range`、`Read skill document`），
    /// 比我们从工具参数里编一个准得多。
    pub summary: Option<String>,
    /// 工作目录，只有 `run_command` 那类步骤有。
    pub cwd: Option<String>,
}

/// JSON 之前允许跳过多少个非标识符字节（protobuf 的 tag + 长度前缀）。
///
/// 实测是 3 个（`\x1a` + 两字节 varint 长度）。给到 6 是留余量——
/// 再大就有可能跨过分隔符抓到上一个字段的内容。
const TOOL_NAME_PREFIX_SKIP: usize = 6;

/// 工具名往前最多回看多少字节。
const TOOL_NAME_WINDOW: usize = 64;

/// 工具名最短长度。
///
/// **这条限制是实测逼出来的**：不设下限时，回看窗口会在二进制噪声里抓到
/// 单个小写字母，实测捞出 13 个形如 `w`/`e`/`g`/`q` 的假工具名。
/// 设成 3 之后本机 872 个工具名里再没有一个是垃圾。
///
/// 代价：真有一个两字符的工具名会被漏掉（显示不出工具名，而不是显示错的）。
/// 这个失败方向是可接受的。
const TOOL_NAME_MIN_LEN: usize = 3;

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 在 blob 里找第一段能被解析的 JSON 对象，返回它和它的起始偏移。
///
/// ⚠️ **必须是平衡括号扫描，不能 `find('{')` + `rfind('}')`**：blob 里 JSON
/// 之后还跟着 protobuf 的字段名（`run_command*`、`Cwd*`、`toolSummary2`），
/// `rfind` 会把它们一起吞进来，然后整段解析失败。
///
/// 扫描必须**感知字符串与转义**：实测入参里有 `"powershell -Command \"…\""`
/// 这种嵌套引号，和 `C:\\Users\\…` 这种转义反斜杠。不跟踪字符串状态的话，
/// 命令行里的 `{`/`}` 会把深度算歪。
///
/// 第一个候选解析失败时**继续往后找**（不是直接放弃）：blob 是二进制，
/// `{"` 这两个字节完全可能在噪声里偶然出现。
pub fn find_json(buf: &[u8]) -> Option<(Value, usize)> {
    let mut search_from = 0usize;
    while search_from < buf.len() {
        let start = find_subslice(&buf[search_from..], b"{\"")? + search_from;
        if let Some(end) = scan_balanced(buf, start) {
            if let Ok(text) = std::str::from_utf8(&buf[start..=end]) {
                if let Ok(v) = serde_json::from_str::<Value>(text) {
                    return Some((v, start));
                }
            }
        }
        search_from = start + 1;
    }
    None
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 从 `start`（指向 `{`）开始找配对的 `}`，返回它的下标。
fn scan_balanced(buf: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in buf.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            b'\\' => escaped = true,
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// 取紧挨着 JSON 起点之前的那个标识符当工具名。
///
/// blob 里的排布实测是 `…\x12\x0brun_command\x1a\xd9\x02{"CommandLine":…`
/// ——工具名和它的入参 JSON 是相邻的两个 protobuf 字段。所以"JSON 前面那个
/// 标识符"就是这次调用的工具名，**不需要知道字段号**。
///
/// 刻意不这么做的两条：
/// - **不取"blob 里第一个标识符"**：那会抓到 step 自己的 8 字符随机 id
///   （实测 `ijwg5mks`、`ylu8fznn` 这种全小写的 id 会被当成工具名）。
/// - **不维护工具名白名单**：上游加一个工具我们就得跟着发版，而漏掉一个
///   工具名的代价（卡片少一行）远小于维护成本。
pub fn tool_name_before(buf: &[u8], json_start: usize) -> Option<String> {
    let mut end = json_start;
    let mut skipped = 0usize;
    while end > 0 && skipped < TOOL_NAME_PREFIX_SKIP && !is_ident_byte(buf[end - 1]) {
        end -= 1;
        skipped += 1;
    }
    let floor = end.saturating_sub(TOOL_NAME_WINDOW);
    let mut begin = end;
    while begin > floor && is_ident_byte(buf[begin - 1]) {
        begin -= 1;
    }
    if end <= begin || end - begin < TOOL_NAME_MIN_LEN {
        return None;
    }
    let raw = std::str::from_utf8(&buf[begin..end]).ok()?;
    // 工具名实测全是 snake_case 小写。这条既排除随机 id（带大写的那些），
    // 也排除 JSON 的字段名（`CommandLine` 一类的 CamelCase）。
    let ok = raw.starts_with(|c: char| c.is_ascii_lowercase())
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if !ok {
        return None;
    }
    Some(raw.to_string())
}

/// 按白名单从 JSON 里取字段。**只取这三个**，理由见模块头的隐私一节。
fn extract_whitelisted(v: &Value) -> (Option<String>, Option<String>) {
    let obj = match v.as_object() {
        Some(o) => o,
        None => return (None, None),
    };
    let str_of = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(truncate_text)
    };
    // toolSummary 是给人看的短句，toolAction 是进行时态的同一件事。
    // 实测 write_to_file 那类步骤只有 toolAction 没有 toolSummary，所以要退。
    let summary = str_of("toolSummary").or_else(|| str_of("toolAction"));
    let cwd = str_of("Cwd");
    (summary, cwd)
}

/// 解析一个 step 的 `metadata` blob。
///
/// 传 `metadata` 列，**不要传 `step_payload`**——理由见模块头那张对比表。
pub fn parse_step(metadata: &[u8]) -> StepInfo {
    let Some((json, offset)) = find_json(metadata) else {
        return StepInfo::default();
    };
    let (summary, cwd) = extract_whitelisted(&json);
    StepInfo {
        tool: tool_name_before(metadata, offset),
        summary,
        cwd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一段贴近真实排布的 blob：噪声 + 工具名 + 长度前缀 + JSON + 二进制尾巴。
    ///
    /// ⚠️ **尾巴里必须有 `}`（0x7d）字节**，否则这批测试会退化成"随便写写也能过"。
    /// 第一版的尾巴只有 protobuf 字段名（不含 `}`），结果把 `scan_balanced` 换成
    /// `rfind('}')` 之后 15 条测试全绿——因为那时最后一个 `}` 恰好就是正确答案。
    ///
    /// 实测真实数据里 **922 个带 JSON 的 blob 有 640 个（69.4%）在正确的收尾
    /// 括号之后还有 `}` 字节**（后面跟的是压缩过的二进制内容）。所以尾巴要照这个
    /// 样子造，测试才真的在区分两种实现。
    fn blob(tool: &str, json: &str) -> Vec<u8> {
        let mut v = vec![0x0a, 0x0c, 0x08, 0xaa, 0x9f, 0xb2, 0xd3];
        v.push(0x12);
        v.push(tool.len() as u8);
        v.extend_from_slice(tool.as_bytes());
        v.extend_from_slice(&[0x1a, 0xd9, 0x02]);
        v.extend_from_slice(json.as_bytes());
        // 真实 blob 在 JSON 之后是 protobuf 字段名 + 压缩过的二进制，
        // 后者几乎必然包含 0x7d。这是 rfind('}') 会踩的雷。
        v.extend_from_slice(b"run_command*CommandLine*toolSummary2");
        v.extend_from_slice(&[0x3a, 0x90, 0x03, 0x12, 0x7d, 0xca, 0xb7, 0x24, 0x7d, 0x1f]);
        v
    }

    #[test]
    fn parses_a_realistic_run_command_step() {
        let b = blob(
            "run_command",
            r#"{"CommandLine":"npm test","Cwd":"C:\\proj\\demo","IsDaemon":false,"toolAction":"Running command","toolSummary":"Run the test suite"}"#,
        );
        let got = parse_step(&b);
        assert_eq!(got.tool.as_deref(), Some("run_command"));
        assert_eq!(got.summary.as_deref(), Some("Run the test suite"));
        assert_eq!(got.cwd.as_deref(), Some("C:\\proj\\demo"));
    }

    #[test]
    fn trailing_protobuf_field_names_do_not_break_the_scan() {
        // 这条钉的是"必须平衡括号扫描"：把 scan_balanced 换成 rfind('}')
        // 会把尾部的 `run_command*CommandLine*…` 一起吃进去，JSON 解析失败。
        let b = blob("view_file", r#"{"AbsolutePath":"a.rs","toolSummary":"Read a.rs"}"#);
        let got = parse_step(&b);
        assert_eq!(got.summary.as_deref(), Some("Read a.rs"));
    }

    #[test]
    fn braces_and_quotes_inside_a_command_line_do_not_confuse_the_scanner() {
        // 实测入参里就有 powershell -Command "…" 这种嵌套引号，
        // 以及 shell 里的 {} —— 不跟踪字符串状态就会把深度算歪。
        let json = r#"{"CommandLine":"powershell -Command \"Get-ChildItem | %{ $_.Name }\"","toolSummary":"List names"}"#;
        let b = blob("run_command", json);
        let got = parse_step(&b);
        assert_eq!(got.tool.as_deref(), Some("run_command"));
        assert_eq!(got.summary.as_deref(), Some("List names"));
    }

    #[test]
    fn escaped_backslashes_in_windows_paths_survive() {
        let b = blob(
            "run_command",
            r#"{"Cwd":"C:\\Users\\me\\.gemini\\antigravity","toolSummary":"ok"}"#,
        );
        assert_eq!(
            parse_step(&b).cwd.as_deref(),
            Some("C:\\Users\\me\\.gemini\\antigravity")
        );
    }

    #[test]
    fn falls_back_from_tool_summary_to_tool_action() {
        // 实测 write_to_file / 那类 artifact 步骤只有 toolAction。
        let b = blob("write_to_file", r#"{"TargetFile":"x.md","toolAction":"Creating implementation plan"}"#);
        assert_eq!(
            parse_step(&b).summary.as_deref(),
            Some("Creating implementation plan")
        );
    }

    #[test]
    fn never_leaks_code_content_or_other_unlisted_fields() {
        // 隐私回归：write_to_file 的 JSON 带整个文件内容。白名单之外的东西
        // 一个都不该出现在 StepInfo 里。
        let secret = "SECRET_API_KEY=hunter2";
        let json = format!(
            r#"{{"CodeContent":"{secret}","TargetFile":"C:\\proj\\.env","ArtifactMetadata":{{"Summary":"{secret}"}},"toolSummary":"Write env file"}}"#
        );
        let b = blob("write_to_file", &json);
        let got = parse_step(&b);
        assert_eq!(got.summary.as_deref(), Some("Write env file"));
        let rendered = format!("{got:?}");
        assert!(
            !rendered.contains(secret),
            "StepInfo 里不该出现白名单外的内容：{rendered}"
        );
        assert!(!rendered.contains(".env"), "TargetFile 也不在白名单里");
    }

    #[test]
    fn nested_json_objects_are_scanned_to_the_right_closing_brace() {
        // ArtifactMetadata 是个嵌套对象，深度算错会在它的 } 上收工，
        // 于是 toolSummary（在它后面）就取不到了。
        let b = blob(
            "write_to_file",
            r#"{"ArtifactMetadata":{"RequestFeedback":true,"UserFacing":false},"toolSummary":"Create module"}"#,
        );
        assert_eq!(parse_step(&b).summary.as_deref(), Some("Create module"));
    }

    #[test]
    fn step_without_json_yields_all_none() {
        // type=15 / 90 这类步骤的 metadata 里压根没有 JSON（实测 1007 + 600 步），
        // 这是正常态，不是解析失败。
        let noise = vec![0x0a, 0x0c, 0x08, 0xaa, 0x9f, 0xb2, 0xd3, 0x06, 0x10, 0xd8];
        assert_eq!(parse_step(&noise), StepInfo::default());
        assert_eq!(parse_step(&[]), StepInfo::default());
    }

    #[test]
    fn random_lowercase_step_ids_are_not_mistaken_for_tool_names() {
        // 实测的坑：step 自己的 8 字符 id 有时全小写（`ijwg5mks`、`ylu8fznn`），
        // "取 blob 里第一个标识符"会把它当工具名。取"紧挨 JSON 前面那个"才对。
        let mut v = vec![0x0a, 0x08];
        v.extend_from_slice(b"ijwg5mks"); // 随机 id 在前
        v.push(0x12);
        v.push(8);
        v.extend_from_slice(b"list_dir"); // 真工具名紧挨 JSON
        v.extend_from_slice(&[0x1a, 0x40]);
        v.extend_from_slice(br#"{"DirectoryPath":"c:/x","toolSummary":"Directory analysis"}"#);
        let got = parse_step(&v);
        assert_eq!(got.tool.as_deref(), Some("list_dir"));
    }

    #[test]
    fn single_letter_noise_is_rejected_as_a_tool_name() {
        // 不设最短长度时，回看窗口会在二进制噪声里抓到单个字母当工具名
        // （实测捞出 13 个 `w`/`e`/`g`/`q` 这种）。
        let mut v = vec![0xff, 0xfe, b'w', 0x1a, 0x20];
        v.extend_from_slice(br#"{"toolSummary":"noise"}"#);
        let got = parse_step(&v);
        assert_eq!(got.summary.as_deref(), Some("noise"));
        assert_eq!(got.tool, None, "单字母不该被当成工具名");
    }

    #[test]
    fn camel_case_field_names_are_rejected_as_tool_names() {
        // JSON 前面偶然是个 CamelCase 字段名时不该当工具名——工具名实测全小写。
        let mut v = vec![0x12, 0x0b];
        v.extend_from_slice(b"CommandLine");
        v.extend_from_slice(&[0x1a, 0x20]);
        v.extend_from_slice(br#"{"toolSummary":"x"}"#);
        assert_eq!(parse_step(&v).tool, None);
    }

    #[test]
    fn binary_noise_that_happens_to_contain_brace_quote_is_skipped() {
        // `{"` 这两个字节在二进制里会偶然出现。第一个候选解析失败时必须
        // 继续往后找，而不是放弃整个 blob。
        let mut v = vec![0xc2, b'{', b'"', 0x00, 0xff, 0x01];
        v.push(0x12);
        v.push(8);
        v.extend_from_slice(b"list_dir");
        v.extend_from_slice(&[0x1a, 0x20]);
        v.extend_from_slice(br#"{"toolSummary":"real one"}"#);
        let got = parse_step(&v);
        assert_eq!(got.summary.as_deref(), Some("real one"));
        assert_eq!(got.tool.as_deref(), Some("list_dir"));
    }

    #[test]
    fn empty_and_whitespace_only_summaries_are_treated_as_absent() {
        let b = blob("run_command", r#"{"toolSummary":"   ","toolAction":"Running"}"#);
        assert_eq!(
            parse_step(&b).summary.as_deref(),
            Some("Running"),
            "空白的 toolSummary 应该退到 toolAction"
        );
        let b2 = blob("run_command", r#"{"toolSummary":"","toolAction":""}"#);
        assert_eq!(parse_step(&b2).summary, None);
    }

    #[test]
    fn long_summary_is_truncated_like_every_other_text_field() {
        let long = "字".repeat(400);
        let json = format!(r#"{{"toolSummary":"{long}"}}"#);
        let b = blob("run_command", &json);
        let got = parse_step(&b).summary.unwrap();
        assert!(got.ends_with('…'));
        assert_eq!(got.chars().count(), crate::fleet::types::TEXT_LIMIT + 1);
    }

    #[test]
    fn non_object_json_does_not_panic() {
        // `{"` 开头保证了不会是数组，但 JSON 值可能是任何东西——不该 panic。
        let mut v = vec![0x1a, 0x10];
        v.extend_from_slice(br#"{"a":[1,2,{"b":3}]}"#);
        let got = parse_step(&v);
        assert_eq!(got.summary, None);
        assert_eq!(got.cwd, None);
    }
}
