
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::transcript::parse_iso8601_utc_ms;
use super::types::{self, JobDigest, JobInFlight};

/// 一条后台会话（`/loop`、`--bg`）。
///
/// 除了 [`JobDigest`] 本身，还带着**足以独立成一个 `AgentSession` 的 L1 字段**
/// ——这正是"方案 B 独立成条"的地基：`state.json` 里 `name`/`cwd`/`cliVersion`/
/// `sessionId`/`createdAt` 一应俱全，不需要从别处凑，也不需要编造。
/// 唯一凑不出来的是 pid，而那恰恰是 v2 把 `AgentSession.pid` 改成 `Option` 的原因。
#[derive(Debug, Clone)]
pub struct JobEntry {
    pub digest: JobDigest,
    /// 后台会话同样有 transcript（jsonl），靠这个 id 定位。缺失时该 job
    /// 仍然值得显示，只是没有标题/分支可看。
    pub session_id: Option<String>,
    pub name: String,
    pub cwd: String,
    pub cli_version: String,
    /// 取自 `backend`（实测 `daemon`）。语义与名册的 `entrypoint` 一致：
    /// 这个会话是从哪儿起来的。
    pub entrypoint: String,
    /// ms epoch。源数据是 ISO 字符串，这里已经转好。
    pub created_at: i64,
}

/// 一次 jobs 扫描的结果：解析出的条目 + 过程中产生的非致命 warning。
#[derive(Debug)]
pub struct JobScan {
    pub entries: Vec<JobEntry>,
    pub warnings: Vec<types::FleetWarning>,
}

/// `state.json` 的原始形状。
///
/// 全部 `Option`：这个文件由 Claude Code 自己写，字段随版本增减很正常，
/// 缺哪个都不该让整条记录作废。同样不加 `deny_unknown_fields`——实测它还有
/// `output`/`children`/`template`/`respawnFlags`/`bgIsolation`/`providerEnv`/
/// `linkScan*`/`nameSource`/`daemonShort`/`resumeSessionId`/`firstTerminalAt`
/// 等我们不关心的字段。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawJobState {
    state: Option<String>,
    detail: Option<String>,
    tempo: Option<String>,
    tokens: Option<u64>,
    in_flight: Option<RawInFlight>,
    intent: Option<String>,
    name: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    cli_version: Option<String>,
    backend: Option<String>,
    /// ⚠️ 实测是 **ISO-8601 字符串**（`"2026-07-14T14:55:10.085Z"`），
    /// 而名册那边的 `startedAt` 是**数字毫秒**。同一个产品里两种时间格式并存，
    /// 说明它随时可能再变，所以这里收成 `Value` 由 [`parse_ts`] 两种都认。
    created_at: Option<Value>,
    updated_at: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RawInFlight {
    tasks: Option<u32>,
    queued: Option<u32>,
}

