# Agent Fleet Monitor 实现方案

浮窗新增一个 tab，展示本机在跑的 AI coding agent：横向是多个 Claude Code 会话，纵向是每个会话内部的 subagent 树。

- 分支：`feat/agent-fleet-monitor`
- 定位：**观察者**（observe, never control）。只读展示，不 spawn、不终止、不拦权限。
- 铁律：**在 `~/.claude` 里零脚印，只读不写。**

## 进度

| 阶段 | 状态 |
|---|---|
| P1–P5 准备 | ✅ 完成 |
| 阶段 0 轨 A（Rust 采集层 A1–A8） | ✅ 完成，含真机验证 |
| 阶段 0 轨 B（JS 纯函数 B1–B5） | ✅ 完成 |
| 阶段 1 轨 C（浮窗 UI） | ✅ 完成，含真浏览器冒烟 + 用户真机验收 |
| 阶段 2 subagent 树 | ✅ 完成，含真机验证 |
| 阶段 3 收尾 | ✅ 完成 |
| 阶段 4 可选增强 | 🔶 E2/E3/E5 完成；E1 待决策，E6/E7/E8 待触发，E4 未开始 |

当前规模：Rust 88 个单测 + 5 个 sysinfo 探针 + 1 个默认跳过的真机诊断测试；
前端 670 个测试 + 3 个真浏览器冒烟脚本 + 1 个对比度校验脚本（10 项）；
clippy 0 新增警告；lint 0/0。

**D4 全量回归全绿**：前端 654 单测 / lint 0-0 / 对比度 4 项达标 / 主冒烟 30 项 /
CSP 冒烟 32 项 / Agent tab 冒烟 / cargo test 83+4 / clippy 0 新增。
另用本机真实存量存档（`settings` 里没有 `fleet` 键）过了一遍 `normalizeState`：
补上默认值且其它设置与内容一个没丢；`enabled` 的 10 种取值里只有真正的 `false`
会关，其余 9 种脏值一律回落 `true`；`fleet` 键的 7 种残缺形态都不抛异常。

**真机验证累计结果**（`cargo test --test fleet_real_machine -- --ignored --nocapture`）：

- 会话识别：多轮都是名册里的会话全部识别、存活校验全通过；无 transcript 的会话
  正确落到「已启动 · 未开始」（这是实测最常见的正常状态，不是错误）
- 字段读取：分支 / 模型 / 思考档位 / 尾部状态全对，`parse_errors` 一直是 0
- subagent 树：单会话 11 个子 agent 的两层树重建正确，缩进（按 `parentAgentId` 算）
  与 `meta.json` 的 `spawnDepth` 完全吻合；两个会话共 15 个子 agent 全部读出
- CPU：与 `Get-Process` 累计 CPU 秒数在 10 秒窗口上算出的真值同量级
  （0.602% vs 我们的 0.2%，差异来自窗口长短——claude 是突发型负载）

---

## 0. 已定的四个决策

| # | 决策 | 取值 | 理由 |
|---|---|---|---|
| 1 | CPU 口径 | 归一化到 0–100%（除以核心数），**含工具子进程**（E5） | 与任务管理器一致。⚠️ **算法不是 `cpu_usage() / ncpu`** —— P3 实测那个 API 在 Windows 上是坏的，改成自己用 `accumulated_cpu_time()` 差值算，见 §1.3 与 §5 轨A。子进程要算进来，否则 claude 跑 Bash 时面板显示 0.1% 而机器风扇狂转 |
| 2 | idle 阈值 | 5 分钟无写入 | 常量 `IDLE_MS`，集中在 fleet.js 一处 |
| 3 | 默认 tab | 记住上次停留 | localStorage `composer-fw-tab`，与 `composer-fw-autopaste` 同套路 |
| 4 | subagent 树 | 做，独立成阶段 2 | 真正的"多 agent"；调研的 13 个项目无人做过 |

---

## 1. 调研结论摘要（决定了下面所有设计）

### 1.1 两条路线，我们选哪条

| | Clawd on Desk（5718★，Electron） | Claw-Kanban（72★） | **我们** |
|---|---|---|---|
| 角色 | 观察者 | 驱动者（自己 spawn） | **观察者** |
| 数据来源 | hooks HTTP 上报 + transcript 尾部 | spawn 拿 stdout | **纯读本地文件** |
| 改用户配置 | 会（往 settings.json 注册 statusLine） | 不 | **不** |
| 显示 CPU | 否 | 否 | **是** |
| 显示 git 分支 | 否 | 否 | **是** |
| 显示 subagent 树 | 只显示计数 | 否 | **是（差异化点）** |

不走 hooks 的硬理由（来自 Clawd 自己的 known-limitations.md）：Clawd 没开着时，Claude Code 的权限 hook 拿到 `ECONNREFUSED`，**结果 Claude Code 直接拒绝了工具调用**，而不是回落内置提示。任何把自己插进 Claude Code 关键路径的设计都有这个失败模式。纯读文件没有这个风险——我们挂掉了，Claude Code 毫无感知。

### 1.2 抄谁的设计

- **状态语义与视觉**：抄 Claude Code 官方 agent view 规范（`code.claude.com/docs/en/agent-view`）。好处是浮窗里的图标语义和终端里完全一致。
- **分组顺序**：抄官方 + Vibe Kanban（27.6k★）：`Needs input` 排在 `Working` 前面。最需要你注意的在最上面。
- **卡片字段**：抄 Happy（22.9k★）的 `模型 · 状态 · 活动摘要` 单行范式。
- **归约到一个点**：抄 Clawd 的 `state-priority.js` 优先级表（给悬浮小球用）。
- **不抄**：Claude Squad / CCManager 的 tmux 抓屏 + 硬编码 TUI 文案匹配（CCManager 判 busy 靠匹配字符串 `"esc to interrupt"`）。上游改一个字就失效。

### 1.3 已实测确认的坑（不是假想）

