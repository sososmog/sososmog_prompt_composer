
use std::collections::{HashMap, HashSet};
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

/// 单个会话子树最多纳入多少个进程。
///
/// 纯防御性上限：正常情况下 claude 的子树是个位数（一个 Bash 工具调用带起
/// 一两个 shell）。但 parent 指针来自内核、pid 又会被复用，理论上可能出现
/// 一条指向系统进程树的伪边，那样一棵"子树"就会把半台机器的进程都吸进来。
/// 宁可少算几个子进程，也不要让一次采样去刷几百个进程。
const MAX_SUBTREE_PIDS: usize = 256;

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
    /// 本次为这个进程合并计入了几个进程（含它自己）。只算主进程时恒为 1。
    ///
    /// **不上报给前端**，纯诊断用。存在的理由：子树收集一旦失效（拿不到
    /// parent、拓扑刷新姿势不对），表现是"CPU 读数偏低"——不崩、不报错、
    /// 看起来完全正常，跟 `cpu_usage()` 那个坑是同一类静默失败。有这个计数，
    /// 真机诊断一眼就能看出子树到底有没有认出来。
    pub sampled_pids: usize,
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
    ///
    /// 用含子树的口径预热，好让子进程也一并进基准表：不然第一次真正采样时
    /// 它们全是"首次出现"，只建基准、贡献 0，用户还是要多等一轮才看到实数。
    /// 这里多付的一次全量刷进程发生在启动后的后台线程里，没人在等它。
    pub fn prime(&self, pids: &[u32]) {
        let _ = self.sample_with_descendants(pids);
    }

    /// 对给定的一组 pid 采样，CPU 只算进程自己。
    ///
    /// 查不到的 pid（已退出 / 从未存在）**不会出现在返回的 map 里**——调用方
    /// 用"这个 pid 在不在 map 里"判断进程是否还活着，而不是塞一个哨兵值进去。
    pub fn sample(&self, pids: &[u32]) -> HashMap<u32, ProcSample> {
        self.sample_inner(pids, false)
    }

    /// 同 [`sample`](Self::sample)，但把每个进程**及其全部后代**的 CPU 合并计入。
    ///
    /// 为什么需要：claude 执行 Bash 工具时，CPU 实际消耗记在 `bash.exe` /
    /// `node.exe` 这些子进程上。只采主进程会出现"机器风扇狂转、面板显示
    /// 0.1%"——那不是一个不够精细的数字，而是一个错误的数字。
    ///
    /// 代价（本机 debug build、520 个进程实测，见 `tests/sysinfo_probe.rs` 的
    /// `probe_full_refresh_cost_and_parent_map`）：全量刷拓扑 14.4ms + 对子树
    /// 刷 CPU 约 12ms。而"一次性 `All` + `with_cpu()`"要 75ms——所以这里刻意
    /// 分成两次刷新，先用最便宜的口径拿拓扑，再只对真正关心的那几十个 pid 取
    /// CPU。调用方应该只在用户真的看得到 CPU 的那一档轮询里用这个方法。
    ///
    /// 内存**不**跟着合并：父子进程共享内存页会被重复计算，而这个字段目前前端
    /// 根本不显示，不值得为它引入一个需要长篇解释的新语义。CPU 合并是因为它
    /// 回答的是"这个会话让机器多忙"，那个问题的答案本来就该含子进程。
    pub fn sample_with_descendants(&self, pids: &[u32]) -> HashMap<u32, ProcSample> {
        self.sample_inner(pids, true)
    }

    fn sample_inner(&self, pids: &[u32], include_descendants: bool) -> HashMap<u32, ProcSample> {
        let mut result = HashMap::new();
        if pids.is_empty() {
            return result;
        }

        let mut sys = self.sys.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // pid → 该次采样要合并计入它的进程组（含它自己，永远排第一个）。
        let mut groups: HashMap<u32, Vec<Pid>> = HashMap::new();

        if include_descendants {
            // parent 关系只能从整张进程表里读出来，这一步没法只刷关心的 pid。
            // 用最便宜的 `nothing()` 口径：这次刷新只要拓扑，CPU/内存留给下面
            // 那次窄得多的刷新。
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );

            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, p) in sys.processes() {
                if let Some(parent) = p.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
            }

            let mut to_refresh: Vec<Pid> = Vec::new();
            for &pid in pids {
                let group = collect_subtree(&children, Pid::from_u32(pid));
                to_refresh.extend(group.iter().copied());
                groups.insert(pid, group);
            }
            // 两个会话可能共享同一棵子树的一部分（正常不会，但去重是免费的，
            // 而重复刷同一个 pid 不是）。
            to_refresh.sort_unstable();
            to_refresh.dedup();

            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&to_refresh),
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
        } else {
            let sysinfo_pids: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();
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
            for (&pid, &sp) in pids.iter().zip(sysinfo_pids.iter()) {
                groups.insert(pid, vec![sp]);
            }
        }

        let now = Instant::now();
        let mut prev = self.prev.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 本轮真正读到过的 pid，用于收尾时清理基准表。
        let mut touched: HashSet<u32> = HashSet::with_capacity(pids.len());

        for &pid in pids {
            let Some(p) = sys.process(Pid::from_u32(pid)) else {
                // 进程查不到：可能刚退出，也可能 roster 文件本来就是残留。
                // 不插入 result，调用方据此判死。
                continue;
            };

            // 这三样**必须**是主进程自己的：start_time 是存活校验的锚点，
            // 换成子进程的会让 check_liveness 全盘失效。
            let memory_mb = p.memory() / 1024 / 1024;
            let run_time_sec = p.run_time();
            let start_time_secs = p.start_time();

            // 按**每个进程各自**算差值再求和，而不是"把子树的 acc 先求和、再减
            // 上一次的和"。后者在子进程生灭时会跳变：一个刚起的 bash 进来时自带
            // 几十毫秒 CPU 时间，会被整段计入这一个采样窗口，冒出一个虚高的尖峰。
            // 分别算差值的话，新进程这一轮只建基准、贡献 0，下一轮才开始计入；
            // 已退出的进程则查不到 acc_now，它最后那一小段被丢掉（宁可轻微低估，
            // 也不要一个会随子进程生灭乱跳的数字）。
            let mut total_pct = 0.0f32;
            let mut sampled_pids = 0usize;
            // 只有主进程算出了有效读数，整体才算有读数——保持"首次采样返回
            // None"这条语义不变（None = 还不知道，不是 0%）。
            let mut main_has_reading = false;

            let empty = Vec::new();
            let group = groups.get(&pid).unwrap_or(&empty);
            for &member in group {
                let Some(mp) = sys.process(member) else {
                    continue;
                };
                let member_pid = member.as_u32();
                touched.insert(member_pid);
                sampled_pids += 1;

                let acc_now = mp.accumulated_cpu_time();
                let mut update_baseline = true;

                if let Some(&(acc_prev, t_prev)) = prev.get(&member_pid) {
                    let wall_ms = now.duration_since(t_prev).as_millis();
                    if wall_ms < MIN_SAMPLE_INTERVAL_MS {
                        // 间隔太短：这次不产出百分比，也不更新基准——留着上一次的
                        // 基准给下一次用，凑够一个有意义的采样窗口。
                        update_baseline = false;
                    } else {
                        // pid 被复用时新进程的 acc 可能比旧记录还小，saturating_sub
                        // 让它归零而不是 underflow 溢出成一个巨大的数。
                        let cpu_ms = acc_now.saturating_sub(acc_prev) as f64;
                        total_pct += (cpu_ms / wall_ms as f64 * 100.0 / self.ncpu as f64) as f32;
                        if member_pid == pid {
                            main_has_reading = true;
                        }
                    }
                }
                // `prev` 里没有这个 pid 时上面的 `if let` 落空（首次采样没有基准），
                // 但 `update_baseline` 保持默认的 `true`——必须把这次的
                // (acc_now, now) 记下来，否则永远拿不到基准。

                if update_baseline {
                    prev.insert(member_pid, (acc_now, now));
                }
            }

            // clamp 吸收采样抖动（理论上不该超过 100%，但差分算法在边界条件下
            // 可能有一点点越界）。
            let cpu_percent = main_has_reading.then(|| total_pct.clamp(0.0, 100.0));

            result.insert(
                pid,
                ProcSample {
                    cpu_percent,
                    memory_mb,
                    run_time_sec,
                    start_time_secs,
                    sampled_pids,
                },
            );
        }

        // 子进程的 pid 是一次性的（每次 Bash 工具调用都是新 pid），不清理的话
        // 基准表会随运行时长无限膨胀。本轮没读到的一律丢掉，但**目标 pid 本身
        // 即使这次查不到也保留**——它可能只是这一瞬间读不到，丢了基准就意味着
        // 下次要重新攒一个采样窗口，白等一轮。
        let targets: HashSet<u32> = pids.iter().copied().collect();
        prev.retain(|k, _| touched.contains(k) || targets.contains(k));

        result
    }
}

