//! Antigravity 会话采集（E9）。方案见 `docs/agent-fleet-antigravity.md`。
//!
//! 与 Claude Code 侧的分层对应关系：
//!
//! | Claude 侧 | Antigravity 侧 | 说明 |
//! |---|---|---|
//! | [`roster`](super::roster) `sessions/<pid>.json` | **无** | 没有名册，拿不到 pid |
//! | [`transcript`](super::transcript) | [`discover`] + [`trajectory`] | `conversations/<cascadeId>.db` |
//! | [`subagents`](super::subagents) | **无（有样本但只有一个）** | 见下 |
//! | [`jobs`](super::jobs) | **无** | 没有后台会话概念 |
//! | [`proc`](super::proc) | **无** | 没有 pid 就没有进程指标 |
//!
//! ## 这一侧的两个结构性差异
//!
//! 1. **不是一个根目录，是两个**：`~/.gemini/antigravity/` 和
//!    `~/.gemini/antigravity-ide/` 并存且数据同构。所以 [`scan`] 收的是
//!    install 列表，而不是单个目录。
//! 2. **数据是 SQLite**，不是行式文件。所以没有尾部窗口那一套（Codex 侧
//!    `read_rollout` 的 4× 扩窗逻辑在这边完全不需要），
//!    一条 `ORDER BY idx DESC LIMIT` 就拿到尾部。
//!
//! ## subagent 为什么恒空
//!
//! `browser_subagent` 是真实存在的机制，`steps.has_subtrajectory` 也是个显式
//! 标记。但本机 2752 步里只有 **1 步** 是 `has_subtrajectory=1`，
//! 且 `parent_references` 表 18/18 全空——**子轨迹的内容存在哪里根本不知道**。
//!
//! 一个样本推不出树结构。Claude 侧那棵树做得成，是因为有 11 个子 agent 的两层
//! 树可以对着 `meta.json` 的 `spawnDepth` 验证。这边猜一个结构画出一棵假树，
//! 比不画糟得多。所以 `subagents` 恒 `[]`，而 `browser_subagent` 会作为**工具名**
//! 出现在卡片上（那不需要理解树结构，零风险）。

pub mod discover;
pub mod payload;
pub mod trajectory;

use std::path::Path;

use super::types::{
    AgentSession, FleetOptions, FleetWarning, Liveness, Provider, WarningCode,
    ANTIGRAVITY_RETENTION_MS,
};

/// 取路径最后一段作为项目名。
///
/// 同时认 `/` 和 `\`，不走 `Path::file_name()`：cwd 来自库里的字符串，
/// 可能是另一个平台写的。理由同 Codex 侧的同名函数。
fn basename(cwd: &str) -> Option<&str> {
    cwd.rsplit(['/', '\\']).find(|seg| !seg.is_empty())
}

/// install 标识 → 卡片上显示的名字。
fn entrypoint_of(install: &str) -> String {
    match install {
        "antigravity-ide" => "Antigravity IDE".to_string(),
        _ => "Antigravity".to_string(),
    }
}

/// 把一个解析好的会话库组装成 [`AgentSession`]。
///
/// 字段映射见方案 §3。这里没有一处是编造的：拿不到的字段要么有明确的退路，
/// 要么就是 `None`。
fn build_session(entry: discover::DbEntry, parsed: trajectory::TrajectoryParsed) -> AgentSession {
    let cwd = parsed.cwd.clone().unwrap_or_default();

    // name 语义与另两家一致：**这个会话在哪儿干活**（不是会话标题）。
    let name = basename(&cwd)
        .map(String::from)
        // 连 cwd 都没有时退到 id 前 8 位——空串会在列表里留一行看不见的东西。
        .unwrap_or_else(|| entry.cascade_id.chars().take(8).collect());

    AgentSession {
        provider: Provider::Antigravity,
        install: Some(entry.install.clone()),
        // 没有名册就没有 pid。这条路 E1 的后台会话已经趟平。
        pid: None,
        session_id: entry.cascade_id,
        name,
        cwd,
        entrypoint: entrypoint_of(&entry.install),
        // 没有后台会话概念。
        kind: "interactive".to_string(),
        // 优先用文件创建时间；拿不到就退 mtime。
        //
        // ⚠️ 退到 mtime 意味着"启动时间 = 最后活动时间"，界面上算出来的运行
        // 时长会偏短。这是有意的失真——比填 0（界面显示 1970 年）好，也比编
        // 一个数字好。Windows 有创建时间，Linux 上 `created()` 常常不支持。
        started_at: entry.created_ms.unwrap_or(entry.mtime_ms),
        // 落盘里没有版本号。
        cli_version: String::new(),
        liveness: Liveness::NoProcess,
        proc: None,
        transcript: parsed.digest,
        // 见模块头「subagent 为什么恒空」。
        subagents: Vec::new(),
        job: None,
    }
}

