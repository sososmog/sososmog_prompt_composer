//! 真机诊断：对**真实**的 `~/.claude` / `~/.codex` 跑一遍采集链路，把认出来的
//! 东西打印出来。
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
//! 两个测试：`dump_what_the_collector_sees_on_this_machine`（Claude Code）与
//! `dump_codex_rollouts_on_this_machine`（Codex）。
//!
//! ## 隐私提醒
//!
//! 输出里会包含真实的会话标题、git 分支、工作目录——那都是你自己的工作内容。
//! **贴到 issue 或聊天里之前先看一眼。**

use std::path::PathBuf;
use std::time::Duration;

use composer_lib::fleet::{codex, jobs, proc, roster, subagents, transcript, types};

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
    // ---------- L4 后台会话 ----------
    // 放在名册的 early-return 之前，理由同 mod.rs：机器上完全可能只有 --bg
    // 起的后台任务、一个交互式会话都没有。
    //
    // 扫两遍是刻意的：正常口径会把超出保留期的历史归档过滤掉，本机很可能
    // 一条都不剩——那样就分不清"解析器在真实数据上跑通了"和"解析器整个坏了"
    // （两种情况都是 0 条）。第二遍传 now=0 让保留期判定永远不成立，等于
    // "忽略新旧，全都解析一遍"，用真实的 state.json 验证解析路径本身。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let job_scan = jobs::scan(&dir, now);
    let all_jobs = jobs::scan(&dir, 0);
    println!(
        "\nL4 后台会话: {} 条在列（忽略保留期则 {} 条，差额是超出 {} 分钟的历史归档）, {} 条 warning",
        job_scan.entries.len(),
        all_jobs.entries.len(),
        types::JOB_TERMINAL_RETENTION_MS / 60_000,
        job_scan.warnings.len()
    );
    for w in &job_scan.warnings {
        println!("  [warn] {:?} — {}", w.code, w.detail);
    }
    // 打印 state/name/tokens 就够诊断了。**不打印 detail 和 intent**——
    // 那两个直接来自用户的 prompt 和模型输出，这个脚本的输出是要贴给别人看的。
    for e in &all_jobs.entries {
        println!(
            "  job {} — state={:?} tempo={:?} tokens={:?} name={} 有sessionId={} detail长度={}",
            e.digest.job_id,
            e.digest.state.as_deref().unwrap_or("—"),
            e.digest.tempo.as_deref().unwrap_or("—"),
            e.digest.tokens,
            e.name,
            e.session_id.is_some(),
            e.digest.detail.as_ref().map(|d| d.chars().count()).unwrap_or(0),
        );
    }
    if all_jobs.entries.is_empty() {
        println!("  （没有任何 job 目录。要验 L4 必须先用 claude --bg 或 /loop 造一个）");
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

/// 与 `fleet::config::resolve_codex` 同规则的无 Tauri 版本，理由同
/// [`real_config_dir`]。
fn real_codex_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|h| PathBuf::from(h).join(".codex"))
}

