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
//! | L3 subagent 树 | [`subagents`] | `<sid>/subagents/agent-*.{jsonl,meta.json}` |
//! | L4 后台会话 | `jobs`（阶段 4，未实现） | `$CONFIG/jobs/<id>/state.json` |
//! | L5 进程指标 | [`proc`] | sysinfo，只刷 L1 拿到的 pid |
//!
//! 本文件是**编排层**：把上面几层拼成一份 [`types::FleetReport`]。各层自己不知道
//! 彼此的存在，拼装规则集中在这里，好让"哪个失败该降级成什么"只有一处定义。

pub mod config;
pub mod proc;
pub mod roster;
pub mod subagents;
pub mod transcript;
pub mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use types::{
    AgentSession, FleetOptions, FleetReport, FleetWarning, Liveness, ProcMetrics, WarningCode,
    SCHEMA_VERSION,
};

/// 当前时刻的 ms epoch。整个采集层的时间基准，前端算 age 也用它。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 跨命令调用长期持有的状态。
///
/// 有两样东西**必须**跨调用保留，否则功能不成立：
/// - CPU 采样器的"上一次基准"：差值算法本质有状态（见 [`proc`] 模块注释）。
/// - transcript 路径缓存：定位一个 sessionId 的 jsonl 要遍历 `projects/` 下的所有
///   项目目录（本机 16 个），而一个会话的 jsonl 路径在其生命周期内不会变，
///   每次轮询都重新遍历纯属浪费。
pub struct FleetState {
    sampler: proc::CpuSampler,
    /// sessionId → jsonl 路径。复用前会 `exists()` 校验，所以文件被删/搬走
    /// 不会一直命中一个死路径。
    transcript_paths: Mutex<HashMap<String, PathBuf>>,
}

impl Default for FleetState {
    fn default() -> Self {
        Self::new()
    }
}

impl FleetState {
    pub fn new() -> Self {
        Self {
            sampler: proc::CpuSampler::new(),
            transcript_paths: Mutex::new(HashMap::new()),
        }
    }

    /// 带缓存地定位 transcript。缓存未命中或已失效时才真正去遍历目录。
    fn resolve_transcript(&self, config_dir: &Path, session_id: &str) -> Option<PathBuf> {
        // 锁中毒不该让整个功能瘫掉——退化成"这次不用缓存"即可。
        let mut cache = self
            .transcript_paths
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(cached) = cache.get(session_id) {
            if cached.is_file() {
                return Some(cached.clone());
            }
            // 缓存里的路径已经不在了（文件被删、配置目录被搬走）——清掉重新找，
            // 而不是一直返回一个死路径。
            cache.remove(session_id);
        }

        let found = transcript::find_transcript(config_dir, session_id)?;
        cache.insert(session_id.to_string(), found.clone());
        Some(found)
    }
}

