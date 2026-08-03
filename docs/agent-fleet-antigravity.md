# Agent Fleet — Antigravity 会话接入方案（E9）

Agent tab 目前认两家：Claude Code（`~/.claude`，五层采集）和 Codex（`~/.codex`，
一条平级链）。本文是把 **Antigravity**（Google 的 Gemini 系 agentic IDE）也纳进
同一个面板的方案。

主方案见 [agent-fleet.md](./agent-fleet.md)，Codex 方案见
[agent-fleet-codex.md](./agent-fleet-codex.md)。本文只写增量，不重复那两篇已经定死的
东西（观察者定位、零脚印铁律、digest 翻译层范式）。

- 分支：`feat/fleet-antigravity-provider`
- 定位：延续观察者原则。**在 `~/.gemini` 里同样零脚印，只读不写。**
- 前置：SCHEMA_VERSION 3（E4 带来的 `provider` + `contextWindow`）

## 进度

| 阶段 | 状态 |
|---|---|
| 调研（本机 18 个会话库实测，两个安装） | ✅ 完成 |
| E9a Rust 采集层 | ⬜ 未开始 |
| E9b 契约升 4 + 前端接入 | ⬜ 未开始 |
| E9c 项目名与分支 | ⬜ 未开始 |
| E9d 精确状态（working/needs-input 区分） | ⬜ **阻塞：缺样本，且是本方案唯一的真问题** |

---

## 0. 结论先行

**能接，而且采集难度比 Codex 低。** 数据是结构化 SQLite，不用像 Codex 那样跟 64KB
尾窗和 46KB 单行搏斗——一条 `select … order by idx desc limit 1` 就拿到尾部状态。

但有一件事**比 Codex 差**，而且是本方案的核心风险：

> **Antigravity 的落盘里区分不出「正在干活」和「等你说话」。**

实测 18 个会话库，**每一个的最后一步都是 `type=15 status=3`**，无一例外。
不管那个会话是刚被用户打断的、跑完在等输入的、还是我关掉 IDE 时正在跑的——
尾部长得一模一样。Codex 那边 `task_started`/`task_complete` 的 `turn_id` 配对
是个明确信号，Antigravity 没有等价物。

所以第一版**只能把所有 Antigravity 会话显示成 `needs-input` 或 `idle`（靠 mtime）**，
不显示 `working`。这是数据源的硬限制。详见 §2.2，那里也写了为什么"猜一个"比
"不猜"糟。

反过来白捡了三样：
- **真实的项目名和 git 分支**（`config/projects/*.json` 直接给 `gitFolder.folderUri`
  和 `defaultBranch`，比 Claude 侧靠 cwd 反推、比 Codex 侧靠 `session_meta.git` 都干净）
- **人话活动摘要**（`toolSummary` 字段是 Antigravity 自己写给 UI 看的，
  如 `Finding log date range`，不用我们从工具参数里编）
- **两个安装的数据完全同构**，采集器写一份扫两个根

---

## 1. 数据源（全部已在本机实测）

### 1.1 两个独立安装，各一套数据

⚠️ **这是与 Claude/Codex 最大的结构差异：不是一个根目录，是两个。**

| | 路径 | installation_id | 会话数 |
|---|---|---|---|
| Antigravity | `~/.gemini/antigravity/` | `d8479eed-e004-…` | 12 |
| Antigravity IDE | `~/.gemini/antigravity-ide/` | `b72a5aeb-6480-…` | 6 |

两者 schema 完全相同，是同一个产品的两个 channel（正式版与 IDE 版并存）。
用户明确要求**两个都覆盖**。

实测 cascadeId 在两个安装间**无重叠**，但仍然要把 install 拼进身份键——
理由同 E4 §5.3：零成本的保险，别等真撞了才补。

对应的 Electron 侧目录（`%APPDATA%/Antigravity/` 和 `%APPDATA%/Antigravity IDE/`）
只有窗口状态和缓存，**不是采集源**，唯一有用的是 §1.5 那个当前打开会话的线索。

### 1.2 目录结构

