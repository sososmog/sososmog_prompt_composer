//! sysinfo 行为探针
//!
//! 这不是在测我们自己的代码，而是在**钉住 sysinfo 的行为契约**——
//! `src/fleet/proc.rs` 的实现建立在下面这几条假设上，而它们都不是显而易见的：
//!
//! 1. **`Process::cpu_usage()` 不可用**（见下），CPU 百分比必须由我们自己
//!    从 `accumulated_cpu_time()` 的差值算。
//! 2. `start_time()` 返回 UNIX 秒，我们靠它和 roster 里的 `startedAt` 对齐来防 PID 复用。
//! 3. `refresh_processes_specifics(Some(&pids), true, ..)` 里的 `true`
//!    （remove_dead_processes）不会把不在 pids 里的进程从表里清掉。
//!
//! ## 为什么不用 `cpu_usage()`
//!
//! 实测（sysinfo 0.36.1 / Windows 11 / 32 逻辑核）：在一个线程里烧满 1 个核，
//! `cpu_usage()` 返回 0.0003 ~ 0.002，而真值应当在 110 左右（累加口径）。
//! 换过四种姿势都一样错：`nothing().with_cpu()` 间隔 250ms / 间隔 1000ms、
//! `everything()`、`System::new_all()` 打底——读数只随间隔略微变大，
//! 始终差五个数量级。
//!
//! 同一次实验里，`accumulated_cpu_time()` 的差值算法完全正确：
//! `cpu_ms=1125 / wall_ms=1015 = 110.84%`（烧满 1 核 + 主线程零头），
//! 除以 32 核得 3.46%。
//!
//! 所以 `fleet/proc.rs` 用后者，公式：
//! ```text
//! 归一化% = (acc_ms_now - acc_ms_prev) / wall_ms_elapsed * 100 / 核心数
//! ```
//! 这样做还有两个附带好处：不依赖 sysinfo 的平台实现（它显然有平台差异 bug）；
//! 统计窗口就是我们自己的轮询间隔，语义明确（"最近一个轮询周期的平均占用"）。
//!
//! 第 3 条的意义：`sys.processes()` 会一直留着上次全量扫描的残留，
//! 所以只能按 pid 单查，不能用 `processes()` 做任何整体判断。
//!
//! 跑 `cargo test --test sysinfo_probe -- --nocapture` 能看到实测数值。
//! 平台差异（Windows / macOS / Linux）也靠这个文件暴露出来。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

/// 在后台烧 CPU 一段时间，好让 `cpu_usage()` 有非零读数可采。
/// 返回的 JoinHandle 需要 join，避免测试结束了线程还在跑。
fn burn_cpu_for(dur: Duration) -> std::thread::JoinHandle<u64> {
    std::thread::spawn(move || {
        let deadline = Instant::now() + dur;
        let mut acc: u64 = 0;
        while Instant::now() < deadline {
            // 做点编译器优化不掉的无用功
            for i in 0..50_000u64 {
                acc = acc.wrapping_add(i.wrapping_mul(2_654_435_761));
            }
        }
        acc
    })
}

#[test]
fn probe_process_lookup_and_start_time() {
    let my_pid = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    let refreshed = sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[my_pid]),
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    println!("refresh_processes_specifics 返回（刷新条数）: {refreshed}");

    let proc = sys
        .process(my_pid)
        .expect("必须能按 pid 找到当前进程；找不到说明 ProcessesToUpdate::Some 用法不对");

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let start = proc.start_time();
    let run = proc.run_time();
    let mem = proc.memory();

    println!("进程名: {:?}", proc.name());
    println!("start_time(): {start} (UNIX 秒)");
    println!("now:          {now_secs}");
    println!("run_time():   {run} 秒");
    println!("memory():     {mem} 字节 = {} MB", mem / 1024 / 1024);

    // start_time 必须是个像样的 UNIX 秒：2020-01-01 之后、且不在未来。
    // 这是 fleet/proc.rs 防 PID 复用的立足点——若这里失败（某些平台返回 0 或
    // boot 相对时间），那条防护就得换实现。
    assert!(
        start > 1_577_836_800,
        "start_time() 看起来不是 UNIX 秒: {start}"
    );
    assert!(
        start <= now_secs + 5,
        "start_time() 在未来: {start} > {now_secs}"
    );

    // 内存必须是字节数量级（几 MB 以上），不是 KB
    assert!(mem > 1024 * 1024, "memory() 疑似不是字节: {mem}");
}

