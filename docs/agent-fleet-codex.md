# Agent Fleet — Codex 会话接入方案（E4）

Agent tab 现在只认 Claude Code 一家，数据源全部锚死在 `~/.claude`。本文是把
Codex 会话也纳进同一个面板的方案。主方案见 [agent-fleet.md](./agent-fleet.md)，
本文只写增量，不重复那边已经定死的东西（观察者定位、零脚印铁律、分层结构）。

- 分支：`feat/fleet-codex-provider`
- 定位：延续观察者原则。**在 `~/.codex` 里同样零脚印，只读不写。**
- 前置：SCHEMA_VERSION 2（E1 后台会话带来的 `pid: Option` + `Liveness::NoProcess`）

## 进度

| 阶段 | 状态 |
|---|---|
| 调研（本机 56 个 rollout 实测） | ✅ 完成 |
| E4a Rust 采集层 | ✅ 完成：config / discover / rollout / index，45 个单测 + 真机验证（9 个会话全部解析成功、标题全部匹配） |
| E4b 契约升 3 + 前端接入 | ✅ 完成：provider 字段 / contextWindow / 徽章 / keyed 身份键，前端 709 测试全绿 |
| E4c 上下文百分比显示 | ⬜ 未开始（数据已到前端，差渲染） |
| E4d approval / error 精确状态 | ⬜ 阻塞：缺样本 |

---

## 0. 结论先行

主方案 §阶段4 的 E4 行当初判断「与其余几项不是一个量级」，理由是没名册、
状态判据要另写、契约要升版。实测下来三条里对了两条：

- **没名册属实**。pid/CPU 确实拿不到，走降级。
- **状态判据不用另写**。Codex 的 `task_started`/`task_complete` 配对比 Claude Code
  那边的 `stop_reason` 更明确，可以在采集层翻译成现有 digest 的形状，
  **前端 `statusCodeFromDigest` 一行不改**。这是本方案最关键的一点，见 §2.2。
- **契约升版属实**，SCHEMA_VERSION 2 → 3。

反而白捡了两样 Claude 侧做不到的：**真实的上下文占用百分比**（Codex 明确给了
`model_context_window`）和**每轮的 model/effort**。

---

## 1. 数据源（全部已在本机实测）

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl
```

本机 56 个文件，横跨三个 Codex 版本：`0.140.0-alpha.2`、`0.146.0-alpha.3.1`、
`0.146.0-alpha.9.2`。

### 1.1 首行恒为 `session_meta`（56/56）

| 字段 | 实测值 |
|---|---|
| `session_id` | `019fc5dc-d8d0-78c2-bdb7-427137d069e2`（与文件名后半段一致） |
| `cwd` | `C:\Users\sososmog\Desktop\sososmog-personal-website` |
| `originator` / `source` | `Codex Desktop` / `vscode` |
| `cli_version` | `0.146.0-alpha.9.2` |
| `git` | `{branch:"main", commit_hash:"ce4584a…", repository_url:"git@github.com:…"}` |
| `base_instructions` | 系统提示词全文 —— **绝不进 IPC**，见 §7 |
| `context_window` | 只是个 `window_id`，**不是窗口大小**，别被名字骗了 |

### 1.2 行类型全集（取最新会话，229 行）

| type | payload.type | 用途 |
|---|---|---|
| `event_msg` | `task_started`（带 `turn_id`、`model_context_window`） | **状态判据核心** |
| `event_msg` | `task_complete`（带 `turn_id`、`last_agent_message`） | **状态判据核心** |
| `event_msg` | `token_count` | 上下文占用 |
| `event_msg` | `user_message` / `agent_message` | 纯文本 `message` 字段，比 Claude 的 content 数组好解析 |
| `event_msg` | `mcp_tool_call_begin/end`（`invocation{server,tool}`） | 工具名 |
| `event_msg` | `turn_aborted` | 用户中断，实测出现过 1 次 |
| `response_item` | `custom_tool_call` / `function_call`（带 `name`） | 工具名，实测 `exec`、`wait` |
| `response_item` | `reasoning` / `message` / `*_output` | tail kind |
| `turn_context` | `model`、`effort`、`approval_policy`、`sandbox_policy` | **每轮更新** |
| `world_state` | — | 用途不明，忽略 |

### 1.3 已实测确认的坑（不是假想）

1. **`session_meta` 不止一条，而且它有 46KB**。样本里出现在 idx 0 和 idx 31
   （第二条多了 `memory_mode`）。首行解析没问题，但**尾部窗口会被它整个占满**
   ——见下面 §1.4，这是实现时唯一一个靠单测抓不出来的坑。
2. **`turn_context` 每轮变**。idx 7 是 `gpt-5.6-terra`/`medium`，idx 35 变成
   `gpt-5.6-sol`/`high`。**必须取最后一条**，取首条会显示过期的模型。
3. **token 有两个口径，差 25 倍**。`total_token_usage.total_tokens` = 2,227,341
   （整个会话累计消耗），`last_token_usage.total_tokens` = 88,172（当前上下文
   占用），窗口 258,400。**算百分比必须用 last** —— 用 total 会显示 862%。
4. **`sessions/` 是只增不删的归档**，跟 `jobs/` 一个毛病。本机 56 个会话里有 19 个
   是 `2026-06-12T11:39` 同一秒创建的，那是 `external_agent_session_imports.json`
   导入的历史。不做保留窗口，面板就是个垃圾堆。
5. **`session_index.jsonl` 不全**。24 行 vs 56 个 rollout（推测只索引 Desktop 建的
   线程）。只能当标题的补充来源，**绝不能当发现源**。
6. **`process_manager/chat_processes.json` 是空数组**，不能当名册用。

### 1.4 尾部窗口必须扩窗重试（真机第一次跑就打脸的判断）

方案初稿在这里写的是「**不**扩窗重试——Claude 侧扩窗是因为单条消息可能超过窗口，
而 Codex 这边『没有内容』是个确定的结论，扩窗只是白读几 MB」。

**这个判断是错的。** E4a 第一次真机验证时，那个 3.7MB、560 行、正在跑的活跃会话
被判成了「已启动 · 未开始」。原因：

```
64KB 尾部窗口切出 3 段：19484 / 46050 / 0 字节
  第 1 段 = 半行，按规矩丢弃
  第 2 段 = 一整条 46KB 的 session_meta（会话中途重写的那条）
  第 3 段 = 空