```
~/.gemini/{antigravity,antigravity-ide}/
  conversations/<cascadeId>.db     ← 主数据源，每会话一个 SQLite 库
  brain/<cascadeId>/               ← artifact：task.md / implementation_plan.md / walkthrough.md
  installation_id
  antigravity_state.pbtxt          ← 只有 antigravity/ 有；protobuf 文本格式
~/.gemini/config/
  projects/<uuid>.json             ← 项目名 + gitFolder + defaultBranch（两个安装共享）
  config.json                      ← 只有主题和 hostname，无用
```

`brain/` 里的 artifact 第一版不读（见 §7.4）。

### 1.3 SQLite schema（18/18 库完全一致）

```sql
CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text,
                              trajectory_type integer, source integer,
                              PRIMARY KEY (trajectory_id));
CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0,
                    status integer NOT NULL DEFAULT 0,
                    has_subtrajectory numeric NOT NULL DEFAULT false,
                    metadata blob, error_details blob, permissions blob,
                    task_details blob, render_info blob, step_payload blob,
                    step_format integer …);
CREATE TABLE gen_metadata (idx integer, data blob, size integer …);
CREATE TABLE executor_metadata (idx integer, data blob, …);
CREATE TABLE parent_references (idx integer, data blob, …);   -- 实测全空
CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, …);
CREATE TABLE battle_mode_infos (idx integer, data blob, …);   -- 实测全空
```

`steps` 行数实测 6～835。`trajectory_meta` 恒 1 行，`trajectory_type=4`、`source=1`
（18/18 都一样，暂不知其它取值含义，不依赖它）。

### 1.4 blob 是 protobuf，但**不解 proto**

`step_payload` / `metadata` 是二进制 protobuf。**不引 prost、不写 .proto**，
理由：没有公开 schema，字段号会随上游漂移，解错比不解糟。

改用**ASCII 抽取 + JSON 子串定位**。实测 payload 里有一段完整的 JSON 明文，
这是 Antigravity 自己塞进去的工具入参：

```
run_command
{"CommandLine":"powershell -Command \"Get-ChildItem 'C:\\Users\\…\\.claude\\projects' …\"",
 "Cwd":"C:\\…","IsDaemon":false,"WaitMsBeforeAsync":…,
 "toolAction":"Running command","toolSummary":"Find log date range"}
…
Find log date range              ← toolSummary 又以裸串形式重复出现
Finding log date range           ← toolAction 的进行时态
```

所以解析策略是：**在 payload 里找第一个 `{"` 开头、能被 `serde_json` 吃下的
平衡括号子串**，从里面白名单取 `toolSummary` / `toolAction` / `Cwd` /
`CommandLine`。取不到就退到裸串抽取。两条都失败只记 `parseErrors`，不猜。

⚠️ **JSON 子串扫描必须是平衡括号扫描，不能 `find('{')` + `rfind('}')`**——
payload 里 JSON 之后还有 protobuf 的二进制字段名（`run_command*`、`Cwd*`、
`toolSummary2`），`rfind` 会把它们一起吞进来。

### 1.5 已实测确认的坑（不是假想）

1. **`journal_mode=wal`** —— **最要紧的一条，也是与 Codex 的关键差异。**
   Codex 的 rollout 是普通 jsonl，我们可以随便读。这边是 WAL 模式的 SQLite，
   意味着：
   - **绝不能用 `?immutable=1`**。那会让 SQLite 忽略 `-wal` 文件，读到一个
     陈旧快照——正在跑的会话的最新几十步全看不见，而且不报错。
     （调研时我第一版就写了 `immutable=1`，是查 `pragma journal_mode` 才发现的。）
   - 正确写法：`file:<path>?mode=ro`，**不带 immutable**，让 SQLite 正常走 WAL。
   - `mode=ro` 下 SQLite 仍需要能读 `-wal`/`-shm`。实测这两个 sidecar 在
     Antigravity 没跑时不存在（干净关闭会 checkpoint 掉），跑起来时才出现。
2. **成本可忽略**：两个安装 18 个库全扫（开库 + tail 查询 + count）实测 **21ms**。
   不需要为性能做任何特殊设计，也不需要缓存 db 路径（对比 Claude 侧要缓存
   transcript 路径，因为那边得遍历 16 个项目目录）。
