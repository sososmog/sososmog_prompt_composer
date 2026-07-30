
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use sysinfo::{CpuRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// 两次采样之间的最小间隔（毫秒）。低于这个值直接判"间隔过短"、返回 `None`，
/// 且**不更新基准**——差值算法是 `Δcpu / Δwall`，Δwall 太小时，调度抖动带来的
/// 几毫秒误差换算成百分比会被放大成离谱的数字（比如 20ms 内偶然多记 5ms CPU
/// 时间，算出来是 25%）。sysinfo 自己的 `MINIMUM_CPU_UPDATE_INTERVAL` 是 200ms
/// （用于它内部 `cpu_usage()` 的节流缓存，我们不用那个 API），这里按同一个
/// 心智模型收紧到 100ms。
const MIN_SAMPLE_INTERVAL_MS: u128 = 100;

/// 存活校验的时间容差（秒）。
///
/// 进程一定先启动、Claude Code 才会在之后把 `startedAt` 写进 roster 文件，
/// 所以理论上 `proc_start <= session_started`。但两者来自不同的时钟读取点
/// （sysinfo 的 `start_time()` 对齐的是内核记录的进程创建时间；roster 里的
/// `startedAt` 是 Claude Code 自己 `Date.now()` 之后才落盘），中间还隔着落盘的
/// 调度延迟，实测会有几秒到几十秒的偏差。±120s 是刻意放宽的值：宁可放过真正的
/// PID 复用（需要在 120s 内旧进程退出、系统把同一个 pid 分配给新进程、新进程
/// 恰好也在跑 claude.exe，概率很低），也不要把正常会话误判成 `pid-reused`
/// 从而把它从列表里剔除。
pub const LIVENESS_TOLERANCE_SECS: i64 = 120;

/// 单个进程一次采样的结果。
#[derive(Debug, Clone, Copy)]
pub struct ProcSample {
    /// `None` = 本次拿不到——首次采样（还没有上一次的基准）或两次采样间隔过短。
    /// 调用方据此在 UI 上显示 "—" 而不是 0%（0% 是一个具体的、可能误导人的数值）。
    pub cpu_percent: Option<f32>,
    pub memory_mb: u64,
    pub run_time_sec: u64,
    /// UNIX 秒。给 [`check_liveness`] 用，判断 pid 是否被系统回收复用。
    pub start_time_secs: u64,
}

/// 自包含的 CPU/内存采样器。
///
/// 持有长生命周期的 `System` 和"上一次采样"的基准表——CPU 差值算法本质上是
/// 有状态的，这个状态必须跨越多次命令调用保留，所以编排层要把它放进
/// `FleetState`，整个应用生命周期只建一次。
pub struct CpuSampler {
    sys: Mutex<System>,
    /// 逻辑核心数，归一化 CPU 百分比的分母。构造时刷一次拿到，运行期不再变化
    /// （不处理"运行中插拔 CPU"这种边缘场景，不值得为它每次都重新刷新核心表）。
    ncpu: usize,
    /// pid → (上次采样时的 accumulated_cpu_time 毫秒数, 采样时刻)。
    prev: Mutex<HashMap<u32, (u64, Instant)>>,
}

impl Default for CpuSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl CpuSampler {
    pub fn new() -> Self {
        let mut sys = System::new();
        // P3 实测坑：`System::new()` 之后 `cpus()` 是空的，不先刷一次 CPU 列表，
        // 下面 `cpus().len()` 就是 0，归一化时会直接除以 0。
        sys.refresh_cpu_list(CpuRefreshKind::nothing());
        // `.max(1)` 是防御性兜底：正常机器上 `cpus().len()` 不可能是 0，
        // 但"绝不能除 0"这条规则比"这条件理论上不会发生"更值得写死。
        let ncpu = sys.cpus().len().max(1);

        Self {
            sys: Mutex::new(sys),
            ncpu,
            prev: Mutex::new(HashMap::new()),
        }
    }

    /// 只填基准、不关心结果，供应用启动时的预热线程用——避免用户第一次打开
    /// Agent tab 就看到所有 CPU 都是 "—"（首次采样必然拿不到百分比）。
    pub fn prime(&self, pids: &[u32]) {
        let _ = self.sample(pids);
    }

    /// 对给定的一组 pid 采样。
    ///
    /// 查不到的 pid（已退出 / 从未存在）**不会出现在返回的 map 里**——调用方
    /// 用"这个 pid 在不在 map 里"判断进程是否还活着，而不是塞一个哨兵值进去。
    pub fn sample(&self, pids: &[u32]) -> HashMap<u32, ProcSample> {
        let mut result = HashMap::new();
        if pids.is_empty() {
            return result;
        }

        let sysinfo_pids: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();

        let mut sys = self.sys.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 只刷关心的 pid。P3 实测：`remove_dead_processes:true` 配
        // `ProcessesToUpdate::Some(&pids)` **不会**清掉没被刷新的进程（510 个
        // 全部残留），所以 `processes()` 的整体内容不可信，任何判断都只能按
        // pid 单查，这里也确实只调用了 `sys.process(pid)`，从不遍历
        // `sys.processes()`。
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&sysinfo_pids),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        let now = Instant::now();
        let mut prev = self.prev.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        for &pid in pids {
            let Some(p) = sys.process(Pid::from_u32(pid)) else {
                // 进程查不到：可能刚退出，也可能 roster 文件本来就是残留。
                // 不插入 result，调用方据此判死；同时也不清 prev——如果同一个
                // pid 之后被复用，我们希望旧基准仍然存在从而在 acc 变小时触发
                // 下面的 saturating_sub 归零，而不是巧合地拿一个"干净"的起点。
                continue;
            };

            let acc_now = p.accumulated_cpu_time();
            let memory_mb = p.memory() / 1024 / 1024;
            let run_time_sec = p.run_time();
            let start_time_secs = p.start_time();

            let mut cpu_percent = None;
            let mut update_baseline = true;

            if let Some(&(acc_prev, t_prev)) = prev.get(&pid) {
                let wall_ms = now.duration_since(t_prev).as_millis();
                if wall_ms < MIN_SAMPLE_INTERVAL_MS {
                    // 间隔太短：这次不产出百分比，也不更新基准——留着上一次的
                    // 基准给下一次用，凑够一个有意义的采样窗口。
                    update_baseline = false;
                } else {
                    // pid 被复用时新进程的 acc 可能比旧记录还小，saturating_sub
                    // 让它归零而不是 underflow 溢出成一个巨大的数。
                    let cpu_ms = acc_now.saturating_sub(acc_prev) as f64;
                    let pct = (cpu_ms / wall_ms as f64 * 100.0 / self.ncpu as f64) as f32;
                    // clamp 吸收采样抖动（理论上不该超过 100%，但差分算法在
                    // 边界条件下可能有一点点越界）。
                    cpu_percent = Some(pct.clamp(0.0, 100.0));
                }
            }
            // `prev` 里没有这个 pid 时上面的 `if let` 落空，`cpu_percent` 保持
            // `None`（首次采样没有基准），但 `update_baseline` 保持默认的
            // `true`——必须把这次的 (acc_now, now) 记下来，否则永远拿不到基准。

            if update_baseline {
                prev.insert(pid, (acc_now, now));
            }

            result.insert(
                pid,
                ProcSample {
                    cpu_percent,
                    memory_mb,
                    run_time_sec,
                    start_time_secs,
                },
            );
        }

        result
    }
}