| 坑 | 后果 | 对策 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` 能整体搬走 `~/.claude` | 写死 home 就找不到数据 | 优先读该环境变量 |
| Windows 上 CLI 是 `claude.exe`，Claude 桌面版**也叫** `Claude.exe`（+9 个 Electron 子进程） | 按进程名匹配会混入桌面版 | 不按名字找，反过来从 roster 拿 pid |
| macOS 进程名显示成版本号（如 `2.0.53`）而非 `claude` | 同上 | 同上 |
| sysinfo 的 `Process::cwd()` 在 Windows 永远返回空 | 拿不到工作目录 | cwd 从 roster 文件拿 |
| **sysinfo 0.36.1 的 `Process::cpu_usage()` 在 Windows 上是坏的**（P3 实测：烧满 1 核只返回 0.0003~0.002，四种姿势全错，差五个数量级） | CPU 永远显示 0% —— 不崩、不报错，最难发现的那类 bug | 自己用 `accumulated_cpu_time()` 差值算，见 §5 轨A |
| 项目 `rust-version = "1.77.2"` 会让 cargo 的 MSRV 感知解析把 sysinfo 挡在 0.36.1（最新 0.39.6） | 想当然按 0.39 的 API 写会编不过 | 就着 0.36.1 写；不为此抬 MSRV（项目级决定） |
| 项目目录名编码不可逆（`/a/b-c` 与 `/a/b/c` 编码后相同；且大小写不统一，实测同时存在 `C--Users-...` 和 `c--Users-...`） | 按 cwd 推算 jsonl 路径会算错 | 不推算，遍历 `projects/*/` 找 `<sessionId>.jsonl` |
| jsonl 时间戳是 UTC（`...T07:29:57.407Z`），本机 UTC+8 | 与本地时间直接比会差 8 小时 | Rust 侧统一解析成 ms epoch |
| `claude agents --json` 实测单次 **1.1–1.9 秒**，且承诺的 `status`/`waitingFor` 在 VS Code 宿主会话里**全部缺失** | 不能用来轮询 | 不用（连兜底都先不做） |
| jsonl 里**没有** `costUSD` 字段 | 算不出成本 | 不显示成本（见 1.4） |
| `message.model` 是 `claude-opus-5`，但用户设的是 `opus[1m]` | 区分不出 200k / 1M 上下文窗口 | **只显示绝对 token，不显示百分比** |
| Tauri v2 **非 async 命令跑在主线程** | 文件 I/O + sysinfo 会卡 UI | 命令必须 `async` + `spawn_blocking`；且托管 `Arc<FleetState>` 而非 `FleetState`（`State<'_, T>` 是借用的，move 不进 `spawn_blocking`） |
| 社区教程里的 `stop_hook_active` 字段官方已删除 | 照抄会失效 | 我们不用 hooks，无影响 |
| **`effort` 只在 assistant 行有**（`gitBranch` 在 user 行也有） | 尾部恰好是 `tool_result` 时 effort 变 null，同一会话的思考档位会随轮询时刻闪 | 和 `model`/`context_tokens` 一样回溯到最近的 assistant 行 |
| Agent 工具的 `isolation: "worktree"` **从 main 建 worktree，不是从当前分支** | 三个 subagent 全都开局就没有本分支的契约与夹具 | 派活时预先说明要先 `git merge --ff-only <分支>`（三个 agent 各自自行发现并修正了，但白花了时间） |
| `eslint .` 会扫 `.claude/worktrees/` 里的仓库副本 | 三个 worktree 并存时报 2109 个假错误，看着像自己写崩了 | 已加进 `eslint.config.js` 的 ignores |
| 契约类型定完但编排层还没接时，**每个新采集模块都会各自触发一串 dead_code** | 四个文件各加了一次模块级豁免，容易变成长期存在 | 编排层接通后一次性删净；只留挂在具体字段/方法上、标注了阶段的精准豁免 |

### 1.4 明确放弃的功能

要拿到 `cost.total_cost_usd`、`rate_limits`（5小时/7天额度）、官方口径的 `context_window.used_percentage`，**唯一路径是往 `~/.claude/settings.json` 注册 statusLine 脚本**。违反零脚印铁律，不做。

代价：
- 成本显示 —— 放弃。
- 额度显示 —— 放弃。
- context 占用 —— **不受影响**。官方 `used_percentage` 的公式实测是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（只算 input 侧、不含 output），我们用同一公式自己算，数字对得上。只是不显示百分比（窗口大小判不准）。

**"不显示百分比"已被真机数据证实是对的**：A8 实测本会话 `contextTokens = 435306`，
**超过 200k**。而 jsonl 里 `message.model` 记的是 `claude-opus-5`（用户实际设的是
`opus[1m]`），从中区分不出 200k 还是 1M 窗口。若按 200k 算，这里会显示 **218%**。

---

## 2. 数据源（全部已在本机实测）

### L1 会话名册 —— `$CONFIG/sessions/<pid>.json`

一个运行中的 claude 进程一个文件，**文件名就是 PID**。实测内容：

```json
{"pid":52052,"sessionId":"2beb9e7d-7043-4470-ab86-702ef89ce1dd",
 "cwd":"c:\\Users\\sososmog\\Desktop\\sososmog_prompt_composer",
 "startedAt":1785395815772,"version":"2.1.220","peerProtocol":1,
 "kind":"interactive","entrypoint":"claude-vscode",
 "name":"sososmog-prompt-composer-18","nameSource":"derived"}
```

- `entrypoint` 实测值 `claude-vscode`；社区还见过 `cli`、`claude-desktop`。
- **只在会话启动时写一次，不随活动更新**（mtime = 启动时间）。"最后活动时间"必须用 transcript 的 mtime。
- 调研过的项目里**没有一个知道这个文件存在**（Clawd 靠 hook payload 带 `transcript_path` 过来）。

**"名册比任何进程侧启发式都准"—— 一次实测把这条证死了。** 同一时刻在本机数：

| 判据 | 得到几个 | 对不对 |
|---|---|---|
| 按进程名 `claude.exe` | **12 个** | ❌ 其中 8 个是 Claude **桌面版** Electron 进程，跟 agent 会话毫无关系 |
| 只算 CLI 原生二进制（`native-binary` 路径） | 4 个 | ❌ 多出的那个是 `claude.exe --claude-in-chrome-mcp`，浏览器 MCP 桥，不是会话 |
| **读 `sessions/*.json` 名册** | **3 个** | ✅ 正好是真实的交互会话 |

所以进程侧只用来做"这个 pid 还活着吗 / 占多少 CPU"，**绝不用来发现会话**。

### L2 主 transcript —— `$CONFIG/projects/<slug>/<sessionId>.jsonl`

实测 entry `type` 全集（扫 53 个真实会话文件）：`ai-title` `assistant` `attachment`
`file-history-delta` `file-history-snapshot` `last-prompt` `mode` `permission-mode`
`pr-link` `queue-operation` `relocated` `system` `user` `worktree-state`。
**没有官方 spec，字段全是可选，解析器必须防御式写**——我们只认其中 4 种
（`assistant` / `user` / `ai-title` / `last-prompt`），其余必须安全忽略而不是报错，
因为这个列表只会越来越长。

可用字段：

| 展示项 | 来源 |
|---|---|
| 当前任务标题 | `type:"ai-title"` 的 `aiTitle`（Claude 自己生成，实测 `"创建分支实现多agent桌面进程显示"`） |
| 用户最后一句 | `type:"last-prompt"` 的 `lastPrompt` |
| git 分支 | `user`/`assistant` 行的 `gitBranch` |
| 模型 / 思考档 | `message.model` / 顶层 `effort` |
| context token | `message.usage` 的 `input + cache_creation + cache_read` |
| 错误态 | `assistant` 行的 `error` / `isApiErrorMessage` / `apiErrorStatus` |
| 状态判据 | `message.stop_reason`（实测分布 `tool_use:45, end_turn:3, stop_sequence:1`）+ 尾行 role |
| 最后活动时间 | **文件 mtime**（实测随每次写入更新，毫秒精度） |

### L3 subagent 树 —— `$CONFIG/projects/<slug>/<sessionId>/subagents/`

**官方无文档，无人在用。** 实测本会话产出：

```
subagents/agent-a52f755df57239c77.jsonl        540KB
subagents/agent-a52f755df57239c77.meta.json    149B
...
```

`.meta.json` 实测原文：

```json
{"agentType":"general-purpose","description":"调研 Claude Squad/Crystal/Conductor/Vibe Kanban",
 "toolUseId":"toolu_01SAZbD51yk9cbPNL9JFa7wY","parentAgentId":"a52f755df57239c77","spawnDepth":2}
```

实测重建出的树：

```
2beb9e7d  主会话
├── a52f755d  调研 agent dashboard 生态与数据源        depth 1
│   ├── a3207b20  调研 Claude Squad/Crystal/…          depth 2
│   ├── a8f5a290  调研 CCManager/claude-code-ui/cui 等  depth 2
│   └── ac3b63ab  调研 Omnara/Happy/claudia/…          depth 2
└── acc2596e  调研 Clawd-on-Desk 等项目                depth 1
```

- `description` 就是现成的"这个 agent 在干什么"。
- `parentAgentId` + `spawnDepth` 足够画树；顶层 agent **没有** `parentAgentId` 字段（不是 null，是缺失）。
- 每个 `agent-*.jsonl` 的 mtime 就是该 subagent 的活跃度。
- `agent-*.jsonl` 顶层多出 `agentId`、`isSidechain:true`、`attributionAgent`。
- **subagent 不是独立进程**，全在同一个 `claude.exe` 里 → **拿不到独立 CPU**。这一层用 token / 耗时 / 活跃状态代替。

### L4 后台会话 —— `$CONFIG/jobs/<id>/state.json` + `timeline.jsonl`

`/loop`、`--bg` 起的会话，官方**已经把状态算好写在磁盘上**。实测 `state.json`：

```json
{"state":"done","detail":"stopped; awaiting further instructions","tempo":"idle",
 "inFlight":{"tasks":0,"queued":0,"kinds":[]},"tokens":91774,
 "intent":"现在我的浮窗可以正常显示了，但是不能在屏幕上自由拖拽…",
 "name":"浮窗拖拽功能调试","cwd":"…","backend":"daemon","updatedAt":"…"}
```

`timeline.jsonl` 是 append-only 的状态变迁流，实测 state 值 `working` / `blocked` / `done`。

当前本机 `daemon status` = not running，`roster.json` 的 `workers` 是 `{}` —— 没有后台会话可测。**所以 L4 排到阶段 4，且必须能在"目录不存在"时静默跳过。**

### L5 进程指标 —— sysinfo

只刷 L1 拿到的 pid，不做全量扫描。

---

## 3. 接口契约（冻结项，两侧实现前必须先定死）

> 这一节是**阶段 0 的产出物**，Rust 和 JS 两条并行轨都依赖它。改契约必须同时改两侧 + 升 `schemaVersion`。

### 3.1 Rust 命令

```rust
#[tauri::command]
async fn list_agent_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, FleetState>,
    opts: Option<FleetOptions>,
) -> Result<FleetReport, String>
```

**必须是 `async`**：Tauri v2 的同步命令跑在主线程，这里有文件 I/O + sysinfo 刷新，会卡住浮窗 UI。内部用 `tauri::async_runtime::spawn_blocking` 包住阻塞部分。

```rust
struct FleetOptions {
    tail_bytes: Option<u64>,        // 默认 65536
    include_subagents: Option<bool>,// 默认 true
    include_jobs: Option<bool>,     // 默认 false（阶段 4 才转 true）
    cpu: Option<bool>,              // 默认 true
}
```

`opts` 存在的意义：编写 tab 的低频轮询可以传 `{cpu:false, includeSubagents:false}`，只为喂 tab 角标，代价接近零。

### 3.2 返回结构（serde `rename_all = "camelCase"`）

```ts
type FleetReport = {
  schemaVersion: 1,          // 我们自己的契约版本
  scannedAt: number,         // ms epoch，Rust 侧时钟 —— 前端算 age 必须用这个，不用 Date.now()
  configDir: string,         // 实际使用的目录，排错用
  sessions: AgentSession[],
  warnings: FleetWarning[],  // 非致命问题
}

type FleetWarning = {
  code: 'no-config-dir' | 'roster-unreadable' | 'roster-entry-invalid'
      | 'transcript-unreadable' | 'transcript-unparsable'
      | 'subagents-unreadable' | 'pid-reused',
  // 刻意没有 'transcript-not-found' 与 'cpu-unavailable'，理由见 §3.6
  detail: string,            // 已脱敏，只带文件名不带内容
}

type AgentSession = {
  // L1（必有）
  pid: number,
  sessionId: string,
  name: string,
  cwd: string,
  entrypoint: string,
  kind: string,              // 'interactive' | 'background'
  startedAt: number,         // ms epoch
  cliVersion: string,

  liveness: 'alive' | 'pid-reused',   // 'dead' 直接不返回

  // L5 进程指标。两级 null 刻意区分（见 §3.6）：
  //   proc === null            → 没采（cpu 开关关了 / 进程没了）
  //   proc.cpuPercent === null → 内存和运行时长采到了，只有 CPU 还缺基准
  proc: { cpuPercent: number | null, memoryMb: number, runTimeSec: number } | null,

  // L2（null = 空会话，找不到 jsonl —— 这是已验证的真实状态，不是错误）
  transcript: TranscriptDigest | null,

  // L3（空数组 = 无 subagents 目录）
  subagents: SubagentDigest[],

  // L4（阶段 4）
  job: JobDigest | null,
}

type TranscriptDigest = {
  sizeBytes: number,
  mtimeMs: number,
  aiTitle: string | null,        // Rust 侧截断到 200 字符
  lastPrompt: string | null,     // 同上
  gitBranch: string | null,
  model: string | null,
  effort: string | null,
  // 尾部形态 —— 状态判定的全部输入
  lastRole: 'user' | 'assistant' | null,
  lastStopReason: string | null,  // 'tool_use' | 'end_turn' | 'stop_sequence' | null
  lastTailKind: 'tool_use' | 'tool_result' | 'text' | 'thinking' | null,
  lastToolNames: string[],        // 尾部 assistant 的 tool_use 名字，最多 4 个
  lastMsgTsMs: number | null,
  hasApiError: boolean,          // 主信号：顶层 isApiErrorMessage === true
  apiErrorStatus: string | null, // 源数据是数字且可能缺失，采集侧归一化成字符串
  apiErrorCode: string | null,   // 顶层 error 字段，如 oauth_org_not_allowed
  contextTokens: number | null,
  parseErrors: number,            // 尾部坏行数，>0 说明格式可能漂移了
}

type SubagentDigest = {
  agentId: string,
  agentType: string | null,
  description: string | null,      // 截断到 200
  parentAgentId: string | null,    // 顶层 agent 该字段缺失 → null
  spawnDepth: number | null,
  mtimeMs: number | null,
  lastRole / lastStopReason / lastTailKind / lastMsgTsMs / contextTokens  // 与 TranscriptDigest 同构子集
}

type JobDigest = {              // 阶段 4
  jobId: string, state: string | null, detail: string | null, tempo: string | null,
  tokens: number | null, inFlight: { tasks: number, queued: number } | null,
  intent: string | null, updatedAt: number | null,
}
```

**契约设计上的三个关键点**

1. **`scannedAt` 是唯一时间基准。** 前端算 age 一律 `scannedAt - mtimeMs`，绝不用 `Date.now()`。否则 Rust 时钟与 JS 时钟的微小差异会算出负数 age，显示成"-3秒前"。
2. **`schemaVersion` 不是给未来用的，是给开发期用的。** `tauri dev` 下前端热重载但 Rust 二进制是旧的，版本对不上时前端要显式报"需要重启 dev"，而不是渲染出一堆 undefined。
3. **`warnings` 与 `sessions` 并存。** 一个会话读不出 transcript，不能让整个 tab 空掉；返回该会话 + 一条 warning。

### 3.3 前端纯函数（`src/fleet.js`）

零 DOM、零 Tauri、全部可 vitest 单测。

```js
export const IDLE_MS = 5 * 60 * 1000;

// 单会话状态推断
deriveStatus(session, scannedAt, opts?) → {
  code: 'needs-input'|'working'|'idle'|'fresh'|'failed'|'completed'|'stopped'|'unknown',
  label: string,      // 中文
  glyph: string,      // ✻ ✽ ∙ ✗ ✓ ⊘ ?
  tone: 'attention'|'active'|'muted'|'danger'|'ok'|'unknown',
  animated: boolean,
}
deriveSubagentStatus(sub, scannedAt, opts?) → 同上（子集判据）
groupSessions(sessions, scannedAt, opts?) → [{ key, label, items }]
buildSubagentTree(subagents) → { roots: Node[], orphans: Node[] }
reduceFleetTone(sessions, scannedAt) → tone   // 悬浮小球那一个点
countNeedsInput(sessions, scannedAt) → number // tab 角标
formatAgo(ms) → '刚刚' | '36秒' | '5分钟前' | '2小时前'
formatTokens(n) → '68k'
formatCpu(pct) → '12%' | '—'
```

### 3.4 状态推断算法（伪码，逐条对应单测）

```
deriveStatus(s, now, { idleMs = IDLE_MS }):
  if s.liveness === 'pid-reused'        → 'unknown'（不该出现在列表里，防御性返回）
  if s.job                              → 映射 job.state:
        working→working, blocked→needs-input, done→completed,
        failed→failed, stopped→stopped, 其它→unknown
  if !s.transcript                      → 'fresh'      // 已启动·未开始（实测真实状态）
  t = s.transcript
  if t.lastRole === null                → 'unknown'    // 尾部窗口里一条消息都没解析出来
  if t.hasApiError                       → 'failed'
  age = now - (t.mtimeMs ?? t.lastMsgTsMs ?? s.startedAt)
  if age > idleMs                        → 'idle'
  if t.lastRole === 'assistant':
        if t.lastStopReason === 'tool_use'  → 'working'
        if t.lastStopReason === null        → 'working'   // 消息还没收完，在途
        else                                 → 'needs-input'  // end_turn / stop_sequence
  if t.lastRole === 'user'               → 'working'      // tool_result 或刚提问，模型在动
  → 'idle'
```

**分组顺序**（`groupSessions`）：`needs-input` → `working` → `failed` → `fresh` → `idle` → `completed` → `stopped` → `unknown`。组内按"最后活动时间"降序，时间相同按 `name` 升序（保证渲染稳定，不会每次刷新跳位）。

**小球归约优先级**（`reduceFleetTone`，抄 Clawd）：

```js
const TONE_PRIORITY = { failed: 5, 'needs-input': 4, working: 3, fresh: 2, idle: 1, completed: 1, stopped: 0, unknown: 0 };
```

### 3.5 一个需要明确的语义决定

**主会话在等你输入，但它的后台 subagent 还在跑** —— 这正是本次会话发生过的情况（我在等你回话，两个调研 agent 还在跑）。

决定：**会话状态保持 `needs-input`**（准确——你确实可以现在打字），**另外在卡片上挂一个"N 个子 agent 在跑"的独立指示**。不把两个事实塌缩成一个状态。

---

### 3.6 实现期对契约做的三处修正（连理由一起记，否则会被加回去）

契约在 P4 冻结，但 P5 造夹具和 A 轨实现时撞出三处**定错了**的地方。三处都是趁"还
没有任何消费者"改的，`SCHEMA_VERSION` 保持 1（两侧在同一个 commit 里一起改，且有
跨语言测试强制它们一致）。

**① `apiErrorStatus` 是数字且可能缺失，另加 `apiErrorCode`**

造夹具时全盘搜真实的 API 错误行，发现两个都存在的变体：

| | 变体 A | 变体 B |
|---|---|---|
| `apiErrorStatus` | `403`（**数字**） | **字段整个不存在** |
| `error` | `"oauth_org_not_allowed"` | `"invalid_request"` |
| `stop_reason` | `"stop_sequence"` | `"refusal"` |

原契约写的是 `Option<String>`。改为采集侧把数字归一化成字符串（免得前端处理
number/string/undefined 三态），并新增 `apiErrorCode` 承接 `error`——它比状态码更有
展示价值（能直接告诉用户是权限问题还是请求被拒）。

顺带纠正一条会导致误判的认知：**API 出错的行 `stop_reason` 是 `stop_sequence` 或
`refusal`**，不是 null 也不是 `end_turn`。只看 stopReason 会把"出错"误判成"正常收尾
等你回话"。判定顺序必须先看 `hasApiError`——伪码本来就是这个顺序，现在有夹具钉住。

**② `cpuPercent` 改成可为 null —— 原设计在撒谎**

原本是 `f32`，逼得采集层在首次采样还没有基准时只能填 `0.0`。但 **`0%` 是一个具体
结论（这进程真的闲着），跟"还不知道"是两回事**。改成可为 null 之后，两级 null 表达
两件不同的事：`proc === null` 是没采，`proc.cpuPercent === null` 是内存和运行时长
采到了、只有 CPU 还缺基准。前端对后者显示 "—"。

**③ 删掉两个 `WarningCode`**

- `transcript-not-found`：找不到 jsonl 是**最常见的正常状态**（会话已启动但一句话没
  说，实测本机 6 个会话里有 2 个如此）。为它产 warning 会让每轮轮询都刷出一堆噪声，
  而它根本不是问题。编排层直接映射成 `transcript: null`，前端渲染"已启动 · 未开始"。
  jsonl 存在但 0 字节也走同一条路径，同样不报。
- `cpu-unavailable`：自从 ①② 之后，"还没有基准"已经在数据里表达清楚了，再加一条
  warning 是重复信息。

两条"为什么没有它们"的理由同时留在 `types.rs` 里——只写在文档里，下一个人在代码里
看不到，照样会顺手补上。

---

## 4. 文件清单

新增：

```
src-tauri/src/fleet/mod.rs          命令入口 + 编排 + FleetState
src-tauri/src/fleet/config.rs       CLAUDE_CONFIG_DIR 解析
src-tauri/src/fleet/roster.rs       L1
src-tauri/src/fleet/transcript.rs   L2（tail 读 + digest 抽取）
src-tauri/src/fleet/subagents.rs    L3（阶段 2）
src-tauri/src/fleet/proc.rs         L5（sysinfo）
src-tauri/src/fleet/jobs.rs         L4（阶段 4）
src-tauri/tests/fixtures/*.jsonl    脱敏后的真实样本
src/fleet.js                        纯函数
src/fleetView.js                    浮窗 DOM 层 + 轮询调度
src/__tests__/fleet.test.js
src/__tests__/fleetView.test.js
src/__tests__/fixtures/fleet-snapshots.json
src/__tests__/fleet.smoke.mjs
docs/agent-fleet.md                 本文档
```

改动：

```
src-tauri/Cargo.toml       + sysinfo
src-tauri/src/lib.rs       + mod fleet; + 注册命令 + manage(FleetState) + 启动预热线程
src/float.html             + tab 栏 + 两个 panel 包裹
src/float.css              + tab/卡片样式 + .is-mini 隐藏 tab 栏
src/float.js               + import fleetView + tab 切换与持久化
src/core.js                阶段 3：normalizeState 加 settings.fleet
src/events.js + index.html 阶段 3：设置面板开关
```

`.github/workflows/pr.yml` **不需要改** —— 它已经在跑 `cargo test` + `cargo clippy --all-targets`（见 §7.1）。

**不需要动 capabilities/default.json** —— Tauri v2 自定义命令默认对所有窗口开放、不走 ACL（做自动粘贴时已验证）。所有文件读取在 Rust 侧，不经 `fs` 插件，所以也不需要放宽 `$HOME` 的 fs 权限。这是把数据层放 Rust 的一个额外好处。

---

## 5. 阶段与步骤

### 图例

- 🔒 阻塞其它步骤，必须先完成
- ⇄ 可与同标记的步骤并行
- ⛓ 依赖前序，不能并行

---

### 阶段 P — 准备工作（全部 🔒，串行）

没有这些，后面两条并行轨会各自猜契约、各自造数据，最后对不上。

| 步 | 内容 | 节点（怎么算做完） |
|---|---|---|
| **P1** | Rust 工具链跑通基线 | `export PATH="$PATH:$USERPROFILE/.cargo/bin"` 后 `cargo check` 通过。**注意**：若报 `failed to remove ...composer.exe / os error 5`，说明有旧实例在跑，先 `Get-Process composer \| Stop-Process -Force` |
| **P2** | 前端基线 | `npm run lint` 0 error 0 warning、`npm test` 全绿。记下当前用例数作为基线 |
| **P3** ✅ | 加 sysinfo 并验证 Windows 行为 | 已完成。产出 `src-tauri/tests/sysinfo_probe.rs`（4 个探针，全过）。**实测结论见下方 P3 结论** |
| **P4** | 🔒 **冻结契约** | 把本文档第 3 节的类型定义落成两份代码骨架：Rust 侧 `struct` + serde 标注（`cargo check` 过），JS 侧 `src/fleet.js` 的 JSDoc `@typedef`。**此后改契约要同时改两侧 + 升 schemaVersion** |
| **P5** | 造测试夹具 | 见下方 P5 详述 |

#### P3 结论（已实测，Windows 11 / 32 逻辑核 / sysinfo 0.36.1）

| 探针 | 结果 |
|---|---|
| 按 pid 单查进程 | ✅ `ProcessesToUpdate::Some(&[pid])` 可用，返回刷新条数 1 |
| `start_time()` | ✅ 返回正常 UNIX 秒（如 `1785416167`）。**防 PID 复用的立足点成立** |
| `memory()` | ✅ 字节量级 |
| 不存在的 pid | ✅ `process()` 返回 `None`，不 panic |
| `cpus().len()` / `available_parallelism()` | ✅ 都是 32。但 `cpus()` 在 `System::new()` 后是空的，**必须先 `refresh_cpu_list()`**，否则归一化会除以 0 |
| `MINIMUM_CPU_UPDATE_INTERVAL` | 200ms |
| `remove_dead_processes: true` + `Some(&pids)` | ⚠️ **不会**清掉未刷新的进程（510 个全留着）。所以只能按 pid 单查，`processes()` 的整体内容不可信 |
| `cpu_usage()` | 🔴 **不可用**。烧满 1 核实测只返回 0.0003~0.002，换四种姿势（`with_cpu()` 250ms / 1000ms、`everything()`、`new_all()` 打底）全部差五个数量级 |
| `accumulated_cpu_time()` 自算 | ✅ **正确**。`cpu_ms=1141 / wall_ms=1011 = 112.86%` 累加，除 32 核 = 3.53% |

**真实数据上的交叉验证**（不只是合成的烧核测试）：拿 `Get-Process` 的累计 CPU
秒数在 10 秒窗口上自己算真值 —— pid 52052 增量 1.938 秒 / 10.1 秒 = 19.26% 累加，
除 32 核 = **0.602%**；我们的采集层在 1.2 秒窗口上报 0.2%。同量级，差异来自窗口
不同（claude 进程是突发型负载：处理 API 响应时冲高、间隙空闲）。**这条验证的价值
在于它用的是真实进程而非人造负载**——合成测试只能证明公式对，证不了在真实的
突发型负载上读数不离谱。

#### P5 详述：夹具

两套，用途不同：

**(a) Rust 解析器夹具** `src-tauri/tests/fixtures/`
从本机真实 jsonl 各截一小段（20–40 行足够），**必须脱敏**：`aiTitle` / `lastPrompt` / `description` / message 内容全部替换成占位文本，`cwd` 换成 `C:\work\demo`，保留全部结构与字段名。需要覆盖：

- `tail-working.jsonl` 尾部是 `assistant` + `stop_reason:"tool_use"`
- `tail-needs-input.jsonl` 尾部是 `assistant` + `stop_reason:"end_turn"`
- `tail-tool-result.jsonl` 尾部是 `user` + `tool_result`
- `tail-api-error.jsonl` 带 `isApiErrorMessage` / `apiErrorStatus`
- `tail-garbage.jsonl` 混入坏行、空行、被截断的首行
- `tail-utf8-boundary.jsonl` 让 64KB 窗口边界正好切在一个中文字符中间
- `roster-*.json` 合法 / 缺字段 / 非法 JSON / 目录里混入非 `.json` 文件
- `subagent-meta-*.json` 正常两层树 / 顶层缺 `parentAgentId` / 父 id 指向不存在的 agent / 两个 agent 互相指（环）

**(b) JS 纯函数夹具** `src/__tests__/fixtures/fleet-snapshots.json`
纯合成的 `FleetReport`，不需要真实数据。每个状态一个 session，加上边界样本（age 恰好 5 分钟、`mtimeMs` 为 null、`lastStopReason` 为 null 等）。

**脱敏检查**：`git diff --cached` 人工过一遍夹具，确认没有真实项目名、真实 prompt、路径里的用户名。这些文件会永久进仓库历史。

---

### 阶段 0 — 数据层（P 完成后，A / B 两轨并行 ⇄）

#### 轨 A（Rust）⇄ — 采集层

| 步 | 内容 | 节点 |
|---|---|---|
| A1 | `config.rs`：解析配置目录 | 单测：环境变量设置 / 为空字符串 / 未设置三种情况 |
| A2 | `roster.rs`：扫 `sessions/*.json` | 单测吃 P5 夹具：合法解析、缺字段跳过并产 warning、非法 JSON 不 panic、非 `.json` 文件忽略 |
| A3 | `proc.rs`：sysinfo 采样 + 存活校验 | 单测：`accumulated_cpu_time` 差值公式（含首次采样返回 null、间隔过短、pid 复用导致 acc 变小、clamp 上界）；存活校验对齐 `startedAt`（容差 ±120s）；pid 不存在时判 dead。**行为契约已由 `tests/sysinfo_probe.rs` 钉住** |
| A4 | `transcript.rs`：定位 + tail 读 | 单测：文件小于窗口 / 恰好等于 / 远大于；无尾随换行；空文件；UTF-8 边界切断；**尾部窗口里找不到任何 user/assistant 消息时按 4× 扩窗重试，上限 1MB，仍失败则 `transcript-unparsable`** |
| A5 | `transcript.rs`：digest 抽取 | 单测：每个夹具抽出的字段逐个断言；ISO 时间戳→ms epoch（含 UTC 偏移）；`parseErrors` 计数正确 |
| A6 | `mod.rs`：编排 + `FleetState` + 命令 | `cargo check` + `cargo test` 通过 |
| A7 | 接进 `lib.rs`：注册命令、`manage(FleetState)`、启动预热线程 | `cargo check` 通过 |
| A8 | **真机手测** | `npm run dev` 起来，在浮窗控制台 `__TAURI__.core.invoke('list_agent_sessions')`，肉眼核对：5 个会话都在、cwd 正确、CPU 与任务管理器数量级一致、本会话状态是 working |

**A 轨的关键实现细节**

*配置目录*
```rust
fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        let v = v.trim();
        if !v.is_empty() { return Some(PathBuf::from(v)); }
    }
    app.path().home_dir().ok().map(|h| h.join(".claude"))
}
```
用 Tauri 自带的 `path().home_dir()`，不额外引 `dirs` crate。

*transcript 定位（不能按 cwd 推算）*
```rust
// 遍历 projects/*/ 找 <sessionId>.jsonl。
// 结果缓存进 FleetState 的 HashMap<String, PathBuf>，复用前先 exists() 校验。
// 缓存命中时省掉 16 次 readdir。
```

*tail 读*
```rust
let start = size.saturating_sub(max_bytes);
// seek 到 start，读到尾
// 若 start > 0，丢掉第一行（它既可能是半行，也可能起点正好切在多字节字符中间）
// 用 String::from_utf8_lossy，不要 from_utf8().unwrap()
```

*存活校验（防 PID 复用）*
```rust
// sysinfo 的 start_time() 是 UNIX 秒。进程先启动、再写 roster 文件，
// 所以 proc_start <= session_started。给 ±120s 容差吸收各种偏差。
// 不匹配 → liveness='pid-reused' + warning（而不是静默丢弃，便于排错）
```

*CPU 采样（P3 实测后定稿——不要用 `cpu_usage()`）*
```rust
// FleetState 持有：
//   sys: Mutex<System>                          长生命周期
//   ncpu: usize                                 构造时 refresh_cpu_list() 后取 cpus().len()
//   cpu_prev: Mutex<HashMap<Pid, (u64, Instant)>>  上次的 (accumulated_ms, 采样时刻)
//
// 每次命令调用：
//   1. sys.refresh_processes_specifics(Some(&pids), true, nothing().with_cpu().with_memory())
//   2. 对每个 pid：acc_now = p.accumulated_cpu_time()（毫秒）
//   3. 查 cpu_prev：
//        无记录            → cpuPercent = null（UI 显示 "—"），只记下本次值
//        wall_ms < 100     → 间隔太短，返回 null，不更新记录（避免除小数放大噪声）
//        否则              → pct = (acc_now - acc_prev) / wall_ms * 100 / ncpu
//                            用 saturating_sub：pid 复用导致 acc 变小时得 0 而不是溢出
//                            clamp 到 [0, 100]，吸收采样抖动
//   4. 更新 cpu_prev
//
// 启动时在后台线程预热一次（只为把 cpu_prev 填上），避免用户第一次打开 tab 看到 "—"。
// processes() 的整体内容不可信（P3 实测：未刷新的进程会残留），只能按 pid 单查。
```

*E5 之后的修订：CPU 含工具子进程*
```rust
// 上面第 1 步在"要报 CPU"的那一档（opts.cpu）改成两次刷新：
//   1a. refresh_processes_specifics(All, true, nothing())      仅拓扑，实测 14.4ms
//       → 遍历 processes() 用 parent() 建 parent→children 映射（0.23ms）
//       → 对每个目标 pid 收集子树（含自己），上限 MAX_SUBTREE_PIDS=256、带防环
//   1b. refresh_processes_specifics(Some(&子树全体), true, ..with_cpu().with_memory())
//
// 为什么不图省事用一次 All + with_cpu()：实测 75.2ms，而分两次约 27ms。
// 数据来自 tests/sysinfo_probe.rs 的 probe_full_refresh_cost_and_parent_map，
// 换机器/换 sysinfo 版本重跑即可。
//
// 第 3 步改成：对子树里**每个进程各自**算差值再求和，而不是先求和再作差。
// 后者在子进程生灭时会跳变（刚起的 bash 自带的历史 CPU 时间被整段计入一个窗口，
// 打出虚高尖峰）。代价：新子进程首轮只建基准、贡献 0，存活不到一个轮询周期的
// 短命子进程不会被计入——接受。
//
// cpu_prev 现在必须按轮清理（子进程 pid 是一次性的，否则表随运行时长无限膨胀）：
// 本轮没读到的丢掉，但目标 pid 即使这轮查不到也保留（丢了基准要白等一轮）。
//
// 内存不合并：父子共享内存页会重复计算，且该字段前端不显示。
// ProcSample.sampled_pids（不上报前端）记录本次合并了几个进程——子树收集失效时
// 表现是"CPU 偏低"而不崩不报错，真机诊断打印这一列，永远是 1 就说明坏了。
```

#### 轨 B（JS 纯函数）⇄ — 判定层

**不依赖轨 A**：吃 P5(b) 的合成夹具就能完整开发和测试。

| 步 | 内容 | 节点 |
|---|---|---|
| B1 | `fleet.js`：`deriveStatus` | 单测覆盖 3.4 伪码的每个分支 + 每个边界 |
| B2 | `deriveSubagentStatus` + `buildSubagentTree` | 单测：正常两层树、孤儿（父不存在→进 orphans）、**环（A→B→A 必须不死循环）**、重复 agentId、深度缺失 |
| B3 | `groupSessions` + `reduceFleetTone` + `countNeedsInput` | 单测：分组顺序、组内排序稳定性（同时间按 name）、优先级归约 |
| B4 | 格式化函数 | 单测边界：0 / 999 / 1000 / 59s / 60s / 3599s / 3600s；`formatCpu(null)` → `'—'` |
| B5 | `schemaVersion` 不匹配的处理 | 单测：报告版本 ≠ 1 时返回可识别的错误态而不是崩 |

---

### 阶段 1 — 浮窗 UI（⛓ 依赖 B；与 A 剩余步骤可并行）

轨 C 只需要 `fleet.js` 就能开工——数据先喂夹具，等 A 轨合进来再换成真调用。

| 步 | 内容 | 节点 |
|---|---|---|
| C1 | `float.html`：tab 栏 + 两个 panel | 现有编写区完整包进 `#fwPanelCompose`，行为零变化 |
| C2 | `float.css`：tab / 卡片 / 分组标题样式；**`.fw-card.is-mini` 追加隐藏 `.fw-tabs`** | 深浅两套主题变量都给到 |
| C3 | `fleetView.js`：渲染分组 + 卡片 | 吃夹具能渲染出全部状态 |
| C4 | `fleetView.js`：轮询调度 | 见下方 C4 详述 |
| C5 | `float.js`：接线 tab 切换 + localStorage 持久化 + 角标 | 切 tab 不丢编写区内容；重开浮窗回到上次 tab |
| C6 | 降级与空态 | 非 Tauri 环境显示"此功能需要桌面端"；无会话显示"没有正在运行的 agent"；有 warnings 时可折叠显示 |
| C7 | `fleetView.test.js`（jsdom） | 见下方测试策略 |
| C8 | ⛓ **与 A 轨合流**：换成真 invoke | 真机验收清单（见 §7） |