/// 扫描 Antigravity 会话。
///
/// 与 Claude 侧 `scan_blocking`、Codex 侧 `codex::scan` 平级：自己完成
/// 发现 → 解析 → 组装，返回可以直接并进 `FleetReport.sessions` 的结果。
///
/// `installs` 是 `(install 标识, install 目录)` 的列表，由
/// [`config::antigravity_installs`](super::config::antigravity_installs) 算出。
/// 目录不存在的 install 会在 [`discover::discover_install`] 里被静默跳过。
pub fn scan(
    installs: &[(String, std::path::PathBuf)],
    opts: &FleetOptions,
    now_ms: i64,
) -> (Vec<AgentSession>, Vec<FleetWarning>) {
    scan_with_retention(installs, opts, now_ms, ANTIGRAVITY_RETENTION_MS)
}

/// [`scan`] 的可注入保留窗口版本。
///
/// 存在的理由是**真机诊断**：本机的会话库常常是几天前的，走默认的 8 小时窗口
/// 会一条都读不出来，于是那个诊断测试就完全验不到解析层
/// （第一版真的这样——18 个库在磁盘上、解析出 0 条，硬断言炸了才发现）。
/// 诊断需要"把磁盘上的全部读一遍"，而保留窗口本身由 discover 的单测覆盖。
///
/// 与 Codex 侧 `discover(dir, now_ms, CODEX_RETENTION_MS)` 把窗口作为参数
/// 传入是同一个路子。
pub fn scan_with_retention(
    installs: &[(String, std::path::PathBuf)],
    _opts: &FleetOptions,
    now_ms: i64,
    retention_ms: i64,
) -> (Vec<AgentSession>, Vec<FleetWarning>) {
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();

    for (install, dir) in installs {
        let (s, w) = scan_install(install, dir, now_ms, retention_ms);
        sessions.extend(s);
        warnings.extend(w);
    }

    (sessions, warnings)
}

fn scan_install(
    install: &str,
    install_dir: &Path,
    now_ms: i64,
    retention_ms: i64,
) -> (Vec<AgentSession>, Vec<FleetWarning>) {
    let found = discover::discover_install(install, install_dir, now_ms, retention_ms);
    let mut warnings = found.warnings;
    let mut sessions = Vec::with_capacity(found.entries.len());

    for entry in found.entries {
        match trajectory::read_trajectory(&entry) {
            Ok(parsed) => sessions.push(build_session(entry, parsed)),
            Err(trajectory::TrajectoryError::NoSteps) => {
                warnings.push(FleetWarning::new(
                    WarningCode::AntigravityDbUnparsable,
                    format!("{} 的会话库里没有可用的 steps 表", entry.cascade_id),
                ));
            }
            Err(trajectory::TrajectoryError::Open(e)) => {
                warnings.push(FleetWarning::new(
                    WarningCode::AntigravityDbUnreadable,
                    // 只带 id 和错误种类，不带路径全文——同其余各层的脱敏口径。
                    format!(
                        "打开 Antigravity 会话 {} 失败：{}",
                        entry.cascade_id,
                        kind_of(&e)
                    ),
                ));
            }
        }
    }

    (sessions, warnings)
}

