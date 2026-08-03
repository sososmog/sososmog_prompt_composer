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
 * @property {'no-config-dir'|'roster-unreadable'|'roster-entry-invalid'|'transcript-unreadable'|'transcript-unparsable'|'subagents-unreadable'|'pid-reused'|'jobs-unreadable'|'job-entry-invalid'|'codex-rollout-unreadable'|'codex-rollout-unparsable'|'antigravity-db-unreadable'|'antigravity-db-unparsable'} code
 * @property {string} detail
 */

/**
 * @typedef {Object} AgentSession
 * @property {'claude'|'codex'|'antigravity'} provider  这张卡片是谁家的（v3 起）。
 *                                不是可选——每个会话必然属于某一家，"不知道"不是
 *                                有效状态。Codex 与 Antigravity 会话恒为 pid:null /
 *                                liveness:'no-process' / proc:null / subagents:[] /
 *                                job:null，那不是缺陷，是数据源就没有这些东西
 * @property {string|null} install  同一 provider 下的安装 channel（v4 起）。
 *                                只有 Antigravity 有值（'antigravity' |
 *                                'antigravity-ide'），其余恒 null。
 *                                **要拼进 keyed 更新的身份键**，见 sessionKey()
 * @property {number|null} pid    null = 这个会话没有对应进程（daemon 托管的后台
 *                                会话，或任何 Codex 会话），不是"没采到"。
 *                                前端不读它，留在这里是为了让契约完整
 * @property {string} sessionId
 * @property {string} name
 * @property {string} cwd
 * @property {string} entrypoint
 * @property {string} kind                'interactive' | 'background'
 * @property {number} startedAt           ms epoch
 * @property {string} cliVersion
 * @property {'alive'|'pid-reused'|'no-process'} liveness
 * @property {ProcMetrics|null} proc
 * @property {TranscriptDigest|null} transcript  null = 空会话（已启动未开始），**不是错误**
 * @property {SubagentDigest[]} subagents
 * @property {JobDigest|null} job
 */

/**
 * @typedef {Object} ProcMetrics
 * @property {number|null} cpuPercent  已归一化到 0–100。**null = 还不知道，不是 0%**：
 *                                     差值算法要两次采样，首次扫描没有基准可减。
 *                                     0% 是个具体结论（真的闲着），null 是没有结论。
 * @property {number} memoryMb         内存和运行时长不需要基准，采到就有值
 * @property {number} runTimeSec
 */

/**
 * @typedef {Object} TranscriptDigest
 * @property {number} sizeBytes
 * @property {number} mtimeMs                最可靠的"最后活动时间"
 * @property {string|null} aiTitle
 * @property {string|null} lastPrompt
 * @property {string|null} activitySummary  「现在在干什么」的一句人话（v4 起）。
 *                                目前只有 Antigravity 侧有——那是它自己写给它的
 *                                UI 看的 toolSummary，不是我们编的。用在标题位的
 *                                兜底上，见 cardTitle()
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
 * @property {number|null} contextWindow     模型上下文窗口（v3 起）。**只有 Codex 有**，
 *                                           Claude 侧恒为 null——jsonl 区分不出 200k
 *                                           还是 1M 窗口，显示错的百分比比不显示更糟。
 *                                           有值时才算占用率
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

/**
 * 必须与 src-tauri/src/fleet/types.rs 的 SCHEMA_VERSION 一致。
 * fleet.test.js 有一条测试直接读那个文件比对，改漏一边会立刻变红。
 *
 * v3：接入 Codex，`AgentSession.provider` 与 `TranscriptDigest.contextWindow`。
 * v4：接入 Antigravity，`Provider` 加 `antigravity`、`AgentSession.install`、
 *     `TranscriptDigest.activitySummary`。
 */
export const SCHEMA_VERSION = 4;

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

/**
 * 小球状态点的显示门槛：归约后的状态优先级 >= 这个值才点亮。
 *
 * 取 3 = working，也就是只有 failed / needs-input / working 三档会亮点。
 * 门槛不设成 0（永远亮）的理由：小球是**长时间挂着**的形态，如果它上面
 * 永远有个点，点就退化成装饰，"有事发生"这条信息就被稀释掉了——恰恰是
 * 加这个点唯一想解决的问题。fresh（已启动·未开始）和 idle 这时候展开
 * 浮窗也没有东西可看，不值得打断你。
 *
 * 顺带一个视觉上的巧合：这三档正好对应 danger / attention / active 三个
 * 有饱和度的 tone，点在小球上颜色够扎眼；muted / unknown 那两档本来就是
 * 灰的，画上去也几乎看不出亮没亮。
 */
