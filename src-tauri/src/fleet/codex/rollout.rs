//! rollout jsonl 的解析：首行 `session_meta` + 尾部窗口的状态判定。
//!
//! ## 为什么要读两处
//!
//! Claude 侧只读尾部就够了——它的每条消息都自带 `gitBranch`、`model` 之类的
//! 元信息。Codex 不是：`cwd` / `cli_version` / `git.branch` / 起始时间全部只在
//! **首行的 `session_meta`** 里出现一次，而状态判定的依据在**尾部**。
//! 所以这里读两次：`read_first_line` 拿元信息，`tail_lines`（复用 Claude 侧的）
//! 拿状态。
//!
//! 首行实测 19–46KB（`base_instructions` 全文 + `dynamic_tools` 定义撑的），
//! 不是个小数字。会话生命周期内它不会变，**将来值得按 sessionId 缓存**——
//! 那要动 `FleetState`，属于编排层的事，这一层先老实每次读。
//!
//! ⚠️ 同样 46KB 的 `session_meta` **还会在会话中途被重复写**（实测同一个文件里
//! 第 0 行和第 31 行各一条）。它大到能把 64KB 的尾部窗口整个占满，所以
//! [`read_rollout`] 必须扩窗重试——细节见那个函数里的注释。
//!
//! ## 状态是怎么判出来的
//!
//! 见 `docs/agent-fleet-codex.md` §2.2。一句话：按 `turn_id` 配对
//! `task_started` 与 `task_complete`，把结论**翻译成 Claude 侧 digest 的形状**
//! （`last_role` + `last_stop_reason`），这样前端 `statusCodeFromDigest`
//! 一行都不用改。
//!
//! > ⚠️ **`last_role` 和 `last_stop_reason` 在这一侧是合成的**，rollout jsonl
//! > 里根本没有 `stop_reason` 这个字段。别去源数据里找它。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

use super::super::transcript::{parse_iso8601_utc_ms, tail_lines};
use super::super::types::{self, Role, TailKind, TranscriptDigest};
use super::discover::RolloutEntry;

/// 首行读取上限。实测首行 19–46KB，256KB 给足余量。
///
/// 超过这个长度就当解析失败：正常的 `session_meta` 不该有那么大，真到了那一步
/// 说明要么格式变了，要么文件损坏——两种情况都不该让我们把几 MB 读进内存。
const HEAD_MAX_BYTES: u64 = 256 * 1024;

/// 首行 `session_meta` 里我们要的东西。
///
/// 全部来自源数据，没有一处是推的。拿不到的就是 `None` / 空串，由编排层决定
/// 怎么兜底展示。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionMeta {
    /// 与文件名里的 id 应当一致。不一致时以文件名为准（见 [`read_rollout`]）。
    pub session_id: Option<String>,
    pub cwd: String,
    pub cli_version: String,
    /// 实测 `Codex Desktop`。纯 CLI 会是什么值本机没有样本。
    pub originator: String,
    /// 实测 `vscode`。
    pub source: Option<String>,
    pub git_branch: Option<String>,
    /// ms epoch，来自 `payload.timestamp`（带 `Z`，UTC，无歧义）。
    ///
    /// **不用文件名里的时间**——那个是本地时间且不带时区，见
    /// [`super::discover`] 的模块文档。
    pub started_at: Option<i64>,
}

/// 一个 rollout 解析出来的全部内容。
#[derive(Debug, Clone)]
pub struct RolloutParsed {
    pub meta: SessionMeta,
    /// `None` = 尾部窗口里没有任何可用内容（刚建的会话只有 `session_meta` 一行）。
    /// 这**不是错误**，对应前端的「已启动 · 未开始」，同 Claude 侧的语义。
    pub digest: Option<TranscriptDigest>,
    /// 模型上下文窗口。Codex 在 `token_count` 和 `task_started` 里都明确给了这个
    /// 数字，Claude 侧则根本判不出来（见 `TranscriptDigest::context_tokens` 注释）。
    ///
    /// 暂时放在 digest 外面：把它塞进 `TranscriptDigest` 属于改契约，那要连
    /// `SCHEMA_VERSION` 和前端一起动，是 E4b 的事。
    pub context_window: Option<u64>,
}

#[derive(Debug)]
pub enum RolloutError {
    Io(std::io::Error),
    /// 首行不是一个能用的 `session_meta`。整条会话跳过——没有 cwd 和起始时间的
    /// 卡片没有展示价值，硬塞一个空壳只会让用户以为自己的会话坏了。
    NoSessionMeta,
}

