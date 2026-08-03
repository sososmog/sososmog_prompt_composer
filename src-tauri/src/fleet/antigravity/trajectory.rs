//! 打开一个 Antigravity 会话库，读出组装卡片需要的东西。
//!
//! ## ⚠️ 绝不能加 `immutable=1`
//!
//! **这是本方案最容易踩且最难发现的坑。** 这些库是 `journal_mode=wal`
//! （实测 `pragma journal_mode` 返回 `wal`）。Codex 侧的 rollout 是普通 jsonl，
//! 随便读都行；这边如果照搬那个思路给 SQLite 加 `immutable=1`：
//!
//! - SQLite 会**忽略 `-wal` 文件**，只读主库文件；
//! - 于是正在跑的会话最新的几十步全都看不见，面板显示的是半小时前的状态；
//! - **而且不报任何错**——数据看起来是合法的，只是旧的。
//!
//! 所以这里用 [`OpenFlags::SQLITE_OPEN_READ_ONLY`]（等价于 `mode=ro`），
//! **不带 immutable**，让 SQLite 正常走 WAL 重放。
//!
//! 只读打开仍然需要能读到 `-wal`/`-shm`。实测 Antigravity 没在跑时这两个
//! sidecar 不存在（干净退出会 checkpoint 掉），跑起来才出现——两种情况
//! `mode=ro` 都能正确处理。
//!
//! ## 零脚印
//!
//! 只读打开不会创建任何文件，也不会 checkpoint 别人的 WAL。
//! 与 `~/.claude` / `~/.codex` 一样：我们挂掉了，Antigravity 毫无感知。

use rusqlite::{Connection, OpenFlags};

use super::super::types::{truncate_text, Role, TailKind, TranscriptDigest};
use super::discover::DbEntry;
use super::payload;

/// 尾部读多少个 step。
///
/// 只需要够凑出「最近在干什么」：状态判据看最后一个，工具名最多显示 4 个，
/// 活动摘要取最近一个有摘要的。实测 type=15/90 这类没有摘要的步骤会连着出现
/// （一次回答里夹着若干段文本），24 个的窗口足够跨过它们摸到上一次工具调用。
///
/// 不读全部：本机最大的库有 835 步，每步的 metadata 有几 KB，全读等于把
/// 几 MB 搬进内存去用最后几行。
pub const TAIL_STEPS: usize = 24;

/// 最多报几个工具名。与 Claude / Codex 两侧一致。
const MAX_TOOL_NAMES: usize = 4;

/// 一个会话库解析出来的东西。
#[derive(Debug, Clone, Default)]
pub struct TrajectoryParsed {
    /// 工作目录。优先取 `trajectory_metadata_blob` 里的 workspace folderUri
    /// （实测 10/18 个会话有），退到某个 `run_command` 步骤的 `Cwd`。
    pub cwd: Option<String>,
    /// **当前**分支，不是默认分支。见 [`read_workspace`] 的注释。
    pub git_branch: Option<String>,
    /// 模型短名，如 `M71`。见 [`read_model`]。
    pub model: Option<String>,
    pub digest: Option<TranscriptDigest>,
}

#[derive(Debug)]
pub enum TrajectoryError {
    /// 库打不开（文件损坏、被独占锁住、权限不足）。
    Open(rusqlite::Error),
    /// 库开了但 `steps` 表查不了——schema 漂移的信号。
    NoSteps,
}

/// 只读打开。**看模块头，不要加 `immutable`。**
fn open_readonly(path: &std::path::Path) -> Result<Connection, rusqlite::Error> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

/// 把 `file:///c:/Users/x/proj` 这种 URI 还原成路径。
///
/// 实测库里存的是**未编码**的形式（`file:///c:/Users/...`），但
/// `config/projects/*.json` 里同一个值是 percent-encoded 的（`c%3A`）。
/// 两种都认，免得哪天上游统一成编码形式我们就瞎了。
fn uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file:///")?;
    let decoded = percent_decode(rest);
    if decoded.is_empty() {
        return None;
    }
    Some(decoded)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 从 `trajectory_metadata_blob` 里抽 workspace 路径与分支。