/// 收集 `root` 及其全部后代 pid（含 root 自己，排在第一个）。
///
/// 进程树理论上无环，但 parent 指针来自内核且 pid 会被复用，成环不是不可能；
/// `seen` 集合兜住这种情况，避免死循环。数量到 [`MAX_SUBTREE_PIDS`] 就停止
/// 扩展——见那个常量的说明。
fn collect_subtree(children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> Vec<Pid> {
    let mut out = Vec::new();
    let mut seen: HashSet<Pid> = HashSet::new();
    let mut queue = vec![root];

    while let Some(cur) = queue.pop() {
        if !seen.insert(cur) {
            continue;
        }
        out.push(cur);
        if out.len() >= MAX_SUBTREE_PIDS {
            break;
        }
        if let Some(kids) = children.get(&cur) {
            queue.extend(kids.iter().copied());
        }
    }

    out
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

    /// 起一个**真的子进程**在烧 CPU。跨平台各来一条：Windows 用 cmd 的空循环，
    /// 其余用 sh 的忙等。调用方负责 kill。
    fn spawn_cpu_burning_child() -> std::process::Child {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "for /L %i in (1,1,2000000000) do rem"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("起不了烧 CPU 的子进程")
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("sh")
                .arg("-c")
                .arg("while :; do :; done")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("起不了烧 CPU 的子进程")
        }
    }

    /// E5 的核心断言：子进程烧掉的 CPU 必须算到父进程头上。
    ///
    /// 用两个**各自独立**的采样器而不是交替调用同一个：它们共享 `prev` 基准表，
    /// 交替调用会互相污染采样窗口，测出来的差异就说明不了任何问题了。
    ///
    /// 断言口径参照 `tests/sysinfo_probe.rs`：只断言"含子树的读数明显更大"，
    /// 不断言具体数值——核心数、机器负载、CI 环境差异都会影响绝对值，把某台
    /// 机器上的数字钉死只会换来一个随机失败的测试。
    #[test]
    fn descendant_cpu_is_attributed_to_the_parent() {
        let own_only = CpuSampler::new();
        let with_kids = CpuSampler::new();
        let me = std::process::id();

        own_only.sample(&[me]);
        with_kids.sample_with_descendants(&[me]);

        let mut child = spawn_cpu_burning_child();

        // 采三次而不是两次，是因为**子进程首次出现的那一轮只建基准、贡献 0**
        // （见 sample_inner 里"分别算差值"那段注释）。第二次采样让子进程进
        // 基准表，第三次才拿得到它真正的读数。这不是测试的怪癖，而是实现的
        // 真实行为：一个存活不到一个轮询周期的短命子进程根本不会被计入。
        // 接受这个代价，是因为另一条路（首次出现就把它的历史 CPU 全额计入
        // 当前窗口）会在每次工具调用时打出一个虚高的尖峰。
        thread::sleep(Duration::from_millis(200));
        own_only.sample(&[me]);
        with_kids.sample_with_descendants(&[me]);

        thread::sleep(Duration::from_millis(600));

        let own_sample = own_only.sample(&[me])[&me];
        let kids_sample = with_kids.sample_with_descendants(&[me])[&me];
        let a = own_sample.cpu_percent.expect("主进程口径应有读数");
        let b = kids_sample.cpu_percent.expect("含子树口径应有读数");

        let _ = child.kill();
        let _ = child.wait();

        println!(
            "主进程自身 {a:.3}%（{} 个进程） / 含子树 {b:.3}%（{} 个进程）",
            own_sample.sampled_pids, kids_sample.sampled_pids
        );
        assert_eq!(own_sample.sampled_pids, 1, "只算主进程时不该纳入别的进程");
        assert!(
            kids_sample.sampled_pids > 1,
            ">>> 含子树口径只纳入了 {} 个进程，子进程根本没被收集到——\
             后面的 CPU 比较也就没有意义了",
            kids_sample.sampled_pids
        );
        assert!(
            b > a,
            ">>> 含子树的 CPU（{b}）没有超过只算主进程的（{a}），\
             说明子进程的消耗根本没被计入——这正是 E5 要修的缺陷"
        );
        assert!(
            b - a > 0.5,
            ">>> 含子树只比主进程多 {:.3}%，子进程明明在烧满一个核。\
             差值这么小通常意味着子树收集没拿到那个进程",
            b - a
        );
    }

    #[test]
    fn descendants_sampling_still_hides_unknown_pids() {
        let sampler = CpuSampler::new();
        let result = sampler.sample_with_descendants(&[4_294_967_294]);
        assert!(
            result.is_empty(),
            "查不到的 pid 在含子树口径下也不该出现在结果里"
        );
    }

    #[test]
    fn collect_subtree_puts_root_first_and_survives_a_cycle() {
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        let a = Pid::from_u32(101);
        let b = Pid::from_u32(102);
        children.insert(a, vec![b]);
        children.insert(b, vec![a]); // A→B→A：内核不该给出这种拓扑，但防着
        let out = collect_subtree(&children, a);
        assert_eq!(out[0], a, "root 必须排第一个（主进程要靠这个位置区分自己）");
        assert_eq!(out.len(), 2, "成环时必须收敛，每个节点只出现一次");
    }

    #[test]
    fn collect_subtree_is_capped() {
        // 一条超长的父子链，模拟"伪边把半台机器吸进来"的最坏情况。
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for i in 1..(MAX_SUBTREE_PIDS as u32 + 50) {
            children.insert(Pid::from_u32(i), vec![Pid::from_u32(i + 1)]);
        }
        let out = collect_subtree(&children, Pid::from_u32(1));
        assert!(
            out.len() <= MAX_SUBTREE_PIDS,
            "子树规模没有被上限挡住：{}",
            out.len()
        );
    }

    #[test]
    fn stale_child_baselines_are_dropped_but_target_baselines_survive() {
        let sampler = CpuSampler::new();
        let me = std::process::id();
        let ghost = 4_294_967_293u32; // 假装是上一轮某个已经退出的工具子进程

        sampler.sample(&[me]);
        sampler
            .prev
            .lock()
            .unwrap()
            .insert(ghost, (0, Instant::now()));

        sampler.sample(&[me]);

        let prev = sampler.prev.lock().unwrap();
        assert!(
            !prev.contains_key(&ghost),
            "已经消失的子进程基准必须清掉，否则长期运行时基准表会无限膨胀"
        );
        assert!(
            prev.contains_key(&me),
            "目标 pid 的基准必须保留，丢了就要白等一轮才重新有读数"
        );
    }

    fn sample_with_start(start_time_secs: u64) -> ProcSample {
        ProcSample {
            cpu_percent: None,
            memory_mb: 10,
            run_time_sec: 5,
            start_time_secs,
            sampled_pids: 1,
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