#### C4 详述：轮询调度

```
可见 && 非小球 && 停在 Agent tab   → 2000ms  （全量：cpu + subagents）
可见 && (小球 || 停在编写 tab)      → 8000ms  （精简：{cpu:false, includeSubagents:false}，只喂角标/小球）
不可见                               → 暂停
```

实现要点：

- 用 `setTimeout` 自链，**不用 `setInterval`** —— 避免上一次调用没回来就发下一次。
- 单飞：有 in-flight 请求时跳过本次 tick。
- 失败退避：连续失败时 2s → 4s → 8s → 16s → 30s 封顶；成功即复位。UI 上显示一行低调的错误提示，**不清空已有卡片**（旧数据 + "N 秒前"标注，比空白有用）。
- 可见性判定：优先 `document.visibilityState`，同时监听已有的 `composer-float-visibility` 事件。**Windows 上 `window.hide()` 是否触发 `visibilitychange` 未验证** —— 但这只是省电优化，判断失败最坏情况是隐藏时仍以 8s 轮询，代价可忽略。**不把它当正确性问题。**
- 顺带补一个现有缺口：Rust 侧全局热键 toggle 浮窗时没有广播可见性事件（`lib.rs` 的 shortcut handler）。加上 `emit('composer-float-visibility', ...)`。