///
/// blob 是 protobuf，同 [`payload`] 的理由不解 schema，改用内容驱动：
///
/// - **路径**：找 `file:///` 开头的那段 ASCII。无歧义。
/// - **分支**：紧跟在 git 仓库 URL 之后的那个长度前缀字符串。实测排布是
///   `…component-page.git" feature/cyber-emerald-components`
///   （`"` = 0x22 是长度前缀的 tag，后面一个 varint 长度）。取"紧挨着的
///   下一个字段"而不是靠字段号，同 [`payload::tool_name_before`] 的思路。
///
/// ⚠️ **这是当前分支，不是默认分支。** 方案初稿曾打算从
/// `config/projects/*.json` 的 `defaultBranch` 取，那是错的——那个字段是仓库
/// 配置，会话在 feature 分支上干活时它还写 `main`。这里取到的是真实值：
/// 实测同一个仓库的三个会话分别是 `main` / `codex/prototype` /
/// `feature/cyber-emerald-components`，能变说明它跟着 HEAD。
///
/// 诚实的限制：它是**会话捕获 workspace 时**的分支，会话开着期间用户切了分支
/// 大概率不会更新。Claude 侧的 `gitBranch` 也是从 transcript 里读的历史值，
/// 两边同样失真，不算这一侧特有的问题。
fn read_workspace(blob: &[u8]) -> (Option<String>, Option<String>) {
    let path = find_ascii_after(blob, b"file:///")
        .and_then(|s| uri_to_path(&format!("file:///{s}")));
    let branch = find_branch(blob);
    (path, branch)
}

/// 从 `needle` 之后连续取可打印 ASCII（不含空格），到第一个非法字节为止。
fn find_ascii_after(buf: &[u8], needle: &[u8]) -> Option<String> {
    let at = buf.windows(needle.len()).position(|w| w == needle)? + needle.len();
    let end = buf[at..]
        .iter()
        .position(|&b| !(0x21..0x7f).contains(&b))
        .map(|n| at + n)
        .unwrap_or(buf.len());
    if end <= at {
        return None;
    }
    std::str::from_utf8(&buf[at..end]).ok().map(str::to_string)
}

/// git URL 之后紧跟的那个字符串就是分支。
fn find_branch(buf: &[u8]) -> Option<String> {
    // 仓库 URL 以 `.git` 结尾，实测形如 `git@github.com:owner/repo.git`
    // 或 `https://github.com/owner/repo.git`。取最后一个匹配。
    let mut git_end = None;
    let mut i = 0;
    while i + 4 <= buf.len() {
        if &buf[i..i + 4] == b".git" {
            git_end = Some(i + 4);
        }
        i += 1;
    }
    let at = git_end?;
    // 期望 `0x22 <varint len> <branch>`。0x22 是"下一个字符串字段"的 tag；
    // 不是它就说明这个会话没记分支（实测 9/18 有），老实返回 None。
    if at >= buf.len() || buf[at] != 0x22 {
        return None;
    }
    let (len, start) = read_varint(buf, at + 1)?;
    let end = start.checked_add(len as usize)?;
    if end > buf.len() || len == 0 {
        return None;
    }
    let s = std::str::from_utf8(&buf[start..end]).ok()?;
    // 分支名不该有控制字符。有就说明我们对错了字段，不猜。
    if s.is_empty() || s.bytes().any(|b| b < 0x20) {
        return None;
    }
    Some(truncate_text(s))
}

fn read_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut v = 0u64;
    let mut shift = 0u32;
    while i < buf.len() && shift < 64 {
        let b = buf[i];
        i += 1;
        v |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((v, i));
        }
        shift += 7;
    }
    None
}

/// 从 `gen_metadata` 里找模型占位符。
///
/// 实测取值是 `MODEL_PLACEHOLDER_M71` / `M16` / `M72`，**per-session 真实归属**
/// （不同会话不同值，不是一份静态菜单）。取 idx 最大的那条——同 Codex 侧
/// `turn_context` 要取最后一条的理由：模型可能中途换。
///
/// ⚠️ **只显示占位符的短名（`M71`），不映射成"Gemini 3 Pro"一类的真名。**
/// 落盘里没有任何地方写着这些代号对应哪个模型，猜一个然后被上游改版打脸
/// 比显示 `M71` 糟得多。等用户确认过映射再硬编码（E9c）。
fn read_model(conn: &Connection) -> Option<String> {
    const NEEDLE: &[u8] = b"MODEL_PLACEHOLDER_";
    let mut stmt = conn
        .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC")
        .ok()?;
    let mut rows = stmt.query([]).ok()?;
    while let Ok(Some(row)) = rows.next() {
        let data: Vec<u8> = match row.get(0) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if let Some(short) = find_ascii_after(&data, NEEDLE) {
            // 只留 `[A-Za-z0-9]`：抽出来的 run 可能带上后面的 protobuf 噪声。
            let cleaned: String = short
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if !cleaned.is_empty() {
                return Some(cleaned);
            }
        }
    }
    None
}

