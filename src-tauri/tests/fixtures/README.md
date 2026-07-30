# Agent Fleet 测试夹具

**全部是合成数据。** 结构忠于 Claude Code **2.1.220** 在 Windows 11 上的实测观察
（观察日期 2026-07-30），内容一律占位文本。

## 为什么不直接用真实数据

`aiTitle` / `lastPrompt` / subagent `description` 是用户真实工作内容，
而夹具会永久进仓库历史。所以采取"结构照抄、内容重写"的做法：
先程序化调查真实文件的字段集与嵌套形状，再手工构造同结构的占位数据。

生成后跑过脱敏检查（搜用户名与真实项目名，0 命中）。

## ⚠️ 字节精确性

`utf8-heavy.jsonl`、`single-huge-message.jsonl`、`no-trailing-newline.jsonl`
这三个夹具的用途**依赖具体字节偏移**，不只是内容。

仓库根 `.gitattributes` 是 `* text=auto eol=lf`，已核实这三个文件在索引与工作区里
字节数完全一致（12331 / 21077 / 1061），所以在 macOS / Linux 上 checkout 出来是
同样的字节，偏移量跨平台稳定。

**但测试不该假定这一点。** 相关测试要**自己算出**那个属性再断言，
例如"`size - 4096` 处的字节是 UTF-8 续接字节（`b & 0xC0 == 0x80`）"，
而不是把 `4096` 和期望结果都写死。这样将来若行尾策略变了、或有人重新生成了夹具，
测试会明确失败并指出夹具需要重新生成，而不是悄悄测了个空。

## 路径约定

Rust 单测在 `src/fleet/*.rs` 里，用 manifest 相对路径取夹具：

```rust
let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
```

## 实测记录（供日后比对格式漂移）

### jsonl 的 line type 全集

扫了 53 个真实会话文件，出现过的 `type`：

```
ai-title  assistant  attachment  file-history-delta  file-history-snapshot
last-prompt  mode  permission-mode  pr-link  queue-operation  relocated
system  user  worktree-state
```

我们只关心 `assistant` / `user` / `ai-title` / `last-prompt`，其余必须被安全忽略
（**不是报错**——未知类型只会越来越多）。

### 顶层字段

`assistant`：
```
parentUuid isSidechain message requestId type uuid timestamp effort userType
entrypoint cwd sessionId version gitBranch slug
出错时另有：error isApiErrorMessage apiErrorStatus
```

`user`：
```
parentUuid isSidechain promptId type message uuid timestamp userType entrypoint
cwd sessionId version gitBranch toolUseResult sourceToolAssistantUUID origin
promptSource slug permissionMode classifierMetaLines isMeta
```

`message`（assistant）：
```
model id type role content stop_reason stop_sequence stop_details usage
另见过：container context_management
```

`content` block 四种：
- `text` → `{type, text}`
- `thinking` → `{type, thinking, signature}`
- `tool_use` → `{type, id, name, input, caller}`
- `tool_result` → `{tool_use_id, type, content}`

实测计数（53 个文件）：`tool_use` 2496 / `tool_result` 2496 / `text` 2387 / `thinking` 265。

### `stop_reason` 实测值

`tool_use`（最常见）、`end_turn`、`stop_sequence`、`refusal`。

⚠️ **API 出错的行 `stop_reason` 是 `stop_sequence` 或 `refusal`**，光看它会误判成
正常收尾，所以判定顺序必须先看 `isApiErrorMessage`。

### API 错误行的两个变体（都真实存在）

| | 变体 A | 变体 B |
|---|---|---|
| `isApiErrorMessage` | `true` | `true` |
| `apiErrorStatus` | `403`（**数字**） | **字段整个不存在** |
| `error` | `"oauth_org_not_allowed"` | `"invalid_request"` |
| `stop_reason` | `"stop_sequence"` | `"refusal"` |

这两个变体直接改了契约：`apiErrorStatus` 源数据是数字且可能缺失（采集侧归一化成
字符串），并新增了 `apiErrorCode` 承接 `error`。

### `usage` 形状

```json
{"input_tokens":2,"cache_creation_input_tokens":3483,"cache_read_input_tokens":66939,
 "output_tokens":2098,"server_tool_use":{...},"service_tier":"standard",
 "cache_creation":{...},"inference_geo":"global","iterations":[...],"speed":"standard"}
```