/// 读文件首行，最多 `max_bytes`。
///
/// 首行超过上限时返回的是被截断的内容，JSON 必然解析失败，于是自然降级成
/// [`RolloutError::NoSessionMeta`]——不需要单独判一次"是不是截断了"。
fn read_first_line(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::new(file.take(max_bytes));
    let mut buf = Vec::new();
    reader.read_until(b'\n', &mut buf)?;
    // lossy 而不是 unwrap：截断可能正好切在多字节字符中间，那不该让整个采集崩掉。
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 解析首行 `session_meta`。纯函数，喂字符串即可测。
///
/// 返回 `None` 表示这行不是 `session_meta`（或压根不是 JSON）。
pub fn parse_session_meta(line: &str) -> Option<SessionMeta> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let p = v.get("payload")?;

    let s = |k: &str| p.get(k).and_then(Value::as_str);

    Some(SessionMeta {
        session_id: s("session_id").or_else(|| s("id")).map(String::from),
        cwd: s("cwd").unwrap_or_default().to_string(),
        cli_version: s("cli_version").unwrap_or_default().to_string(),
        originator: s("originator").unwrap_or_default().to_string(),
        source: s("source").map(String::from),
        // git 整块可能缺失（非 git 目录里起的会话）。
        git_branch: p
            .get("git")
            .and_then(|g| g.get("branch"))
            .and_then(Value::as_str)
            .map(String::from),
        // payload.timestamp 是会话真正的开始时刻；外层那个 timestamp 是**这一行
        // 被写下的时刻**，实测差 11 秒（04:23:32.963 vs 04:23:44.152）。
        // 取错了会让"已运行多久"多算十几秒——不致命，但没理由要错的那个。
        started_at: s("timestamp").and_then(parse_iso8601_utc_ms),
    })
}

/// 一轮（turn）是怎么结束的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnEnd {
    /// `task_complete`：正常收尾，模型在等你说话。
    Complete,
    /// `turn_aborted`：被中断。实测出现过（用户按停）。
    Aborted,
}

/// 尾部扫描的产物。字段与 [`TranscriptDigest`] 大致对应，外加几个只在
/// Codex 侧存在的东西。
#[derive(Debug, Default)]
struct TailExtract {
    last_role: Option<Role>,
    last_stop_reason: Option<String>,
    last_tail_kind: Option<TailKind>,
    last_tool_names: Vec<String>,
    last_msg_ts_ms: Option<i64>,
    last_prompt: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    parse_errors: u32,
    /// 尾部窗口里有没有任何我们认识的内容。false → digest 整个为 None。
    found_content: bool,
}

/// 从一行里取出 `(type, payload.type)` 这对判别式。
///
/// Codex 的行结构是两层的：外层 `type` 分 `event_msg` / `response_item` /
/// `turn_context` / `session_meta` / `world_state`，真正的种类在
/// `payload.type` 里。只看外层什么也判断不出来。
fn kinds(v: &Value) -> (&str, &str) {
    let outer = v.get("type").and_then(Value::as_str).unwrap_or("");
    let inner = v
        .get("payload")
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    (outer, inner)
}

/// 一行里如果是工具调用，返回它的名字。
///
/// 三种形态都要认：`custom_tool_call`（实测 `exec`）、`function_call`
/// （实测 `wait`）、以及 MCP 的 `server.tool`。
fn tool_name(p: &Value, inner: &str) -> Option<String> {
    match inner {
        "custom_tool_call" | "function_call" => {
            p.get("name").and_then(Value::as_str).map(String::from)
        }
        "mcp_tool_call_begin" | "mcp_tool_call_end" => {
            let inv = p.get("invocation")?;
            let server = inv.get("server").and_then(Value::as_str).unwrap_or("?");
            let tool = inv.get("tool").and_then(Value::as_str).unwrap_or("?");
            Some(format!("{server}.{tool}"))
        }
        _ => None,
    }
}

/// 把一行映射成尾部形态。`None` = 这行不代表任何一种形态。
fn tail_kind_of(inner: &str) -> Option<TailKind> {
    match inner {
        "custom_tool_call" | "function_call" | "mcp_tool_call_begin" => Some(TailKind::ToolUse),
        "custom_tool_call_output" | "function_call_output" | "mcp_tool_call_end" => {
            Some(TailKind::ToolResult)
        }
        "reasoning" | "agent_reasoning" => Some(TailKind::Thinking),
        "message" | "agent_message" | "user_message" => Some(TailKind::Text),
        _ => None,
    }
}