/// 读尾部若干 step，合成状态与活动摘要。
///
/// ## 状态判据（方案 §2.2）
///
/// 沿用 Codex 侧那套「在采集层翻译成现有 digest 的形状」的做法，
/// `src/fleet.js` 的 `statusCodeFromDigest` 一个字符都不改。
///
/// | 尾部实况 | 合成的字段 | 前端判定 |
/// |---|---|---|
/// | 最后一步是工具调用 | `tool_use` | `working` |
/// | 最后一步不是工具调用 | `end_turn` | `needs-input` |
/// | mtime 超 idleMs | （不管） | `idle`，前端 age 逻辑接管 |
///
/// **"是不是工具调用"靠内容判定**（metadata 里有没有工具入参 JSON），
/// **不靠 `step_type` 的取值**。初稿本想列一张 step_type → 工具的表，
/// 实测发现那个编号不是工具身份：同一个 `type=15` 既出现在纯文本输出上，
/// 也出现在带工具入参的步骤上，而本机 17 种 type 只覆盖我用过的功能。
/// 内容判定没有这个问题，也不会因为上游加一个 type 就失效。
///
/// ⚠️ **`last_stop_reason` 在这一侧是合成的，源数据里没有这个字段。**
/// 半年后有人 grep `stop_reason` 会在 Antigravity 的库里找不到它——
/// 这句话必须留着。（这已经是第三个这么干的 provider 了。）
///
/// 实测 18/18 个会话的最后一步都不是工具调用，所以现实里几乎恒定落在
/// `needs-input`/`idle` 两态。**这是数据源的硬限制，不是 bug**：
/// 落盘里区分不出"正在思考"和"等你说话"。刻意不拿 mtime 去猜 working——
/// 误报"在跑"会让用户漏掉真正在等他的会话，是最坏的误报方向。
fn read_steps(
    conn: &Connection,
    entry: &DbEntry,
) -> Result<Option<TranscriptDigest>, TrajectoryError> {
    let mut stmt = conn
        .prepare("SELECT step_type, status, metadata FROM steps ORDER BY idx DESC LIMIT ?1")
        .map_err(|_| TrajectoryError::NoSteps)?;

    let rows = stmt
        .query_map([TAIL_STEPS as i64], |row| {
            let metadata: Option<Vec<u8>> = row.get(2)?;
            Ok(metadata.unwrap_or_default())
        })
        .map_err(|_| TrajectoryError::NoSteps)?;

    let mut tools: Vec<String> = Vec::new();
    let mut summary: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut newest_is_tool: Option<bool> = None;
    let mut parse_errors: u32 = 0;
    let mut seen_any = false;

    for row in rows {
        let Ok(metadata) = row else {
            parse_errors += 1;
            continue;
        };
        seen_any = true;
        let info = payload::parse_step(&metadata);
        // 第一条（idx 最大）决定状态。
        if newest_is_tool.is_none() {
            newest_is_tool = Some(info.tool.is_some());
        }
        if summary.is_none() {
            summary = info.summary.clone();
        }
        if cwd.is_none() {
            cwd = info.cwd.clone();
        }
        if let Some(t) = info.tool {
            if !tools.contains(&t) && tools.len() < MAX_TOOL_NAMES {
                tools.push(t);
            }
        }
    }

    if !seen_any {
        // 一个 step 都没有 = 会话刚建、一句话没说。这是**正常状态**，
        // 同 Claude 侧的"已启动 · 未开始"，不是解析失败。
        return Ok(None);
    }

    let is_tool = newest_is_tool.unwrap_or(false);
    Ok(Some(TranscriptDigest {
        size_bytes: entry.size_bytes,
        mtime_ms: entry.mtime_ms,
        ai_title: None,
        last_prompt: None,
        activity_summary: summary,
        git_branch: None,
        model: None,
        effort: None,
        last_role: Some(Role::Assistant),
        last_stop_reason: Some(
            if is_tool { "tool_use" } else { "end_turn" }.to_string(),
        ),
        last_tail_kind: Some(if is_tool { TailKind::ToolUse } else { TailKind::Text }),
        last_tool_names: tools,
        last_msg_ts_ms: Some(entry.mtime_ms),
        // 落盘里没有 API 错误的可靠判据。`status=7` 是"这一步失败了"
        // （实测是 list_dir 目录不存在、ask_permission 被拒），跟 Claude 侧
        // `hasApiError`（API 层面报错）语义不同——一个 list_dir 找不到目录
        // 不该让整张卡片变成红色错误态。宁可不报不猜。
        has_api_error: false,
        api_error_status: None,
        api_error_code: None,
        // 落盘里没有 token 计数，也没有窗口大小。
        context_tokens: None,
        context_window: None,
        parse_errors,
    }))
}