3. **模型是占位符**：`MODEL_PLACEHOLDER_M71` / `M16` / `M72`。
   好消息是它**per-session 真实归属**（不同会话不同值，不是静态菜单），
   坏消息是要自己维护 → 人类可读名的映射，会随上游漂移。见 §2.4。
4. **`status` 的取值不是"进行中/完成"**，实测全集 `{3: 2729, 6: 16, 7: 7}`：
   - `3` = 正常完成（99.2%）
   - `6` = **`IsDaemon:true` 的长跑进程**（全部是 `npm run dev` / `vite` /
     `python -m http.server` 这类起服务器的命令）
   - `7` = **失败**（实测是 `list_dir` 目录不存在、`ask_permission` 被拒）
   
   ⚠️ **`7` 不是"等待审批"**。`ask_permission` 这个 step_type（132）存在，
   容易让人以为抓到了 Codex E4d 缺的那个审批态样本——**不是**。
   实测那三条 status=7 的 `ask_permission` 都是**已经结束**的（被拒绝/已完成），
   不是"正挂着等你点同意"。别被 step 名字骗了。
5. **`gen_metadata` / `executor_metadata` 里有系统提示词全文和沙箱命令白名单**
   （`As IDE feedback, the following lint errors…`、`apt-get`/`docker`/`kubectl`
   一长串）。**绝不进 IPC**，同 E4 §7.5 对 `base_instructions` 的处理。
6. **Python 读这些库时 Windows 控制台 GBK 会炸**（`UnicodeEncodeError: 'gbk'`）。
   只影响调研脚本，不影响 Rust。写 fixture 生成脚本时记得 `PYTHONIOENCODING=utf-8`。
7. **没有进程名册**。调研时 Antigravity 没在跑，`Get-CimInstance` 按
   `antigravity|agy` 匹配**零结果**。没有任何 `<pid>.json` 等价物。→ §2.1

### 1.6 step_type 实测全集

| type | 含义（从 payload 推断） | 用途 |
|---|---|---|
| 8 | `view_file` | 工具名 |
| 9 | `list_dir` | 工具名 |
| 14 | 只有 id，用途不明 | 忽略 |
| 15 | **agent 输出**（含 markdown 正文） | 尾部内容、`lastRole` |
| 17 | 出现 1 次（3dbc8c30 尾部） | 忽略 |
| 21 | `run_command` | 工具名 + cwd |
| 23 | 只有 id | 忽略 |
| 33 | `search_web` | 工具名 |
| 85 | `browser_subagent` | **subagent 唯一样本**，见 §2.5 |
| 98 | 只有 id，每库 idx≈1 | 疑似会话头，忽略 |
| 132 | `ask_permission` | 工具名（**不是审批态**，见坑 4） |

**这张表是不完备的**：它来自本机 18 个会话，只覆盖我实际用过的功能。
未知 type 必须静默忽略（记 `parseErrors` 但不产 warning），不能 panic、
不能当成"解析失败"整条丢弃。

---

## 2. 架构决策

### 2.1 没有名册 → 不做进程关联（同 E4，理由更强）

Codex 那边至少机器上有活的 `codex.exe` 可看。Antigravity 连这个都没有：
调研时按进程名匹配零结果。

沿用 E4 §2.1 的**方案 A 纯降级**：`pid: None`、`liveness: NoProcess`、`proc: None`。
SCHEMA 2 就有的东西，契约不用为此再动。

**代价**：Antigravity 卡片没有 CPU/内存。同 Codex，是数据源硬限制。

明确**否决**「按进程名 + cwd 匹配」：主方案已记过一次教训（不按进程名找 claude），
E4 §8 又否决过一次，这是同一个坑的第三次。而且这边更没得谈——Antigravity 是
Electron 应用，一个进程带几十个 renderer/utility 子进程，"会话主进程"根本不存在。

### 2.2 状态判据：**只能两态，且必须诚实**

**本方案唯一的真问题。**

