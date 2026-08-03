//! Codex 会话采集（E4）。方案见 `docs/agent-fleet-codex.md`。
//!
//! 与 Claude Code 侧的分层对应关系：
//!
//! | Claude 侧 | Codex 侧 | 说明 |
//! |---|---|---|
//! | [`roster`](super::roster) `sessions/<pid>.json` | **无** | Codex 没有名册，拿不到 pid |
//! | [`transcript`](super::transcript) `projects/<slug>/<sid>.jsonl` | [`discover`] + [`rollout`] | `sessions/YYYY/MM/DD/rollout-*.jsonl` |
//! | [`subagents`](super::subagents) | **无** | 本机找不到落盘目录，恒空 |
//! | [`jobs`](super::jobs) | **无** | Codex 暂无对应物 |
//! | [`proc`](super::proc) | **无** | 没有 pid 就没有进程指标 |
//!
//! 「没有名册」是这一侧最大的结构性差异，后果是 `pid: None`、
//! `liveness: no-process`、`proc: None`。这条路 E1（后台会话）已经趟平了，
//! 契约不用为 Codex 再改一次。**不要试图靠进程名 + cwd 去反推 pid**——
//! 被否决的理由记在方案文档 §8。

pub mod discover;
pub mod index;
pub mod rollout;

use std::path::Path;

use super::types::{
    self, AgentSession, FleetOptions, FleetWarning, Liveness, Provider, WarningCode,
};

/// 取路径最后一段作为项目名。
///
/// 同时认 `/` 和 `\`，不走 `Path::file_name()`：cwd 是从 JSON 里读来的字符串，
/// 可能是另一个平台写的（Windows 上的 Codex 写 `C:\a\b`，而这份数据将来完全
/// 可能在 macOS 上被读到），`Path` 只认当前平台的分隔符。
fn basename(cwd: &str) -> Option<&str> {
    cwd.rsplit(['/', '\\']).find(|seg| !seg.is_empty())
}

/// 把一个解析好的 rollout 组装成 [`AgentSession`]。
///
/// 字段映射见 `docs/agent-fleet-codex.md` §3。这里没有一处是编造的：
/// 拿不到的字段要么有明确的退路，要么就是 `None`。
fn build_session(
    entry: discover::RolloutEntry,
    parsed: rollout::RolloutParsed,
    titles: &std::collections::HashMap<String, String>,
) -> AgentSession {
    let meta = parsed.meta;

    // name 对应 Claude 侧名册里的"项目名"（如 `demo-proj-18`），语义是
    // **这个会话在哪儿干活**，所以取 cwd 的最后一段——而不是会话标题。
    // 会话标题是另一个字段（ai_title），两者在卡片上各占一行。
    let name = basename(&meta.cwd)
        .map(String::from)
        // 连 cwd 都没有时退到 id 前 8 位：卡片总得有个能认出来的抬头，
        // 而空串会让列表里出现一行看不见的东西。
        .unwrap_or_else(|| entry.session_id.chars().take(8).collect());

    // 会话标题来自 session_index.jsonl。查不到很正常（那个索引不全），
    // 前端对 aiTitle 为 null 已有处理（显示最后一条提问）。
    let ai_title = titles.get(&entry.session_id).cloned();

    let entrypoint = match &meta.source {
        Some(src) if !src.is_empty() => format!("{} / {}", meta.originator, src),
        _ => meta.originator.clone(),
    };

    let digest = parsed.digest.map(|mut d| {
        d.ai_title = ai_title;
        d
    });

    AgentSession {
        provider: Provider::Codex,
        // 没有名册就没有 pid。这条路 E1 的后台会话已经趟平，见 types.rs。
        pid: None,
        // 以**文件名里的 id** 为准而不是 session_meta 里的：文件名是我们发现
        // 这个会话的依据，两者不一致时（实测没见过）用后者会让同一个会话在
        // 两轮扫描间换 id，前端 keyed 更新会把卡片整个重建。
        session_id: entry.session_id,
        name,
        cwd: meta.cwd,
        entrypoint,
        // Codex 暂无后台会话概念（没有 jobs/ 的对应物）。
        kind: "interactive".to_string(),
        // 拿不到起始时间时退到 mtime——不是 0。0 会在界面上显示成 1970 年，
        // 而 mtime 至少是个真实发生过的时刻。
        started_at: meta.started_at.unwrap_or(entry.mtime_ms),
        cli_version: meta.cli_version,
        liveness: Liveness::NoProcess,
        proc: None,
        transcript: digest,
        // 本机找不到 Codex 的 subagent 落盘目录，恒空。见方案 §1.5。
        subagents: Vec::new(),
        job: None,
    }
}

/// 扫描 Codex 会话。
///
/// 与 Claude 侧 `scan_blocking` 平级：自己完成发现 → 解析 → 组装，
/// 返回可以直接并进 `FleetReport.sessions` 的结果。
pub fn scan(
    codex_dir: &Path,
    opts: &FleetOptions,
    now_ms: i64,
) -> (Vec<AgentSession>, Vec<FleetWarning>) {
    let found = discover::discover(codex_dir, now_ms, types::CODEX_RETENTION_MS);
    let mut warnings = found.warnings;

    // 索引只读一次，不是每个会话读一遍。
    let titles = index::load_titles(codex_dir);

    let mut sessions = Vec::with_capacity(found.entries.len());
    for entry in found.entries {
        match rollout::read_rollout(&entry, opts.tail_bytes()) {
            Ok(parsed) => sessions.push(build_session(entry, parsed, &titles)),
            Err(rollout::RolloutError::NoSessionMeta) => {
                warnings.push(FleetWarning::new(
                    WarningCode::CodexRolloutUnparsable,
                    format!("{} 的首行不是可用的 session_meta", entry.session_id),
                ));
            }
            Err(rollout::RolloutError::Io(e)) => {
                warnings.push(FleetWarning::new(
                    WarningCode::CodexRolloutUnreadable,
                    format!("读取 Codex 会话 {} 失败：{}", entry.session_id, e.kind()),
                ));
            }
        }
    }

    (sessions, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_handles_both_separators_and_trailing_slashes() {
        assert_eq!(basename("C:\\proj\\demo"), Some("demo"));
        assert_eq!(basename("/home/me/work"), Some("work"));
        assert_eq!(basename("C:\\proj\\demo\\"), Some("demo"), "尾部分隔符要跳过");
        assert_eq!(basename("demo"), Some("demo"));
        assert_eq!(basename(""), None);
        assert_eq!(basename("/"), None);
    }
}
