
use std::io::{Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{self, Role, TailKind, TranscriptDigest};

/// 遍历 `<config_dir>/projects/*/`，找 `<那个目录>/<session_id>.jsonl`。
///
/// **不要试图从 cwd 反推项目目录名**——那个编码不可逆（见模块文档）。遍历是唯一
/// 可靠的办法，好在 `projects/` 下目录数量不多（本机实测几十个量级），代价可接受。
///
/// 目录不存在、读不了、里面没有匹配的文件——统统返回 `None`，不 panic。
pub fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let projects_dir = config_dir.join("projects");
    let entries = std::fs::read_dir(&projects_dir).ok()?;

    let filename = format!("{session_id}.jsonl");
    for entry in entries.filter_map(Result::ok) {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let candidate = project_dir.join(&filename);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 文件尾部读取结果。
pub struct Tail {
    /// 已过滤空行（含纯空白行）的尾部内容，按行拆分。
    pub lines: Vec<String>,
    /// 文件总大小（不是读到的字节数）。
    pub size_bytes: u64,
    /// 文件 mtime，ms epoch。
    pub mtime_ms: i64,
}

/// 读文件尾部最多 `max_bytes` 字节，按行拆分。
///
/// 两个不能省的细节（都来自真实 jsonl 会踩到的坑）：
///
/// - **起点 > 0 时必须丢掉第一行**：seek 到 `size - max_bytes` 这个位置完全是
///   随机切入的，切到的第一行要么是上一行写了一半，要么正好切在一个多字节
///   UTF-8 字符中间（`utf8-heavy.jsonl` 就是故意构造这种场景的夹具）。丢掉它，
///   剩下的都是完整行。
/// - **用 `from_utf8_lossy`，不要 `from_utf8().unwrap()`**：即便丢了首行，
///   lossy 转换仍是必须的兜底——`unwrap()` 会在任何意外情况下直接把整个采集
///   命令搞挂，而这里只是展示用的摘要，不值得为了几个乱码字符崩溃。
pub fn tail_lines(path: &Path, max_bytes: u64) -> std::io::Result<Tail> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let start = size.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;

    let text = String::from_utf8_lossy(&buf);
    let mut raw_lines: Vec<&str> = text.split('\n').collect();

    // 起点不在文件开头：第一段要么是半行，要么被切在多字节字符中间，统一丢弃。
    if start > 0 && !raw_lines.is_empty() {
        raw_lines.remove(0);
    }

    // 过滤空行：既包括真正的空字符串（常见于"文件以换行符结尾"时 split 出的
    // 末尾空段），也包括纯空白行（实测夹具里出现过，比如 garbage-mixed.jsonl）。
    // 两者都不携带任何可解析内容，没必要往下游传。
    let lines = raw_lines
        .into_iter()
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();

    Ok(Tail {
        lines,
        size_bytes: size,
        mtime_ms,
    })
}

/// digest 抽取失败的两种情形。
#[derive(Debug)]
pub enum DigestError {
    /// 文件打不开 / 读不了。
    Io(std::io::Error),
    /// 尾部窗口（哪怕已经扩到 [`types::TAIL_BYTES_MAX`] 或覆盖了整个文件）里
    /// 一条 `user`/`assistant` 消息都解析不出来。可能是格式漂移，也可能文件
    /// 本身就没有实质内容——两种情况前端都应该显示"状态未知"，不猜。
    Unparsable,
}

/// 从 transcript 尾部抽取 [`TranscriptDigest`]。
///
/// 核心策略：先按 `tail_bytes` 读一次，抽不出任何 `user`/`assistant` 消息就
/// 4× 扩窗重试，直到抽出消息、或窗口已经到 [`types::TAIL_BYTES_MAX`]、或窗口
/// 已经覆盖整个文件（此时再扩没有意义，扩了也是读同样的内容）。
pub fn read_digest(path: &Path, tail_bytes: u64) -> Result<TranscriptDigest, DigestError> {
    // 防御一下 0：调用方理论上不该传 0，但万一传了，saturating_mul(4) 永远是 0，
    // 会死循环。夹一个下限保证窗口每轮真的在变大。
    let mut window = tail_bytes.max(1);

    loop {
        let tail = tail_lines(path, window).map_err(DigestError::Io)?;
        let extracted = extract(&tail.lines);

        if extracted.found_message {
            return Ok(TranscriptDigest {
                size_bytes: tail.size_bytes,
                mtime_ms: tail.mtime_ms,
                ai_title: extracted.ai_title,
                last_prompt: extracted.last_prompt,
                // v4 新增，Claude 侧没有对应物：这一侧的"在干什么"由
                // aiTitle / lastPrompt 表达，不需要再合成一句。
                activity_summary: None,
                git_branch: extracted.git_branch,
                model: extracted.model,
                effort: extracted.effort,
                last_role: extracted.last_role,
                last_stop_reason: extracted.last_stop_reason,
                last_tail_kind: extracted.last_tail_kind,
                last_tool_names: extracted.last_tool_names,
                last_msg_ts_ms: extracted.last_msg_ts_ms,
                has_api_error: extracted.has_api_error,
                api_error_status: extracted.api_error_status,
                api_error_code: extracted.api_error_code,
                context_tokens: extracted.context_tokens,
                // Claude 侧给不出窗口大小（jsonl 区分不出 200k 还是 1M），
                // 这个字段是 Codex 专属的，见 types.rs 里的说明。
                context_window: None,
                parse_errors: extracted.parse_errors,
            });
        }

        // 窗口已经盖住整个文件、或者已经到上限——再扩也读不出新内容，没有意义。
        if window >= tail.size_bytes || window >= types::TAIL_BYTES_MAX {
            return Err(DigestError::Unparsable);
        }
        window = window.saturating_mul(4).min(types::TAIL_BYTES_MAX);
    }
}

/// [`extract`] 的输出：还没填 `size_bytes` / `mtime_ms`（那两个字段来自
/// [`Tail`]，与逐行解析无关）的 digest 半成品，外加一个"是否找到过至少一条
/// user/assistant 消息"的标记，供 [`read_digest`] 判断要不要扩窗重试。
struct Extracted {
    ai_title: Option<String>,
    last_prompt: Option<String>,
    git_branch: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    last_role: Option<Role>,
    last_stop_reason: Option<String>,
    last_tail_kind: Option<TailKind>,
    last_tool_names: Vec<String>,
    last_msg_ts_ms: Option<i64>,
    has_api_error: bool,
    api_error_status: Option<String>,
    api_error_code: Option<String>,
    context_tokens: Option<u64>,
    parse_errors: u32,
    found_message: bool,
}

/// 逐行解析 + 反向扫描抽取。
///
/// 两遍走：第一遍把每行 parse 成 `serde_json::Value`（失败的计入 `parse_errors`，
/// 未知 `type` 的行安全忽略，**不算解析失败**——它们是合法 JSON，只是我们不认识
/// 这个类型）；第二遍从尾部往前扫，找"最后一条 ai-title"「最后一条 last-prompt」
/// 「最后一条 user/assistant 消息」「最后一条 assistant 消息」这四样东西。
/// 反向扫描 + 一旦找到就不再更新，天然等价于"取最后一条"。
fn extract(lines: &[String]) -> Extracted {
    let mut values: Vec<Value> = Vec::with_capacity(lines.len());
    let mut parse_errors = 0u32;
    for line in lines {
        match serde_json::from_str::<Value>(line) {
            Ok(v) => values.push(v),
            Err(_) => parse_errors += 1,
        }
    }

    let mut ai_title: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    let mut last_msg: Option<&Value> = None;
    let mut last_assistant: Option<&Value> = None;

    for v in values.iter().rev() {
        if ai_title.is_some() && last_prompt.is_some() && last_msg.is_some() && last_assistant.is_some() {
            break;
        }

        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "ai-title" if ai_title.is_none() => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                    ai_title = Some(types::truncate_text(t));
                }
            }
            "last-prompt" if last_prompt.is_none() => {
                if let Some(p) = v.get("lastPrompt").and_then(Value::as_str) {
                    last_prompt = Some(types::truncate_text(p));
                }
            }
            "user" | "assistant" => {
                if last_msg.is_none() {
                    last_msg = Some(v);
                }
                if ty == "assistant" && last_assistant.is_none() {
                    last_assistant = Some(v);
                }
            }
            // 未知 type（实测已有 14 种，以后只会更多）：安全忽略，不是解析错误。
            _ => {}
        }
    }

    let found_message = last_msg.is_some();

    let (
        last_role,
        last_stop_reason,
        last_tail_kind,
        last_tool_names,
        last_msg_ts_ms,
        has_api_error,
        api_error_status,
        api_error_code,
        git_branch,
    ) = match last_msg {
        Some(v) => {
            let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
            let role = match ty {
                "assistant" => Some(Role::Assistant),
                "user" => Some(Role::User),
                _ => None,
            };
            let message = v.get("message");
            let stop_reason = message
                .and_then(|m| m.get("stop_reason"))
                .and_then(Value::as_str)
                .map(String::from);
            let content = message.and_then(|m| m.get("content"));
            let (tail_kind, tool_names) = extract_tail_kind_and_tools(content);
            let ts = v
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_iso8601_utc_ms);
            let has_api_error = v
                .get("isApiErrorMessage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let api_error_status = v.get("apiErrorStatus").and_then(normalize_api_error_status);
            let api_error_code = v.get("error").and_then(Value::as_str).map(String::from);
            let git_branch = v.get("gitBranch").and_then(Value::as_str).map(String::from);
            (
                role,
                stop_reason,
                tail_kind,
                tool_names,
                ts,
                has_api_error,
                api_error_status,
                api_error_code,
                git_branch,
            )
        }
        None => (None, None, None, Vec::new(), None, false, None, None, None),
    };

    // model / effort / context_tokens 都来自"最后一条 assistant 消息"，而不是
    // "最后一条 user/assistant 消息"——最后一条可能是 user 行（这三样都没有），
    // 这时要往前找最近的 assistant。`last_assistant` 就是那次回溯的结果。
    //
    // effort 一开始按"取最后一条消息"实现（契约原文的字面意思），跑通之后发现
    // 那样会出一个纯采样假象：尾巴恰好是 tool_result（user 行）时 effort 变 null，
    // 于是同一个会话的思考档位会随轮询时刻在 "xhigh" 和空之间来回闪，
    // 而这段时间里它其实一直没变。gitBranch 不受影响是因为 user 行顶层也带它。
    let model = last_assistant
        .and_then(|v| v.get("message"))
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .map(String::from);
    let effort = last_assistant
        .and_then(|v| v.get("effort"))
        .and_then(Value::as_str)
        .map(String::from);
    let context_tokens = last_assistant
        .and_then(|v| v.get("message"))
        .and_then(|m| m.get("usage"))
        .map(|usage| {
            let field = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
            // 官方 statusLine 的 used_percentage 同公式：只算 input 侧，不含 output。
            field("input_tokens") + field("cache_creation_input_tokens") + field("cache_read_input_tokens")
        });

    Extracted {
        ai_title,
        last_prompt,
        git_branch,
        model,
        effort,
        last_role,
        last_stop_reason,
        last_tail_kind,
        last_tool_names,
        last_msg_ts_ms,
        has_api_error,
        api_error_status,
        api_error_code,
        context_tokens,
        parse_errors,
        found_message,
    }
}