沿用 E4 §2.2 的翻译层范式——在采集层合成 `TranscriptDigest`，
`src/fleet.js` 的 `statusCodeFromDigest` 一个字符不改。但可合成的状态少一个：

| Antigravity 尾部实况 | 合成的 digest 字段 | 前端判定结果 |
|---|---|---|
| 尾部 step 是 `type=15`（agent 输出） | `lastRole:'assistant'`, `lastStopReason:'end_turn'` | `needs-input` |
| 尾部 step 是工具类（8/9/21/33/132） | `lastRole:'assistant'`, `lastStopReason:'tool_use'` | `working` |
| mtime 超 `idleMs` | （不用管） | `idle`，现有 age 逻辑接管 |

**但实测 18/18 的尾部都是 `type=15`**，所以现实里第一版几乎恒定显示
`needs-input` / `idle` 两态。上面那行 `working` 是为"真的在跑时尾部停在工具步"
准备的，**未经验证**——因为我没能在 Antigravity 正在跑的瞬间抓到一个库快照。

为什么**不**猜一个更聪明的判据：

- **拿 mtime 当 working 判据**（"30 秒内写过 = 在跑"）：否决。
  用户手动翻看历史会话、IDE 后台 checkpoint 都会碰 mtime。
  会把闲着的会话报成在跑，**误报方向是最坏的那个**——面板的价值就在于
  "哪个 agent 在等我"，谎报"在跑"等于让用户忽略它。
- **拿 `status=6` 当 working**：否决。那是 daemon 服务器进程（`vite` 之类），
  跟"agent 在思考"完全是两件事，一个起了 dev server 的会话会永久显示 working。
- **不区分，全报 needs-input**：✅ **选这条**。
  最坏情况是一个真在跑的会话被显示成"等你说话"，用户点过去发现它在跑——
  轻微困扰。反过来（在等你、却显示在跑）会让用户漏掉它。

> ⚠️ **`lastStopReason` 在 Antigravity 侧是合成的，源数据里没有这个字段。**
> 必须在代码注释里写死这句话——同 E4 §2.2 的同一条理由。这是第三个 provider
> 了，`grep stop_reason` 找不到源头的困惑会翻倍。

E9d 就是"等抓到活体样本后把 working 判准"这件事。**它阻塞在样本上，
不阻塞 E9a-c 交付。**

### 2.3 契约：SCHEMA 3 → 4

`Provider` 枚举加变体。types.rs 那段注释（"真有第三家进来时该加枚举变体，
而不是靠 null 表示"）正是为这一刻写的：

```rust
pub enum Provider {
    Claude,
    Codex,
    Antigravity,     // 新增
}
```

序列化成 `"antigravity"`（`serde(rename_all="lowercase")` 已就位，不用加 attr）。

**新增一个字段**，`AgentSession`：

```rust
/// 哪个 Antigravity 安装（`antigravity` / `antigravity-ide`）。
/// 其余 provider 恒 None。前端把它拼进身份键，并在徽章上区分两个 channel。
pub install: Option<String>,
```

犹豫过是否复用 `entrypoint` 塞这个信息（那样契约不用动）。**否决**：
`entrypoint` 在 Claude 侧语义是"怎么启动的"，塞安装 channel 是语义污染，
而且身份键需要它是个独立字段，混在一起要靠字符串切分。

`FleetOptions` 加 `include_antigravity: Option<bool>`，默认 `true`（同
`include_codex`）。

三处同步（`src/fleet.js:12` 与 `:149` 已有注释提醒）：`types.rs:13` 的 `SCHEMA_VERSION`、
`fleet.js` 的 `SCHEMA_VERSION`、本文档 + 主方案的进度表。

### 2.4 模型占位符映射

`MODEL_PLACEHOLDER_M71` 这种东西直接显示在卡片上很难看，但**映射表要放前端还是
采集层**有个取舍：

- 放采集层：卡片直接拿到 `Gemini 3.x`，前端零改动。但映射错了要重编 Rust。
- 放前端：改一行 JS 就能修。

**选采集层**，理由是与 Claude/Codex 一致——那两家的 `model` 字段进 IPC 时
已经是可读名了，前端从不做 model 翻译。