/// Codex 侧的同类诊断：`discover` 在真实 `~/.codex` 上认出了哪些会话。
///
/// 同样不断言具体内容——本机有几个 Codex 会话完全取决于你今天用没用它。
/// 它要暴露的是"扫描链路还通不通"：路径规则变了、文件名换格式了，
/// 这里会直接变成 0 条，而全部单测照样绿（夹具是我们自己造的）。
///
/// 顺带用一个放宽到 90 天的窗口对照跑一次。两个数字差得多是正常的，
/// 差成 0 vs 0 才说明有问题。
#[test]
#[ignore]
fn dump_codex_rollouts_on_this_machine() {
    let Some(codex_dir) = real_codex_dir() else {
        println!("拿不到 home 目录，跳过");
        return;
    };
    println!("Codex 配置目录：{}", codex_dir.display());
    if !codex_dir.is_dir() {
        println!("本机没有这个目录——没装 Codex 就是这样，不是错误。");
        return;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut fresh_count = 0usize;
    for (label, retention) in [
        ("默认保留窗口", types::CODEX_RETENTION_MS),
        ("放宽到 90 天", 90i64 * 24 * 3600 * 1000),
    ] {
        let scan = codex::discover::discover(&codex_dir, now_ms, retention);
        println!(
            "
=== {label}（{:.1} 小时）→ {} 条会话，{} 条 warning ===",
            retention as f64 / 3_600_000.0,
            scan.entries.len(),
            scan.warnings.len()
        );
        for w in &scan.warnings {
            println!("  [warn] {:?} {}", w.code, w.detail);
        }
        for e in scan.entries.iter().take(10) {
            println!(
                "  {:<40} {:>9} bytes  {:>7.1} 小时前",
                e.session_id,
                e.size_bytes,
                (now_ms - e.mtime_ms) as f64 / 3_600_000.0
            );
        }
        if scan.entries.len() > 10 {
            println!("  ... 还有 {} 条", scan.entries.len() - 10);
        }
        if label == "放宽到 90 天" {
            fresh_count = scan.entries.len();
        }
    }

    // ---- 会话标题索引 ----
    let titles = codex::index::load_titles(&codex_dir);
    println!("
=== session_index.jsonl → {} 条标题 ===", titles.len());

    // ---- 逐个真实 rollout 跑一遍解析 ----
    //
    // 这一段才是这个测试的重点。单测吃的是手写夹具，只能证明"代码符合我对格式的
    // 理解"；只有真实文件能证明那个理解本身没错。
    let scan = codex::discover::discover(&codex_dir, now_ms, 90i64 * 24 * 3600 * 1000);
    println!("
=== 逐个解析（{} 个）===", scan.entries.len());
    let mut ok = 0usize;
    let mut with_digest = 0usize;
    let mut meta_fail = 0usize;
    for e in &scan.entries {
        match codex::rollout::read_rollout(e, types::DEFAULT_TAIL_BYTES) {
            Ok(parsed) => {
                ok += 1;
                let m = &parsed.meta;
                println!(
                    "
  {} 
    cwd={} 
    入口={} / {} 版本={} 分支={:?}",
                    e.session_id,
                    m.cwd,
                    m.originator,
                    m.source.as_deref().unwrap_or("-"),
                    m.cli_version,
                    m.git_branch
                );
                // 文件名里的 id 与 session_meta 里的 id 是否一致——不一致说明
                // 我们对命名规则的理解有问题。
                if let Some(inner) = &m.session_id {
                    if inner != &e.session_id {
                        println!("    ⚠️ 文件名 id 与 session_meta.session_id 不一致：{inner}");
                    }
                }
                println!(
                    "    标题: {}",
                    titles.get(&e.session_id).map(String::as_str).unwrap_or("（索引里没有）")
                );
                match &parsed.digest {
                    None => println!("    （只有 session_meta，未开始）"),
                    Some(d) => {
                        with_digest += 1;
                        let pct = match (d.context_tokens, parsed.context_window) {
                            (Some(t), Some(w)) if w > 0 => {
                                format!("{:.1}%", t as f64 * 100.0 / w as f64)
                            }
                            _ => "—".to_string(),
                        };
                        println!(
                            "    状态: role={:?} stop={:?} kind={:?} tools={:?}",
                            d.last_role, d.last_stop_reason, d.last_tail_kind, d.last_tool_names
                        );
                        println!(
                            "    模型={:?} 档位={:?} | context {:?}/{:?} = {pct} | 坏行 {}",
                            d.model, d.effort, d.context_tokens, parsed.context_window, d.parse_errors
                        );
                        if let Some(p) = &d.last_prompt {
                            let one_line: String =
                                p.chars().filter(|c| !c.is_control()).take(60).collect();
                            println!("    最后提问: {one_line}");
                        }
                    }
                }
            }
            Err(err) => {
                meta_fail += 1;
                println!("
  {} → 解析失败 {:?}", e.session_id, err);
            }
        }
    }
    println!(
        "
---- 汇总：{} 个成功 / {} 个有 digest / {} 个失败",
        ok, with_digest, meta_fail
    );

    // 解析失败是硬错误：这些文件是 discover 认过的真 rollout，
    // 读不出 session_meta 说明首行格式与我们的理解不符。
    assert_eq!(
        meta_fail, 0,
        "有 {meta_fail} 个 rollout 读不出 session_meta——首行格式可能变了"
    );

    // 唯一的硬断言，而且只在"目录里确实有 rollout 文件"时才成立：
    // 磁盘上有文件却一条都发现不了，说明文件名规则或目录布局变了——
    // 那正是这个测试存在的意义（单测吃自造夹具，发现不了上游漂移）。
    let has_any_rollout = walk_has_rollout(&codex_dir.join("sessions"));
    if has_any_rollout {
        assert!(
            fresh_count > 0,
            "磁盘上有 rollout 文件，discover 却一条都没认出来——文件名规则或目录布局可能变了"
        );
    } else {
        println!("
（sessions/ 下没有任何 rollout 文件，跳过硬断言）");
    }
}

/// 递归找一个 rollout 文件，只为给上面的硬断言判定前提条件。
/// 刻意不复用 `discover` 的任何逻辑——用被测代码去证明被测代码的前提是循环论证。
fn walk_has_rollout(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            if walk_has_rollout(&path) {
                return true;
            }
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                return true;
            }
        }
    }
    false
}