/// 从 `message.content` 里算出尾部形态与 tool_use 名字列表。
///
/// `content` 有两种实测形状：user 的纯文本消息是一个 JSON 字符串；其余（assistant
/// 的文本/思考/工具调用、user 的 tool_result）都是 block 数组。两种都要处理，
/// 既不是数组也不是字符串（字段缺失、格式漂移）时保守返回 `None` / 空列表。
fn extract_tail_kind_and_tools(content: Option<&Value>) -> (Option<TailKind>, Vec<String>) {
    match content {
        Some(Value::String(_)) => (Some(TailKind::Text), Vec::new()),
        Some(Value::Array(blocks)) => {
            let tail_kind = blocks
                .last()
                .and_then(|b| b.get("type"))
                .and_then(Value::as_str)
                .and_then(map_tail_kind);
            let tool_names = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| b.get("name").and_then(Value::as_str).map(String::from))
                .take(4)
                .collect();
            (tail_kind, tool_names)
        }
        _ => (None, Vec::new()),
    }
}

fn map_tail_kind(s: &str) -> Option<TailKind> {
    match s {
        "tool_use" => Some(TailKind::ToolUse),
        "tool_result" => Some(TailKind::ToolResult),
        "text" => Some(TailKind::Text),
        "thinking" => Some(TailKind::Thinking),
        _ => None,
    }
}