**映射表怎么填**：本机只观察到 M71/M16/M72 三个值，且**无法从落盘反推它们对应
哪个真实模型**。`antigravity_state.pbtxt` 里有 `last_selected_agent_model:
MODEL_PLACEHOLDER_M71`，只能确认"这是当前选中的模型"，拿不到名字。

所以第一版：**已知的三个都不硬编码为具体模型名**，一律显示原始占位符去掉前缀
后的短名（`M71`），并在字段注释里写明"这是上游占位符，映射待补"。
宁可显示 `M71` 也不猜一个 `Gemini 3 Pro` 然后被上游改版打脸。

E9c 的可选项：用户手工确认一次映射后再硬编码。

### 2.5 subagent：有样本但只有一个 → 恒空数组

`step_type=85` / `browser_subagent` 是真实存在的 subagent 机制，payload 里
字段齐全：

```
browser_subagent
{"RecordingName":"ui_gallery_demo","Task":"Open http://localhost:5173/ …",
 "TaskName":…,"TaskSummary":…}
Launch browser subagent to verify UI          ← toolAction
Verifying UI showcase with browser agent      ← toolSummary
```

同时 `steps.has_subtrajectory` 是个显式布尔标记。

**但样本严重不足**：18 个库 2752 步里只有 **1 步** `has_subtrajectory=1`，
且 `parent_references` 表 **18/18 全空**。

- 子轨迹的内容存在哪里？不知道。`parent_references` 空着说明它不是靠这张表关联的。
  可能在同库另一段、可能在另一个 db、可能就没落盘。
- 一个样本推不出树结构。Claude 侧 subagent 树能做，是因为有 11 个子 agent 的
  两层树可以对照 `meta.json` 的 `spawnDepth` 验证。

**第一版 `subagents: vec![]`**，同 E4 §1.5 对 Codex 的处理。
不猜结构——猜错了画出一棵假树，比不画糟得多。

E9d 的一部分：`browser_subagent` 至少可以**当工具名显示**（进 `lastToolNames`），
这不需要理解树结构，零风险。这条第一版就做。

### 2.6 保留窗口：必须做，但比 Codex 简单

`conversations/` 同样是只增不删的归档（本机最老的是 07-28，跨 6 天）。
不做过滤面板就是垃圾堆。

但**不需要 Codex 那套日期目录技巧**——这边是平铺的 `<cascadeId>.db`，
直接 `stat` 拿 mtime 过滤。18 个文件 stat 一遍的成本在噪声里。

复用 `JOB_TERMINAL_RETENTION_MS` 的思路和常量口径。
**文件名自带 cascadeId**，不打开文件就知道是谁——同 Codex，很省。

### 2.7 项目名与 git 分支：本方案白捡的部分

`~/.gemini/config/projects/<uuid>.json`（**两个安装共享这一份**）：

```json
{
  "id": "7033814b-…",
  "name": "sososmog-personal-website",
  "projectResources": { "resources": [ {
      "gitFolder": {
        "folderUri": "file:///c%3A/Users/sososmog/Desktop/sososmog-personal-website",
        "defaultBranch": "main"
  } } ] },
  "permissionGrants": { … }     ← 有真实命令历史，不进 IPC
}
```

两种 resource 形态实测都有：`gitFolder`（带分支）和裸 `folderUri`（scratch 项目，
无 git）。还有个特殊 id `outside-of-project`，无 resources。

⚠️ **`folderUri` 是 percent-encoded 的 file URI**（`c%3A` = `c:`）。
要解码才是路径。别直接当路径用。

⚠️ **`defaultBranch` 是"默认分支"不是"当前分支"**。它是仓库配置，不是 HEAD。
一个在 feature 分支上干活的会话，这里还是写 `main`。

这是个诚实性问题：Claude 侧的 `gitBranch` 语义是**当前分支**。
把 `defaultBranch` 填进 `gitBranch` 会显示一个错的分支。