/// 存活校验结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessCheck {
    Alive,
    /// pid 存在，但启动时间与 roster 记录的 `startedAt` 对不上——疑似系统把
    /// 这个 pid 回收后分配给了别的进程。
    PidReused,
    /// sysinfo 查不到这个 pid，roster 文件是残留。
    Dead,
}

/// 用进程启动时间校验 roster 记录是否仍然对应同一个进程。
///
/// 为什么不按进程名校验：实测 Windows 上 CLI 是 `claude.exe`，而 Claude 桌面版
/// （Electron）**也叫** `Claude.exe`，还带 9 个子进程；macOS 上进程名甚至显示
/// 成版本号（如 `2.0.53`）。名字完全靠不住，启动时间才是可靠的锚点。
pub fn check_liveness(sample: Option<&ProcSample>, roster_started_at_ms: i64) -> LivenessCheck {
    let Some(sample) = sample else {
        return LivenessCheck::Dead;
    };

    let session_started_secs = roster_started_at_ms.div_euclid(1000);
    let proc_start_secs = sample.start_time_secs as i64;

    if (proc_start_secs - session_started_secs).abs() <= LIVENESS_TOLERANCE_SECS {
        LivenessCheck::Alive
    } else {
        LivenessCheck::PidReused
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    /// 在后台烧 CPU 一段时间，让 `accumulated_cpu_time()` 有非零差值可采。
    /// 写法照抄 `tests/sysinfo_probe.rs` 的 `burn_cpu_for`——两边各自独立编译
    /// （集成测试 crate 与 lib 单测不共享代码），保持一份小重复比额外抽公共
    /// 测试工具 crate 更简单。
    fn burn_cpu_for(dur: Duration) -> thread::JoinHandle<u64> {
        thread::spawn(move || {
            let deadline = Instant::now() + dur;
            let mut acc: u64 = 0;
            while Instant::now() < deadline {
                for i in 0..50_000u64 {
                    acc = acc.wrapping_add(i.wrapping_mul(2_654_435_761));
                }
            }
            acc
        })
    }

    #[test]
    fn new_gets_a_positive_core_count() {
        let sampler = CpuSampler::new();
        assert!(sampler.ncpu > 0, "ncpu 必须 > 0，否则归一化会除以 0");
    }

    #[test]
    fn first_sample_has_no_baseline_then_burning_cpu_produces_a_reading() {
        let sampler = CpuSampler::new();
        let pid = std::process::id();

        let first = sampler.sample(&[pid]);
        assert!(first.contains_key(&pid), "当前测试进程自己必须能采到");
        assert!(
            first[&pid].cpu_percent.is_none(),
            "首次采样没有基准，必须是 None"
        );

        // 烧一点 CPU，制造 accumulated_cpu_time 的差值。
        let burner = burn_cpu_for(Duration::from_millis(400));
        thread::sleep(Duration::from_millis(300));
        let _ = burner.join();

        let second = sampler.sample(&[pid]);
        let pct = second[&pid]
            .cpu_percent
            .expect("烧过 CPU、间隔也够长之后应该有读数");
        assert!(
            (0.0..=100.0).contains(&pct),
            "归一化后的 CPU 百分比越界: {pct}"
        );
    }

    #[test]
    fn unknown_pid_is_absent_from_the_result_map() {
        let sampler = CpuSampler::new();
        // 与 sysinfo_probe.rs 用的同一个"几乎不可能存在"的 pid。
        let result = sampler.sample(&[4_294_967_294]);
        assert!(
            result.is_empty(),
            "查不到的 pid 不该出现在结果里，调用方要靠这个判死"
        );
    }

    #[test]
    fn memory_is_reported_in_megabytes_for_current_process() {
        let sampler = CpuSampler::new();
        let pid = std::process::id();
        let sample = sampler.sample(&[pid]);
        assert!(
            sample[&pid].memory_mb > 0,
            "当前测试进程的内存不该是 0 MB"
        );
    }

    #[test]
    fn short_interval_returns_none_and_does_not_update_the_baseline() {
        let sampler = CpuSampler::new();
        let pid = std::process::id();

        sampler.sample(&[pid]); // 建立基准
        let baseline_before = *sampler.prev.lock().unwrap().get(&pid).unwrap();

        // 立即再采一次：两次调用间隔远小于 MIN_SAMPLE_INTERVAL_MS。
        let short = sampler.sample(&[pid]);
        assert!(
            short[&pid].cpu_percent.is_none(),
            "间隔过短应返回 None，而不是拿噪声算出一个数字"
        );

        let baseline_after = *sampler.prev.lock().unwrap().get(&pid).unwrap();
        assert_eq!(
            baseline_before, baseline_after,
            "间隔过短时不该更新基准，否则噪声会污染下一次真正的计算窗口"
        );
    }

    fn sample_with_start(start_time_secs: u64) -> ProcSample {
        ProcSample {
            cpu_percent: None,
            memory_mb: 10,
            run_time_sec: 5,
            start_time_secs,
        }
    }

    #[test]
    fn liveness_none_sample_means_dead() {
        assert_eq!(check_liveness(None, 1_700_000_000_000), LivenessCheck::Dead);
    }

    #[test]
    fn liveness_exact_alignment_is_alive() {
        let roster_ms = 1_700_000_000_000i64;
        let s = sample_with_start(1_700_000_000); // roster_ms / 1000，完全对齐
        assert_eq!(check_liveness(Some(&s), roster_ms), LivenessCheck::Alive);
    }

    #[test]
    fn liveness_one_hour_off_is_pid_reused() {
        let roster_ms = 1_700_000_000_000i64;
        let s = sample_with_start(1_700_000_000 + 3600);
        assert_eq!(
            check_liveness(Some(&s), roster_ms),
            LivenessCheck::PidReused
        );
    }

    #[test]
    fn liveness_at_tolerance_boundary_is_still_alive() {
        let roster_ms = 1_700_000_000_000i64;
        let later = sample_with_start(1_700_000_000 + 120);
        assert_eq!(
            check_liveness(Some(&later), roster_ms),
            LivenessCheck::Alive,
            "恰好 +120s 应仍判 alive（边界含）"
        );
        let earlier = sample_with_start(1_700_000_000 - 120);
        assert_eq!(
            check_liveness(Some(&earlier), roster_ms),
            LivenessCheck::Alive,
            "恰好 -120s 应仍判 alive（边界含）"
        );
    }

    #[test]
    fn liveness_just_past_the_boundary_is_pid_reused() {
        let roster_ms = 1_700_000_000_000i64;
        let later = sample_with_start(1_700_000_000 + 121);
        assert_eq!(
            check_liveness(Some(&later), roster_ms),
            LivenessCheck::PidReused,
            "刚超出 +120s 就该判 pid-reused"
        );
        let earlier = sample_with_start(1_700_000_000 - 121);
        assert_eq!(
            check_liveness(Some(&earlier), roster_ms),
            LivenessCheck::PidReused,
            "刚超出 -120s 就该判 pid-reused"
        );
    }
}