#### C4 附：重渲染不能打断交互

Clawd 的 `dashboard-renderer.js` 有一条守卫，注释说每秒重建整棵卡片树会打断正在进行的重命名输入或聚焦的下拉框。我们的卡片有可展开的 subagent 区，同样会踩。

MVP 方案（够用且简单）：

1. 展开状态存模块变量（照抄 `float.js` 里 `openQuickGroupId` 的做法），重建后恢复。
2. 重建前后保存/恢复列表容器的 `scrollTop`。
3. 守卫：若 `document.activeElement` 在 fleet 面板内，本次跳过重建（下一 tick 再来）。

阶段 3 如果手感不好，再升级成按 `sessionId` 做 keyed 原地更新。

---

### 阶段 2 — subagent 树（⛓ 依赖阶段 1 合流）

Rust 侧（A9–A10）与 UI 侧（C9–C10）可并行 ⇄，但都依赖阶段 1 的骨架。

| 步 | 内容 | 节点 |
|---|---|---|
| A9 | `subagents.rs`：扫 `<sid>/subagents/`，读 `.meta.json` + 各 jsonl 的 mtime/tail | 单测吃 P5 夹具 |
| A10 | 接进编排，填 `AgentSession.subagents` | `cargo test` 过；真机 invoke 能看到本会话那 5 个 |
| C9 | 卡片上的"子 agent N ▾"折叠区，复用 `.fw-quick-block` accordion 词汇 | 同时只展开一个 |
| C10 | 树形缩进渲染（按 `spawnDepth`）+ 每个 subagent 的状态点 | jsdom 单测断言层级与缩进 |