**决策**：`gitBranch` 填 `None`，**不填 defaultBranch**。
宁可留空也不显示错的分支——同主方案"不显示错的百分比"的原则。
（如果要真分支：cwd 已知，可以自己读 `.git/HEAD`。但那是**在用户仓库里做
额外 I/O**，且 Claude 侧的分支是从 transcript 里拿的现成值。留作 E9c 可选项，
默认不做。）

**cascadeId → project 的关联关系尚未确认**：`trajectory_metadata_blob` 里抽出了
`outside-of-project` 这个字符串（497 字节的 blob 里），说明关联信息**在库里**，
但只验证了 `outside-of-project` 这一种。带 uuid 的项目怎么关联，需要在 E9a
用一个属于真实项目的会话验证。**这是 E9a 的第一个待验证项**，不是已知结论。

### 2.8 `GEMINI_HOME` / 目录重定向

Claude 有 `CLAUDE_CONFIG_DIR`，Codex 有 `CODEX_HOME`。Antigravity 是否支持类似
环境变量**未确认**——`base_instructions` 里没找到线索，官方文档没查。

第一版照抄 `config.rs` 的三分支范式，读 `GEMINI_HOME`（有非空值就用它，
否则 `<home>/.gemini`），**但这只是防御性的**，没有证据表明这个变量存在。
成本几行，且与既有两家的结构一致。

---

## 3. 字段映射表

| `AgentSession` | Antigravity 来源 | 备注 |
|---|---|---|
| `provider` | 常量 `antigravity` | 新增枚举变体 |
| `install` | `antigravity` / `antigravity-ide` | **新增字段** |
| `pid` | — | 恒 `None` |
| `sessionId` | 文件名的 cascadeId | 与 `trajectory_meta.cascade_id` 一致 |
| `name` | 项目名（`projects/*.json` 的 `name`）→ 退到 cwd 末段 → 退到 cascadeId 前 8 位 | 关联关系待 E9a 验证 |
| `cwd` | payload JSON 的 `Cwd`（取最后一个有值的 step） | 无 `run_command` 的会话拿不到 |
| `entrypoint` | 常量 `Antigravity` / `Antigravity IDE` | 按 install 区分 |
| `kind` | 常量 `interactive` | 无后台概念 |
| `startedAt` | db 文件 **birthtime**，取不到退 mtime | 见下方 ⚠️ |
| `cliVersion` | — | 恒 `None`，落盘里没有版本号 |
| `liveness` | 常量 `no-process` | |
| `proc` | — | 恒 `None` |
| `subagents` | — | 恒 `[]`（§2.5） |
| `job` | — | 恒 `None` |
| **`transcript.*`** | | |
| `aiTitle` | — | 恒 `None`；未找到会话标题的落盘位置 |
| `lastPrompt` | 最后一个 `type=15` 之前的用户输入 | **待验证**：用户输入的 step_type 未确认 |
| `gitBranch` | — | **恒 `None`**，理由见 §2.7 |
| `model` | `gen_metadata` 的 `MODEL_PLACEHOLDER_Mxx` → 短名 | 见 §2.4 |
| `effort` | — | 恒 `None` |
| `lastRole` | 尾部 step 推断 | 见 §2.2 |
| `lastStopReason` | **合成**，见 §2.2 | |
| `lastTailKind` | `type=15`→`text`、工具类→`tool_use` | 只映两态，够用 |
| `lastToolNames` | 尾部若干 step 的工具名（含 `browser_subagent`） | 最多 4 个，同其余两家 |
| `contextTokens` | — | 恒 `None`，落盘里没有 token 计数 |
| `contextWindow` | — | 恒 `None` |
| `hasApiError` | `status=7` 的 step？ | **恒 `false`**，见 §7.2 |
| `parseErrors` | 解析失败的 step 数 | 同其余两家，格式漂移的唯一诊断信号 |

⚠️ **`startedAt` 用 birthtime 有平台问题**：Windows 有创建时间，
`std::fs::Metadata::created()` 可用。但这个字段在 Linux 上常常 `Unsupported`。
Antigravity 目前只有 Win/macOS 版，风险可接受；取不到就退 mtime 并接受
"启动时间 = 最后活动时间"的失真（比编一个数字好）。

