//! 真机诊断：对**真实**的 `~/.claude` 跑一遍采集链路，把认出来的东西打印出来。
//!
//! ## 为什么需要它
//!
//! 单测吃的是 `tests/fixtures/` 里的合成夹具——那些夹具的结构是照着 Claude Code
//! 2.1.220 的实测观察造的。夹具能保证"逻辑对"，但保证不了"Claude Code 还是那个
//! 格式"。等哪天上游改了字段名或行结构，全部单测照样绿，而真机上什么都读不出来。
//!
//! 这个测试就是那种情况下的**主要诊断手段**：它不断言任何具体内容（真机数据每次
//! 都不一样），只跑通链路并打印结果，让人一眼看出是"没有会话"还是"字段读不出来"。
//!
//! ## 默认被 `#[ignore]` 跳过
//!
//! 它依赖开发者本机的真实数据，在 CI 上没有 `~/.claude`、也不该依赖任何人的
//! 私人数据，所以 `cargo test` 默认不跑它。手动跑：
//!
//! ```text
//! cargo test --test fleet_real_machine -- --ignored --nocapture
//! ```
//!
//! ## 隐私提醒
//!
//! 输出里会包含真实的会话标题、git 分支、工作目录——那都是你自己的工作内容。
//! **贴到 issue 或聊天里之前先看一眼。**

use std::path::PathBuf;
use std::time::Duration;

use composer_lib::fleet::{proc, roster, transcript};

/// 与 `fleet::config::resolve` 同样的规则，但不需要 Tauri 的 AppHandle。
/// 这里刻意重写一遍而不是复用——`config::resolve` 要 `AppHandle`，
/// 为了这个测试去造一个 mock app 不值得。
fn real_config_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    // Windows 用 USERPROFILE，类 Unix 用 HOME
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|h| PathBuf::from(h).join(".claude"))
}

#[test]
#[ignore = "依赖开发者本机的真实 ~/.claude 数据，手动跑：cargo test --test fleet_real_machine -- --ignored --nocapture"]
fn dump_what_the_collector_sees_on_this_machine() {
    let Some(dir) = real_config_dir() else {
        println!("拿不到配置目录（既无 CLAUDE_CONFIG_DIR 也无 USERPROFILE/HOME），跳过");
        return;
    };
    println!("配置目录: {}", dir.display());
    if !dir.is_dir() {
        println!("目录不存在——这台机器没跑过 Claude Code，采集层应当静默返回空。");
        return;
    }

    // ---------- L1 名册 ----------
    let scan = roster::scan(&dir);
    println!(
        "\nL1 名册: {} 条条目, {} 条 warning",
        scan.entries.len(),
        scan.warnings.len()
    );
    for w in &scan.warnings {
        println!("  [warn] {:?} — {}", w.code, w.detail);
    }
    if scan.entries.is_empty() {
        println!("名册为空：当前没有 claude 进程在跑（或 sessions/ 目录不存在）。");
        return;
    }

    // ---------- L5 进程指标 ----------
    // CPU 要两次采样才有值，这里先 prime 再等一会儿，模拟真实轮询的节奏。
    let pids: Vec<u32> = scan.entries.iter().map(|e| e.pid).collect();
    let sampler = proc::CpuSampler::new();
    sampler.prime(&pids);
    std::thread::sleep(Duration::from_millis(1200));
    let samples = sampler.sample(&pids);

    let mut alive = 0usize;
    let mut fresh = 0usize;
    let mut with_digest = 0usize;

    for e in &scan.entries {
        let sample = samples.get(&e.pid);
        let liveness = proc::check_liveness(sample, e.started_at);
        let cpu = sample
            .and_then(|s| s.cpu_percent)
            .map(|v| format!("{v:.1}%"))
            .unwrap_or_else(|| "—".to_string());
        let mem = sample
            .map(|s| format!("{} MB", s.memory_mb))
            .unwrap_or_else(|| "—".to_string());

        println!("\n=== {} (pid {}) — {liveness:?}", e.name, e.pid);
        println!("    入口={} 类型={} 版本={}", e.entrypoint, e.kind, e.cli_version);
        println!("    cwd={}", e.cwd);
        println!("    CPU={cpu}  内存={mem}");

        if liveness == proc::LivenessCheck::Alive {
            alive += 1;
        }

        // ---------- L2 transcript ----------
        match transcript::find_transcript(&dir, &e.session_id) {
            None => {
                fresh += 1;
                println!("    transcript: 无 → 「已启动 · 未开始」（正常状态，不是错误）");
            }
            Some(path) => {
                let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(false);
                if empty {
                    fresh += 1;
                    println!("    transcript: 0 字节 → 同样按「已启动 · 未开始」处理");
                    continue; // 跳过这一个会话，不是退出整个循环
                }
                match transcript::read_digest(&path, 64 * 1024) {
                    Ok(d) => {
                        with_digest += 1;
                        println!(
                            "    标题: {}",
                            d.ai_title.as_deref().unwrap_or("(无 ai-title)")
                        );
                        println!(
                            "    分支={:?} 模型={:?} 档位={:?}",
                            d.git_branch, d.model, d.effort
                        );
                        println!(
                            "    尾部: role={:?} stop={:?} kind={:?} tools={:?}",
                            d.last_role, d.last_stop_reason, d.last_tail_kind, d.last_tool_names
                        );
                        println!(
                            "    context={:?} tokens | 文件 {} KB | 坏行 {}",
                            d.context_tokens,
                            d.size_bytes / 1024,
                            d.parse_errors
                        );
                        // 坏行不为 0 是格式漂移的第一个信号，值得显眼提示。
                        if d.parse_errors > 0 {
                            println!(
                                "    ⚠️ 尾部有 {} 行解析失败 —— 若持续出现，可能是 jsonl 格式变了",
                                d.parse_errors
                            );
                        }
                    }
                    Err(err) => {
                        println!("    ⚠️ transcript 读取/解析失败: {err:?}");
                    }
                }
            }
        }
    }

    println!(
        "\n---- 汇总：{} 条名册 / {alive} 个存活 / {fresh} 个未开始 / {with_digest} 个读到摘要",
        scan.entries.len()
    );

    // 唯一的硬断言：名册里有条目，就至少要有一个能被判定为存活。
    // 全都判死说明存活校验（启动时间对齐）在这个平台上失效了——那会让整个
    // Agent tab 永远空着，而且不会有任何报错。这是本测试真正要防的回归。
    assert!(
        alive > 0,
        "名册里有 {} 条会话，却没有一个通过存活校验——check_liveness 的启动时间对齐可能在本平台失效了",
        scan.entries.len()
    );
}
