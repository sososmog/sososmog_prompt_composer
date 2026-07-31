
use serde::{Deserialize, Serialize};

/// IPC 契约版本。改契约必须递增。
pub const SCHEMA_VERSION: u32 = 1;

/// transcript 尾部默认读取字节数。
///
/// 64KB 在实测数据上足够覆盖最后若干轮消息（本机最大的 session 文件 3.7MB，
/// 尾部 64KB 里有几十条消息）。但**不保证**——单条 assistant 消息带大 tool_result
/// 时可能超过这个窗口，所以采集侧必须实现扩窗重试（见 `TAIL_BYTES_MAX`）。
pub const DEFAULT_TAIL_BYTES: u64 = 64 * 1024;

/// 扩窗重试的上限。尾部窗口里找不到任何 user/assistant 消息时按 4× 递增，
/// 到这个上限仍找不到就判 `transcript-unparsable`，不再往下读。
pub const TAIL_BYTES_MAX: u64 = 1024 * 1024;

/// 文本字段截断长度（字符数，不是字节数）。
pub const TEXT_LIMIT: usize = 200;

/// 前端可传的采集选项。全部可选，缺省值见各字段注释。
///
/// 存在的意义：编写 tab 的低频轮询可以传 `{cpu:false, includeSubagents:false}`，
/// 只为喂 tab 角标，代价接近零。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetOptions {
    /// 默认 [`DEFAULT_TAIL_BYTES`]
    pub tail_bytes: Option<u64>,
    /// 默认 `true`。编排层用它决定要不要扫 `subagents/` 目录（见 `mod.rs`）。
    pub include_subagents: Option<bool>,
    /// 默认 `false`。**阶段 4**（后台会话）接入后才有人读。
    #[allow(dead_code)]
    pub include_jobs: Option<bool>,
    /// 默认 `true`
    pub cpu: Option<bool>,
}

impl FleetOptions {
    pub fn tail_bytes(&self) -> u64 {
        self.tail_bytes
            .unwrap_or(DEFAULT_TAIL_BYTES)
            .clamp(4 * 1024, TAIL_BYTES_MAX)
    }
    pub fn include_subagents(&self) -> bool {
        self.include_subagents.unwrap_or(true)
    }
    /// 阶段 4 才会被编排层调用。
    #[allow(dead_code)]
    pub fn include_jobs(&self) -> bool {
        self.include_jobs.unwrap_or(false)
    }
    pub fn cpu(&self) -> bool {
        self.cpu.unwrap_or(true)
    }
}

/// 一次扫描的完整结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetReport {
    pub schema_version: u32,
    /// 扫描时刻（ms epoch，Rust 侧时钟）。前端算 age 的唯一基准。
    pub scanned_at: i64,
    /// 实际使用的配置目录，排错用。拿不到时是空串。
    pub config_dir: String,
    pub sessions: Vec<AgentSession>,
    /// 非致命问题。有 warning 不代表整体失败。
    pub warnings: Vec<FleetWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetWarning {
    pub code: WarningCode,
    /// 已脱敏：只带文件名/路径，不带文件内容。
    pub detail: String,
}