/// 钉住 `fleet/proc.rs` 真正采用的 CPU 算法：`accumulated_cpu_time()` 差值 / 墙钟差值。
///
/// 这是本文件里最重要的一条——它保护的是一个数值正确性，
/// 而数值错了不会崩、只会在界面上显示成 0%，属于最难发现的那类 bug。
#[test]
fn probe_cpu_via_accumulated_time() {
    let my_pid = Pid::from_u32(std::process::id());
    let kind = ProcessRefreshKind::nothing().with_cpu();
    let mut sys = System::new();

    // cpus() 在 System::new() 之后是空的，必须先刷一次 CPU 列表，
    // 否则拿不到核心数、归一化会除以 0。
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let ncpu = sys.cpus().len();
    println!("sys.cpus().len() = {ncpu}");
    println!(
        "std::thread::available_parallelism() = {:?}",
        std::thread::available_parallelism()
    );
    println!("MINIMUM_CPU_UPDATE_INTERVAL = {MINIMUM_CPU_UPDATE_INTERVAL:?}");
    assert!(ncpu > 0, "cpus() 为空——归一化会除以 0");

    // 烧满 1 个核，持续到两次采样都取完
    let burner = burn_cpu_for(Duration::from_millis(2500));

    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[my_pid]), true, kind);
    let t0 = Instant::now();
    let acc0 = sys.process(my_pid).unwrap().accumulated_cpu_time();

    std::thread::sleep(Duration::from_millis(1000));

    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[my_pid]), true, kind);
    let acc1 = sys.process(my_pid).unwrap().accumulated_cpu_time();
    let wall_ms = t0.elapsed().as_millis() as f64;

    // 顺带打印 sysinfo 自己的读数，方便日后升级版本时对比它有没有被修好
    let builtin = sys.process(my_pid).unwrap().cpu_usage();
    let _ = burner.join();

    let cpu_ms = acc1.saturating_sub(acc0) as f64;
    let raw_pct = cpu_ms / wall_ms * 100.0;
    let norm_pct = raw_pct / ncpu as f64;

    println!("accumulated_cpu_time: {acc0} -> {acc1}  (差 {cpu_ms} ms)");
    println!("墙钟 {wall_ms} ms");
    println!("累加口径 {raw_pct:.2}% / 归一化 {norm_pct:.2}%");
    println!("（对比）sysinfo 自带 cpu_usage() = {builtin}  ← 实测不可用，见文件头注释");

    assert!(cpu_ms > 0.0, "accumulated_cpu_time 差值为 0：烧了 1 秒 CPU 却没记到");
    // 烧满 1 个核 → 累加口径应当接近 100%。给宽松区间容纳调度抖动与主线程开销。
    assert!(
        raw_pct > 50.0,
        "烧满 1 核，累加口径只有 {raw_pct:.2}%，公式或采样窗口有问题"
    );
    assert!(
        norm_pct > 0.0 && norm_pct <= 100.0,
        "归一化后越界: {norm_pct:.2}%"
    );
}

#[test]
fn probe_remove_dead_processes_scope() {
    let my_pid = Pid::from_u32(std::process::id());
    let kind = ProcessRefreshKind::nothing();
    let mut sys = System::new();

    // 先全量扫一遍，让进程表里装满东西
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let after_all = sys.processes().len();
    println!("全量刷新后 processes().len() = {after_all}");
    assert!(after_all > 1, "全量刷新居然只有 {after_all} 个进程");

    // 再只刷我们关心的一个 pid，remove_dead_processes = true。
    // 问题：这个 true 会不会把"没被刷到"的进程也当死进程清掉？
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[my_pid]), true, kind);
    let after_some = sys.processes().len();
    println!("只刷 1 个 pid 后 processes().len() = {after_some}");

    if after_some <= 2 {
        println!(
            ">>> 结论：Some(&pids) + remove_dead_processes=true 会清掉未刷新的进程。\
             fleet/proc.rs 因此不能依赖 processes() 的整体内容，只能按 pid 单查。"
        );
    } else {
        println!(
            ">>> 结论：未刷新的进程被保留了（残留 {after_some} 个）。\
             fleet/proc.rs 必须按 pid 单查，不能用 processes() 整体判断，\
             否则会看到上次全量扫描的陈旧残留。"
        );
    }

    // 无论哪种语义，按 pid 单查自己都必须成立——这是 proc.rs 唯一依赖的行为。
    assert!(
        sys.process(my_pid).is_some(),
        "只刷自己这一个 pid 之后反而查不到自己了"
    );
}

#[test]
fn probe_dead_pid_returns_none() {
    // 找一个几乎不可能存在的 pid，确认 process() 返回 None 而不是 panic。
    // fleet/proc.rs 靠这个把 roster 里的残留文件过滤掉。
    let mut sys = System::new();
    let fake = Pid::from_u32(4_294_967_294);
    let n = sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[fake]),
        true,
        ProcessRefreshKind::nothing(),
    );
    println!("刷新一个不存在的 pid，返回条数 = {n}");
    assert!(
        sys.process(fake).is_none(),
        "不存在的 pid 居然查到了进程"
    );
}