**边界**：`spawnDepth` 可能缺失 → 按 `parentAgentId` 链自算，链断了当 depth 1；深度上限渲染 3 层，更深的折叠成"更深层 N 个"（380px 宽塞不下）。

---

### 阶段 3 — 收尾（⛓ 依赖阶段 2；内部三步可并行 ⇄）

| 步 | 内容 | 节点 |
|---|---|---|
| D1 ⇄ | `settings.fleet = { enabled }`，`core.js` 的 `normalizeState` 校验；主窗口设置面板加开关 | `normalizeState` 单测；关掉后 tab 隐藏、轮询停 |
| D2 ⇄ | 主题深浅色适配核对 | 两套主题各看一眼（照 PR #32 的做法） |
| D3 ⇄ | 文案/空态/warning 展示打磨；README 补一节 | — |
| D4 | 全量回归 | `npm test`、`npm run lint`、`npm run check:contrast`、`npm run smoke`、`npm run smoke:csp`、`npm run smoke:fleet`、`cargo test`、`cargo clippy --all-targets`、真机诊断 |

> 原计划里 D1 是 `{ enabled, showCpu }`，实现时砍掉了 `showCpu`：实测该开关省不下什么（真正的开销是逐个会话读 transcript 尾部，控制成本靠前端轮询分档），而每多一个设置项就是一份长期维护成本。