impl FleetWarning {
    pub fn new(code: WarningCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WarningCode {
    /// 配置目录解析不出来或不存在
    NoConfigDir,
    /// `sessions/` 目录读不了
    RosterUnreadable,
    /// 单个 `sessions/<pid>.json` 解析失败（跳过该条，其余照常）
    RosterEntryInvalid,
    /// 找到了 jsonl 但读不了（I/O 错误）
    TranscriptUnreadable,
    /// 读到了但尾部窗口里解析不出任何消息（格式漂移的信号）
    TranscriptUnparsable,
    /// `<sid>/subagents/` 目录存在但读不了（权限问题一类），或其中某个
    /// `meta.json` 解析失败
    SubagentsUnreadable,
    /// pid 存在但启动时间与 roster 的 startedAt 对不上 → 疑似 PID 被复用
    PidReused,
}

// 关于这里**没有**哪两个 code，理由值得留着，否则以后会有人"顺手补上"：
//
// - `TranscriptNotFound`：找不到 jsonl 是**最常见的正常状态**（会话已启动但一句话
//   没说，实测本机 5 个会话里有 2 个如此）。为它产 warning 会让每轮轮询都刷出一堆
//   噪声，而它根本不是问题——编排层把这种情况直接映射成 `transcript: null`，
//   前端渲染为"已启动 · 未开始"。
// - `CpuUnavailable`：自从 `ProcMetrics::cpu_percent` 改成 `Option` 之后，
//   "还没有基准"这件事已经在数据里表达清楚了（前端显示 "—"），再加一条 warning
//   是重复信息。

/// 一个 Claude Code 会话。
///
/// L1 字段来自 `sessions/<pid>.json`，必有；其余各层可能为 null，
/// 且 **null 不等于错误**——最典型的是 `transcript: null` 表示"已启动但一句话
/// 没说"，这是实测存在的真实状态（本机 5 个会话里有 2 个是这样）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    // ---- L1：名册（必有） ----
    pub pid: u32,
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    /// 实测见过 `claude-vscode`；社区还见过 `cli`、`claude-desktop`
    pub entrypoint: String,
    /// `interactive` | `background`
    pub kind: String,
    /// ms epoch
    pub started_at: i64,
    pub cli_version: String,

    /// 存活性。`dead` 的会话直接不返回，所以这里只会是这两个值之一。
    pub liveness: Liveness,

    // ---- L5：进程指标（cpu:false 或采样失败时为 null） ----
    pub proc: Option<ProcMetrics>,

    // ---- L2：主 transcript（null = 空会话） ----
    pub transcript: Option<TranscriptDigest>,

    // ---- L3：subagent（空数组 = 无 subagents 目录） ----
    pub subagents: Vec<SubagentDigest>,

    // ---- L4：后台会话（阶段 4；非后台会话为 null） ----
    pub job: Option<JobDigest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Liveness {
    Alive,
    PidReused,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcMetrics {
    /// 已归一化到 0–100（除过核心数）。
    ///
    /// 算法是自己用 `accumulated_cpu_time()` 差值算的，**不是** sysinfo 的
    /// `cpu_usage()`——后者在 Windows 上实测是坏的，详见
    /// `tests/sysinfo_probe.rs` 头部注释。
    ///
    /// **`None` 表示"还不知道"，不是 0%。** 差值算法需要两次采样，首次扫描
    /// （或应用刚重启）时没有基准可减。这两种情况必须区分开：`0%` 是一个具体
    /// 结论（这进程真的闲着），`None` 是没有结论，前端显示 "—"。
    /// 早先这个字段是 `f32`，逼得采集层在没基准时只能填 0.0 —— 那是在撒谎。
    pub cpu_percent: Option<f32>,
    /// 内存和运行时长不需要基准，采到就有值，所以它们不是 Option。
    pub memory_mb: u64,
    pub run_time_sec: u64,
}

/// 主 transcript 尾部摘要。字段分两类：**展示用** 和 **状态判定用**。
/// 状态判定的全部输入就是 `last_*` 那几个字段 + `has_api_error`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDigest {
    pub size_bytes: u64,
    /// 文件 mtime（ms epoch）。这是**最可靠的"最后活动时间"**，
    /// 实测随每次写入更新、毫秒精度。
    pub mtime_ms: i64,

    // ---- 展示用 ----
    /// `type:"ai-title"` 的 `aiTitle`，Claude 自己生成的会话标题。截断到 TEXT_LIMIT。
    pub ai_title: Option<String>,
    /// `type:"last-prompt"` 的 `lastPrompt`。截断到 TEXT_LIMIT。
    pub last_prompt: Option<String>,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,

    // ---- 状态判定用 ----
    pub last_role: Option<Role>,
    /// 实测见过的值：`tool_use`（最常见）、`end_turn`、`stop_sequence`、`refusal`。
    /// null 表示消息还没收完（在途），前端据此判 working。
    ///
    /// ⚠️ **不能只靠这个字段判"在等用户"**：API 出错的行 `stop_reason` 实测是
    /// `stop_sequence` 或 `refusal`，光看它会误判成 end_turn 一类的正常收尾。
    /// 所以前端的判定顺序必须是先看 `has_api_error`，再看 stop_reason。
    pub last_stop_reason: Option<String>,
    pub last_tail_kind: Option<TailKind>,
    /// 尾部 assistant 的 tool_use 名字，最多 4 个
    pub last_tool_names: Vec<String>,
    /// 尾部最后一条消息的 timestamp（ms epoch）。
    /// jsonl 里是 ISO-8601 UTC（`...T07:29:57.407Z`），采集侧负责转换——
    /// 本机是 UTC+8，直接当本地时间比会差 8 小时。
    pub last_msg_ts_ms: Option<i64>,

    /// 判据是顶层 `isApiErrorMessage === true`。这是**主信号**，
    /// 下面两个字段只是补充说明，可能都缺。
    pub has_api_error: bool,
    /// HTTP 状态码。源数据里**是数字**（实测 `"apiErrorStatus": 403`），
    /// 而且可能整个字段缺失（实测 refusal 那类错误就没有）。
    /// 采集侧统一归一化成字符串，免得前端要处理 number | string | undefined 三态。
    pub api_error_status: Option<String>,
    /// 错误码，来自顶层 `error` 字段。实测值 `oauth_org_not_allowed`、`invalid_request`。
    /// 比状态码更有展示价值（能直接告诉用户是权限问题还是请求被拒）。
    pub api_error_code: Option<String>,

    /// 官方口径的 context 占用：`input + cache_creation + cache_read`
    /// （只算 input 侧、不含 output，与 statusLine 的 `used_percentage` 同公式）。
    ///
    /// 不提供百分比：`message.model` 记的是 `claude-opus-5`，而用户实际可能设的是
    /// `opus[1m]`，**从 jsonl 里区分不出 200k 还是 1M 窗口**，显示错的百分比比不
    /// 显示更糟。
    pub context_tokens: Option<u64>,

    /// 尾部解析失败的行数。>0 说明格式可能漂移了，是我们唯一的诊断信号。
    pub parse_errors: u32,
}

/// subagent 摘要。字段是 [`TranscriptDigest`] 的同构子集 + meta.json 的内容。
///
/// **注意 subagent 不是独立进程**，全跑在同一个 `claude.exe` 里，
/// 所以这里没有 CPU——那一层只能到会话粒度。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDigest {
    pub agent_id: String,
    /// meta.json 的 `agentType`，如 `general-purpose`
    pub agent_type: Option<String>,
    /// meta.json 的 `description` —— 现成的"这个 agent 在干什么"。截断到 TEXT_LIMIT。
    pub description: Option<String>,
    /// 顶层 agent 该字段在 meta.json 里是**缺失**而非 null，反序列化后为 None
    pub parent_agent_id: Option<String>,
    pub spawn_depth: Option<u32>,

    pub mtime_ms: Option<i64>,
    pub size_bytes: Option<u64>,

    pub last_role: Option<Role>,
    pub last_stop_reason: Option<String>,
    pub last_tail_kind: Option<TailKind>,
    pub last_msg_ts_ms: Option<i64>,
    pub context_tokens: Option<u64>,
}

/// 后台会话（`/loop`、`--bg`）摘要 —— 阶段 4。
///
/// 这一层的字段**官方已经算好写在磁盘上**（`jobs/<id>/state.json`），
/// 尤其 `detail` 是一句人话摘要（实测样本："`stopped; awaiting further instructions`"、
/// "`要我顺手提交这条 fix 吗?`"），比我们自己从 transcript 推的准。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDigest {
    pub job_id: String,
    /// 实测值 `working` | `blocked` | `done`；文档另有 `failed` | `stopped`
    pub state: Option<String>,
    pub detail: Option<String>,
    pub tempo: Option<String>,
    pub tokens: Option<u64>,
    pub in_flight: Option<JobInFlight>,
    /// 原始 prompt。截断到 TEXT_LIMIT。
    pub intent: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInFlight {
    pub tasks: u32,
    pub queued: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TailKind {
    ToolUse,
    ToolResult,
    Text,
    Thinking,
}

/// 按**字符**（不是字节）截断，超长时补省略号。
///
/// 用字符而不是字节是因为中文内容按字节切会切坏 UTF-8；
/// 这个函数同时承担隐私边界和 IPC 体积上限两个职责。
pub fn truncate_text(s: &str) -> String {
    let mut out: String = s.chars().take(TEXT_LIMIT).collect();
    if s.chars().count() > TEXT_LIMIT {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_defaults_match_documented_contract() {
        let o = FleetOptions::default();
        assert_eq!(o.tail_bytes(), DEFAULT_TAIL_BYTES);
        assert!(o.include_subagents());
        assert!(!o.include_jobs(), "include_jobs 缺省必须是 false（阶段 4 才开）");
        assert!(o.cpu());
    }

    #[test]
    fn tail_bytes_is_clamped_both_ends() {
        let too_small = FleetOptions {
            tail_bytes: Some(1),
            ..Default::default()
        };
        assert_eq!(too_small.tail_bytes(), 4 * 1024, "过小的窗口读不出完整消息");

        let too_big = FleetOptions {
            tail_bytes: Some(999 * 1024 * 1024),
            ..Default::default()
        };
        assert_eq!(
            too_big.tail_bytes(),
            TAIL_BYTES_MAX,
            "前端不该能让我们读整个 3.7MB 文件"
        );
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        // 300 个中文字符 = 900 字节。按字节截断会切坏 UTF-8，按字符才对。
        let long = "中".repeat(300);
        let out = truncate_text(&long);
        assert_eq!(out.chars().count(), TEXT_LIMIT + 1, "应是 200 字符 + 省略号");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_leaves_short_text_untouched() {
        assert_eq!(truncate_text("短标题"), "短标题");
        let exactly = "a".repeat(TEXT_LIMIT);
        assert_eq!(truncate_text(&exactly), exactly, "刚好等于上限时不该加省略号");
    }

    #[test]
    fn enums_serialize_to_the_documented_wire_format() {
        // 这几个字符串是前端 fleet.js 直接比对的字面量，写错了不会编译报错，
        // 只会让状态判定静默失效——所以必须钉住。
        assert_eq!(serde_json::to_string(&Role::User).unwrap(), "\"user\"");
        assert_eq!(
            serde_json::to_string(&Role::Assistant).unwrap(),
            "\"assistant\""
        );
        assert_eq!(
            serde_json::to_string(&TailKind::ToolUse).unwrap(),
            "\"tool_use\""
        );
        assert_eq!(
            serde_json::to_string(&TailKind::ToolResult).unwrap(),
            "\"tool_result\""
        );
        assert_eq!(
            serde_json::to_string(&Liveness::PidReused).unwrap(),
            "\"pid-reused\""
        );
        assert_eq!(
            serde_json::to_string(&WarningCode::NoConfigDir).unwrap(),
            "\"no-config-dir\""
        );
        assert_eq!(
            serde_json::to_string(&WarningCode::TranscriptUnparsable).unwrap(),
            "\"transcript-unparsable\""
        );
    }

    /// 构造一个**每个字段都填满**的报告，用于钉住出线格式。
    fn full_report() -> FleetReport {
        FleetReport {
            schema_version: SCHEMA_VERSION,
            scanned_at: 1_785_416_167_000,
            config_dir: "C:\\Users\\demo\\.claude".into(),
            warnings: vec![FleetWarning::new(
                WarningCode::PidReused,
                "pid 62222 的启动时间与名册记录不符",
            )],
            sessions: vec![AgentSession {
                pid: 52052,
                session_id: "11111111-2222-3333-4444-555555555555".into(),
                name: "demo-proj-18".into(),
                cwd: "C:\\work\\demo".into(),
                entrypoint: "claude-vscode".into(),
                kind: "interactive".into(),
                started_at: 1_785_395_815_772,
                cli_version: "2.1.220".into(),
                liveness: Liveness::Alive,
                proc: Some(ProcMetrics {
                    cpu_percent: Some(3.53),
                    memory_mb: 483,
                    run_time_sec: 1200,
                }),
                transcript: Some(TranscriptDigest {
                    size_bytes: 318_000,
                    mtime_ms: 1_785_416_160_000,
                    ai_title: Some("占位标题".into()),
                    last_prompt: Some("占位提问".into()),
                    git_branch: Some("main".into()),
                    model: Some("claude-opus-5".into()),
                    effort: Some("xhigh".into()),
                    last_role: Some(Role::Assistant),
                    last_stop_reason: Some("tool_use".into()),
                    last_tail_kind: Some(TailKind::ToolUse),
                    last_tool_names: vec!["Bash".into()],
                    last_msg_ts_ms: Some(1_785_416_159_000),
                    has_api_error: false,
                    api_error_status: None,
                    api_error_code: None,
                    context_tokens: Some(68_000),
                    parse_errors: 0,
                }),
                subagents: vec![SubagentDigest {
                    agent_id: "a52f755df57239c77".into(),
                    agent_type: Some("general-purpose".into()),
                    description: Some("占位描述".into()),
                    parent_agent_id: None,
                    spawn_depth: Some(1),
                    mtime_ms: Some(1_785_416_100_000),
                    size_bytes: Some(540_410),
                    last_role: Some(Role::User),
                    last_stop_reason: None,
                    last_tail_kind: Some(TailKind::ToolResult),
                    last_msg_ts_ms: Some(1_785_416_099_000),
                    context_tokens: Some(41_000),
                }],
                job: Some(JobDigest {
                    job_id: "56520b5f".into(),
                    state: Some("blocked".into()),
                    detail: Some("占位摘要".into()),
                    tempo: Some("idle".into()),
                    tokens: Some(91_774),
                    in_flight: Some(JobInFlight { tasks: 0, queued: 0 }),
                    intent: Some("占位意图".into()),
                    updated_at: Some(1_785_416_000_000),
                }),
            }],
        }
    }

    /// 钉住**出线的键名全部是 camelCase**。
    ///
    /// 这是整个契约里最容易静默出错的一处：漏掉 `#[serde(rename_all = "camelCase")]`
    /// 不会有任何编译错误，前端也不会抛异常，只会把 `sessionId` 读成 undefined，
    /// 然后界面上一片空白，而排查方向会完全跑偏（去怀疑采集逻辑）。
    #[test]
    fn wire_format_keys_are_camel_case() {
        let v = serde_json::to_value(full_report()).unwrap();

        for k in ["schemaVersion", "scannedAt", "configDir", "sessions", "warnings"] {
            assert!(v.get(k).is_some(), "报告顶层缺 {k}");
        }

        let s = &v["sessions"][0];
        for k in [
            "pid",
            "sessionId",
            "name",
            "cwd",
            "entrypoint",
            "kind",
            "startedAt",
            "cliVersion",
            "liveness",
            "proc",
            "transcript",
            "subagents",
            "job",
        ] {
            assert!(s.get(k).is_some(), "session 缺 {k}");
        }

        for k in ["cpuPercent", "memoryMb", "runTimeSec"] {
            assert!(s["proc"].get(k).is_some(), "proc 缺 {k}");
        }

        let t = &s["transcript"];
        for k in [
            "sizeBytes",
            "mtimeMs",
            "aiTitle",
            "lastPrompt",
            "gitBranch",
            "model",
            "effort",
            "lastRole",
            "lastStopReason",
            "lastTailKind",
            "lastToolNames",
            "lastMsgTsMs",
            "hasApiError",
            "apiErrorStatus",
            "apiErrorCode",
            "contextTokens",
            "parseErrors",
        ] {
            assert!(t.get(k).is_some(), "transcript 缺 {k}");
        }

        let sub = &s["subagents"][0];
        for k in [
            "agentId",
            "agentType",
            "description",
            "parentAgentId",
            "spawnDepth",
            "mtimeMs",
            "sizeBytes",
            "lastRole",
            "lastStopReason",
            "lastTailKind",
            "lastMsgTsMs",
            "contextTokens",
        ] {
            assert!(sub.get(k).is_some(), "subagent 缺 {k}");
        }

        let job = &s["job"];
        for k in [
            "jobId", "state", "detail", "tempo", "tokens", "inFlight", "intent", "updatedAt",
        ] {
            assert!(job.get(k).is_some(), "job 缺 {k}");
        }
        assert!(job["inFlight"].get("tasks").is_some());
        assert!(job["inFlight"].get("queued").is_some());

        let w = &v["warnings"][0];
        assert_eq!(w["code"], "pid-reused");
        assert!(w.get("detail").is_some());
    }

    /// `Option::None` 必须出线成 JSON `null` 而不是**整个键消失**。
    ///
    /// 前端的判定逻辑写的是 `t.lastStopReason === null → 判 working`；
    /// 如果 serde 把 None 的键整个省掉（比如哪天有人加了 skip_serializing_if），
    /// 读出来同样是 undefined，`=== null` 就不成立，状态判定会静默走错分支。
    #[test]
    fn none_serializes_to_null_not_missing_key() {
        let v = serde_json::to_value(full_report()).unwrap();
        let t = &v["sessions"][0]["transcript"];
        assert!(
            t["apiErrorStatus"].is_null(),
            "None 应出线为 null，实际为 {:?}",
            t["apiErrorStatus"]
        );
        let sub = &v["sessions"][0]["subagents"][0];
        assert!(sub["parentAgentId"].is_null(), "顶层 agent 的 parentAgentId 应为 null");
        assert!(sub["lastStopReason"].is_null());
    }

    /// 空集合出线成 `[]` 而不是 null——前端会直接 `.length` / `.map`。
    #[test]
    fn empty_collections_serialize_as_arrays() {
        let mut r = full_report();
        r.sessions.clear();
        r.warnings.clear();
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["sessions"].is_array());
        assert!(v["warnings"].is_array());

        let mut r2 = full_report();
        r2.sessions[0].subagents.clear();
        r2.sessions[0].transcript.as_mut().unwrap().last_tool_names.clear();
        let v2 = serde_json::to_value(&r2).unwrap();
        assert!(v2["sessions"][0]["subagents"].is_array());
        assert!(v2["sessions"][0]["transcript"]["lastToolNames"].is_array());
    }
}