/// `apiErrorStatus` 源数据里是数字（实测 403），且可能整个字段缺失。统一归一化
/// 成字符串，免得下游要处理 number | string | undefined 三态。
fn normalize_api_error_status(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 解析形如 `2026-07-30T07:29:57.407Z` 的 ISO-8601 UTC 时间戳为 ms epoch。
///
/// 只处理这一种固定形状（jsonl 实测全部如此），所以手写解析，不为此引入
/// chrono / time 依赖。毫秒段允许缺失（`...:57Z`）。任何不符合预期的输入
/// 一律返回 `None`，不 panic、不 unwrap。
///
/// 天数计算用的是 Howard Hinnant 的 `days_from_civil` 算法，对公历闰年规则
/// （4 年一闰、100 年不闰、400 年再闰）天然正确，且对 1970 年之前的日期
/// （负的天数偏移）同样成立。
pub fn parse_iso8601_utc_ms(s: &str) -> Option<i64> {
    let body = s.strip_suffix('Z')?;
    let (date_part, time_part) = body.split_once('T')?;

    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: u32 = date_iter.next()?.parse().ok()?;
    let day: u32 = date_iter.next()?.parse().ok()?;
    if date_iter.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (hms_part, millis_part) = match time_part.split_once('.') {
        Some((hms, ms)) => (hms, ms),
        None => (time_part, ""),
    };
    let mut hms_iter = hms_part.split(':');
    let hour: i64 = hms_iter.next()?.parse().ok()?;
    let minute: i64 = hms_iter.next()?.parse().ok()?;
    let second: i64 = hms_iter.next()?.parse().ok()?;
    if hms_iter.next().is_some() {
        return None;
    }
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) || !(0..60).contains(&second) {
        return None;
    }

    let ms: i64 = if millis_part.is_empty() {
        0
    } else {
        if !millis_part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // 小数点后的数字按十进制"位权"对齐到毫秒：右补零到 3 位再截到 3 位——
        // ".4" 是 400ms、".47" 是 470ms、".4567" 截到 ".456"。
        let padded = format!("{millis_part:0<3}");
        padded.get(..3)?.parse().ok()?
    };

    let days = days_from_civil(year, month, day);
    let total_seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second)?;
    total_seconds.checked_mul(1000)?.checked_add(ms)
}

