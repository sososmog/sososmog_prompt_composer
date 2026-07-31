# 前端测试夹具

## `fleetReport.json`

一份**确定性的** `FleetReport`（契约见 `src-tauri/src/fleet/types.rs` 与
`src/fleet.js` 顶部的 typedef）。合成数据，内容一律占位。

两个用途：

1. **纯函数测试**（`fleet.test.js`）里当"一份真实形态的报告"用，验分组、排序、
   角标计数、小球归约这些跨会话的整体行为。单个状态的边界用例（age 恰好 5 分钟、
   mtimeMs 为 null 之类）在测试里就地构造，不放这里——就地构造的用例读起来更清楚。
2. **轨 C 的 UI 开发桩**。浮窗 tab 可以先渲染这份数据，不必等 Rust 采集层落地。

### 时间基准

`scannedAt` 固定为 `1785416160000`，所有 `mtimeMs` / `lastMsgTsMs` 都由它减去
偏移得来。**判定 age 一律用 `scannedAt` 做基准，不用 `Date.now()`** ——
否则测试会随运行时刻漂移，而且真实场景里 Rust 时钟与 JS 时钟的差异会算出负数 age。

### 8 个会话覆盖的状态

| # | sessionId | 覆盖点 |
|---|---|---|
| ① | `sid-needs-input` | assistant + `end_turn`，36 秒前 → 等你回话 |
| ② | `sid-working` | assistant + `tool_use` + **两层 subagent 树**（5 个，复刻真实形态，其中一个已 end_turn 且 8 分钟没动） |
| ③ | `sid-idle` | 41 分钟没写入 → 空闲（且 `sizeBytes` 3.7MB，是本机真实量级） |
| ④ | `sid-fresh` | `transcript: null` → 已启动·未开始（实测本机 5 个会话里有 2 个这样） |
| ⑤ | `sid-failed` | `hasApiError: true`，且 `lastStopReason` 是 `stop_sequence` —— **专门用来验判定顺序**：先看 hasApiError，否则会误判成正常收尾 |
| ⑥ | `sid-no-cpu` | `proc: null`（首次采样没有基准）→ CPU 显示"—" |
| ⑦ | `sid-job` | 后台会话，`job.state: 'blocked'`（阶段 4 的形状） |
| ⑧ | `sid-unknown` | 尾部一条消息都解析不出（`lastRole: null`、`parseErrors: 12`）→ 状态"未知"，**宁可显示未知也不猜** |

另有两条 `warnings`，用于验 warning 折叠区的渲染。

### 会话 ② 的 subagent 树

```
root1  占位：调研 agent dashboard 生态       depth 1  运行中
├── child1  占位：调研 Claude Squad / Crystal  depth 2  运行中
├── child2  占位：调研 CCManager / cui         depth 2  已收尾且 8 分钟没动
└── child3  占位：调研 Omnara / Happy          depth 2  运行中
root2  占位：调研 Clawd-on-Desk               depth 1  运行中
```

注意顶层 agent 的 `parentAgentId` 是 `null`（Rust 侧从"字段缺失"归一化而来）。