→ 窗口里唯一完整的一行，是我们不认识的类型 → 判定「无内容」
```

所以 `read_rollout` 必须照抄 Claude 侧 `read_digest` 的 4× 扩窗逻辑，
只有在「窗口盖住整个文件」或「撞到 `TAIL_BYTES_MAX`」时才能下「确实没内容」的结论。
修好之后同一个会话解析出 `gpt-5.6-sol` / `high` / context 64.2%。

**为什么单测抓不到**：复现它要求单行长度和窗口大小在同一个量级（46KB vs 64KB）。
手写夹具总共才几百字节，`start` 恒为 0，连"丢首行"那条分支都走不到。
回归用例（`a_huge_trailing_session_meta_does_not_hide_the_whole_session`）因此必须
真的造一个大于窗口的文件，并在用例开头断言「64KB 窗口里确实只剩那一行」——
否则它会退化成一个随便读读也能过的假测试（第一版就是这样，改坏源码它照样绿）。

### 1.5 明确放弃的功能

- **CPU / 内存**。没有 pid 就没有进程指标，见 §2.1。
- **subagent 树**。`turn_context` 里有 `multi_agent_version` 字段，暗示 Codex 有多
  agent 机制，但本机找不到对应的落盘目录。不猜，先恒空数组。
- **后台会话**。Codex 暂无 `jobs/` 对应物，`job` 恒 `None`。

---

## 2. 架构决策

### 2.1 没有名册 → 第一版不做进程关联

Claude Code 有 `sessions/<pid>.json`，Codex 没有任何等价物。机器上确实有活的
`codex.exe`（实测 pid 22016、50712），但**没有任何磁盘记录把 pid 和 session_id
关联起来**。

| 方案 | 做法 | 判断 |
|---|---|---|
| **A. 纯降级** | `pid: None`、`liveness: no-process`、`proc: None` | ✅ **选这条**。诚实，零误报 |
| B. 进程名 + cwd 匹配 | 枚举 `codex.exe`，用 sysinfo 的 `cwd()` 匹配 `session_meta.cwd` | ❌ 否决，见 §8 |
| C. 全局存活信号 | 只判「有没有 codex 进程」，不逐会话关联 | ❌ 无用：Codex Desktop 常驻，恒为 true |

E1 后台会话已经趟平了 A 这条路 —— `pid: Option`、`Liveness::NoProcess` 是
SCHEMA 2 就有的东西，Codex 直接复用，**契约不用为此再动一次**。

代价要说清楚：**Codex 卡片没有 CPU/内存**。这是数据源的硬限制，不是偷懒。

### 2.2 状态判据：task 配对，前端零改动

整个方案最关键的一点。**不给前端加 provider 分支**，而是在采集层把 Codex 的信号
翻译成现有 `TranscriptDigest` 的形状：

| Codex 尾部实况 | 合成的 digest 字段 | 现有前端判定结果 |
|---|---|---|
| 最后一个 `task_started` 无配对 `task_complete` | `lastRole:'assistant'`, `lastStopReason:'tool_use'` | `working` |
| 有配对 `task_complete` | `lastRole:'assistant'`, `lastStopReason:'end_turn'` | `needs-input` |
| 见到 `turn_aborted` | `lastRole:'assistant'`, `lastStopReason:'stop_sequence'` | `needs-input` |
| mtime 超 `idleMs` | （不用管） | `idle`，现有 age 逻辑自动接管 |

`src/fleet.js` 的 `statusCodeFromDigest` 一个字符都不用改，分组、角标、悬浮小球
状态点全部自动生效。

配对靠 `turn_id`（如 `019fc5dd-03bb-7bb0-b019-0c324ac37a1e`），**不是靠出现顺序**。

> ⚠️ **`lastStopReason` 在 Codex 侧是合成的，不是源数据里的字段。**
> 必须在代码注释里写死这句话 —— 否则半年后有人 grep `stop_reason` 会在 Codex 的
> jsonl 里找不到，怀疑自己看错了。

**防御性回退**：万一某个 Codex 版本不写 `task_started`，回退到「最后一条
`user_message`/`agent_message` 谁在后」的朴素判据。56/56 的覆盖率让这条回退大概率
永远不触发，但成本只有几行，值得留着 —— 本机全是 `Codex Desktop`，没有纯 CLI 的
样本（见 §7）。

### 2.3 契约：加 `provider`，SCHEMA 2 → 3

`AgentSession` 只加一个必填字段：

```rust
pub provider: Provider,   // "claude" | "codex"
```

`TranscriptDigest` 加一个可选字段：

```rust
/// 模型上下文窗口。Codex 的 task_started / token_count 明确给了这个数字，
/// Claude 侧恒为 None（jsonl 区分不出 200k 还是 1M，见 context_tokens 的原注释）。
pub context_window: Option<u64>,
```

这让 Codex 卡片能显示 `88.2k / 258.4k (34%)`，而 Claude 卡片继续只显示绝对值 ——
主方案「不显示错的百分比」的原则不受影响。

三处同步（`src/fleet.js:140` 已有注释提醒）：`types.rs` 的 `SCHEMA_VERSION`、
`fleet.js` 的 `SCHEMA_VERSION`、本文档。

`FleetOptions` 加 `include_codex: Option<bool>`，默认 `true`。

### 2.4 保留窗口：必须做

两层过滤，都很便宜：

1. **按日期目录**：`YYYY/MM/DD` 结构天生有序，只进最近 2 天的目录，
   **不用 stat 任何文件**。
2. **按 mtime**：目录内再按 mtime 过滤，复用 `JOB_TERMINAL_RETENTION_MS` 的思路。

本机实测下来这意味着每轮只读 1–2 个文件，成本可忽略。

**文件名自带 session_id**（`rollout-2026-08-03T12-23-32-<uuid>.jsonl`），不用打开
文件就知道「这个会话是谁」。这比 Claude 侧要遍历 `projects/` 找 jsonl 便宜得多。

⚠️ 但**文件名里的时间不能当起始时间用**（方案初稿这里写错了）：它是本地时间且
不带时区，同一会话的 `session_meta.timestamp` 实测是 `2026-08-03T04:23:32.963Z`，
差整 8 小时（本机 UTC+8）。所以：

- 发现层只从文件名取 `session_id`，**时间一律用 mtime**（文件系统给的就是 epoch）；
- 日期目录同理，只用于字典序排序（零填充，字典序 = 时间序），**从不与当前日期比较**；
- 真正的 `startedAt` 由 `rollout.rs` 从 `session_meta.payload.timestamp` 解析
  ——注意是 `payload` 里那个（会话开始时刻），不是外层那个（这行被写下的时刻），
  实测两者差 11 秒。

### 2.5 `CODEX_HOME`

`base_instructions` 里提到 `$CODEX_HOME/automations/`，说明 Codex 和 Claude Code
一样支持环境变量重定向配置目录。照抄 `config.rs` 的三分支逻辑：

- 环境变量有非空值（trim 后）→ 用它，**不再拼 `.codex`**
- 未设置 / 为空 / 只有空白 → `<home>/.codex`

---

## 3. 字段映射表

| `AgentSession` | Codex 来源 | 备注 |
|---|---|---|
| `provider` | 常量 `codex` | 新增字段 |
| `pid` | — | 恒 `None` |
| `sessionId` | 文件名的 uuid | 与 `session_meta.session_id` 一致 |
| `name` | **cwd 的最后一段** → 退到 sessionId 前 8 位 | 见下方修正 |
| `cwd` | `session_meta.cwd` | |
| `entrypoint` | `originator` + `source`（如 `Codex Desktop / vscode`） | |
| `kind` | 常量 `interactive` | 暂无后台概念 |
| `startedAt` | `session_meta.timestamp` | ISO-8601 UTC → ms epoch，本机 UTC+8 别差 8 小时 |
| `cliVersion` | `session_meta.cli_version` | |
| `liveness` | 常量 `no-process` | |
| `proc` | — | 恒 `None` |
| `subagents` | — | 恒 `[]` |
| `job` | — | 恒 `None` |
| **`transcript.*`** | | |
| `aiTitle` | `session_index.jsonl` 的 `thread_name` | 查不到很正常，那个索引不全 |
| `lastPrompt` | 最后一条 `user_message.message` | |
| `gitBranch` | `session_meta.git.branch` | 直接有，不用像 Claude 侧那样推 |
| `model` / `effort` | **最后一条** `turn_context` | 见 §1.3 坑 2 |
| `lastRole` | 最后一条 user/agent message | |
| `lastStopReason` | **合成**，见 §2.2 | |
| `lastTailKind` | `custom_tool_call`→`tool_use`、`*_output`→`tool_result`、`reasoning`→`thinking`、`message`→`text` | 四态正好对得上 |
| `lastToolNames` | `custom_tool_call.name` / `function_call.name` / `mcp:<server>.<tool>` | 最多 4 个，同 Claude 侧 |
| `contextTokens` | `last_token_usage.total_tokens` | **不是 `total_token_usage`**，见 §1.3 坑 3 |
| `contextWindow` | `model_context_window` | 新字段 |
| `hasApiError` | 未验证 | 保守恒 `false`，见 §7 |
| `parseErrors` | 解析失败行数 | 同 Claude 侧，格式漂移的唯一诊断信号 |

### 3.1 `name` 的映射改了（初稿把两个字段搞反了）

初稿写的是 `name` 取 `thread_name`（会话标题）。**那是错的**：Claude 侧
`name` 来自名册，语义是「这个会话在哪儿干活」（如 `demo-proj-18`），
而会话标题是另一个字段 `aiTitle`，两者在卡片上各占一行。

所以实现里改成：`name` = cwd 的最后一段，`aiTitle` = `thread_name`。
这样两侧卡片的同一行显示的是同一类东西。

**已知的可用性折衷**：同一个目录开多个 Codex 会话时，几张卡片的抬头会完全一样
（真机实测有 4 张都是 `sososmog-personal-website`）。没有加短 id 后缀去区分，
理由是标题行本来就不同（"Find project improvements" / "评估 Taste 和 Inpeccable
skills" / "Review project and await tasks"），而 380px 宽的面板里抬头越短越好。
Claude 侧靠名册自带的 `-b7` 后缀天然避开了这个问题，Codex 没有对应物可用。

---

## 4. 文件清单

```
src-tauri/src/fleet/
  codex/
    mod.rs        编排：发现 → 解析 → 组装 AgentSession
    discover.rs   扫日期目录、保留窗口、文件名解析（不开文件）
    rollout.rs    尾部窗口解析 + task 配对 + digest 合成
    index.rs      session_index.jsonl 读取（标题补充）
  config.rs       + resolve_codex()（CODEX_HOME 三分支）
  mod.rs          scan_blocking 里把 Codex 会话并进现有 sessions 数组
  types.rs        + Provider 枚举、+ contextWindow、SCHEMA_VERSION 3