/// rusqlite 的错误转成一个短标签。
///
/// 不用 `to_string()`：那会把**完整文件路径**拼进 detail，而 warning 是要进
/// IPC 给前端显示的。其余各层的口径都是"只带文件名/错误种类，不带内容和全路径"。
fn kind_of(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(err, _) => format!("SQLite 错误码 {}", err.extended_code),
        _ => "无法打开".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("C:\\proj\\demo"), Some("demo"));
        assert_eq!(basename("c:/Users/me/work"), Some("work"));
        assert_eq!(basename("c:/Users/me/work/"), Some("work"));
        assert_eq!(basename(""), None);
        assert_eq!(basename("/"), None);
    }

    #[test]
    fn entrypoint_distinguishes_the_two_channels() {
        assert_eq!(entrypoint_of("antigravity"), "Antigravity");
        assert_eq!(entrypoint_of("antigravity-ide"), "Antigravity IDE");
    }

    fn entry(install: &str, id: &str, with_birthtime: bool) -> discover::DbEntry {
        discover::DbEntry {
            path: std::path::PathBuf::from("x.db"),
            install: install.to_string(),
            cascade_id: id.to_string(),
            mtime_ms: 1_785_416_160_000,
            created_ms: if with_birthtime {
                Some(1_785_416_000_000)
            } else {
                None
            },
            size_bytes: 827_392,
        }
    }

    #[test]
    fn name_comes_from_cwd_basename() {
        let p = trajectory::TrajectoryParsed {
            cwd: Some("c:/Users/me/Desktop/my-proj".into()),
            ..Default::default()
        };
        let s = build_session(
            entry("antigravity", "abcdef12-0000-0000-0000-000000000000", true),
            p,
        );
        assert_eq!(s.name, "my-proj");
        assert_eq!(s.install.as_deref(), Some("antigravity"));
        assert_eq!(s.provider, Provider::Antigravity);
    }

    #[test]
    fn name_falls_back_to_id_prefix_when_there_is_no_cwd() {
        // 实测 8/18 个会话是 outside-of-project，可能连 Cwd 都没有。
        // 卡片抬头不能是空串。
        let s = build_session(
            entry("antigravity", "5fa07317-769c-4b99-b2b2-3ed8f027a75a", false),
            trajectory::TrajectoryParsed::default(),
        );
        assert_eq!(s.name, "5fa07317");
        assert!(!s.name.is_empty());
    }

    #[test]
    fn started_at_falls_back_to_mtime_when_birthtime_is_unavailable() {
        // Linux 上 created() 常常返回 Unsupported。退 mtime 而不是 0——
        // 0 会在界面上显示成 1970 年。
        let s = build_session(
            entry("antigravity", "abcdef12-0000-0000-0000-000000000000", false),
            trajectory::TrajectoryParsed::default(),
        );
        assert_eq!(s.started_at, 1_785_416_160_000);
    }

    #[test]
    fn no_process_fields_are_consistently_absent() {
        // 没有名册 → 这四样必须一起缺，缺一半会让前端显示出矛盾的卡片。
        let s = build_session(
            entry("antigravity-ide", "abcdef12-0000-0000-0000-000000000000", true),
            trajectory::TrajectoryParsed::default(),
        );
        assert_eq!(s.pid, None);
        assert!(s.proc.is_none());
        assert_eq!(s.liveness, Liveness::NoProcess);
        assert!(s.subagents.is_empty());
        assert!(s.job.is_none());
    }

    #[test]
    fn scanning_a_missing_install_is_quiet() {
        let installs = vec![
            (
                "antigravity".to_string(),
                std::path::PathBuf::from("C:\\nope\\a"),
            ),
            (
                "antigravity-ide".to_string(),
                std::path::PathBuf::from("C:\\nope\\b"),
            ),
        ];
        let (sessions, warnings) = scan(&installs, &FleetOptions::default(), 0);
        assert!(sessions.is_empty());
        assert!(warnings.is_empty(), "没装 Antigravity 不该刷 warning");
    }
}