/// 逐行解析 + 反向扫描。
///
/// 两遍走，和 Claude 侧同一个套路：第一遍 parse 成 `Value`（失败计入
/// `parse_errors`），第二遍从尾部往前扫，"一旦找到就不再更新"天然等价于
/// "取最后一条"。
fn extract_tail(lines: &[String]) -> TailExtract {
    let mut values: Vec<Value> = Vec::with_capacity(lines.len());
    let mut parse_errors = 0u32;
    for line in lines {
        match serde_json::from_str::<Value>(line) {
            Ok(v) => values.push(v),
            Err(_) => parse_errors += 1,
        }
    }

    let mut out = TailExtract {
        parse_errors,
        ..Default::default()
    };

    // ---- 第一趟（反向）：task 配对 + 各种"最后一条" ----

    // 已经结束的 turn：turn_id → 怎么结束的。
    // 反向扫描时先遇到结束事件、后遇到对应的 task_started，所以要先攒着。
    let mut ended: HashMap<String, TurnEnd> = HashMap::new();
    // 反向遇到的第一个结束事件（= 时间上最后一个），供"窗口里只剩结束事件"
    // 那条降级路径使用。
    let mut latest_end: Option<TurnEnd> = None;
    // 反向遇到的第一个 task_started（= 时间上最后一次开跑）。
    let mut latest_start_turn: Option<String> = None;

    let mut last_real_role: Option<Role> = None;

    for v in values.iter().rev() {
        let (outer, inner) = kinds(v);
        let empty = Value::Null;
        let p = v.get("payload").unwrap_or(&empty);

        // 时间戳：任何一行都可能有，取最后一个有的。
        if out.last_msg_ts_ms.is_none() {
            out.last_msg_ts_ms = v
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_iso8601_utc_ms);
        }

        match (outer, inner) {
            ("event_msg", "task_complete") | ("event_msg", "turn_aborted") => {
                let kind = if inner == "turn_aborted" {
                    TurnEnd::Aborted
                } else {
                    TurnEnd::Complete
                };
                if latest_end.is_none() {
                    latest_end = Some(kind);
                }
                if let Some(id) = p.get("turn_id").and_then(Value::as_str) {
                    ended.entry(id.to_string()).or_insert(kind);
                }
                out.found_content = true;
            }
            ("event_msg", "task_started") => {
                if latest_start_turn.is_none() {
                    // turn_id 缺失时用一个哨兵：它不会出现在 ended 里，
                    // 于是判成"在跑"——对一个刚开始、还没写完的 turn 而言
                    // 这是安全的方向（宁可说它在动，也别说它在等你）。
                    latest_start_turn = Some(
                        p.get("turn_id")
                            .and_then(Value::as_str)
                            .unwrap_or("<no-turn-id>")
                            .to_string(),
                    );
                }
                out.found_content = true;
            }
            ("event_msg", "token_count") => {
                // 只认第一个（= 最后一条）。
                if out.context_tokens.is_none() {
                    let info = p.get("info");
                    // ⚠️ 必须是 last_token_usage 而不是 total_token_usage：
                    // 后者是整个会话的累计消耗，实测 2,227,341 对 88,172，
                    // 差 25 倍，拿它算占用率会显示 862%。
                    out.context_tokens = info
                        .and_then(|i| i.get("last_token_usage"))
                        .and_then(|u| u.get("total_tokens"))
                        .and_then(Value::as_u64);
                    out.context_window = info
                        .and_then(|i| i.get("model_context_window"))
                        .and_then(Value::as_u64);
                    out.found_content = true;
                }
            }
            ("event_msg", "user_message") => {
                if last_real_role.is_none() {
                    last_real_role = Some(Role::User);
                }
                if out.last_prompt.is_none() {
                    out.last_prompt = p
                        .get("message")
                        .and_then(Value::as_str)
                        .map(types::truncate_text);
                }
                out.found_content = true;
            }
            ("event_msg", "agent_message") => {
                if last_real_role.is_none() {
                    last_real_role = Some(Role::Assistant);
                }
                out.found_content = true;
            }
            // model / effort 只在每轮开头写一次，长会话的尾部窗口里常常压根没有
            // ——那时只能是 None。这是已知的展示缺口，不值得为它把整个文件读一遍。
            // 守卫写在 match 臂上（而不是臂内再 if）：反向扫描下"第一个遇到的
            // 就是最后一条"，找到之后后面那些更旧的 turn_context 直接不匹配。
            ("turn_context", _) if out.model.is_none() => {
                out.model = p.get("model").and_then(Value::as_str).map(String::from);
                out.effort = p.get("effort").and_then(Value::as_str).map(String::from);
            }
            _ => {}
        }

        // 尾部形态与工具名：response_item 和 event_msg 里都可能有。
        if let Some(kind) = tail_kind_of(inner) {
            if out.last_tail_kind.is_none() {
                out.last_tail_kind = Some(kind);
            }
            out.found_content = true;
        }
        if out.last_tool_names.len() < 4 {
            if let Some(name) = tool_name(p, inner) {
                // 反向扫描，所以这里是倒序攒的，最后再翻回时间正序。
                if !out.last_tool_names.contains(&name) {
                    out.last_tool_names.push(name);
                }
            }
        }

        // task_started 之后没有对应的结束事件，且各"最后一条"都齐了 —— 可以停了。
        // 这个提前退出只是省几次循环，不影响结论（后面的行只会更旧）。
        if latest_start_turn.is_some()
            && out.context_tokens.is_some()
            && out.model.is_some()
            && last_real_role.is_some()
            && out.last_tail_kind.is_some()
        {
            break;
        }
    }

    out.last_tool_names.reverse(); // 倒序攒的 → 时间正序

    // task_started 里也带 model_context_window，作为 token_count 缺失时的补充。
    if out.context_window.is_none() {
        out.context_window = values.iter().rev().find_map(|v| {
            let (outer, inner) = kinds(v);
            if (outer, inner) != ("event_msg", "task_started") {
                return None;
            }
            v.get("payload")?
                .get("model_context_window")?
                .as_u64()
        });
    }

    // ---- 第二趟：把 turn 状态翻译成 Claude 侧 digest 的形状 ----
    //
    // ⚠️ 这里合成的 (role, stop_reason) 在源数据里并不存在，纯粹是为了让
    //    前端 statusCodeFromDigest 不用为 Codex 加分支。对应关系见方案 §2.2。
    let synthesized: Option<(Role, &str)> = match (&latest_start_turn, latest_end) {
        // 最后一次开跑有对应的结束事件 → 那一轮已经收尾了。
        (Some(turn), _) if ended.contains_key(turn) => match ended[turn] {
            TurnEnd::Aborted => Some((Role::Assistant, "stop_sequence")),
            TurnEnd::Complete => Some((Role::Assistant, "end_turn")),
        },
        // 开跑了但窗口里找不到它的结束事件 → 还在跑。
        (Some(_), _) => Some((Role::Assistant, "tool_use")),
        // 窗口里只剩结束事件（那一轮的 task_started 已经被切出窗口了）——
        // 同样说明"已经收尾"。
        (None, Some(TurnEnd::Aborted)) => Some((Role::Assistant, "stop_sequence")),
        (None, Some(TurnEnd::Complete)) => Some((Role::Assistant, "end_turn")),
        // 一个 task 事件都没有 → 走降级判据，见下。
        (None, None) => None,
    };

    match synthesized {
        Some((role, reason)) => {
            // role 跟着一起合成，不用真实的最后一条消息角色：两者混用会出现
            // "role=user 但那一轮已经 complete"这种自相矛盾的组合，而前端对
            // role=user 的判定是 working——正好判反。
            out.last_role = Some(role);
            out.last_stop_reason = Some(reason.to_string());
        }
        None => {
            // 降级判据：没有 task 事件时（某个 Codex 版本不写？窗口太小？），
            // 退回"最后一条消息是谁说的"。这条路径实测从未触发——本机 56 个
            // rollout 横跨三个版本，task_started/task_complete 全都有——
            // 但它是格式漂移时唯一的兜底，成本只有几行。
            out.last_role = last_real_role;
            out.last_stop_reason = match last_real_role {
                Some(Role::Assistant) => Some("end_turn".to_string()),
                _ => None,
            };
        }
    }

    out
}