export const ORB_DOT_MIN_PRIORITY = 3;

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

/* ============================================================
 * 状态推断
 * ------------------------------------------------------------
 * 算法见 docs/agent-fleet.md §3.4。会话与 subagent 共用同一段
 * "transcript 尾部判定"核心逻辑（statusCodeFromDigest），区别只在
 * 外层短路：会话多了 liveness / job / 空 transcript 三个前置分支，
 * subagent 没有这些包装，直接把自己的字段喂给核心判定。
 * ============================================================ */

/**
 * 把状态码展开成完整的 {@link AgentStatus}。
 * 单拎出来是因为 deriveStatus / deriveSubagentStatus 都要在拿到 code
 * 之后做这一步，本身没有分支，不值得重复写两遍。
 * @param {StatusCode} code
 * @returns {AgentStatus}
 */
function buildStatus(code) {
  const def = STATUS_DEFS[code];
  return { code, label: def.label, glyph: def.glyph, tone: def.tone, animated: def.animated };
}

/**
 * job.state → 状态码。job 是官方/采集层已经算好的权威口径，存在就不用
 * 再看 transcript 猜——阶段 4 的后台会话不一定还在持续写主 transcript。
 * @param {string|null|undefined} state
 * @returns {StatusCode}
 */
function mapJobState(state) {
  switch (state) {
    case 'working':
      return 'working';
    case 'blocked':
      return 'needs-input';
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      // 覆盖"未知取值"和"字段缺失（null）"两种情况：宁可显示未知，不猜。
      return 'unknown';
  }
}

/**
 * 状态判定的核心：吃一份"transcript 形态"的摘要，判它是
 * working / needs-input / idle / failed / unknown 里的哪个。
 *
 * 会话与 subagent 共用这段逻辑——SubagentDigest 是 TranscriptDigest 的
 * 同构子集，缺 hasApiError 字段，所以 `d.hasApiError` 对 subagent 恒为
 * undefined，对应分支自然不会触发，不需要为 subagent 单独写一份判定。
 *
 * @param {{lastRole: ('user'|'assistant'|null|undefined), hasApiError?: boolean,
 *          mtimeMs?: (number|null), lastMsgTsMs?: (number|null), lastStopReason?: (string|null)}} d
 * @param {number} scannedAt
 * @param {number} idleMs
 * @param {number|null|undefined} fallbackTs   age 基准的最后一道退路
 *   （会话传 session.startedAt；subagent 没有这一层退路，传 null）
 * @returns {StatusCode}
 */
function statusCodeFromDigest(d, scannedAt, idleMs, fallbackTs) {
  if (d.lastRole == null) return 'unknown'; // 尾部窗口一条消息都没解析出来

  // ⚠️ 必须排在 age / stopReason 判断之前：API 出错的行 stop_reason 实测是
  // stop_sequence 或 refusal，光看 stopReason 会把出错误判成"正常收尾等你回话"。
  if (d.hasApiError) return 'failed';

  const base = d.mtimeMs ?? d.lastMsgTsMs ?? fallbackTs;
  if (base == null) return 'unknown'; // 三级退路全落空（只有 subagent 缺 startedAt 会走到这里）

  // 负数原样参与比较，不做 clamp——负数必然小于 idleMs，不会被误判成 idle。
  // （age 为负发生在 Rust 时钟 vs JS 时钟有微小偏差时，这里只是不让它出错，
  // 真正"显示成什么样"是 formatAgo 的职责。）
  const age = scannedAt - base;
  if (age > idleMs) return 'idle';

  if (d.lastRole === 'assistant') {
    // tool_use：模型还要接着调用工具；stopReason 为 null：消息还在途、没收完。
    // 这两种都算"在动"。其余（end_turn / stop_sequence / refusal）才是真的在等你说话。
    return d.lastStopReason === 'tool_use' || d.lastStopReason == null ? 'working' : 'needs-input';
  }
  if (d.lastRole === 'user') return 'working'; // tool_result 落地或刚提问，模型这一刻在动

  return 'idle';
}

/**
 * 单会话状态推断。见 docs/agent-fleet.md §3.4。
 * @param {AgentSession} session
 * @param {number} scannedAt
 * @param {{idleMs?: number}} [opts]
 * @returns {AgentStatus}
 */