**诚实地说，这张表里 `None` 很多**：没有 cliVersion、没有 token、没有标题、
没有分支、没有 CPU。Antigravity 卡片会比 Claude 卡片朴素得多，
大致等于「项目名 + 模型短名 + 活动摘要 + 相对时间」。这就是数据源能给的东西。

---

## 4. 文件清单

```
src-tauri/src/fleet/
  antigravity/
    mod.rs        编排：发现 → 逐库解析 → 组装 AgentSession
    discover.rs   扫两个安装根、保留窗口、文件名取 cascadeId（不开库）
    trajectory.rs 开库（mode=ro，不带 immutable）、tail 查询、digest 合成
    payload.rs    protobuf blob 的 JSON 子串定位 + 白名单取字段 + 裸串回退
    projects.rs   config/projects/*.json 读取（项目名；folderUri 解码）
  config.rs       + resolve_antigravity() → Vec<(install, PathBuf)>，两个根
  mod.rs          list_agent_sessions 里加第三条平级链
  types.rs        + Provider::Antigravity、+ install 字段、SCHEMA_VERSION 4
```

**依赖**：需要 SQLite。`src-tauri` 目前没有 rusqlite——**这是本方案唯一的新依赖**，
要在 PR 里单独说明。用 `rusqlite` 的 `bundled` feature（自带 SQLite 源码编译），
避免依赖系统库导致 CI 的 macOS/Windows 编译检查挂掉（PR #34 刚加的那两个 job）。

`bundled` 会让首次编译变慢（C 编译），这是要接受的成本。
考虑过手写 SQLite 文件格式解析器来避免依赖——**否决**，WAL 模式下这等于
自己实现一遍 WAL 重放，是纯粹的自找麻烦。

新增 warning code：`AntigravityDbUnreadable`、`AntigravityDbUnparsable`。
**不新增** "目录不存在" —— 没装 Antigravity 的机器上那目录本来就不存在，
正常状态不报警，同 E4 §4 对 Codex 的处理。

`transcript.rs` 的尾窗/扩窗逻辑**用不上**（SQL 直接 `order by idx desc`）。
这是 SQLite 数据源相对 jsonl 的纯收益。

---

## 5. 前端改动

1. **`SCHEMA_VERSION` 3 → 4**（`src/fleet.js`）。
2. **provider 徽章加两个取值**：`Antigravity` / `Antigravity IDE`。
   `fleetView.js:453` 那行现在是 `session.provider === 'codex' ? 'Codex' : ''`
   的三元，**三家之后要改成查表**，别接着堆三元。
   ⚠️ 配色注意主方案的教训：色块上有文字就得算对比度，
   `npm run smoke` 那个对比度校验脚本要加对应断言。
3. **⚠️ keyed 更新的身份键要带 install**。`fleetView.js:533` 现在是
   `provider + ':' + sessionId`，改成 `provider + ':' + (install ?? '') + ':' + sessionId`。
   E6 的加权 LIS 靠这个键保文本选区，键撞了会串卡片。
4. **CPU 栏**：`proc` 为 `None`。Codex 卡片已经走过这条路，大概率不用改——
   但同 E4 §5.4 的要求，**要实测确认不是渲染成 `undefined`**。
5. **大量 `None` 字段的渲染**：这是 Antigravity 特有的压力测试。
   没有 token、没有分支、没有标题、没有 cliVersion 的卡片长什么样，
   现有渲染没被这么空的数据考验过。要真机看一眼有没有孤零零的分隔符
   （`·` 两边都空）。
6. 可选：按 provider 过滤的开关（Codex 那版也留了这个可选项，一直没做）。

---

## 6. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **E9a** | `config.rs` + `discover.rs` + `trajectory.rs` + `payload.rs` + `projects.rs`，纯 Rust | `cargo test`；本机 18 个库全部解析出正确 digest，`parseErrors` 为 0；**先解决 §2.7 的 cascadeId→project 关联验证** |
| **E9b** | 契约升 4 + 编排层接第三条链 + 前端徽章与身份键 | 面板同时出现三家卡片；空字段不出现孤立分隔符 |
| **E9c** | 项目名落地；可选：真实分支（读 `.git/HEAD`）、模型映射表 | 卡片显示项目名而非 uuid |
| **E9d** | working 状态判准 + `browser_subagent` 进工具名 | **阻塞**：需先抓活体样本 |

