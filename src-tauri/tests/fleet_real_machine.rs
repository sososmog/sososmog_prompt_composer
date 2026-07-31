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

use composer_lib::fleet::{proc, roster, subagents, transcript};

/// 把扁平的 subagent 列表按 parentAgentId 打印成树。
///
/// 这里刻意**不复用前端 `buildSubagentTree` 的逻辑**（那是 JS，且有环检测/孤儿
/// 归置等一整套规则）——这个函数的用途是"让人肉眼确认磁盘上的父子关系被正确读出
/// 来了"，越笨越好。前端那套树重建规则由 fleet.test.js 用合成数据覆盖。
fn print_tree(digests: &[composer_lib::fleet::types::SubagentDigest], scanned_at: i64) {
    fn walk(
        all: &[composer_lib::fleet::types::SubagentDigest],
        parent: Option<&str>,
        indent: usize,
        scanned_at: i64,
    ) {
        for d in all.iter().filter(|d| d.parent_agent_id.as_deref() == parent) {
            let ago = d
                .mtime_ms
                .or(d.last_msg_ts_ms)
                .map(|t| format!("{}s前", (scanned_at - t) / 1000))
                .unwrap_or_else(|| "无 jsonl".to_string());
            println!(
                "      {:indent$}{} {}  [{}] {} tok  {}  {}",
                "",
                d.spawn_depth.map(|n| n.to_string()).unwrap_or("?".into()),
                &d.agent_id[..d.agent_id.len().min(9)],
                d.last_stop_reason.as_deref().unwrap_or("-"),
                d.context_tokens.map(|t| t.to_string()).unwrap_or("?".into()),
                ago,
                d.description.as_deref().unwrap_or("(无描述)"),
                indent = indent
            );
            walk(all, Some(&d.agent_id), indent + 2, scanned_at);
        }
    }
    walk(digests, None, 0, scanned_at);

    // 父指针悬空的（父不在本次结果里）不会被上面的 walk 打到，单独列出来——
    // 漏掉它们就等于"树里少了几个 agent 但没人知道"。
    let ids: std::collections::HashSet<&str> =
        digests.iter().map(|d| d.agent_id.as_str()).collect();
    for d in digests.iter().filter(|d| {
        d.parent_agent_id
            .as_deref()
            .is_some_and(|p| !ids.contains(p))
    }) {
        println!(
            "      [孤儿] {} 父={} {}",
            &d.agent_id[..d.agent_id.len().min(9)],
            d.parent_agent_id.as_deref().unwrap_or("-"),
            d.description.as_deref().unwrap_or("(无描述)")
        );
    }
}

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
    // 用 sample_with_descendants 而不是 sample：应用在全量档走的就是这条路
    // （claude 跑 Bash 工具时 CPU 记在子进程上），诊断跑另一条路就失去意义了。
    let pids: Vec<u32> = scan.entries.iter().map(|e| e.pid).collect();
    let sampler = proc::CpuSampler::new();
    sampler.prime(&pids);
    std::thread::sleep(Duration::from_millis(1200));
    let samples = sampler.sample_with_descendants(&pids);

    let mut alive = 0usize;
    let mut fresh = 0usize;
    let mut with_digest = 0usize;
    let mut subagent_total = 0usize;
    // subagent 行的"多久前"要有个时间基准。这里用本地时钟即可——这是诊断输出，
    // 不是产品逻辑（产品里前端一律用 Rust 报告里的 scannedAt，见契约注释）。
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

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
        // 子树规模：CPU 是把主进程和它的工具子进程合并算的，这里显示合并了
        // 几个进程。如果这一列**永远是 1**，说明子树收集在本机失效了——那种
        // 坏法不崩不报错，只表现为 CPU 偏低，光看百分比看不出来。
        let subtree = sample.map(|s| s.sampled_pids).unwrap_or(0);

        println!("\n=== {} (pid {}) — {liveness:?}", e.name, e.pid);
        println!("    入口={} 类型={} 版本={}", e.entrypoint, e.kind, e.cli_version);
        println!("    cwd={}", e.cwd);
        println!("    CPU={cpu}（合并 {subtree} 个进程）  内存={mem}");

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

                        // ---------- L3 subagent 树 ----------
                        // subagents_dir 与编排层同样的推导方式：transcript 的父目录
                        // 就是项目目录。
                        if let Some(project_dir) = path.parent() {
                            let dir = project_dir.join(&e.session_id).join("subagents");
                            let scan = subagents::scan(&dir, 64 * 1024);
                            if !scan.digests.is_empty() || !scan.warnings.is_empty() {
                                println!("    子 agent {} 个：", scan.digests.len());
                                print_tree(&scan.digests, now_ms);
                                for w in &scan.warnings {
                                    println!("      [warn] {:?} — {}", w.code, w.detail);
                                }
                                subagent_total += scan.digests.len();
                            }
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
        "\n---- 汇总：{} 条名册 / {alive} 个存活 / {fresh} 个未开始 / {with_digest} 个读到摘要 / {subagent_total} 个子 agent",
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
