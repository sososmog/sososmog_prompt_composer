//! Agent Fleet 采集层：扫描本机在跑的 Claude Code 会话，供浮窗的 Agent tab 展示。
//!
//! 完整方案见 `docs/agent-fleet.md`。要点复述：
//!
//! - **定位是观察者**：只读，不 spawn、不终止、不拦权限。
//! - **在 `~/.claude` 里零脚印**：不写文件、不注册 hook、不改 settings.json。
//!   我们挂掉了 Claude Code 毫无感知（对比 Clawd on Desk 的教训：它的阻塞式权限
//!   hook 在 daemon 挂掉时会让 Claude Code 直接拒绝工具调用）。
//! - **数据层放 Rust 而非前端**的两个理由：①进程存活校验和 CPU 采样只能在这边做；
//!   ②前端直接读 `~/.claude` 就得把 fs 插件权限放宽到那个目录，放这边一行 ACL 都不用加。
//!
//! ## 分层
//!
//! | 层 | 模块 | 数据源 |
//! |----|------|--------|
//! | L1 会话发现 | [`roster`] | `$CONFIG/sessions/<pid>.json` |
//! | L2 活动与内容 | [`transcript`] | `$CONFIG/projects/<slug>/<sid>.jsonl` 尾部 |
//! | L3 subagent 树 | `subagents`（阶段 2） | `<sid>/subagents/agent-*.{jsonl,meta.json}` |
//! | L4 后台会话 | `jobs`（阶段 4） | `$CONFIG/jobs/<id>/state.json` |
//! | L5 进程指标 | [`proc`] | sysinfo，只刷 L1 拿到的 pid |
//!
//! ## 当前进度
//!
//! P4（契约冻结）：[`types`] 已定稿，[`config`] 已实现，命令是**返回空列表的 stub**。
//! 采集逻辑由 A 轨（A2–A7）填入。

pub mod config;
pub mod transcript;
pub mod types;

use std::time::{SystemTime, UNIX_EPOCH};
use types::{FleetOptions, FleetReport, FleetWarning, WarningCode, SCHEMA_VERSION};

/// 当前时刻的 ms epoch。整个采集层的时间基准，前端算 age 也用它。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 扫描本机在跑的 agent 会话。
///
/// **必须是 `async`**：Tauri v2 的同步命令跑在主线程，而这里有文件 I/O 和 sysinfo
/// 刷新，同步版会卡住浮窗 UI。真正阻塞的部分要用
/// `tauri::async_runtime::spawn_blocking` 包起来（A 轨接入采集逻辑时补）。
///
/// 失败语义：**只有"连配置目录都定位不出来"这类彻底没法干活的情况才返回 `Err`**。
/// 单个会话/单个文件的问题一律降级成 `warnings` 里的一条，其余照常返回——
/// 一个会话读不出 transcript 不该让整个 tab 空掉。
#[tauri::command]
pub async fn list_agent_sessions(
    app: tauri::AppHandle,
    opts: Option<FleetOptions>,
) -> Result<FleetReport, String> {
    // 选项目前还没有采集逻辑消费，A 轨接入后即用。
    let _opts = opts.unwrap_or_default();

    let scanned_at = now_ms();
    let mut warnings: Vec<FleetWarning> = Vec::new();

    let config_dir = match config::resolve(&app) {
        Some(dir) => {
            if !dir.is_dir() {
                warnings.push(FleetWarning::new(
                    WarningCode::NoConfigDir,
                    format!("配置目录不存在：{}", dir.display()),
                ));
            }
            dir.to_string_lossy().into_owned()
        }
        None => {
            warnings.push(FleetWarning::new(
                WarningCode::NoConfigDir,
                "既没有 CLAUDE_CONFIG_DIR，也拿不到 home 目录",
            ));
            String::new()
        }
    };

    Ok(FleetReport {
        schema_version: SCHEMA_VERSION,
        scanned_at,
        config_dir,
        sessions: Vec::new(),
        warnings,
    })
}