**D4 必查项**：删掉 `src-tauri/src/fleet/types.rs` 顶部的 `#![allow(dead_code)]`，重跑 clippy 确认 0 新增警告。那行是 P4"契约先于实现"的临时豁免（当时 13 条 dead_code 来自尚未被 A 轨消费的类型）。若届时仍有字段没人读，**说明契约定多了，该删字段而不是留豁免**。

---

### 阶段 4 — 可选增强（互相独立，全部 ⇄）

| 步 | 内容 | 状态 | 备注 |
|---|---|---|---|
| E2 | 悬浮小球状态点（复用 `reduceFleetTone`） | ✅ 已做 | 门槛 `ORB_DOT_MIN_PRIORITY=3`，只有 failed/needs-input/working 点亮；顺带修掉浅色主题下橙点 2.89:1 的对比度问题 |
| E3 | 点卡片打开该会话的 cwd（走已有的 `opener` 插件） | ✅ 已做 | 独立小按钮而非整卡可点；点完必须 `blur()`，否则焦点守卫会让面板静默停更 |
| E5 | CPU 含工具子进程 | ✅ 已做 | 全量刷拓扑 + 只对子树刷 CPU（14.4+12ms，而非一次性全量带 CPU 的 75ms）；按各进程分别算差值再求和 |
| E1 | L4 后台会话（`jobs/*/state.json` + `timeline.jsonl`） | ⬜ 待决策 | 官方已算好 `state`/`detail`/`tokens`/`intent`。**契约决定未定：后台会话可能没有活进程，`pid` 要不要改 `Option<u32>`**（见下）。**本机现在没有后台会话，需要先 `claude --bg` 造一个才能验** |
| E8 | subagent jsonl 按 mtime 缓存 | ⬜ 待触发 | 等"会话多 + 子 agent 多时轮询变迟钝"真的出现。缓存要有上限或按会话清理 |
| E6 | keyed 原地更新替代全量重建 | ⬜ 待触发 | 触发条件很具体：全量重建会抹掉**文本选区**（焦点守卫护不住它），这是最可能先被感知到的症状 |
| E7 | `notify` 文件监听替代轮询 | ⬜ 待触发 | 只监听已知会话的 jsonl，即时性更好；仅当轮询显得迟钝时做。**改成推送后要保留一个低频兜底轮询**——轮询自带"漏了下次补上"的自愈，监听器静默失效时界面会永久停在旧数据上 |
| E4 | Codex 支持 | ⬜ 未开始 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，首行 `session_meta` 带 `cwd`/`cli_version`/`originator`。**与其余几项不是一个量级**：没有名册（拿不到 pid → 拿不到 CPU）、状态判据要另写一套、契约要加 `provider` 且升 SCHEMA_VERSION |

