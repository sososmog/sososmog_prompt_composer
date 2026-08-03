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
pub mod rollout;