export function deriveStatus(session, scannedAt, opts = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS;

  // 防御性分支：pid 复用的会话正常不该进列表（采集层已经在 liveness 上打了标）。
  // 万一漏网也不能冒充正常状态。
  if (session.liveness === 'pid-reused') return buildStatus('unknown');

  // job 是权威来源，存在就不看 transcript——见 mapJobState 注释。
  if (session.job) return buildStatus(mapJobState(session.job.state));

  // 已启动但一句话没说，是实测存在的真实状态，不是错误。
  if (!session.transcript) return buildStatus('fresh');

  return buildStatus(statusCodeFromDigest(session.transcript, scannedAt, idleMs, session.startedAt));
}

/**
 * subagent 状态推断，核心判据与 deriveStatus 相同，但没有
 * liveness / job / transcript 三层包装——字段直接在 sub 上。
 * @param {SubagentDigest} sub
 * @param {number} scannedAt
 * @param {{idleMs?: number}} [opts]
 * @returns {AgentStatus}
 */
export function deriveSubagentStatus(sub, scannedAt, opts = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS;
  return buildStatus(statusCodeFromDigest(sub, scannedAt, idleMs, null));
}

/* ============================================================
 * subagent 树重建
 * ============================================================ */

/**
 * @typedef {SubagentDigest & { depth: number, children: SubagentTreeNode[] }} SubagentTreeNode
 */

/** @param {{agentId: string}} a @param {{agentId: string}} b */
function compareId(a, b) {
  if (a.agentId < b.agentId) return -1;
  if (a.agentId > b.agentId) return 1;
  return 0;
}

/**
 * 兄弟节点排序：最近活动的排前面，一眼看出哪个 subagent 还在动。
 * mtimeMs 相同（或都缺失）时按 agentId 升序，保证同一份数据每次渲染
 * 顺序一致，不会因为排序不稳定在轮询刷新时跳位。
 * @param {SubagentTreeNode[]} list
 */
function sortSiblingsInPlace(list) {
  list.sort((a, b) => {
    if (a.mtimeMs == null && b.mtimeMs == null) return compareId(a, b);
    if (a.mtimeMs == null) return 1; // null 排最后
    if (b.mtimeMs == null) return -1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs; // 降序
    return compareId(a, b);
  });
  for (const node of list) sortSiblingsInPlace(node.children);
}

/**
 * 把扁平的 subagent 列表重建成树。
 *
 * 三条防御性处理，全部对应"正常不该出现，但要保证不出事"的情况：
 * - 重复 agentId：保留第一个出现的，后面的整条丢弃（而不是覆盖）。
 * - 父 id 指向不存在的 agent：这个 agent 不该从列表里消失，归入 orphans。
 * - 互相指父成环（A→B→A）：用三色染色法一次遍历判定，环内节点全部归入
 *   orphans；挂在"环内节点"下面的节点也没有真正的根可挂，同样归入
 *   orphans（宁可散落展示，也不要静默丢弃）。
 *
 * depth 完全由树结构算出，不读 spawnDepth——spawnDepth 可能缺失，而且
 * 一旦父子关系被上面任何一条防御性规则改写，spawnDepth 记的原始深度
 * 就不准了。
 *
 * @param {SubagentDigest[]} subagents
 * @returns {{ roots: SubagentTreeNode[], orphans: SubagentTreeNode[] }}
 */