/// 一次完整扫描。所有阻塞 I/O 都在这个函数里，由调用方放进 `spawn_blocking`。
fn scan_blocking(
    state: &FleetState,
    config_dir: &Path,
    opts: &FleetOptions,
) -> (Vec<AgentSession>, Vec<FleetWarning>) {
    let scan = roster::scan(config_dir);
    let mut warnings = scan.warnings;

    if scan.entries.is_empty() {
        return (Vec::new(), warnings);
    }

    // 进程采样必须做，哪怕 opts.cpu 是 false —— 存活校验要用 start_time，
    // 而拿 start_time 就得刷进程。`opts.cpu` 只决定**要不要把百分比报出去**，
    // 省不掉这次刷新。（诚实地说：这个开关的实际节省很小，真正的开销是下面
    // 逐个会话读 transcript 尾部。控制成本主要靠前端的轮询分档，不是靠这个开关。）
    let pids: Vec<u32> = scan.entries.iter().map(|e| e.pid).collect();
    let samples = state.sampler.sample(&pids);

    let mut sessions = Vec::with_capacity(scan.entries.len());

    for entry in scan.entries {
        let sample = samples.get(&entry.pid);

        let liveness = match proc::check_liveness(sample, entry.started_at) {
            // 进程已经没了：roster 文件是残留。静默跳过——这是常态，
            // 不值得为它产 warning（用户不关心"刚才有个会话退出了"）。
            proc::LivenessCheck::Dead => continue,
            proc::LivenessCheck::PidReused => {
                // 这个反而要报：前端会把它过滤掉不显示，用户可能正奇怪
                // "我明明开着一个会话怎么没出现"，warning 是唯一的线索。
                warnings.push(FleetWarning::new(
                    WarningCode::PidReused,
                    format!(
                        "pid {} 的启动时间与名册记录不符，疑似已被其它进程复用",
                        entry.pid
                    ),
                ));
                Liveness::PidReused
            }
            proc::LivenessCheck::Alive => Liveness::Alive,
        };

        // proc 指标：opts.cpu 为 false 时整块不报。
        //
        // 注意 `proc: None` 和 `proc: Some { cpu_percent: None }` 是两件不同的事，
        // 契约刻意留了这个区分：前者是"没采（开关关了）或进程没了"，后者是
        // "内存和运行时长采到了，只有 CPU 还缺基准"。首次扫描属于后者。
        let proc_metrics = if opts.cpu() {
            sample.map(|s| ProcMetrics {
                cpu_percent: s.cpu_percent,
                memory_mb: s.memory_mb,
                run_time_sec: s.run_time_sec,
            })
        } else {
            None
        };

        // L2：定位并读 transcript 尾部。
        //
        // 三种"没有 digest"的情况要分清，只有一种算异常：
        //   ①根本没有 jsonl        → 已启动未开始，**实测最常见的正常状态**，不报
        //   ②jsonl 存在但 0 字节    → 同上，也是刚启动，不报
        //   ③读不了 / 解析不出来    → 真异常，报 warning，前端显示"状态未知"
        let mut transcript_digest = None;
        // L3：本会话的 subagent 摘要。默认空数组——`opts.include_subagents()`
        // 关掉、或者压根没有 transcript 时都停在这个默认值上。
        let mut subagents = Vec::new();
        if let Some(path) = state.resolve_transcript(config_dir, &entry.session_id) {
            let is_empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(false);
            if !is_empty {
                match transcript::read_digest(&path, opts.tail_bytes()) {
                    Ok(d) => transcript_digest = Some(d),
                    Err(transcript::DigestError::Unparsable) => {
                        warnings.push(FleetWarning::new(
                            WarningCode::TranscriptUnparsable,
                            format!("{} 的尾部窗口里没有可解析的消息", entry.session_id),
                        ));
                    }
                    Err(transcript::DigestError::Io(e)) => {
                        warnings.push(FleetWarning::new(
                            WarningCode::TranscriptUnreadable,
                            format!("读取 {} 的会话记录失败：{}", entry.session_id, e.kind()),
                        ));
                    }
                }
            }

            // subagents_dir 从 transcript 路径的父目录推导，而不是再遍历一遍
            // `projects/`——transcript 路径已经被 `resolve_transcript` 缓存过，
            // 它的父目录就是项目目录。这条推导同时天然覆盖了「没有 transcript
            // 的会话」：那种会话（已启动未开始）必然也没有子 agent，走不进这个
            // `if let Some(path) = ...`分支，`subagents` 就停在上面的空数组默认值，
            // 不需要再单独判一次「目录不存在」。
            if opts.include_subagents() {
                if let Some(project_dir) = path.parent() {
                    let subagents_dir = project_dir.join(&entry.session_id).join("subagents");
                    let sub_scan = subagents::scan(&subagents_dir, opts.tail_bytes());
                    subagents = sub_scan.digests;
                    warnings.extend(sub_scan.warnings);
                }
            }
        }

        sessions.push(AgentSession {
            pid: entry.pid,
            session_id: entry.session_id,
            name: entry.name,
            cwd: entry.cwd,
            entrypoint: entry.entrypoint,
            kind: entry.kind,
            started_at: entry.started_at,
            cli_version: entry.cli_version,
            liveness,
            proc: proc_metrics,
            transcript: transcript_digest,
            subagents,
            // L4 由阶段 4 填。契约里已经留好位置，前端现在拿到的就是 null，
            // 渲染逻辑不需要为此改动。
            job: None,
        });
    }

    (sessions, warnings)
}