/// 打开并解析一个会话库。
pub fn read_trajectory(entry: &DbEntry) -> Result<TrajectoryParsed, TrajectoryError> {
    let conn = open_readonly(&entry.path).map_err(TrajectoryError::Open)?;

    let mut digest = read_steps(&conn, entry)?;

    // workspace 是可选的：实测 8/18 个会话是 "outside-of-project"，
    // 那种会话整个 workspace 子消息都不存在。查不到不是错误。
    let (mut cwd, branch) = conn
        .query_row(
            "SELECT data FROM trajectory_metadata_blob LIMIT 1",
            [],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .ok()
        .flatten()
        .map(|b| read_workspace(&b))
        .unwrap_or((None, None));

    // 没有 workspace 时退到某个 run_command 步骤记下的 Cwd。
    if cwd.is_none() {
        cwd = read_step_cwd(&conn);
    }

    let model = read_model(&conn);
    if let Some(d) = digest.as_mut() {
        d.git_branch = branch.clone();
        d.model = model.clone();
    }

    Ok(TrajectoryParsed {
        cwd,
        git_branch: branch,
        model,
        digest,
    })
}

/// workspace 缺失时的 cwd 兜底：扫尾部步骤里第一个带 `Cwd` 的。
///
/// 单独一个查询而不是复用 [`read_steps`] 的结果，是因为它可能要往更深处翻——
/// "outside-of-project" 的会话往往前面几十步都是纯文本，`Cwd` 只在某次
/// `run_command` 里出现过一次。
fn read_step_cwd(conn: &Connection) -> Option<String> {
    let mut stmt = conn
        .prepare("SELECT metadata FROM steps ORDER BY idx DESC LIMIT 200")
        .ok()?;
    let mut rows = stmt.query([]).ok()?;
    while let Ok(Some(row)) = rows.next() {
        let md: Option<Vec<u8>> = row.get(0).ok()?;
        let Some(md) = md else { continue };
        if let Some(c) = payload::parse_step(&md).cwd {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_to_path_handles_unencoded_form_from_the_db() {
        // 实测库里就是这个形式（没有 percent 编码）
        assert_eq!(
            uri_to_path("file:///c:/Users/sososmog/Desktop/proj").as_deref(),
            Some("c:/Users/sososmog/Desktop/proj")
        );
    }

    #[test]
    fn uri_to_path_handles_percent_encoded_form() {
        // config/projects/*.json 里是这个形式。两种都得认。
        assert_eq!(
            uri_to_path("file:///c%3A/Users/me/proj").as_deref(),
            Some("c:/Users/me/proj")
        );
    }

    #[test]
    fn uri_to_path_rejects_non_file_uris() {
        assert_eq!(uri_to_path("https://example.com"), None);
        assert_eq!(uri_to_path("file:///"), None);
    }

    #[test]
    fn percent_decode_leaves_lone_percent_alone() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    /// 照真实排布造 workspace blob：folderUri ×2 + git 子消息（repo/url/branch）。
    fn workspace_blob(dir: &str, branch: Option<&str>) -> Vec<u8> {
        let uri = format!("file:///{dir}");
        let mut git = Vec::new();
        git.push(0x0a);
        git.push(16);
        git.extend_from_slice(b"sososmog/thing__");
        let url = b"git@github.com:sososmog/thing.git";
        git.push(0x12);
        git.push(url.len() as u8);
        git.extend_from_slice(url);
        if let Some(br) = branch {
            git.push(0x22);
            git.push(br.len() as u8);
            git.extend_from_slice(br.as_bytes());
        }

        let mut inner = Vec::new();
        for tag in [0x0a, 0x12] {
            inner.push(tag);
            inner.push(uri.len() as u8);
            inner.extend_from_slice(uri.as_bytes());
        }
        inner.push(0x1a);
        inner.push(git.len() as u8);
        inner.extend_from_slice(&git);

        let mut out = vec![0x0a];
        out.push(inner.len() as u8);
        out.extend_from_slice(&inner);
        out
    }

    #[test]
    fn reads_workspace_path_and_branch() {
        let b = workspace_blob("c:/Users/me/proj", Some("feature/cyber-emerald"));
        let (path, branch) = read_workspace(&b);
        assert_eq!(path.as_deref(), Some("c:/Users/me/proj"));
        assert_eq!(branch.as_deref(), Some("feature/cyber-emerald"));
    }

    #[test]
    fn reads_plain_main_branch() {
        let b = workspace_blob("c:/p", Some("main"));
        assert_eq!(read_workspace(&b).1.as_deref(), Some("main"));
    }

    #[test]
    fn missing_branch_field_yields_none_not_garbage() {
        // 实测 9/18 个会话没记分支。那时 .git 后面跟的是别的字段，
        // 不能把它当分支读出来。
        let b = workspace_blob("c:/p", None);
        let (path, branch) = read_workspace(&b);
        assert_eq!(path.as_deref(), Some("c:/p"));
        assert_eq!(branch, None);
    }

    #[test]
    fn outside_of_project_blob_has_no_workspace_at_all() {
        // 实测 8/18：整个 workspace 子消息不存在，只有 id 和
        // `outside-of-project` 字符串。两个字段都该是 None。
        let mut b = vec![0x12, 0x0c, 0x08, 0xdb, 0x81, 0xb2, 0xd3];
        b.extend_from_slice(&[0x92, 0x01, 0x12]);
        b.extend_from_slice(b"outside-of-project");
        let (path, branch) = read_workspace(&b);
        assert_eq!(path, None);
        assert_eq!(branch, None);
    }

    #[test]
    fn branch_with_control_bytes_is_rejected() {
        // 对错字段的自我保护：分支名不该有控制字符。
        let mut b = Vec::new();
        b.extend_from_slice(b"git@github.com:x/y.git");
        b.push(0x22);
        b.push(4);
        b.extend_from_slice(&[b'm', 0x01, b'i', b'n']);
        assert_eq!(find_branch(&b), None);
    }

    #[test]
    fn zero_length_branch_is_rejected() {
        let mut b = Vec::new();
        b.extend_from_slice(b"git@github.com:x/y.git");
        b.push(0x22);
        b.push(0);
        assert_eq!(find_branch(&b), None);
    }

    #[test]
    fn branch_length_running_past_the_buffer_is_rejected() {
        // 防越界：长度字段说有 200 字节，实际只剩几个。
        let mut b = Vec::new();
        b.extend_from_slice(b"git@github.com:x/y.git");
        b.push(0x22);
        b.push(200);
        b.extend_from_slice(b"main");
        assert_eq!(find_branch(&b), None);
    }

    #[test]
    fn find_ascii_after_stops_at_binary_noise() {
        let mut b = Vec::new();
        b.extend_from_slice(b"MODEL_PLACEHOLDER_M71");
        b.extend_from_slice(&[0x00, 0xff, b'j', b'u', b'n', b'k']);
        assert_eq!(find_ascii_after(&b, b"MODEL_PLACEHOLDER_").as_deref(), Some("M71"));
    }

    #[test]
    fn find_ascii_after_returns_none_when_needle_absent() {
        assert_eq!(find_ascii_after(b"nothing here", b"file:///"), None);
    }

    #[test]
    fn read_varint_handles_multibyte_lengths() {
        // 真实分支长度 32 是单字节，但 workspace blob 的外层长度是双字节
        // （实测 \xf1\x01 = 241），解错会整块读歪。
        assert_eq!(read_varint(&[0x04], 0), Some((4, 1)));
        assert_eq!(read_varint(&[0xf1, 0x01], 0), Some((241, 2)));
        assert_eq!(read_varint(&[0xd9, 0x02], 0), Some((345, 2)));
        assert_eq!(read_varint(&[0xff], 0), None, "截断的 varint 该失败");
    }
}
