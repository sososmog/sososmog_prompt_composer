/* ============================================================
 * fleet.js —— Agent Fleet 的纯判定层
 * ------------------------------------------------------------
 * 零 DOM、零 Tauri、零副作用。输入是 Rust 采集层返回的 FleetReport，
 * 输出是"这个 agent 处于什么状态、怎么排序、怎么显示"。
 *
 * 为什么判定逻辑放在 JS 而不是跟采集一起放 Rust：这部分逻辑最绕（状态推断
 * 有七八个分支、树重建要处理环和孤儿），最该被 vitest 密集覆盖；而采集那部分
 * 是进程存活校验和 CPU 采样，只能在 Rust 做。切在"事实"与"判断"之间。
 *
 * 契约定义见 src-tauri/src/fleet/types.rs（唯一真源）与 docs/agent-fleet.md §3。
 * 改契约必须同时改三处并递增 SCHEMA_VERSION。
 * ============================================================ */

/* ============================================================
 * 契约类型（与 src-tauri/src/fleet/types.rs 一一对应）
 * ============================================================ */

/**
 * @typedef {Object} FleetReport
 * @property {number} schemaVersion
 * @property {number} scannedAt   扫描时刻 ms epoch。**算 age 的唯一基准**，
 *                                绝不用 Date.now()——Rust 与 JS 时钟的微小差异
 *                                会算出负数 age，显示成"-3秒前"。
 * @property {string} configDir
 * @property {AgentSession[]} sessions
 * @property {FleetWarning[]} warnings
 */

/**
 * @typedef {Object} FleetWarning
 * @property {'no-config-dir'|'roster-unreadable'|'roster-entry-invalid'|'transcript-not-found'|'transcript-unreadable'|'transcript-unparsable'|'subagents-unreadable'|'cpu-unavailable'|'pid-reused'} code
 * @property {string} detail
 */

/**
 * @typedef {Object} AgentSession
 * @property {number} pid
 * @property {string} sessionId
 * @property {string} name
 * @property {string} cwd
 * @property {string} entrypoint
 * @property {string} kind                'interactive' | 'background'
 * @property {number} startedAt           ms epoch
 * @property {string} cliVersion
 * @property {'alive'|'pid-reused'} liveness
 * @property {ProcMetrics|null} proc
 * @property {TranscriptDigest|null} transcript  null = 空会话（已启动未开始），**不是错误**
 * @property {SubagentDigest[]} subagents
 * @property {JobDigest|null} job
 */

/**
 * @typedef {Object} ProcMetrics
 * @property {number} cpuPercent   已归一化到 0–100
 * @property {number} memoryMb
 * @property {number} runTimeSec
 */

/**
 * @typedef {Object} TranscriptDigest
 * @property {number} sizeBytes
 * @property {number} mtimeMs                最可靠的"最后活动时间"
 * @property {string|null} aiTitle
 * @property {string|null} lastPrompt
 * @property {string|null} gitBranch
 * @property {string|null} model
 * @property {string|null} effort
 * @property {'user'|'assistant'|null} lastRole
 * @property {string|null} lastStopReason    实测值 tool_use / end_turn / stop_sequence / refusal；
 *                                           null = 消息还在途 → 判 working。
 *                                           **不能只靠它判"在等用户"**：API 出错的行
 *                                           stop_reason 是 stop_sequence 或 refusal，
 *                                           必须先看 hasApiError。
 * @property {'tool_use'|'tool_result'|'text'|'thinking'|null} lastTailKind
 * @property {string[]} lastToolNames
 * @property {number|null} lastMsgTsMs
 * @property {boolean} hasApiError           主信号：顶层 isApiErrorMessage === true
 * @property {string|null} apiErrorStatus    源数据里是数字且可能缺失，采集侧已归一化成字符串
 * @property {string|null} apiErrorCode      如 oauth_org_not_allowed / invalid_request
 * @property {number|null} contextTokens     官方口径：input + cache_creation + cache_read
 * @property {number} parseErrors            >0 = 格式可能漂移了
 */

/**
 * @typedef {Object} SubagentDigest
 * @property {string} agentId
 * @property {string|null} agentType
 * @property {string|null} description       现成的"这个 agent 在干什么"
 * @property {string|null} parentAgentId     顶层 agent 为 null
 * @property {number|null} spawnDepth
 * @property {number|null} mtimeMs
 * @property {number|null} sizeBytes
 * @property {'user'|'assistant'|null} lastRole
 * @property {string|null} lastStopReason
 * @property {'tool_use'|'tool_result'|'text'|'thinking'|null} lastTailKind
 * @property {number|null} lastMsgTsMs
 * @property {number|null} contextTokens
 */