/// 扫描本机在跑的 agent 会话。
///
/// **必须是 `async`**：Tauri v2 的同步命令跑在主线程，而这里有文件 I/O 和 sysinfo
/// 刷新，同步版会卡住浮窗 UI。真正阻塞的部分放在 `spawn_blocking` 里，
/// 所以这个 `async fn` 本身不占用异步运行时的工作线程去做阻塞活。
///
/// 失败语义：**只有"连配置目录都定位不出来"这类彻底没法干活的情况才返回 `Err`**。
/// 单个会话/单个文件的问题一律降级成 `warnings` 里的一条，其余照常返回——
/// 一个会话读不出 transcript 不该让整个 tab 空掉。
#[tauri::command]
pub async fn list_agent_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<FleetState>>,
    opts: Option<FleetOptions>,
) -> Result<FleetReport, String> {
    let opts = opts.unwrap_or_default();
    let scanned_at = now_ms();

    // 配置目录解析只是读环境变量 + 拼路径，不值得进 spawn_blocking。
    let resolved = config::resolve(&app);

    let (config_dir_display, dir_for_scan, mut warnings) = match resolved {
        Some(dir) if dir.is_dir() => (dir.to_string_lossy().into_owned(), Some(dir), Vec::new()),
        Some(dir) => {
            let display = dir.to_string_lossy().into_owned();
            (
                display.clone(),
                None,
                vec![FleetWarning::new(
                    WarningCode::NoConfigDir,
                    format!("配置目录不存在：{display}"),
                )],
            )
        }
        None => (
            String::new(),
            None,
            vec![FleetWarning::new(
                WarningCode::NoConfigDir,
                "既没有 CLAUDE_CONFIG_DIR，也拿不到 home 目录".to_string(),
            )],
        ),
    };

    let mut sessions = Vec::new();
    if let Some(dir) = dir_for_scan {
        // Arc clone 进 spawn_blocking —— `State<'_, _>` 是借用的，不能直接 move，
        // 所以托管的是 Arc<FleetState> 而不是 FleetState。
        let st = state.inner().clone();
        let joined = tauri::async_runtime::spawn_blocking(move || scan_blocking(&st, &dir, &opts))
            .await
            .map_err(|e| format!("采集线程异常退出：{e}"))?;
        sessions = joined.0;
        warnings.extend(joined.1);
    }

    Ok(FleetReport {
        schema_version: SCHEMA_VERSION,
        scanned_at,
        config_dir: config_dir_display,
        sessions,
        warnings,
    })
}

/// 应用启动时预热 CPU 基准。
///
/// CPU 百分比要两次采样才算得出来，不预热的话用户第一次打开 Agent tab
/// 看到的全是 0%（伴随一条"首次采样"的 warning），要等下一轮才有真数字。
/// 放后台线程，因为它做文件 I/O 和进程刷新，不能拖慢启动。
pub fn spawn_cpu_prewarm(app: tauri::AppHandle, state: Arc<FleetState>) {
    std::thread::spawn(move || {
        let Some(dir) = config::resolve(&app) else {
            return;
        };
        if !dir.is_dir() {
            return;
        }
        let pids: Vec<u32> = roster::scan(&dir).entries.iter().map(|e| e.pid).collect();
        if !pids.is_empty() {
            state.sampler.prime(&pids);
        }
    });
}