**E1 的契约决定**（做之前必须先定）：后台会话可能没有活进程（daemon 托管，或进程已退出但作业还在），而契约里 `AgentSession.pid` 是必填 `u32`、`liveness` 只有 `alive`/`pid-reused`。

- **方案 A 仅标注**：job 只挂到已有名册会话上（按 `sessionId` 匹配）。简单、不改契约；但没有活进程的后台会话根本不出现，等于功能只做一半。
- **方案 B 独立成条**：job 可以自己成为一个 `AgentSession`。更有用；但要把 `pid` 改 `Option<u32>`、`liveness` 加一个值、前端各处判 pid 的地方跟着改，要升 `SCHEMA_VERSION`。

倾向 B —— A 会让用户困惑（"我 `--bg` 起的活怎么不显示"）。

> `timeline.jsonl` 是完美的状态变迁时间线数据源，但先别做时间线 UI：380px 宽塞不下，且 `state.json` 的 `detail` 一句摘要已经够用。

---

## 6. 并行度总览

```
P1 → P2 → P3 → P4(冻结契约) → P5(夹具)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
              轨A: A1→A2→A3→A4→A5→A6→A7   轨B: B1→B2→B3→B4→B5
                    │                           │
                    │                           ▼
                    │                     轨C: C1→C2→C3→C4→C5→C6→C7
                    │                           │
                    └───────────┬───────────────┘
                                ▼
                          C8 合流 + A8 真机
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              阶段2: A9→A10            阶段2: C9→C10
                    └───────────┬───────────┘
                                ▼
                    阶段3: D1 ⇄ D2 ⇄ D3 → D4
                                ▼
                        阶段4（全部可选，互相独立）
```

**subagent 派活建议**（按 `feedback-worktree-subagent-workflow` 的模式）：

- P 阶段我自己做 —— 契约和夹构是全局约束，不适合外包。
- 轨 A 和轨 B **各开一个 worktree**，两个 sonnet 并行。两轨文件完全不重叠（A 只碰 `src-tauri/**`，B 只碰 `src/fleet.js` + 其单测），合并冲突风险接近零。
- 轨 C 等 B 合回来再派，因为它 import `fleet.js`。
- 阶段 2 的 A9/A10 与 C9/C10 同样可以两个 worktree 并行。
- 每轨合回来我做 review。

**不能并行的硬约束**：

- P4 冻结契约之前，A/B 任何一轨都不能动（会各自猜结构）。
- C8 合流必须等 A7 完成（要真命令）。
- 阶段 2 必须等阶段 1 合流（要卡片骨架）。
- D4 全量回归必须最后做。

---

## 7. 测试策略

### 7.1 Rust（`cargo test`）

纯函数为主，全部吃 P5(a) 夹具，不碰真实 `~/.claude`：

- `tail_lines`：小于窗口 / 等于 / 大于 / 空文件 / 无尾随换行 / UTF-8 边界切断 / 扩窗重试
- digest 抽取：每个状态夹具的字段逐个断言 / 坏行计数 / ISO 时间戳含时区转换
- roster：合法 / 缺字段 / 非法 JSON / 混入非 json 文件 / 空目录 / 目录不存在
- config dir：环境变量三态
- 存活校验：时间对齐容差边界
- subagent meta：正常树 / 缺 `parentAgentId` / 孤儿 / 环 / 重复 id

CI：**`pr.yml` 已经在跑 `cargo test` 和 `cargo clippy --all-targets`**（ubuntu 的 `rust` job），另有 `rust-cross` job 在 macOS + Windows 上跑 `cargo check`。所以 CI 无需改动——方案初稿里"给 CI 加 cargo test"那条是多余的。

注意 clippy 跑 `--all-targets`，会连测试文件一起 lint；但 CI 没加 `-D warnings`，只对 error 失败。当前 lib.rs 有 4 条既有的 `Shortcut` clone 警告（`Copy` 类型上用 `clone`），与本功能无关，不在本次范围内动。

### 7.2 JS 纯函数（vitest）

`src/__tests__/fleet.test.js`，吃 P5(b) 合成夹具。覆盖 §3.4 每个分支 + §5 轨 B 列的每个边界。这是整个功能里逻辑最绕的部分，也是最该重点投入的测试。

### 7.3 JS DOM 层（vitest + jsdom）

`src/__tests__/fleetView.test.js`。按已成型的姿势（见 `mainWindow.test.js`）：灌真实 `float.html` 的 body → 假 Tauri **必须在 import 之前摆好** → 动态 import → 显式调初始化。

断言：

- 分组标题与卡片按 §3.4 顺序渲染
- 空态 / 非 Tauri 降级态 / warning 折叠区
- tab 切换与 localStorage 持久化
- 用 fake timers 验轮询节奏：切到 Agent tab 后 2s 一次、切回编写 tab 后 8s 一次且参数变成精简版、模拟隐藏后停止
- 失败退避：连续 reject 时间隔递增、旧卡片不被清空
- 展开的 subagent 分组在重渲染后仍展开
- `document.activeElement` 在面板内时跳过重建

**已知陷阱**（来自 `reference-vitest-global-stub-leak`）：只 spy 静态方法，别整体替换全局对象；`afterEach` 里无条件 `unstubAllGlobals()`。否则一个用例崩掉会连带后面几十个用例报错在无辜行号上。

### 7.4 Playwright 冒烟

`src/__tests__/fleet.smoke.mjs`，照 `float-theme.smoke.mjs` 的跑法（见 `reference-verify-frontend-playwright`：ESM 里 `import 'playwright'` 找不到包，要动态 import 缓存里 `playwright/index.mjs` 的绝对 file:// URL）。真浏览器里验：tab 能切、Agent tab 显示降级文案、编写区功能未被破坏。

### 7.5 真机验收清单（只能在 `npm run dev` 下验）

- [ ] 5 个会话全部出现，`name` / `cwd` / 分支正确
- [ ] 本会话状态是 working；把某个会话停下来等一会儿，状态转 needs-input，再等 5 分钟转 idle
- [ ] CPU 数值与任务管理器同量级（不是 380% 这种没除核心数的数字）
- [ ] 空会话（启动了没说话的那种）显示"已启动·未开始"而不是报错
- [ ] subagent 树与实际在跑的多 agent 会话一致
- [ ] tab 选择跨浮窗隐藏/重开保持
- [ ] 缩成小球时 tab 栏不露出来
- [ ] 深色/浅色主题切换正常
- [ ] 编写 tab 的所有原有功能（补全、点击即粘贴、清空、快速段落）无变化
- [ ] 全局热键 toggle 浮窗后轮询节奏正确变化

### 7.6 手工制造失败场景

正常路径好测，失败路径必须主动造：

| 场景 | 怎么造 |
|---|---|
| 配置目录不存在 | 临时设 `CLAUDE_CONFIG_DIR=C:\nope` 启动 |
| roster 文件损坏 | 往 `sessions/` 放一个内容为 `{{{` 的 `99999.json`（**用完删掉**） |
| PID 复用 | 手工造一个 `sessions/<某个现有非claude进程的pid>.json` |
| 超大 jsonl | 本机现成有 3.7MB 的（TapMap 那个会话） |
| jsonl 格式漂移 | 夹具里改个字段名，确认降级成"状态未知"而不是崩 |
| 命令 panic | 临时在命令里插一个 `panic!()`，确认前端显示错误行且退避重试，tab 不空白 |

---

## 8. 失败模式与降级

| 失败 | 检测 | 降级行为 | 用户看到 |
|---|---|---|---|
| 配置目录不存在 | `config_dir()` 返回 None 或路径不存在 | 返回空 sessions + `no-config-dir` | "未检测到 Claude Code 数据目录" |
| `sessions/` 不存在 | 读目录失败 | 空 sessions，无 warning（正常情况：从没跑过 claude） | "没有正在运行的 agent" |
| 单个 roster 文件坏 | JSON parse 失败 | 跳过该文件，其余照常 | 其它会话正常显示 |
| 找不到 jsonl | 遍历无果 | `transcript: null` | 该会话显示"已启动·未开始"（**实测真实状态，不是错误**） |
| jsonl 读不了 | I/O 错误 | `transcript: null` + warning | 会话仍在列表，状态"未知" |
| 尾部窗口全是坏行 | `parseErrors > 0 && lastRole == null` | `transcript-unparsable` warning | 状态"未知"，**不猜** |
| 格式漂移（字段改名） | 同上 | 同上 | 同上；`parseErrors` 让我们能诊断 |
| sysinfo 采样失败 | 进程在两次读之间消失 | `proc: null` | CPU 显示 "—" |
| PID 复用 | 启动时间不对齐 | `liveness:'pid-reused'`，不进列表 + warning | 该会话不显示 |
| 命令返回 Err | invoke reject | 退避重试，保留旧数据 | 一行错误提示 + "数据为 N 秒前" |
| `schemaVersion` 不匹配 | 前端校验 | 停止轮询 | "版本不一致，请重启应用"（dev 期热重载会遇到） |
| Claude Code 大版本改结构 | 多个 warning + parseErrors 飙升 | 整个 tab 降级 | "数据格式可能不兼容（检测到 CLI x.y.z）" |