/**
 * @typedef {Object} JobDigest
 * @property {string} jobId
 * @property {string|null} state             'working' | 'blocked' | 'done' | 'failed' | 'stopped'
 * @property {string|null} detail            官方算好的一句人话摘要
 * @property {string|null} tempo
 * @property {number|null} tokens
 * @property {{tasks:number, queued:number}|null} inFlight
 * @property {string|null} intent
 * @property {number|null} updatedAt
 */

/**
 * 状态判定结果。
 * @typedef {Object} AgentStatus
 * @property {StatusCode} code
 * @property {string} label      中文标签
 * @property {string} glyph      与 Claude Code 官方 agent view 一致的图标字符
 * @property {StatusTone} tone   驱动配色
 * @property {boolean} animated  是否需要脉冲动画
 */

/**
 * @typedef {'needs-input'|'working'|'failed'|'fresh'|'idle'|'completed'|'stopped'|'unknown'} StatusCode
 */

/**
 * @typedef {'attention'|'active'|'danger'|'muted'|'ok'|'unknown'} StatusTone
 */

/* ============================================================
 * 常量
 * ============================================================ */

/** 必须与 src-tauri/src/fleet/types.rs 的 SCHEMA_VERSION 一致。 */
export const SCHEMA_VERSION = 1;

/**
 * 多久没有写入算"空闲"。
 *
 * 5 分钟是权衡：太短会把"模型正在长时间思考/跑长命令"误判成空闲；
 * 太长会让真正已经放着不管的会话一直显示成在等你，稀释角标的意义。
 */
export const IDLE_MS = 5 * 60 * 1000;

/**
 * 状态定义表。图标沿用 Claude Code 官方 agent view 的视觉语言，
 * 这样浮窗里看到的符号和你在终端里看到的语义完全一致。
 *
 * 顺序即分组顺序：需要你回话的排最前面（抄官方 + Vibe Kanban 的
 * "Needs Attention 在 Running 之前"）。
 */
export const STATUS_DEFS = Object.freeze({
  'needs-input': { label: '等你回话', glyph: '✻', tone: 'attention', animated: false },
  working: { label: '运行中', glyph: '✽', tone: 'active', animated: true },
  failed: { label: '出错', glyph: '✗', tone: 'danger', animated: false },
  fresh: { label: '已启动 · 未开始', glyph: '∙', tone: 'muted', animated: false },
  idle: { label: '空闲', glyph: '∙', tone: 'muted', animated: false },
  completed: { label: '已完成', glyph: '✓', tone: 'ok', animated: false },
  stopped: { label: '已停止', glyph: '⊘', tone: 'muted', animated: false },
  unknown: { label: '状态未知', glyph: '?', tone: 'unknown', animated: false },
});

/** 分组渲染顺序。就是 STATUS_DEFS 的键序，显式列出来免得依赖对象键序。 */
export const GROUP_ORDER = Object.freeze([
  'needs-input',
  'working',
  'failed',
  'fresh',
  'idle',
  'completed',
  'stopped',
  'unknown',
]);

/**
 * 把多个会话归约成一个状态时的优先级（数字大的赢）。
 * 给悬浮小球那一个状态点用。借 Clawd on Desk 的 state-priority.js 思路。
 */
export const TONE_PRIORITY = Object.freeze({
  failed: 5,
  'needs-input': 4,
  working: 3,
  fresh: 2,
  idle: 1,
  completed: 1,
  stopped: 0,
  unknown: 0,
});

/* ============================================================
 * 版本守卫
 * ============================================================ */

/**
 * 校验采集层返回的报告是否可用。
 *
 * 存在的意义主要在**开发期**：`tauri dev` 下前端热重载了但 Rust 二进制还是旧的，
 * schemaVersion 就会对不上。此时必须显式报错，而不是继续渲染出一堆 undefined
 * 然后让人去猜哪里坏了。
 *
 * @param {unknown} report
 * @returns {{ ok: true, report: FleetReport } | { ok: false, reason: 'not-an-object'|'schema-mismatch', detail: string }}
 */
export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, reason: 'not-an-object', detail: '采集层没有返回对象' };
  }
  const got = report.schemaVersion;
  if (got !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'schema-mismatch',
      detail: `契约版本不一致：前端期望 ${SCHEMA_VERSION}，采集层返回 ${got}`,
    };
  }
  return { ok: true, report: /** @type {FleetReport} */ (report) };
}