出错时 `service_tier` / `iterations` / `inference_geo` / `speed` 都可能是 `null`。

`contextTokens` 取 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
（官方 statusLine 的 `used_percentage` 同公式，只算 input 侧）。
夹具里这三个数固定为 2 / 3483 / 66939，所以断言值是 **70424**。

### roster（`$CONFIG/sessions/<pid>.json`）

```json
{"pid":52052,"sessionId":"...","cwd":"...","startedAt":1785395815772,
 "version":"2.1.220","peerProtocol":1,"kind":"interactive",
 "entrypoint":"claude-vscode","name":"demo-proj-18","nameSource":"derived"}
```

只在会话启动时写一次，**mtime 就是启动时间**，不是活动时间。

### subagent meta（`<sid>/subagents/agent-<id>.meta.json`）

```json
{"agentType":"general-purpose","description":"...","toolUseId":"toolu_...",
 "parentAgentId":"a52f755df57239c77","spawnDepth":2}
```

**顶层 agent 的 `parentAgentId` 是字段缺失，不是 `null`。**

---

## 各夹具的用途

### `transcript/`

| 文件 | 用途 |
|---|---|
| `working.jsonl` | 尾部 assistant + `tool_use` → working。也是"正常多行文件"的基准 |
| `needs-input.jsonl` | 尾部 assistant + `end_turn` → needs-input |
| `tool-result-tail.jsonl` | 尾部 user + `tool_result` → working（模型在思考） |
| `thinking-tail.jsonl` | 尾部 block 是 `thinking` |
| `in-flight.jsonl` | `stop_reason: null`（消息在途）→ working |
| `api-error.jsonl` | 变体 A：`apiErrorStatus` 是数字 403 |
| `api-error-no-status.jsonl` | 变体 B：`apiErrorStatus` 缺失、`stop_reason: refusal` |
| `multi-tool.jsonl` | 5 个并发 `tool_use` → 验 `lastToolNames` 截到 4 个 |
| `garbage-mixed.jsonl` | 坏行（非法 JSON / 空行 / 纯空白 / 未知 type）夹在好行之间 → 好行仍要读出来，`parseErrors` 计数 |
| `all-garbage.jsonl` | 一条消息都解析不出 → `transcript-unparsable`，状态"未知"，**不猜** |
| `empty.jsonl` | 0 字节 |
| `no-trailing-newline.jsonl` | 末行无换行符（文件正在被写入时的真实形态） |
| `utf8-heavy.jsonl` | 12331 字节纯中文。**4096 字节窗口的起点落在 `0x87` 续接字节上**，即切在中文字符中间 → 验 lossy 转换不 panic |
| `single-huge-message.jsonl` | 21077 字节，单条 assistant 约 20KB。**8KB 窗口丢掉残行后剩 0 条可解析消息 → 必须扩窗**；32KB 窗口能读到 1 条 |

### `roster/sessions/`

| 文件 | 用途 |
|---|---|
| `52052.json` | 合法条目 |
| `52053.json` | 合法，**与 52052 同一个 cwd 但不同 sessionId** —— 实测本机有 4 个会话共享一个 cwd，必须按 sessionId 做 key |
| `52054.json` | 缺 `sessionId` → 跳过并产 warning |
| `52055.json` | 非法 JSON → 跳过并产 warning，不影响其余 |
| `weird-name.json` | 文件名不是数字 |
| `notes.txt` | 非 `.json`，必须被忽略 |

### `subagents/`

`tree/` 复刻本次会话的真实两层树，外加几个防御性用例：

```
root1 (depth1) ├─ child1 (depth2)
               └─ child2 (depth2, 只有 meta 没有 jsonl)
root2 (depth1) └─ nodepth (缺 spawnDepth 与 agentType)
orphan  (parentAgentId 指向不存在的 agent)
cyclea ⇄ cycleb  (互相指父，树重建必须不死循环)
badmeta (meta 是非法 JSON)
nometa  (有 jsonl 没有 meta)
```

`empty/` 是空目录（会话没派过子 agent），靠 `.gitkeep` 才能被 git 跟踪。