/// 读并解析一个 rollout。
///
/// `entry` 里的 `mtime_ms` / `size_bytes` 直接复用，不重复 stat（发现阶段
/// 已经拿过一次了）。
pub fn read_rollout(entry: &RolloutEntry, tail_bytes: u64) -> Result<RolloutParsed, RolloutError> {
    let head = read_first_line(&entry.path, HEAD_MAX_BYTES).map_err(RolloutError::Io)?;
    let meta = parse_session_meta(&head).ok_or(RolloutError::NoSessionMeta)?;

    // 扩窗重试，和 Claude 侧 `read_digest` 同一套：抽不出内容就 4× 扩窗，
    // 直到抽出来、窗口盖住整个文件、或撞到 TAIL_BYTES_MAX。
    //
    // 这里最初写的是"不扩窗——没有内容是个确定的结论"，**那是错的**，真机
    // 第一次跑就打脸了：Codex 会在会话中途重复写 `session_meta`（实测同一个
    // 文件里出现在第 0 行和第 31 行），而那一行有 46KB。碰上它正好是最后一行时，
    // 64KB 的窗口切出来只有「19KB 半行 + 46KB 的 session_meta」，丢掉半行后
    // 唯一完整的一行是我们不认识的类型 —— 一个 3.7MB、560 行的活跃会话就这么
    // 被判成了「已启动 · 未开始」。
    //
    // 手写夹具永远造不出这个场景：它要求单行长度和窗口大小在同一个量级。
    let mut window = tail_bytes.max(1);
    let extracted = loop {
        let tail = tail_lines(&entry.path, window).map_err(RolloutError::Io)?;
        let extracted = extract_tail(&tail.lines);
        if extracted.found_content {
            break extracted;
        }
        // 窗口已经盖住整个文件、或到上限——再扩读不出新东西。
        // 这时才能下"确实没有内容"的结论（刚建的会话就是这样）。
        if window >= tail.size_bytes || window >= types::TAIL_BYTES_MAX {
            return Ok(RolloutParsed {
                meta,
                digest: None,
                context_window: None,
            });
        }
        window = window.saturating_mul(4).min(types::TAIL_BYTES_MAX);
    };

    let digest = TranscriptDigest {
        size_bytes: entry.size_bytes,
        mtime_ms: entry.mtime_ms,
        // Codex 自己不生成会话标题；`session_index.jsonl` 里的 thread_name 由
        // 上层补进来（见 `index.rs`），这一层拿不到。
        ai_title: None,
        last_prompt: extracted.last_prompt,
        git_branch: meta.git_branch.clone(),
        model: extracted.model,
        effort: extracted.effort,
        last_role: extracted.last_role,
        last_stop_reason: extracted.last_stop_reason,
        last_tail_kind: extracted.last_tail_kind,
        last_tool_names: extracted.last_tool_names,
        last_msg_ts_ms: extracted.last_msg_ts_ms,
        // 恒 false：本机 56 个 rollout 里没抓到任何 error / stream_error 事件，
        // 不知道它长什么样。宁可不报，也不猜一个判据——猜错的方向是把正常会话
        // 标成 failed，那比缺一个状态糟得多。见方案 §7。
        has_api_error: false,
        api_error_status: None,
        api_error_code: None,
        context_tokens: extracted.context_tokens,
        parse_errors: extracted.parse_errors,
    };

    Ok(RolloutParsed {
        meta,
        digest: Some(digest),
        context_window: extracted.context_window,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一条真实首行的**结构**（`base_instructions` / `dynamic_tools` 这些
    /// 几十 KB 的大字段已剥掉，其余字段名与实测逐一对齐）。
    const META_LINE: &str = r#"{"timestamp":"2026-08-03T04:23:44.152Z","type":"session_meta","payload":{"session_id":"019fc5dc-d8d0-78c2-bdb7-427137d069e2","id":"019fc5dc-d8d0-78c2-bdb7-427137d069e2","timestamp":"2026-08-03T04:23:32.963Z","cwd":"C:\\proj\\demo","originator":"Codex Desktop","cli_version":"0.146.0-alpha.9.2","source":"vscode","thread_source":"user","model_provider":"openai","git":{"commit_hash":"ce4584a","branch":"main","repository_url":"git@github.com:demo/demo.git"}}}"#;

    fn lines(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    fn started(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-08-03T04:24:00.000Z","type":"event_msg","payload":{{"type":"task_started","turn_id":"{turn}","model_context_window":258400}}}}"#
        )
    }
    fn complete(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-08-03T04:25:00.000Z","type":"event_msg","payload":{{"type":"task_complete","turn_id":"{turn}","last_agent_message":"done"}}}}"#
        )
    }
    fn aborted(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-08-03T04:25:00.000Z","type":"event_msg","payload":{{"type":"turn_aborted","turn_id":"{turn}"}}}}"#
        )
    }
    const USER_MSG: &str = r#"{"timestamp":"2026-08-03T04:24:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"帮我看下这个项目"}}"#;
    const AGENT_MSG: &str = r#"{"timestamp":"2026-08-03T04:24:50.000Z","type":"event_msg","payload":{"type":"agent_message","message":"看完了"}}"#;
    const TOOL_CALL: &str = r#"{"timestamp":"2026-08-03T04:24:10.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}"#;
    const TOKEN_COUNT: &str = r#"{"timestamp":"2026-08-03T04:24:20.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2227341},"last_token_usage":{"total_tokens":88172},"model_context_window":258400}}}"#;

    // ---- 首行解析 ----

    #[test]
    fn parses_a_real_session_meta_line() {
        let m = parse_session_meta(META_LINE).expect("应该认出 session_meta");
        assert_eq!(
            m.session_id.as_deref(),
            Some("019fc5dc-d8d0-78c2-bdb7-427137d069e2")
        );
        assert_eq!(m.cwd, "C:\\proj\\demo");
        assert_eq!(m.cli_version, "0.146.0-alpha.9.2");
        assert_eq!(m.originator, "Codex Desktop");
        assert_eq!(m.source.as_deref(), Some("vscode"));
        assert_eq!(m.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn started_at_comes_from_payload_timestamp_not_the_outer_one() {
        // 外层 04:23:44.152 是"这行被写下"的时刻，payload 里的 04:23:32.963
        // 才是会话开始时刻。实测差 11 秒。
        let m = parse_session_meta(META_LINE).unwrap();
        let outer = parse_iso8601_utc_ms("2026-08-03T04:23:44.152Z").unwrap();
        let inner = parse_iso8601_utc_ms("2026-08-03T04:23:32.963Z").unwrap();
        assert_eq!(m.started_at, Some(inner));
        assert_ne!(m.started_at, Some(outer));
    }

    #[test]
    fn rejects_lines_that_are_not_session_meta() {
        for line in [
            "",
            "not json",
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"type":"session_meta"}"#, // 没有 payload
        ] {
            assert!(parse_session_meta(line).is_none(), "{line:?} 不该被认成 meta");
        }
    }

    #[test]
    fn tolerates_a_session_meta_without_git() {
        // 非 git 目录里起的会话没有 git 块，不该整条作废。
        let line = r#"{"type":"session_meta","payload":{"session_id":"s1","cwd":"/tmp","cli_version":"1.0","originator":"cli"}}"#;
        let m = parse_session_meta(line).unwrap();
        assert_eq!(m.git_branch, None);
        assert_eq!(m.cwd, "/tmp");
        assert_eq!(m.started_at, None);
    }

    // ---- 状态合成（方案 §2.2 那张表，逐行钉住）----

    #[test]
    fn unfinished_turn_is_translated_to_working() {
        let e = extract_tail(&lines(&[USER_MSG, &started("t1"), TOOL_CALL]));
        assert_eq!(e.last_role, Some(Role::Assistant));
        assert_eq!(e.last_stop_reason.as_deref(), Some("tool_use"));
    }

    #[test]
    fn completed_turn_is_translated_to_needs_input() {
        let e = extract_tail(&lines(&[
            USER_MSG,
            &started("t1"),
            TOOL_CALL,
            AGENT_MSG,
            &complete("t1"),
        ]));
        assert_eq!(e.last_role, Some(Role::Assistant));
        assert_eq!(e.last_stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn aborted_turn_is_translated_to_stop_sequence() {
        let e = extract_tail(&lines(&[USER_MSG, &started("t1"), &aborted("t1")]));
        assert_eq!(e.last_stop_reason.as_deref(), Some("stop_sequence"));
    }

    #[test]
    fn a_new_turn_after_a_completed_one_is_working_again() {
        // 最容易写错的一条：窗口里同时有旧轮的 complete 和新轮的 started。
        // 只看"有没有 complete"会判成在等你回话，实际上模型正在跑第二轮。
        let e = extract_tail(&lines(&[
            &started("t1"),
            &complete("t1"),
            USER_MSG,
            &started("t2"),
        ]));
        assert_eq!(
            e.last_stop_reason.as_deref(),
            Some("tool_use"),
            "新一轮已经开跑，不该判成在等用户"
        );
    }

    #[test]
    fn completion_is_matched_by_turn_id_not_by_position() {
        // 交错的情况：t2 开跑后才落地 t1 的 complete。t2 仍未结束。
        let e = extract_tail(&lines(&[
            &started("t1"),
            &started("t2"),
            &complete("t1"),
        ]));
        assert_eq!(
            e.last_stop_reason.as_deref(),
            Some("tool_use"),
            "结束的是 t1，最后开跑的 t2 还没结束"
        );
    }

    #[test]
    fn only_an_end_event_in_the_window_still_counts_as_finished() {
        // 一轮很长，它的 task_started 已经被切出窗口，只剩 complete。
        let e = extract_tail(&lines(&[TOOL_CALL, AGENT_MSG, &complete("t1")]));
        assert_eq!(e.last_stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn task_started_without_turn_id_is_treated_as_running() {
        let line = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let e = extract_tail(&lines(&[&complete("t1"), line]));
        assert_eq!(
            e.last_stop_reason.as_deref(),
            Some("tool_use"),
            "拿不到 turn_id 时该往'在跑'的方向兜底"
        );
    }

    #[test]
    fn falls_back_to_message_order_when_there_are_no_task_events() {
        // 降级路径：某个 Codex 版本不写 task_* 事件时的兜底。
        let e = extract_tail(&lines(&[USER_MSG, AGENT_MSG]));
        assert_eq!(e.last_role, Some(Role::Assistant));
        assert_eq!(e.last_stop_reason.as_deref(), Some("end_turn"));

        let e2 = extract_tail(&lines(&[AGENT_MSG, USER_MSG]));
        assert_eq!(e2.last_role, Some(Role::User));
        assert_eq!(e2.last_stop_reason, None, "user 收尾时前端只看 role 就够");
    }

    // ---- 其余字段 ----

    #[test]
    fn context_tokens_use_last_usage_not_the_cumulative_total() {
        // 这两个数差 25 倍，取错会显示 862% 的上下文占用。
        let e = extract_tail(&lines(&[TOKEN_COUNT]));
        assert_eq!(e.context_tokens, Some(88172));
        assert_ne!(e.context_tokens, Some(2227341));
        assert_eq!(e.context_window, Some(258400));
    }

    #[test]
    fn context_window_falls_back_to_task_started() {
        // 窗口里没有 token_count 时，task_started 也带着这个数字。
        let e = extract_tail(&lines(&[&started("t1")]));
        assert_eq!(e.context_window, Some(258400));
    }

    #[test]
    fn collects_tool_names_in_chronological_order() {
        let mcp = r#"{"type":"event_msg","payload":{"type":"mcp_tool_call_begin","invocation":{"server":"node_repl","tool":"js"}}}"#;
        let func = r#"{"type":"response_item","payload":{"type":"function_call","name":"wait"}}"#;
        let e = extract_tail(&lines(&[TOOL_CALL, mcp, func]));
        assert_eq!(e.last_tool_names, vec!["exec", "node_repl.js", "wait"]);
    }

    #[test]
    fn tool_names_are_capped_at_four() {
        let mut raw: Vec<String> = (0..9)
            .map(|i| {
                format!(
                    r#"{{"type":"response_item","payload":{{"type":"function_call","name":"tool{i}"}}}}"#
                )
            })
            .collect();
        raw.insert(0, USER_MSG.to_string());
        let e = extract_tail(&raw);
        assert_eq!(e.last_tool_names.len(), 4);
    }

    #[test]
    fn last_prompt_is_the_most_recent_user_message() {
        let older = r#"{"type":"event_msg","payload":{"type":"user_message","message":"第一个问题"}}"#;
        let e = extract_tail(&lines(&[older, TOOL_CALL, USER_MSG]));
        assert_eq!(e.last_prompt.as_deref(), Some("帮我看下这个项目"));
    }

    #[test]
    fn model_and_effort_come_from_the_latest_turn_context() {
        // turn_context 每轮都写，且会变（实测 terra/medium → sol/high）。
        let older = r#"{"type":"turn_context","payload":{"model":"gpt-5.6-terra","effort":"medium"}}"#;
        let newer = r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"high"}}"#;
        let e = extract_tail(&lines(&[older, USER_MSG, newer, TOOL_CALL]));
        assert_eq!(e.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(e.effort.as_deref(), Some("high"));
    }

    #[test]
    fn tail_kind_maps_each_family_of_rows() {
        let cases = [
            (TOOL_CALL, TailKind::ToolUse),
            (
                r#"{"type":"response_item","payload":{"type":"custom_tool_call_output"}}"#,
                TailKind::ToolResult,
            ),
            (
                r#"{"type":"response_item","payload":{"type":"reasoning"}}"#,
                TailKind::Thinking,
            ),
            (AGENT_MSG, TailKind::Text),
        ];
        for (line, want) in cases {
            let e = extract_tail(&lines(&[line]));
            assert_eq!(e.last_tail_kind, Some(want), "{line}");
        }
    }

    #[test]
    fn bad_lines_are_counted_not_fatal() {
        let e = extract_tail(&lines(&["{ broken", "also not json", AGENT_MSG]));
        assert_eq!(e.parse_errors, 2);
        assert!(e.found_content, "还有一行是好的，不该整块作废");
    }

    #[test]
    fn unknown_row_types_are_ignored_without_counting_as_errors() {
        // world_state 用途不明，将来还会有更多没见过的类型。
        let e = extract_tail(&lines(&[
            r#"{"type":"world_state","payload":{"full":true}}"#,
            r#"{"type":"brand_new_thing","payload":{"type":"whatever"}}"#,
        ]));
        assert_eq!(e.parse_errors, 0, "合法 JSON 只是我们不认识，不算解析失败");
        assert!(!e.found_content, "全是不认识的类型 → 没有可用内容");
    }

    #[test]
    fn empty_window_yields_no_content() {
        let e = extract_tail(&[]);
        assert!(!e.found_content);
        assert_eq!(e.last_role, None);
    }

    // ---- 端到端（真文件）----

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static C: AtomicU64 = AtomicU64::new(0);
            let n = C.fetch_add(1, Ordering::Relaxed);
            let d = std::env::temp_dir().join(format!(
                "composer-fleet-codex-rollout-test-{}-{tag}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry_for(path: &Path) -> RolloutEntry {
        let meta = std::fs::metadata(path).unwrap();
        RolloutEntry {
            path: path.to_path_buf(),
            session_id: "test-session".into(),
            mtime_ms: 1_700_000_000_000,
            size_bytes: meta.len(),
        }
    }

    fn write_rollout(dir: &TempDir, name: &str, rows: &[&str]) -> std::path::PathBuf {
        let p = dir.0.join(name);
        std::fs::write(&p, format!("{}\n", rows.join("\n"))).unwrap();
        p
    }

    #[test]
    fn end_to_end_reads_head_and_tail() {
        let dir = TempDir::new("e2e");
        let started_t1 = started("t1");
        let p = write_rollout(
            &dir,
            "r.jsonl",
            &[META_LINE, USER_MSG, &started_t1, TOOL_CALL, TOKEN_COUNT],
        );

        let parsed = read_rollout(&entry_for(&p), types::DEFAULT_TAIL_BYTES).unwrap();
        assert_eq!(parsed.meta.cwd, "C:\\proj\\demo");
        assert_eq!(parsed.context_window, Some(258400));

        let d = parsed.digest.expect("应该有 digest");
        assert_eq!(d.git_branch.as_deref(), Some("main"), "分支来自首行");
        assert_eq!(d.context_tokens, Some(88172));
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
        assert!(!d.has_api_error);
        assert_eq!(d.ai_title, None, "标题由 index.rs 另行补入");
    }

    #[test]
    fn a_session_with_only_meta_has_no_digest_but_is_not_an_error() {
        // 刚建的会话：只有 session_meta 一行。这是正常状态，对应前端「未开始」。
        let dir = TempDir::new("meta-only");
        let p = write_rollout(&dir, "r.jsonl", &[META_LINE]);

        let parsed = read_rollout(&entry_for(&p), types::DEFAULT_TAIL_BYTES).unwrap();
        assert!(parsed.digest.is_none());
        assert_eq!(parsed.meta.cli_version, "0.146.0-alpha.9.2");
    }

    #[test]
    fn a_huge_trailing_session_meta_does_not_hide_the_whole_session() {
        // 真机第一次跑就撞上的回归：Codex 会在会话中途重复写 session_meta，
        // 而那一行有 46KB。它正好是最后一行时，64KB 的尾部窗口里除了它什么都
        // 装不下，于是一个 3.7MB 的活跃会话被判成「已启动 · 未开始」。
        //
        // 这个用例的关键是**单行长度必须和窗口同量级**——把 pad 调小就复现不出来，
        // 那也正是手写夹具一直没抓到它的原因。
        // 尺寸是这个用例的全部要害，照着真机实测的比例摆：
        //   窗口 64KB < 文件总大小，且窗口切进来之后，**唯一完整的一行**
        //   是那条 46KB 的 session_meta。
        // filler 用来把真正有内容的几行顶到窗口之外，并让窗口的切入点落在它中间
        // （于是它作为半行被丢弃）。
        let dir = TempDir::new("huge-trailing-meta");
        let pad = "x".repeat(46 * 1024);
        let fat_meta = format!(
            r#"{{"type":"session_meta","payload":{{"cwd":"C:\\proj\\demo","base_instructions":"{pad}"}}}}"#
        );
        let filler = format!(
            r#"{{"type":"world_state","payload":{{"full":true,"blob":"{}"}}}}"#,
            "y".repeat(30 * 1024)
        );
        let started_t1 = started("t1");
        let p = write_rollout(
            &dir,
            "r.jsonl",
            &[
                META_LINE,
                USER_MSG,
                &started_t1,
                TOOL_CALL,
                TOKEN_COUNT,
                &filler,
                // 中途重写的那条巨大 session_meta，落在最后。
                &fat_meta,
            ],
        );

        // 先自证这个夹具确实构成了要复现的形态，否则用例会退化成"随便读读也能过"。
        let total = std::fs::metadata(&p).unwrap().len();
        assert!(
            total > 64 * 1024,
            "夹具必须大于窗口才谈得上切分，实际 {total}"
        );
        let one_shot = tail_lines(&p, 64 * 1024).unwrap();
        assert_eq!(
            one_shot.lines.len(),
            1,
            "64KB 窗口里应当只剩那条巨大的 session_meta"
        );

        let parsed = read_rollout(&entry_for(&p), 64 * 1024).unwrap();
        let d = parsed
            .digest
            .expect("扩窗后应该能找到内容，而不是判成「未开始」");
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(d.context_tokens, Some(88172));
    }

    #[test]
    fn a_file_without_session_meta_is_rejected() {
        let dir = TempDir::new("no-meta");
        let p = write_rollout(&dir, "r.jsonl", &[USER_MSG, AGENT_MSG]);

        let err = read_rollout(&entry_for(&p), types::DEFAULT_TAIL_BYTES).unwrap_err();
        assert!(matches!(err, RolloutError::NoSessionMeta));
    }

    #[test]
    fn a_missing_file_surfaces_io_error() {
        let dir = TempDir::new("missing");
        let entry = RolloutEntry {
            path: dir.0.join("nope.jsonl"),
            session_id: "x".into(),
            mtime_ms: 0,
            size_bytes: 0,
        };
        assert!(matches!(
            read_rollout(&entry, types::DEFAULT_TAIL_BYTES),
            Err(RolloutError::Io(_))
        ));
    }

    #[test]
    fn an_oversized_first_line_degrades_instead_of_loading_it_all() {
        // 首行超过 HEAD_MAX_BYTES：截断 → JSON 解析失败 → NoSessionMeta，
        // 而不是把整个文件读进内存。
        let dir = TempDir::new("huge-head");
        let filler = "x".repeat((HEAD_MAX_BYTES as usize) + 1024);
        let huge = format!(
            r#"{{"type":"session_meta","payload":{{"cwd":"/tmp","pad":"{filler}"}}}}"#
        );
        let p = write_rollout(&dir, "r.jsonl", &[&huge, AGENT_MSG]);

        let err = read_rollout(&entry_for(&p), types::DEFAULT_TAIL_BYTES).unwrap_err();
        assert!(matches!(err, RolloutError::NoSessionMeta));
    }
}