/// 把时间字段解析成 ms epoch，字符串（ISO-8601 UTC）和数字（ms）都认。
///
/// 见 [`RawJobState::created_at`]：源格式已经在同一个产品里出现过两种，
/// 只认其中一种就是在等着它下次变更时静默失效（时间会变成 0，界面上表现
/// 为"1970 年"或"很久以前"，而不会报任何错）。
fn parse_ts(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::String(s) => parse_iso8601_utc_ms(s),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// job 是否已经结束。终态的 job 只在 [`types::JOB_TERMINAL_RETENTION_MS`]
/// 时间窗内显示，见那个常量的说明。
///
/// 未知状态（新版本加了我们没见过的值）**按未结束处理**：宁可多显示一条，
/// 也不要因为不认识某个状态就把一个可能还在跑的任务藏起来。
fn is_terminal(state: Option<&str>) -> bool {
    matches!(state, Some("done") | Some("failed") | Some("stopped"))
}

/// 纯函数：把一个 `state.json` 的内容解析成一条 [`JobEntry`]。
///
/// 不做文件 I/O，方便单测直接喂字符串。返回 `None` 表示这条不该出现在列表里
/// （JSON 坏了，或者是早就结束的历史归档）。
fn parse_state(job_id: &str, content: &str, now_ms: i64) -> Option<JobEntry> {
    let raw: RawJobState = serde_json::from_str(content).ok()?;

    let updated_at = parse_ts(raw.updated_at.as_ref());

    // 终态 + 超过保留期 → 这是历史归档，不进列表。
    // 拿不到 updated_at 时按"不确定"处理，保留显示——同 is_terminal 的取向，
    // 宁可多一条也不要静默藏起可能还活着的任务。
    if is_terminal(raw.state.as_deref()) {
        if let Some(updated) = updated_at {
            if now_ms.saturating_sub(updated) > types::JOB_TERMINAL_RETENTION_MS {
                return None;
            }
        }
    }

    let created_at = parse_ts(raw.created_at.as_ref()).unwrap_or(0);

    Some(JobEntry {
        digest: JobDigest {
            job_id: job_id.to_string(),
            state: raw.state,
            // detail 和 intent 都直接来自用户的 prompt / 模型输出，必须截断
            // （既是 IPC 体积上限，也是隐私边界，见 types.rs 的 truncate_text）。
            detail: raw.detail.as_deref().map(types::truncate_text),
            tempo: raw.tempo,
            tokens: raw.tokens,
            in_flight: raw.in_flight.map(|f| JobInFlight {
                tasks: f.tasks.unwrap_or(0),
                queued: f.queued.unwrap_or(0),
            }),
            intent: raw.intent.as_deref().map(types::truncate_text),
            updated_at,
        },
        session_id: raw.session_id,
        name: raw.name.unwrap_or_else(|| job_id.to_string()),
        cwd: raw.cwd.unwrap_or_default(),
        cli_version: raw.cli_version.unwrap_or_default(),
        entrypoint: raw.backend.unwrap_or_else(|| "background".to_string()),
        created_at,
    })
}

/// 扫描 `<config_dir>/jobs/<id>/state.json`。
///
/// 失败语义与 [`super::roster::scan`] 完全一致：目录不存在是正常状态（从没用过
/// `--bg`），静默返回空；目录存在但读不了才报 warning；单个 job 解析失败只跳过
/// 该条。
///
/// `now_ms` 由调用方传入而不是这里现取，是为了让整份报告用同一个时间基准
/// （同 `FleetReport.scanned_at` 的理由），也让单测能精确构造保留期边界。
pub fn scan(config_dir: &Path, now_ms: i64) -> JobScan {
    let jobs_dir = config_dir.join("jobs");

    let read_dir = match std::fs::read_dir(&jobs_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return JobScan {
                entries: Vec::new(),
                warnings: Vec::new(),
            };
        }
        Err(_) => {
            return JobScan {
                entries: Vec::new(),
                warnings: vec![types::FleetWarning::new(
                    types::WarningCode::JobsUnreadable,
                    format!("无法读取目录：{}", jobs_dir.display()),
                )],
            };
        }
    };

    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for dir_entry in read_dir {
        let Ok(dir_entry) = dir_entry else { continue };
        let path = dir_entry.path();

        // 只看子目录。`jobs/` 下还有 `pins.json` 这类平级文件，它们不是 job，
        // 忽略即可，**不产 warning**（不是问题，是约定之外的正常情况）。
        if !path.is_dir() {
            continue;
        }

        let Some(job_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let job_id = job_id.to_string();

        let state_path = path.join("state.json");
        let content = match std::fs::read_to_string(&state_path) {
            Ok(c) => c,
            // 没有 state.json 的目录不是 job（实测每个 job 目录下还有个 `tmp/`）。
            // 静默跳过，这不是错误。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                warnings.push(types::FleetWarning::new(
                    types::WarningCode::JobEntryInvalid,
                    format!("无法读取后台会话状态文件：{job_id}/state.json"),
                ));
                continue;
            }
        };

        match parse_state(&job_id, &content, now_ms) {
            Some(entry) => entries.push(entry),
            None if serde_json::from_str::<Value>(&content).is_err() => {
                // 区分"解析失败"和"按保留期过滤掉了"——后者是正常行为，
                // 报 warning 会变成每轮刷屏的噪声。
                warnings.push(types::FleetWarning::new(
                    types::WarningCode::JobEntryInvalid,
                    format!("后台会话状态文件解析失败：{job_id}/state.json"),
                ));
            }
            None => {}
        }
    }

    JobScan { entries, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_785_416_167_000;

    /// 一份按实测样本裁出来的最小 state.json。
    fn sample(state: &str, updated_at: &str) -> String {
        format!(
            r#"{{
              "state": "{state}",
              "detail": "占位摘要",
              "tempo": "idle",
              "inFlight": {{ "tasks": 1, "queued": 2, "kinds": [] }},
              "tokens": 91774,
              "intent": "占位意图",
              "name": "demo-job",
              "sessionId": "11111111-2222-3333-4444-555555555555",
              "cliVersion": "2.1.220",
              "cwd": "C:\\work\\demo",
              "backend": "daemon",
              "createdAt": "2026-07-14T14:55:10.085Z",
              "updatedAt": "{updated_at}"
            }}"#
        )
    }

    #[test]
    fn parses_all_the_fields_we_show() {
        let content = sample("working", "2026-07-14T15:37:40.083Z");
        let e = parse_state("56520b5f", &content, NOW).expect("进行中的 job 必须解析出来");

        assert_eq!(e.digest.job_id, "56520b5f");
        assert_eq!(e.digest.state.as_deref(), Some("working"));
        assert_eq!(e.digest.detail.as_deref(), Some("占位摘要"));
        assert_eq!(e.digest.tokens, Some(91_774));
        let f = e.digest.in_flight.expect("inFlight 应解析出来");
        assert_eq!((f.tasks, f.queued), (1, 2));

        // 独立成条需要的 L1 字段
        assert_eq!(e.name, "demo-job");
        assert_eq!(e.cwd, "C:\\work\\demo");
        assert_eq!(e.cli_version, "2.1.220");
        assert_eq!(e.entrypoint, "daemon");
        assert!(e.session_id.is_some());
    }

    /// 时间字段是 ISO 字符串，而名册那边是数字毫秒——两种都必须认。
    #[test]
    fn timestamps_accept_both_iso_strings_and_numbers() {
        let iso = sample("working", "2026-07-14T15:37:40.083Z");
        let e = parse_state("j", &iso, NOW).unwrap();
        assert_eq!(
            e.digest.updated_at,
            Some(1_784_043_460_083),
            "ISO 字符串没解析成正确的 ms epoch"
        );
        assert_eq!(e.created_at, 1_784_040_910_085);

        let numeric = r#"{"state":"working","createdAt":1700000000000,"updatedAt":1700000001000}"#;
        let e2 = parse_state("j", numeric, NOW).unwrap();
        assert_eq!(e2.digest.updated_at, Some(1_700_000_001_000));
        assert_eq!(e2.created_at, 1_700_000_000_000);
    }

    #[test]
    fn in_progress_jobs_are_kept_regardless_of_age() {
        // 一年前更新过、但状态还是 working —— 必须留着（它可能真的还在跑）
        let old = sample("working", "2025-07-14T15:37:40.083Z");
        assert!(
            parse_state("j", &old, NOW).is_some(),
            "进行中的 job 不受保留期限制"
        );
        let blocked = sample("blocked", "2025-07-14T15:37:40.083Z");
        assert!(parse_state("j", &blocked, NOW).is_some());
    }

    #[test]
    fn terminal_jobs_are_dropped_after_the_retention_window() {
        // updatedAt 恰好落在保留期边界内/外，用 NOW 反推构造
        let just_inside = NOW - types::JOB_TERMINAL_RETENTION_MS;
        let just_outside = NOW - types::JOB_TERMINAL_RETENTION_MS - 1;

        for state in ["done", "failed", "stopped"] {
            let inside = format!(r#"{{"state":"{state}","updatedAt":{just_inside}}}"#);
            assert!(
                parse_state("j", &inside, NOW).is_some(),
                "{state}：恰好在保留期边界上应仍显示"
            );

            let outside = format!(r#"{{"state":"{state}","updatedAt":{just_outside}}}"#);
            assert!(
                parse_state("j", &outside, NOW).is_none(),
                "{state}：超出保留期的历史归档不该再占列表位置"
            );
        }
    }

    /// 拿不到 updatedAt 就没法判断新旧——这时保留显示，而不是静默藏起来。
    #[test]
    fn terminal_job_without_updated_at_is_kept() {
        let content = r#"{"state":"done"}"#;
        assert!(parse_state("j", content, NOW).is_some());
    }

    /// 不认识的状态按"还没结束"处理，宁可多显示一条。
    #[test]
    fn unknown_state_is_not_treated_as_terminal() {
        let content = format!(
            r#"{{"state":"some-future-state","updatedAt":{}}}"#,
            NOW - 10 * types::JOB_TERMINAL_RETENTION_MS
        );
        assert!(parse_state("j", &content, NOW).is_some());
    }

    #[test]
    fn missing_fields_fall_back_instead_of_failing() {
        let e = parse_state("abc123", "{}", NOW).expect("空对象也该解析出一条");
        assert_eq!(e.name, "abc123", "没有 name 时用 jobId 兜底");
        assert_eq!(e.entrypoint, "background", "没有 backend 时的兜底值");
        assert_eq!(e.cwd, "");
        assert_eq!(e.created_at, 0);
        assert!(e.digest.state.is_none());
    }

    #[test]
    fn invalid_json_yields_none() {
        assert!(parse_state("j", "{ 这不是 json", NOW).is_none());
    }

    #[test]
    fn long_detail_and_intent_are_truncated() {
        let long = "字".repeat(500);
        let content = format!(r#"{{"state":"working","detail":"{long}","intent":"{long}"}}"#);
        let e = parse_state("j", &content, NOW).unwrap();
        assert_eq!(
            e.digest.detail.as_ref().unwrap().chars().count(),
            types::TEXT_LIMIT + 1,
            "detail 直接来自模型输出，必须截断"
        );
        assert_eq!(
            e.digest.intent.as_ref().unwrap().chars().count(),
            types::TEXT_LIMIT + 1,
            "intent 是用户原始 prompt，必须截断"
        );
    }

    #[test]
    fn missing_jobs_dir_is_silent() {
        let dir = std::env::temp_dir().join("composer-fleet-jobs-absent");
        let _ = std::fs::remove_dir_all(&dir);
        let scan = scan(&dir, NOW);
        assert!(scan.entries.is_empty());
        assert!(
            scan.warnings.is_empty(),
            "从没用过 --bg 是正常状态，不该产 warning"
        );
    }

    #[test]
    fn scan_reads_job_dirs_and_ignores_stray_files() {
        let root = std::env::temp_dir().join("composer-fleet-jobs-scan");
        let _ = std::fs::remove_dir_all(&root);
        let jobs = root.join("jobs");
        std::fs::create_dir_all(jobs.join("aaa")).unwrap();
        std::fs::create_dir_all(jobs.join("bbb").join("tmp")).unwrap();
        std::fs::write(
            jobs.join("aaa").join("state.json"),
            sample("working", "2026-07-14T15:37:40.083Z"),
        )
        .unwrap();
        // bbb 只有 tmp/ 没有 state.json —— 不是 job，静默跳过
        // 平级的 pins.json 也不是 job
        std::fs::write(jobs.join("pins.json"), "[]").unwrap();

        let scan = scan(&root, NOW);
        assert_eq!(scan.entries.len(), 1, "只有 aaa 是有效 job");
        assert_eq!(scan.entries[0].digest.job_id, "aaa");
        assert!(
            scan.warnings.is_empty(),
            "缺 state.json 的目录和平级文件都不是错误，不该产 warning"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_state_json_produces_a_warning_but_does_not_kill_the_scan() {
        let root = std::env::temp_dir().join("composer-fleet-jobs-broken");
        let _ = std::fs::remove_dir_all(&root);
        let jobs = root.join("jobs");
        std::fs::create_dir_all(jobs.join("good")).unwrap();
        std::fs::create_dir_all(jobs.join("bad")).unwrap();
        std::fs::write(
            jobs.join("good").join("state.json"),
            sample("working", "2026-07-14T15:37:40.083Z"),
        )
        .unwrap();
        std::fs::write(jobs.join("bad").join("state.json"), "{ 坏掉的").unwrap();

        let scan = scan(&root, NOW);
        assert_eq!(scan.entries.len(), 1, "坏的那条不该拖垮好的那条");
        assert_eq!(scan.warnings.len(), 1);
        assert!(
            !scan.warnings[0].detail.contains("坏掉的"),
            "warning 的 detail 不能带文件内容（隐私边界）"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 被保留期过滤掉**不是**错误，不能产 warning——那会变成每轮刷屏的噪声。
    #[test]
    fn filtered_out_old_job_does_not_produce_a_warning() {
        let root = std::env::temp_dir().join("composer-fleet-jobs-old");
        let _ = std::fs::remove_dir_all(&root);
        let jobs = root.join("jobs");
        std::fs::create_dir_all(jobs.join("ancient")).unwrap();
        std::fs::write(
            jobs.join("ancient").join("state.json"),
            format!(
                r#"{{"state":"done","updatedAt":{}}}"#,
                NOW - 10 * types::JOB_TERMINAL_RETENTION_MS
            ),
        )
        .unwrap();

        let scan = scan(&root, NOW);
        assert!(scan.entries.is_empty());
        assert!(scan.warnings.is_empty(), "正常的保留期过滤不该产 warning");

        let _ = std::fs::remove_dir_all(&root);
    }
}