export function buildSubagentTree(subagents) {
  /** @type {Map<string, SubagentTreeNode>} */
  const byId = new Map();
  for (const sub of subagents) {
    if (!byId.has(sub.agentId)) {
      byId.set(sub.agentId, { ...sub, depth: 0, children: [] });
    }
  }

  // 环检测：经典三色染色法，一次遍历。每个节点最多被推入调用栈一次
  // （一旦命中 'done' 就立即停止），所以就算输入本身构造成一条长环，
  // 也是 O(n) 收敛，不会挂死。
  const inCycle = new Set();
  /** @type {Map<string, 'visiting'|'done'>} */
  const colorOf = new Map();
  for (const startId of byId.keys()) {
    if (colorOf.get(startId)) continue;
    const stack = [];
    let cur = startId;
    while (cur != null && byId.has(cur) && colorOf.get(cur) !== 'done') {
      if (colorOf.get(cur) === 'visiting') {
        const idx = stack.indexOf(cur);
        for (let i = idx; i < stack.length; i += 1) inCycle.add(stack[i]);
        break;
      }
      colorOf.set(cur, 'visiting');
      stack.push(cur);
      cur = byId.get(cur).parentAgentId;
    }
    for (const id of stack) colorOf.set(id, 'done');
  }

  const roots = [];
  const orphans = [];
  for (const [id, node] of byId) {
    if (inCycle.has(id)) {
      orphans.push(node);
      continue;
    }
    const parentId = node.parentAgentId;
    if (parentId == null) {
      roots.push(node);
    } else if (byId.has(parentId) && !inCycle.has(parentId)) {
      byId.get(parentId).children.push(node);
    } else {
      // 父不存在，或父本身在环里（因而已经被摘出正常树）——都没有真正
      // 的根可挂，归入 orphans 而不是丢弃。
      orphans.push(node);
    }
  }

  const assignDepth = (node, depth) => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const node of roots) assignDepth(node, 1);
  for (const node of orphans) assignDepth(node, 1);

  sortSiblingsInPlace(roots);
  sortSiblingsInPlace(orphans);

  return { roots, orphans };
}

/* ============================================================
 * 分组 / 归约 / 角标
 * ============================================================ */

/**
 * 一个会话的"最后活动时间"。UI 层显示"多久前"要用同一个口径，
 * 所以单独 export 出来，不让两处各写一份、慢慢长歪。
 * @param {AgentSession} session
 * @returns {number}
 */
export function lastActivityMs(session) {
  const t = session.transcript;
  // job.updatedAt 排在 startedAt 之前：后台会话常常没有 transcript，那时若直接
  // 落到 startedAt，一个刚刚还在变状态的任务会显示成"3 小时前"——而 updatedAt
  // 正是官方维护的"这个任务最后一次状态变化"。
  return t?.mtimeMs ?? t?.lastMsgTsMs ?? session.job?.updatedAt ?? session.startedAt;
}

/**
 * 这个会话该不该出现在列表 / 角标 / 小球状态点里。
 *
 * 判据从"必须是 alive"改成"排除 pid-reused"，是 SCHEMA 2 带来的：daemon 托管的
 * 后台会话（`/loop`、`--bg`）根本没有进程可言，liveness 是 `no-process`，而它们
 * 恰恰是最需要被看见的一类——起了就没人盯着，全靠面板告诉你它是不是卡住了。
 *
 * 唯一要排除的仍然只有 `pid-reused`：那是"有个进程，但我们不确定它还是不是
 * 原来那个"，显示出来会误导（采集层已经为它单独报了 warning）。
 *
 * @param {AgentSession} session
 * @returns {boolean}
 */
export function isListedSession(session) {
  return session.liveness !== 'pid-reused';
}