E9a 是大头，且不碰契约、不碰前端，可独立验证——同 E4a 的节奏。

**先做 E9a 的一个前置实验**（半小时，不写生产代码）：在 Antigravity 里跑一个
长任务，任务跑到一半时把库复制出来，看尾部 step 长什么样。这一步同时解决
§2.2 的 working 判据和 §2.5 的 subagent 样本——**是解开 E9d 阻塞的唯一途径**，
建议在 E9a 之前就做，别重蹈 E4d 一直挂着的覆辙。

---

## 7. 未定/待验证事项

1. **cascadeId → project 的关联**（§2.7）。只验证了 `outside-of-project`。
   **这是 E9a 的头号待验证项**，`name` 字段的质量全靠它。
2. **`hasApiError` 没有可靠判据**。`status=7` 是"这一步失败了"（目录不存在之类），
   跟 Claude 侧 `hasApiError`（API 层面报错）语义不同。一个 `list_dir` 找不到目录
   不该让卡片显示红色错误态。第一版恒 `false`——同 E4 §7.1，宁可不报不猜。
3. **用户输入的 step_type 未确认**，所以 `lastPrompt` 待定。
   `type=14`/`23`/`98` 这几个"只有 id"的类型里可能有一个是用户消息，
   payload 太短看不出来。E9a 要定位。
4. **`brain/` artifact 第一版不读**。里面的 `task.md` / `implementation_plan.md`
   是 agent 当前在做什么的高质量摘要，比工具名有信息量。但读它要处理
   "哪个 artifact 是最新的"，且这些文件里有大段用户代码/需求
   （隐私面比 digest 大得多）。留作 E9 之后的可选增强。
5. **`trajectory_type` / `source` 恒为 4 / 1**，其它取值含义不明。不依赖。
6. **`battle_mode_infos` 表全空**，名字暗示 A/B 对比模型的功能，忽略。
7. **两个安装是否会同时运行**未验证。如果会，两份 WAL 同时在写，
   §1.5 坑 1 的 sidecar 可读性要再确认一次。
8. **fixture 脱敏**：本机库里有真实仓库路径、命令历史、代码片段。
   进 git 前必须清洗——而且 SQLite 二进制 fixture 比 jsonl 难人工核对，
   建议用脚本**生成**最小库（自己 CREATE TABLE + INSERT 合成 payload），
   而不是拷真实库来删字段。同 E4 §7.6 但更严格。
9. **隐私白名单**：`gen_metadata`/`executor_metadata` 有系统提示词全文，
   `projects/*.json` 的 `permissionGrants` 有完整命令历史。
   采集层白名单取字段，这两处**绝不整体进 IPC**。

---

## 8. 被否决的方案

### 解 protobuf（引 prost + 写 .proto）
没有公开 schema，字段号靠逆向。上游改一版就全错，且错得静默。
ASCII/JSON 抽取虽然土，但**失败是显式的**（取不到就是 None），
且已实测能拿到所有需要的字段。

### 用 `?immutable=1` 打开库
WAL 模式下会读到陈旧快照且不报错——正在跑的会话看起来像停在半小时前。
调研时踩过，见 §1.5 坑 1。

### 手写 SQLite 解析器以避免 rusqlite 依赖
WAL 模式下等于自己实现 WAL 重放。用 `rusqlite` + `bundled`。

### 拿 mtime 或 `status=6` 当 working 判据
§2.2 详述。误报"在跑"是最坏的误报方向，会让用户漏掉真正在等他的会话。

### 把 `defaultBranch` 填进 `gitBranch`
那是仓库默认分支，不是当前分支。显示错的分支比留空糟。§2.7。

### 把 install channel 塞进 `entrypoint` 以避免加契约字段
语义污染，且身份键需要独立字段。§2.3。

### 按进程名匹配拿 CPU
同一个坑的第三次。Antigravity 是 Electron，"会话主进程"不存在。§2.1。