```

`transcript.rs` 的尾部读取和扩窗重试（`DEFAULT_TAIL_BYTES` / `TAIL_BYTES_MAX`）
**可以复用**，Codex 也是行式 jsonl。但解析器本身要独立 —— 两边的行结构完全不同，
硬塞一个泛型解析器只会让两边都难读。

新增 warning code：`CodexRolloutUnreadable`、`CodexRolloutUnparsable`。
**不新增** `CodexNoSessionsDir` —— 没装 Codex 的机器上那个目录本来就不存在，
那是正常状态不是错误，静默跳过（同主方案里 `TranscriptNotFound` 那条的理由）。

---

## 5. 前端改动

1. **`SCHEMA_VERSION` 2 → 3**（`src/fleet.js:140`）。
2. **卡片 provider 徽章**：Codex 卡片一个小标记。配色注意主方案的教训 ——
   色块上有文字就得算对比度，冒烟脚本里有现成的校验。
3. **⚠️ keyed 更新的 key 要带 provider**。`fleetView.js` 的 E6 加权 LIS 用
   `sessionId` 做身份，两边都是 uuid 撞不了，但 key 改成 `${provider}:${sessionId}`
   是零成本的保险。
4. **CPU 栏**：Codex 卡片 `proc` 为 `None`。现有渲染对后台会话已经处理过这种情况，
   大概率不用改 —— 但要实测确认不是渲染成 `undefined`。
5. **上下文百分比**：有 `contextWindow` 时显示 `34%`，没有时维持现状。
6. 可选：按 provider 过滤的开关。

---

## 6. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **E4a** | `config.rs` + `discover.rs` + `rollout.rs`，纯 Rust，单测吃真实 fixture | `cargo test`；解析出本机 56 个会话的正确 digest |
| **E4b** | 契约升 3 + 编排层接入 + 前端徽章 | 面板同时出现 Claude 和 Codex 卡片，状态正确 |
| **E4c** | 上下文百分比 + 保留窗口调优 | 归档会话（06-12 那 19 个）不进列表 |
| **E4d** | approval / error 事件的精确状态 | 阻塞，需先抓到样本 |

E4a 是大头，也是唯一有真实技术难度的一段。它不碰契约、不碰前端，可以独立验证。

---

## 7. 未定/待验证事项

1. **`hasApiError` 没有样本**。56 个文件里没抓到 `error` / `stream_error` 事件，
   不知道它长什么样。第一版恒 `false` —— 宁可不报，不猜一个错的判据。
   对比 Claude 侧：`hasApiError` 是判定顺序里的第一优先级，Codex 侧暂时缺这一环。
2. **审批阻塞判不出来**。Codex 有 `approval_policy: on-request`，理论上存在
   「等你批准执行命令」的状态，那比 `needs-input` 更紧急。没抓到
   `exec_approval_request` 样本，第一版会把它显示成 `working`（因为 task 还没
   complete）。**这是已知的误报方向**，但至少不会漏报成「闲着」。
3. **本机全是 `Codex Desktop`**。没有纯 CLI（`originator` 为其它值）的会话样本，
   CLI 的 rollout 是否同样写 `task_started` 未经验证。§2.2 的防御性回退就是
   为这个准备的。
4. **`world_state` 用途不明**，直接忽略。
5. **隐私**：rollout 里有系统提示词全文、代码内容、token 用量。采集层白名单取
   字段，`base_instructions` / `dynamic_tools` 绝不进 IPC。（那玩意儿一条就几 KB
   —— `session_meta` 首行 2000 字节里 1700 是它。）
6. **fixture 要脱敏**：本机会话带真实仓库地址和代码，进 git 前必须清洗。

---

## 8. 被否决的方案

### 进程名 + cwd 匹配拿 CPU

枚举 `codex.exe`，用 sysinfo 的 `cwd()` 去匹配 `session_meta.cwd`。否决理由三条：

- 主方案已经记过一次教训：**不按进程名找 claude**。同一个坑不该踩第二次。
- 一个 cwd 完全可能开多个会话（本机 07-28 那天同一目录 6 个），匹配是多对一，
  会把 CPU 张冠李戴。
- 本机除了两个 `codex.exe`，还有 `codex-code-mode-host.exe`、
  `codex-windows-sandbox-setup.exe`、一堆 `node_repl.exe` —— 哪个是「会话主进程」
  根本无从判定。

给一个错的 CPU 数字，比留空糟糕得多。

### 用 `session_index.jsonl` 做发现源

24 行 vs 56 个 rollout，它不全。只当标题来源。

### 为 Codex 单写一套前端状态判定

§2.2 的翻译层让这件事完全没必要。多一套判定就是多一处会长歪的地方。