/** @param {AgentSession} a @param {AgentSession} b */
function compareByActivityThenName(a, b) {
  const diff = lastActivityMs(b) - lastActivityMs(a); // 降序：最近活动的在前
  if (diff !== 0) return diff;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * @typedef {Object} SessionGroup
 * @property {StatusCode} key
 * @property {string} label
 * @property {AgentSession[]} items
 */

/**
 * 按状态分组，组的顺序固定为 GROUP_ORDER（needs-input 最前）。
 * 先过滤掉非 alive 的会话——pid-reused 是采集层的防御性标记，
 * 不该出现在任何面向用户的列表里。
 * @param {AgentSession[]} sessions
 * @param {number} scannedAt
 * @param {{idleMs?: number}} [opts]
 * @returns {SessionGroup[]}
 */
export function groupSessions(sessions, scannedAt, opts = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS;
  /** @type {Map<StatusCode, AgentSession[]>} */
  const buckets = new Map(GROUP_ORDER.map((code) => [code, []]));

  for (const session of sessions) {
    if (!isListedSession(session)) continue;
    const { code } = deriveStatus(session, scannedAt, { idleMs });
    buckets.get(code).push(session);
  }

  const groups = [];
  for (const code of GROUP_ORDER) {
    const items = buckets.get(code);
    if (items.length === 0) continue; // 空组不出现在结果里
    items.sort(compareByActivityThenName);
    groups.push({ key: code, label: STATUS_DEFS[code].label, items });
  }
  return groups;
}

/**
 * 需要你回话的会话数，给 tab 角标用。
 * @param {AgentSession[]} sessions
 * @param {number} scannedAt
 * @param {{idleMs?: number}} [opts]
 * @returns {number}
 */
export function countNeedsInput(sessions, scannedAt, opts = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS;
  let count = 0;
  for (const session of sessions) {
    if (!isListedSession(session)) continue;
    if (deriveStatus(session, scannedAt, { idleMs }).code === 'needs-input') count += 1;
  }
  return count;
}

/**
 * 把所有会话的状态归约成一个，给悬浮小球的状态点用。
 * 空列表（没有任何 alive 会话）视为"没什么好看的"，落在 idle。
 * @param {AgentSession[]} sessions
 * @param {number} scannedAt
 * @param {{idleMs?: number}} [opts]
 * @returns {{ code: StatusCode, tone: StatusTone }}
 */
export function reduceFleetTone(sessions, scannedAt, opts = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS;
  let best = null;
  for (const session of sessions) {
    if (!isListedSession(session)) continue;
    const status = deriveStatus(session, scannedAt, { idleMs });
    if (!best || TONE_PRIORITY[status.code] > TONE_PRIORITY[best.code]) best = status;
  }
  if (!best) return { code: 'idle', tone: STATUS_DEFS.idle.tone };
  return { code: best.code, tone: best.tone };
}

/* ============================================================
 * 格式化
 * ------------------------------------------------------------
 * 纯字符串拼接，唯一的坑是各个阈值都是"左闭右开"（用 < 不用 <=），
 * 单测里把每个边界值都钉住。
 * ============================================================ */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * @param {number} ms   已经过去的毫秒数（调用方自己算 scannedAt - mtimeMs）
 * @returns {string}
 */
export function formatAgo(ms) {
  const v = ms < 0 ? 0 : ms; // 负数（时钟误差）当刚刚，不显示"-3秒前"这种反直觉的话
  if (v < 5000) return '刚刚';
  if (v < MS_PER_MINUTE) return `${Math.floor(v / MS_PER_SECOND)}秒前`;
  if (v < MS_PER_HOUR) return `${Math.floor(v / MS_PER_MINUTE)}分钟前`;
  if (v < MS_PER_DAY) return `${Math.floor(v / MS_PER_HOUR)}小时前`;
  return `${Math.floor(v / MS_PER_DAY)}天前`;
}

/**
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const k = Math.round(n / 1000);
    // 999999 会被四舍五入成 1000，显示"1000k"就像是坏了（该进位却没换单位）。
    // 这是阈值用 < 1000000 判断、但取整发生在判断之后带来的必然缝隙：
    // 判断看的是原值，取整可能把它推过单位边界。所以进位后再检查一次。
    if (k >= 1000) return `${(k / 1000).toFixed(1)}M`;
    return `${k}k`;
  }
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * 上下文占用的显示文本。
 *
 * 两种形态，取决于**知不知道窗口有多大**：
 * - 知道（Codex）：`166k/258k (64%)`
 * - 不知道（Claude）：`166k tokens` —— 维持原样
 *
 * Claude 侧之所以给不出窗口，见 types.rs 里 `context_tokens` 的注释：
 * jsonl 里 `message.model` 记的是 `claude-opus-5`，而用户实际可能设的是
 * `opus[1m]`，从记录里区分不出 200k 还是 1M。显示错的百分比比不显示更糟。
 *
 * 百分比**不做 clamp**：真超过 100% 就如实显示。那是"上下文该压缩了"的信号，
 * 抹平它等于把一个用户需要知道的事实藏起来。
 *
 * @param {number|null|undefined} tokens
 * @param {number|null|undefined} window  模型上下文窗口，只有 Codex 有
 * @returns {string}
 */
export function formatContext(tokens, window) {
  // window 为 0 时同样落到这条分支——除零会算出 Infinity%，
  // 而"窗口是 0"本身就是个无意义的值，当作不知道处理。
  if (tokens == null || window == null || window <= 0) {
    return formatTokens(tokens) + ' tokens';
  }
  const pct = Math.round((tokens / window) * 100);
  return formatTokens(tokens) + '/' + formatTokens(window) + ' (' + pct + '%)';
}

/**
 * @param {number|null|undefined} pct   已归一化到 0–100
 * @returns {string}
 */
export function formatCpu(pct) {
  if (pct == null) return '—';
  if (pct === 0) return '0%';
  if (pct < 1) return '<1%'; // 低占用直接显示 0% 会丢信息（"真的没在跑" vs "只是很轻"）
  return `${Math.round(pct)}%`;
}