/// Howard Hinnant 的 `days_from_civil`：由（年, 月, 日）算出相对 1970-01-01
/// 的天数偏移。对公历闰年规则天然正确，1970 年之前返回负数。
/// 算法参考：<http://howardhinnant.github.io/date_algorithms.html#days_from_civil>
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // 3月=0 ... 2月=11
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    fn transcript_fixture(name: &str) -> PathBuf {
        fixtures_dir().join("transcript").join(name)
    }

    // ---------------------------------------------------------------
    // tail_lines
    // ---------------------------------------------------------------

    #[test]
    fn tail_lines_smaller_than_window_returns_everything() {
        let path = transcript_fixture("thinking-tail.jsonl");
        let size = std::fs::metadata(&path).unwrap().len();
        let tail = tail_lines(&path, size + 1024).unwrap();
        assert_eq!(tail.size_bytes, size);
        assert_eq!(tail.lines.len(), 2, "thinking-tail.jsonl 应有 2 条非空行");
        assert!(tail.mtime_ms > 0);
    }

    #[test]
    fn tail_lines_exactly_equal_to_window_reads_from_start() {
        let path = transcript_fixture("working.jsonl");
        let size = std::fs::metadata(&path).unwrap().len();
        let tail = tail_lines(&path, size).unwrap();
        assert_eq!(tail.size_bytes, size);
        // 起点恰好是 0，不需要丢首行；working.jsonl 有 6 行非空 JSON（见夹具 wc -l）。
        assert_eq!(tail.lines.len(), 6);
    }

    #[test]
    fn tail_lines_far_larger_than_window_drops_first_partial_line() {
        let path = transcript_fixture("working.jsonl");
        let raw = std::fs::read(&path).unwrap();
        let text = String::from_utf8(raw.clone()).unwrap();
        let last_line = text.lines().last().unwrap();
        // 窗口只比最后一行长一点：起点必然落在倒数第二行内部，逼出"丢首行"分支。
        let window = last_line.len() as u64 + 10;
        let tail = tail_lines(&path, window).unwrap();
        assert_eq!(tail.size_bytes, raw.len() as u64);
        // 首行已被丢弃，剩下的每一行都必须是完整、可解析的 JSON——
        // 如果丢首行的逻辑有误，半行残留会在这里解析失败。
        for line in &tail.lines {
            assert!(
                serde_json::from_str::<Value>(line).is_ok(),
                "远大于窗口时残留的行必须是完整 JSON，实际: {line}"
            );
        }
    }

    #[test]
    fn tail_lines_empty_file_returns_no_lines() {
        let path = transcript_fixture("empty.jsonl");
        let tail = tail_lines(&path, 65536).unwrap();
        assert_eq!(tail.size_bytes, 0);
        assert!(tail.lines.is_empty());
    }

    #[test]
    fn tail_lines_no_trailing_newline_keeps_last_line() {
        let path = transcript_fixture("no-trailing-newline.jsonl");
        let size = std::fs::metadata(&path).unwrap().len();
        let tail = tail_lines(&path, size).unwrap();
        // 2 行都要读到，且最后一行（没有换行符收尾）不能被漏掉或截断。
        assert_eq!(tail.lines.len(), 2);
        assert!(serde_json::from_str::<Value>(&tail.lines[1]).is_ok());
    }

    #[test]
    fn tail_lines_utf8_boundary_is_lossy_and_does_not_panic() {
        let path = transcript_fixture("utf8-heavy.jsonl");
        let raw = std::fs::read(&path).unwrap();
        let window = 4096u64;
        let start = raw.len().saturating_sub(window as usize);

        // 先验证夹具前提本身成立：size - window 处确实是一个 UTF-8 续接字节
        // （最高两位是 10）。README「字节精确性」一节要求测试自己算出这个属性，
        // 而不是把偏移量和期望结果都写死——夹具将来若重新生成，这里会明确
        // 报错提示"夹具需要重新生成"，而不是悄悄测了个假场景。
        assert_eq!(
            raw[start] & 0xC0,
            0x80,
            "夹具前提不成立：utf8-heavy.jsonl 在 size-{window} 处不是 UTF-8 续接字节，\
             需要重新生成夹具才能测到真正的边界切断场景"
        );

        let tail = tail_lines(&path, window).expect("lossy 转换后不应返回 Err");
        assert_eq!(tail.size_bytes, raw.len() as u64);
        assert!(!tail.lines.is_empty(), "丢掉被切断的首行后应仍有完整行剩余");
        for line in &tail.lines {
            assert!(
                serde_json::from_str::<Value>(line).is_ok(),
                "边界切断后剩余行应仍是合法 JSON: {line}"
            );
        }
    }

    // ---------------------------------------------------------------
    // read_digest —— 逐个夹具核对字段
    // ---------------------------------------------------------------

    #[test]
    fn digest_working_tail_is_tool_use() {
        let d = read_digest(&transcript_fixture("working.jsonl"), 65536).unwrap();
        assert_eq!(d.last_role, Some(Role::Assistant));
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(d.last_tail_kind, Some(TailKind::ToolUse));
        assert_eq!(d.last_tool_names, vec!["Bash".to_string()]);
        assert!(d.ai_title.as_deref().is_some_and(|t| !t.is_empty()));
        assert_eq!(d.context_tokens, Some(70_424));
        assert_eq!(d.parse_errors, 0);
    }

    #[test]
    fn digest_needs_input_tail_is_end_turn_text() {
        let d = read_digest(&transcript_fixture("needs-input.jsonl"), 65536).unwrap();
        assert_eq!(d.last_stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(d.last_tail_kind, Some(TailKind::Text));
        assert!(d.last_tool_names.is_empty());
    }

    #[test]
    fn digest_tool_result_tail_is_user_tool_result() {
        let d = read_digest(&transcript_fixture("tool-result-tail.jsonl"), 65536).unwrap();
        assert_eq!(d.last_role, Some(Role::User));
        assert_eq!(d.last_tail_kind, Some(TailKind::ToolResult));
    }

    /// 尾巴是 user 行（tool_result）时，model / effort / context_tokens 必须回溯到
    /// 前面最近的 assistant 行拿到，而不是变成 None。
    ///
    /// 这三样只在 assistant 行上有。如果不回溯，同一个会话的模型名和思考档位
    /// 就会随轮询时刻在"有值"和"空"之间来回闪——而这段时间里它们其实一直没变。
    /// 纯粹是采样时机造成的假象，用户看到的却像是配置在自己变。
    #[test]
    fn digest_backtracks_to_last_assistant_for_model_effort_and_tokens() {
        let d = read_digest(&transcript_fixture("tool-result-tail.jsonl"), 65536).unwrap();
        assert_eq!(d.last_role, Some(Role::User), "前提：这个夹具的尾巴确实是 user 行");
        assert_eq!(d.model.as_deref(), Some("claude-opus-5"), "model 应回溯到 assistant");
        assert_eq!(d.effort.as_deref(), Some("xhigh"), "effort 应回溯到 assistant");
        assert_eq!(d.context_tokens, Some(70424), "context_tokens 应回溯到 assistant");
        // gitBranch 不需要回溯——user 行顶层也带它，所以它本来就不会闪。
        assert_eq!(d.git_branch.as_deref(), Some("feat/demo-branch"));
    }

    #[test]
    fn digest_thinking_tail_kind_is_thinking() {
        let d = read_digest(&transcript_fixture("thinking-tail.jsonl"), 65536).unwrap();
        assert_eq!(d.last_tail_kind, Some(TailKind::Thinking));
    }

    #[test]
    fn digest_in_flight_has_no_stop_reason() {
        let d = read_digest(&transcript_fixture("in-flight.jsonl"), 65536).unwrap();
        assert_eq!(d.last_stop_reason, None);
    }

    #[test]
    fn digest_api_error_variant_a_status_is_stringified_number() {
        let d = read_digest(&transcript_fixture("api-error.jsonl"), 65536).unwrap();
        assert!(d.has_api_error);
        assert_eq!(d.api_error_status.as_deref(), Some("403"));
        assert_eq!(d.api_error_code.as_deref(), Some("oauth_org_not_allowed"));
        assert_eq!(d.last_stop_reason.as_deref(), Some("stop_sequence"));
    }

    #[test]
    fn digest_api_error_variant_b_status_missing() {
        let d = read_digest(&transcript_fixture("api-error-no-status.jsonl"), 65536).unwrap();
        assert!(d.has_api_error);
        assert_eq!(d.api_error_status, None);
        assert_eq!(d.api_error_code.as_deref(), Some("invalid_request"));
        assert_eq!(d.last_stop_reason.as_deref(), Some("refusal"));
    }

    #[test]
    fn digest_multi_tool_names_are_capped_at_four() {
        let d = read_digest(&transcript_fixture("multi-tool.jsonl"), 65536).unwrap();
        assert_eq!(d.last_tool_names.len(), 4, "源文件有 5 个 tool_use，必须截到 4 个");
    }

    #[test]
    fn digest_garbage_mixed_still_extracts_good_lines() {
        let d = read_digest(&transcript_fixture("garbage-mixed.jsonl"), 65536).unwrap();
        assert!(d.parse_errors > 0, "混入的坏行应该被计数");
        assert_eq!(d.last_role, Some(Role::Assistant));
        assert_eq!(d.last_tool_names, vec!["Bash".to_string()]);
    }

    #[test]
    fn digest_all_garbage_is_unparsable() {
        let err = read_digest(&transcript_fixture("all-garbage.jsonl"), 65536).unwrap_err();
        assert!(matches!(err, DigestError::Unparsable));
    }

    #[test]
    fn digest_empty_file_is_unparsable() {
        let err = read_digest(&transcript_fixture("empty.jsonl"), 65536).unwrap_err();
        assert!(matches!(err, DigestError::Unparsable));
    }

    #[test]
    fn read_digest_missing_file_surfaces_io_error() {
        // 覆盖 DigestError::Io 分支：文件根本打不开时应该原样透出底层 io::Error，
        // 而不是被吞掉、也不能 panic。顺带避免这个字段被 dead_code 检查判定为
        // "从未被读取"（此前没有测试真正解构过 Io(e) 里的 e）。
        let path = transcript_fixture("does-not-exist.jsonl");
        match read_digest(&path, 65536) {
            Err(DigestError::Io(e)) => {
                assert_eq!(e.kind(), std::io::ErrorKind::NotFound);
            }
            other => panic!("期望 DigestError::Io，实际: {other:?}"),
        }
    }

    #[test]
    fn digest_single_huge_message_needs_window_expansion() {
        let path = transcript_fixture("single-huge-message.jsonl");

        // 先证明 8KB 窗口本身抽不出消息——否则下面"扩窗成功"的断言可能只是
        // 因为默认窗口本来就够大，并不能证明扩窗逻辑真的起了作用。
        let tail_8k = tail_lines(&path, 8192).unwrap();
        let direct = extract(&tail_8k.lines);
        assert!(
            !direct.found_message,
            "8KB 窗口应该因为单条超大消息被截断而抽不出任何消息"
        );

        // 用同样的 8KB 起点调 read_digest，必须靠内部 4× 扩窗才能成功。
        let d = read_digest(&path, 8192).expect("应该靠扩窗读到完整消息");
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
    }

    // ---------------------------------------------------------------
    // find_transcript
    // ---------------------------------------------------------------

    /// 测试专用的临时目录：`std::env::temp_dir()` 下按（tag + 进程号 + 自增序号）
    /// 命名，保证并行跑的多个测试互不冲突；`Drop` 里清理，panic 时也能靠栈展开
    /// 触发（除非项目配置了 `panic = "abort"`，未配置，见 Cargo.toml）。
    /// 之所以不用 tempfile crate——任务要求这一层不额外加依赖。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "composer-fleet-transcript-test-{}-{tag}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建测试临时目录失败");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn find_transcript_returns_none_when_config_dir_missing() {
        let tmp = TempDir::new("no-config-dir");
        // 故意不创建这个子目录本身，只是拼一个路径。
        let missing = tmp.path().join("does-not-exist");
        assert!(find_transcript(&missing, "any-session").is_none());
    }

    #[test]
    fn find_transcript_returns_none_when_projects_dir_missing() {
        let tmp = TempDir::new("no-projects-dir");
        // config_dir 本身存在，但没有 projects/ 子目录。
        assert!(find_transcript(tmp.path(), "any-session").is_none());
    }

    #[test]
    fn find_transcript_returns_none_when_session_id_not_found() {
        let tmp = TempDir::new("session-not-found");
        let project_dir = tmp.path().join("projects").join("C--work-demo");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("other-session.jsonl"), "{}").unwrap();

        assert!(find_transcript(tmp.path(), "missing-session").is_none());
    }

    #[test]
    fn find_transcript_finds_file_across_multiple_project_dirs() {
        let tmp = TempDir::new("happy-path");
        let projects = tmp.path().join("projects");
        // 模拟本机实测过的情况：大小写不统一的项目目录名同时存在，
        // 目标 session 藏在其中一个里，find_transcript 不该关心目录名长什么样。
        let dir_a = projects.join("C--Users-demo-project-a");
        let dir_b = projects.join("c--Users-demo-project-b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        std::fs::write(dir_a.join("other-session.jsonl"), "{}").unwrap();
        let target = dir_b.join("target-session.jsonl");
        std::fs::write(&target, "{}").unwrap();

        let found = find_transcript(tmp.path(), "target-session").unwrap();
        assert_eq!(found, target);
    }

    // ---------------------------------------------------------------
    // parse_iso8601_utc_ms
    // ---------------------------------------------------------------

    #[test]
    fn iso8601_epoch_is_zero() {
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00.001Z"), Some(1));
    }

    #[test]
    fn iso8601_ordinary_date_matches_fixture_timestamp() {
        // 与 working.jsonl 里实测出现过的时间戳同一形状，纯粹验证不 panic、能解析。
        let ms = parse_iso8601_utc_ms("2026-07-30T07:29:57.407Z").unwrap();
        assert!(ms > 0);
        // 反过来看：同一秒内毫秒数不同，差值应该正好等于毫秒差。
        let earlier = parse_iso8601_utc_ms("2026-07-30T07:29:57.000Z").unwrap();
        assert_eq!(ms - earlier, 407);
    }

    #[test]
    fn iso8601_leap_year_february_has_29_days() {
        // 2024 是闰年：3月1日 与 2月28日 应该相差 2 天（多出的 2/29 那一天）。
        let mar1 = parse_iso8601_utc_ms("2024-03-01T00:00:00Z").unwrap();
        let feb28 = parse_iso8601_utc_ms("2024-02-28T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb28, 2 * 86_400_000);
    }

    #[test]
    fn iso8601_non_leap_year_february_has_28_days() {
        // 2023 不是闰年：只应该相差 1 天。
        let mar1 = parse_iso8601_utc_ms("2023-03-01T00:00:00Z").unwrap();
        let feb28 = parse_iso8601_utc_ms("2023-02-28T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb28, 86_400_000);
    }

    #[test]
    fn iso8601_century_year_not_divisible_by_400_is_not_leap() {
        // 2100 能被 100 整除但不能被 400 整除，不是闰年——这是最容易被"只判 %4"
        // 的简化实现搞错的边界。
        let mar1 = parse_iso8601_utc_ms("2100-03-01T00:00:00Z").unwrap();
        let feb28 = parse_iso8601_utc_ms("2100-02-28T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb28, 86_400_000, "2100 年 2 月不是闰月，只有 28 天");
    }

    #[test]
    fn iso8601_year_divisible_by_400_is_leap() {
        // 2000 能被 400 整除，是闰年，作为对照组。
        let mar1 = parse_iso8601_utc_ms("2000-03-01T00:00:00Z").unwrap();
        let feb28 = parse_iso8601_utc_ms("2000-02-28T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb28, 2 * 86_400_000);
    }

    #[test]
    fn iso8601_year_end_boundary_crosses_correctly() {
        let last_second_of_year = parse_iso8601_utc_ms("2026-12-31T23:59:59Z").unwrap();
        let first_second_of_next_year = parse_iso8601_utc_ms("2027-01-01T00:00:00Z").unwrap();
        assert_eq!(first_second_of_next_year - last_second_of_year, 1000);
    }

    #[test]
    fn iso8601_missing_milliseconds_defaults_to_zero() {
        let without_ms = parse_iso8601_utc_ms("2026-07-30T07:29:57Z").unwrap();
        let with_zero_ms = parse_iso8601_utc_ms("2026-07-30T07:29:57.000Z").unwrap();
        assert_eq!(without_ms, with_zero_ms);
    }

    #[test]
    fn iso8601_before_epoch_is_negative() {
        // 1970-01-01T00:00:00Z 前一秒。
        assert_eq!(
            parse_iso8601_utc_ms("1969-12-31T23:59:59Z"),
            Some(-1000)
        );
    }

    #[test]
    fn iso8601_malformed_input_returns_none() {
        for bad in [
            "",
            "not-a-date",
            "2026-07-30",                    // 缺时间部分
            "2026-07-30T07:29Z",             // 缺秒
            "2026-07-30T07:29:57",           // 缺 Z 后缀
            "2026/07/30T07:29:57Z",          // 分隔符不对
            "2026-13-01T00:00:00Z",          // 月份非法
            "2026-07-30T25:00:00Z",          // 小时非法
            "2026-07-30T07:29:57.abcZ",      // 毫秒段不是数字
        ] {
            assert_eq!(
                parse_iso8601_utc_ms(bad),
                None,
                "应识别为非法格式: {bad:?}"
            );
        }
    }
}