**贯穿原则**：宁可显示"未知"，不要猜；宁可显示过期数据 + 时间标注，不要空白。后者抄的是 Clawd 的配额条设计——数据不新鲜就标 "as of N ago"，而不是把旧数当实时。

---

## 9. 边界情况清单

已识别、需要各自有测试或明确决定的：

**数据层**

1. 空会话（启动了没说话）→ `fresh`。**实测本机 5 个里有 2 个是这种。**
2. 同一个 cwd 多个会话 → **实测本机有 4 个 TapMap 会话**。必须按 `sessionId` 做 key，绝不能按 cwd。`name` 字段负责区分显示。
3. worktree 里的会话 → 项目 slug 不同（本机有 `...--claude-worktrees-feat-float-window-foundation`）。遍历 `projects/*/` 的做法天然覆盖。
4. jsonl 巨大（实测 3.7MB）→ 只读尾部。
5. 单条 assistant 消息超过 64KB 窗口 → 扩窗重试（4×，上限 1MB）。
6. UTF-8 多字节字符被窗口边界切断 → lossy 转换 + 丢首行。
7. 时间戳时区 → jsonl 是 UTC Z 后缀，本机 UTC+8，必须正确解析。
8. Rust 时钟 vs JS 时钟 → 一律用 `scannedAt` 算 age，防止负数。
9. `parentAgentId` 在顶层 agent 是**字段缺失**而非 null。
10. subagent 树可能有环或孤儿（防御性，正常不该出现）→ 不死循环。
11. `spawnDepth` 缺失 → 按父链自算。
12. `model` 字段区分不出 200k / 1M → 不显示百分比。
13. 会话在扫描过程中退出（roster 读完、sysinfo 刷之前）→ `proc: null`，不当错误。
14. `sessions/` 里的残留文件（进程已退出）→ 存活校验过滤。**本机当前 5 个全部存活，没有残留，但不能假设。**

**UI 层**

15. 380px 宽 + subagent 缩进 → 深度上限 3 层，更深折叠。
16. 长标题 / 长分支名 / 长路径 → 单行截断 + `title` 属性给全文。
17. 会话数很多（一屏放不下）→ 列表可滚动，滚动位置跨重渲染保持。
18. 重渲染打断交互 → 见 §5 C4 附。
19. 缩成小球时 tab 栏必须隐藏（`.is-mini` 规则要加 `.fw-tabs`，**漏了就会露出残缺 UI**——这是浮窗小球功能踩过的同类坑）。
20. 非 Tauri 环境（浏览器预览 / playwright）→ 降级文案，不报错。

**隐私**

21. `aiTitle` / `lastPrompt` / subagent `description` 是真实工作内容 → **纯内存、纯展示**。不进 `composer-state.json`、不进导出备份（与"API Key 永不导出"同一条纪律）。
22. warning 的 `detail` 只带文件名，不带文件内容。
23. Rust 侧对文本字段截断到 200 字符，同时也是 IPC 体积上限。
24. 测试夹具必须脱敏，它们会永久进仓库历史。

---

## 10. 未定/待验证事项

实施中需要确认，现在不装作已经知道：

1. ~~sysinfo 的 `start_time()` 在 Windows 上是否稳定可靠~~ → **P3 已验：可靠**，返回正常 UNIX 秒。
2. ~~`remove_dead_processes: true` 配 `Some(&pids)` 的确切语义~~ → **P3 已验：不会清掉未刷新的进程**，只能按 pid 单查。
2b. 【P3 新增】sysinfo 的 `cpu_usage()` 在 **macOS / Linux** 上是否也坏。我们不用它，所以不影响；但如果哪天想换回去，需要先在那两个平台跑 `tests/sysinfo_probe.rs`。
3. Windows 上 `window.hide()` 是否触发 `visibilitychange`（C4 验；不影响正确性）。
4. ~~正在被 Claude Code 追加写入的 jsonl，Windows 上是否可能读到锁~~ → **实测未遇到**。
   多轮真机诊断都在其它会话活跃写入时跑过（本会话自己的 jsonl 一直在被追加），
   读尾部从未失败、`parse_errors` 一直是 0。Windows 上 Claude Code 显然没有用
   独占锁打开这些文件。**但这是"没遇到"不是"证明不会"**，所以 `read_digest` 的
   I/O 错误路径仍然保留并降级成 `transcript-unreadable`，不能删。
5. macOS 全链路 —— 本机是 Windows，`sessions/*.json` 的路径在 macOS 上应当相同（`~/.claude`），但 sysinfo 行为和进程名差异需要真机验。**参照自动粘贴的 macOS 分支：不要假装验过了。**
6. `entrypoint` 的完整取值集合（实测只见到 `claude-vscode`）。**注意采集层不依赖
   它做任何判断**，只当展示字段，所以取值集合不全不构成风险。
7. jsonl 里 `queue-operation` 能否可靠算出"排队中 N 条"（尾部窗口可能不含配对的 enqueue）→ 当前决定不做。
8. 是否值得引入 `claude-code-transcripts` crate（docs.rs 上有）替代自己解析 —— 倾向不引，我们只需要尾部几个字段，引入等于把格式漂移风险交给第三方更新节奏。
9. 【阶段 2 后新增】subagent 的 jsonl 数量会随会话变多（实测单个会话已达 11 个）。
   目前每轮全量读尾部（窗口已收小到 16KB），本机 15 个子 agent 时没有感知延迟；
   但会话多 + 子 agent 多时是否需要按 mtime 缓存跳过未变动的文件，**尚未实测过
   压力场景**。真出现迟钝再优化，不预先做。
10. 【阶段 3 新增】Agent 面板的深浅主题对比度：`fleet-attention` / `fleet-danger`
   在深色主题下是**浅色**（它们本是为"深底上的前景文字"设计的），当背景用时白字
   对比度只有 2.56 / 2.99，连大字号 AA（3.0）都不到。已改为按主题翻转文字色。
   **教训是这类问题肉眼只觉得"有点发灰"，不会明显觉得坏，必须算。**

---

## 11. 参考

**官方文档**
- Agent view（状态规范 + 落盘位置）：`code.claude.com/docs/en/agent-view`
- Statusline（我们放弃的那条路的字段全集）：`code.claude.com/docs/en/statusline`
- Hooks（我们不走的那条路）：`code.claude.com/docs/en/hooks`
- Env vars：`code.claude.com/docs/en/env-vars`

**sysinfo**
- `docs.rs/sysinfo/latest/sysinfo/struct.Process.html`（`cpu_usage()` 需两次采样、可超 100%）

**值得读源码的项目**
- Clawd on Desk `rullerzhou-afk/clawd-on-desk` —— `src/state-priority.js`（优先级归约）、`src/state-session-snapshot.js`（badge 派生）、`hooks/clawd-hook.js`（tail 读姿势）、`docs/guides/known-limitations.md`（阻塞 hook 的反面教材）
- Vibe Kanban `BloopAI/vibe-kanban` —— `crates/server/src/routes/workspaces/workspace_summary.rs`（卡片字段权威定义）
- Happy `slopus/happy` —— `packages/happy-app/sources/sync/storageTypes.ts`（四态 + activity schema）
- opcode `winfunc/opcode` —— Tauri 2 同栈；`src-tauri/src/commands/claude.rs`（目录名编码不可逆的处理）
- CCManager `kbwo/ccmanager` —— `src/services/stateDetector/claude.ts`（**反面教材**：靠匹配 TUI 文案判状态）

**本仓库相关记忆**
- `project-float-window` 浮窗全部实现细节与踩坑
- `feedback-worktree-subagent-workflow` 并行协作模式
- `reference-verify-frontend-playwright` 冒烟测试跑法
- `reference-vitest-global-stub-leak` 单测全局 stub 泄漏坑
- `reference-dom-layer-no-jsdom-test` DOM 层测试姿势（标题有误导，实际结论是 vitest 环境就是 jsdom、DOM 层可测）
</content>
