/* ============================================================
 * fleet.js 纯判定层单测
 * ------------------------------------------------------------
 * 这一层没有 DOM、没有 Tauri，是整个 Agent Fleet 功能里逻辑最绕的部分
 * （状态推断七八个分支、树重建要处理环和孤儿），所以测试投入集中在这里。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SCHEMA_VERSION,
  IDLE_MS,
  STATUS_DEFS,
  GROUP_ORDER,
  TONE_PRIORITY,
  validateReport,
  deriveStatus,
  deriveSubagentStatus,
  buildSubagentTree,
  groupSessions,
  lastActivityMs,
  countNeedsInput,
  reduceFleetTone,
  formatAgo,
  formatTokens,
  formatCpu,
} from '../fleet.js';

describe('契约常量', () => {
  it('SCHEMA_VERSION 与 Rust 侧保持一致', () => {
    // 这条测试是把 "改契约必须同时改两侧" 从口头约定变成机器强制。
    // 两边版本悄悄漂移不会有任何编译/运行错误，只会让前端在真机上收到
    // 一个自己不认识的结构然后渲染出一片 undefined —— 正是最难查的那类 bug。
    const rust = readFileSync('src-tauri/src/fleet/types.rs', 'utf8');
    const m = rust.match(/pub const SCHEMA_VERSION:\s*u32\s*=\s*(\d+)/);
    expect(m, 'Rust 侧找不到 SCHEMA_VERSION 定义（改名了？）').toBeTruthy();
    expect(Number(m[1])).toBe(SCHEMA_VERSION);
  });

  it('STATUS_DEFS 与 GROUP_ORDER 覆盖同一批状态码', () => {
    // GROUP_ORDER 显式列出而非依赖对象键序，所以要防两边漏掉对方
    expect([...GROUP_ORDER].sort()).toEqual(Object.keys(STATUS_DEFS).sort());
  });

  it('每个状态码都有优先级，否则归约时会得到 undefined', () => {
    for (const code of GROUP_ORDER) {
      expect(TONE_PRIORITY[code], `${code} 缺优先级`).toBeTypeOf('number');
    }
  });

  it('needs-input 的优先级高于 working', () => {
    // 这是整个功能最核心的产品判断：需要你回话的会话必须排在正在干活的前面，
    // 否则角标和小球的意义就没了
    expect(TONE_PRIORITY['needs-input']).toBeGreaterThan(TONE_PRIORITY.working);
  });

  it('分组顺序把 needs-input 排在最前、working 紧随其后', () => {
    expect(GROUP_ORDER[0]).toBe('needs-input');
    expect(GROUP_ORDER[1]).toBe('working');
  });

  it('每个状态定义都齐备 label/glyph/tone/animated', () => {
    for (const [code, def] of Object.entries(STATUS_DEFS)) {
      expect(def.label, `${code}.label`).toBeTypeOf('string');
      expect(def.label.length, `${code}.label 不能为空`).toBeGreaterThan(0);
      expect(def.glyph, `${code}.glyph`).toBeTypeOf('string');
      expect(def.tone, `${code}.tone`).toBeTypeOf('string');
      expect(def.animated, `${code}.animated`).toBeTypeOf('boolean');
    }
  });

  it('只有 working 需要动画', () => {
    // 静止状态挂脉冲动画会让人误以为它还在跑
    const animated = Object.entries(STATUS_DEFS)
      .filter(([, d]) => d.animated)
      .map(([c]) => c);
    expect(animated).toEqual(['working']);
  });

  it('IDLE_MS 是 5 分钟', () => {
    expect(IDLE_MS).toBe(300000);
  });
});

describe('validateReport', () => {
  const good = { schemaVersion: SCHEMA_VERSION, scannedAt: 1, configDir: '', sessions: [], warnings: [] };

  it('放行版本正确的报告', () => {
    const res = validateReport(good);
    expect(res.ok).toBe(true);
    expect(res.report).toBe(good);
  });

  it('挡住版本不一致的报告', () => {
    // 真实触发场景：tauri dev 下前端热重载了但 Rust 二进制还是旧的
    const res = validateReport({ ...good, schemaVersion: 99 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('schema-mismatch');
    expect(res.detail).toContain('99');
  });

  it('schemaVersion 缺失时也算版本不一致，而不是当成正常', () => {
    const res = validateReport({ scannedAt: 1, sessions: [] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('schema-mismatch');
  });

  it('版本比对是严格相等，字符串 "1" 不等于数字 1', () => {
    // 松散比较会让"采集层返回了字符串"这种真实的序列化事故溜过去
    const res = validateReport({ ...good, schemaVersion: '1' });
    expect(res.ok).toBe(false);
  });

  for (const [desc, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'oops'],
    ['数字', 42],
  ]) {
    it(`拒绝非对象输入：${desc}`, () => {
      const res = validateReport(bad);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('not-an-object');
    });
  }
});

/* ============================================================
 * 以下为轨 B 补充：状态推断 / subagent 树 / 分组归约 / 格式化
 * ------------------------------------------------------------
 * 夹具读法见 src/__tests__/fixtures/README.md：直接 readFileSync 成
 * JSON 对象，避免 ESM JSON import 断言在不同 Node 版本上的兼容问题。
 * ============================================================ */

/** @returns {import('../fleet.js').FleetReport} */
function loadFixtureReport() {
  return JSON.parse(readFileSync('src/__tests__/fixtures/fleetReport.json', 'utf8'));
}

/** 就地构造一个最小可用的 AgentSession，边界用例按需覆盖字段。 */
function makeSession(overrides = {}) {
  return {
    pid: 1,
    sessionId: 'test-session',
    name: 'test',
    cwd: 'C:/work',
    entrypoint: 'claude-vscode',
    kind: 'interactive',
    startedAt: 0,
    cliVersion: '2.1.220',
    liveness: 'alive',
    proc: null,
    transcript: null,
    subagents: [],
    job: null,
    ...overrides,
  };
}

/** 就地构造一个最小可用的 TranscriptDigest，默认形态是"正在调用工具"。 */
function makeTranscript(overrides = {}) {
  return {
    sizeBytes: 1000,
    mtimeMs: 0,
    aiTitle: null,
    lastPrompt: null,
    gitBranch: null,
    model: null,
    effort: null,
    lastRole: 'assistant',
    lastStopReason: 'tool_use',
    lastTailKind: 'tool_use',
    lastToolNames: [],
    lastMsgTsMs: null,
    hasApiError: false,
    apiErrorStatus: null,
    apiErrorCode: null,
    contextTokens: null,
    parseErrors: 0,
    ...overrides,
  };
}

/** 断言返回的状态对象与 STATUS_DEFS 完全一致，而不只是 code 对了。 */
function expectStatusMatchesDef(status) {
  const def = STATUS_DEFS[status.code];
  expect(status).toEqual({ code: status.code, label: def.label, glyph: def.glyph, tone: def.tone, animated: def.animated });
}

describe('deriveStatus - 夹具会话', () => {
  const report = loadFixtureReport();
  const scannedAt = report.scannedAt;
  const findSession = (id) => report.sessions.find((s) => s.sessionId === id);

  it('sid-needs-input：assistant + end_turn，36 秒前 → 等你回话', () => {
    const status = deriveStatus(findSession('sid-needs-input'), scannedAt);
    expect(status.code).toBe('needs-input');
    expectStatusMatchesDef(status);
  });

  it('sid-working：assistant + tool_use → 运行中', () => {
    const status = deriveStatus(findSession('sid-working'), scannedAt);
    expect(status.code).toBe('working');
    expectStatusMatchesDef(status);
  });

  it('sid-idle：41 分钟没写入 → 空闲', () => {
    const status = deriveStatus(findSession('sid-idle'), scannedAt);
    expect(status.code).toBe('idle');
    expectStatusMatchesDef(status);
  });

  it('sid-fresh：transcript 为 null → 已启动·未开始', () => {
    const status = deriveStatus(findSession('sid-fresh'), scannedAt);
    expect(status.code).toBe('fresh');
    expectStatusMatchesDef(status);
  });

  it('sid-failed：hasApiError 优先于 lastStopReason(stop_sequence) → 出错', () => {
    const status = deriveStatus(findSession('sid-failed'), scannedAt);
    expect(status.code).toBe('failed');
    expectStatusMatchesDef(status);
  });

  it('sid-job：job.state=blocked → 等你回话（job 是权威口径，忽略 transcript）', () => {
    const status = deriveStatus(findSession('sid-job'), scannedAt);
    expect(status.code).toBe('needs-input');
    expectStatusMatchesDef(status);
  });

  it('sid-unknown：lastRole 为 null（parseErrors=12）→ 状态未知，宁可显示未知也不猜', () => {
    const status = deriveStatus(findSession('sid-unknown'), scannedAt);
    expect(status.code).toBe('unknown');
    expectStatusMatchesDef(status);
  });
});

describe('deriveStatus - 边界', () => {
  const scannedAt = 1_000_000_000;

  it('age 恰好等于 IDLE_MS → 还不算 idle（伪码用 >，不是 >=）', () => {
    const session = makeSession({
      transcript: makeTranscript({ mtimeMs: scannedAt - IDLE_MS, lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('working');
  });

  it('age = IDLE_MS + 1 → idle', () => {
    const session = makeSession({
      transcript: makeTranscript({ mtimeMs: scannedAt - (IDLE_MS + 1), lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('idle');
  });

  it('mtimeMs 为 null 时退到 lastMsgTsMs', () => {
    const session = makeSession({
      // startedAt 故意设成很久以前：如果退路逻辑写错、越过 lastMsgTsMs 直接
      // 退到 startedAt，这条测试就会把它抓出来。
      startedAt: scannedAt - 100_000_000,
      transcript: makeTranscript({ mtimeMs: null, lastMsgTsMs: scannedAt - 1000, lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('working');
  });

  it('mtimeMs 与 lastMsgTsMs 都为 null 时退到 startedAt', () => {
    const session = makeSession({
      startedAt: scannedAt - (IDLE_MS + 1000), // 超过阈值，证明退路真的落到了这里
      transcript: makeTranscript({ mtimeMs: null, lastMsgTsMs: null, lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('idle');
  });

  it('lastStopReason 为 null → working（消息还在途，不是 needs-input）', () => {
    const session = makeSession({
      transcript: makeTranscript({ mtimeMs: scannedAt - 1000, lastStopReason: null }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('working');
  });

  it('hasApiError=true 且 lastStopReason=end_turn → failed，而不是 needs-input（判定顺序）', () => {
    const session = makeSession({
      transcript: makeTranscript({ mtimeMs: scannedAt - 1000, hasApiError: true, lastStopReason: 'end_turn' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('failed');
  });

  it('hasApiError=true 但 age 已超过 idle 阈值 → failed 优先于 idle', () => {
    const session = makeSession({
      transcript: makeTranscript({
        mtimeMs: scannedAt - (IDLE_MS + 1000),
        hasApiError: true,
        lastStopReason: 'stop_sequence',
      }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('failed');
  });

  it('age 为负（scannedAt 比 mtimeMs 小）→ 不能算成 idle', () => {
    const session = makeSession({
      transcript: makeTranscript({ mtimeMs: scannedAt + 5000, lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('working');
  });

  it('liveness=pid-reused → unknown（防御性，正常不该进列表）', () => {
    const session = makeSession({
      liveness: 'pid-reused',
      transcript: makeTranscript({ mtimeMs: scannedAt - 1000, lastStopReason: 'tool_use' }),
    });
    expect(deriveStatus(session, scannedAt).code).toBe('unknown');
  });

  it('liveness=pid-reused 优先于 job：即使 job 显示正在工作，也判 unknown', () => {
    const session = makeSession({
      liveness: 'pid-reused',
      job: { jobId: 'j', state: 'working', detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null },
    });
    expect(deriveStatus(session, scannedAt).code).toBe('unknown');
  });

  for (const [state, expected] of [
    ['working', 'working'],
    ['blocked', 'needs-input'],
    ['done', 'completed'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
    ['some-未来才会有的值', 'unknown'],
    [null, 'unknown'],
  ]) {
    it(`job.state=${state} → ${expected}`, () => {
      const session = makeSession({
        job: { jobId: 'j', state, detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null },
      });
      expect(deriveStatus(session, scannedAt).code).toBe(expected);
    });
  }

  it('每个状态码的返回值都与 STATUS_DEFS 完全一致（覆盖全部 8 种）', () => {
    const cases = [
      makeSession({ liveness: 'pid-reused' }),
      makeSession({ job: { jobId: 'j', state: 'working', detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null } }),
      makeSession({ job: { jobId: 'j', state: 'blocked', detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null } }),
      makeSession({ job: { jobId: 'j', state: 'done', detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null } }),
      makeSession({ job: { jobId: 'j', state: 'stopped', detail: null, tempo: null, tokens: null, inFlight: null, intent: null, updatedAt: null } }),
      makeSession({ transcript: null }),
      makeSession({ transcript: makeTranscript({ mtimeMs: scannedAt - (IDLE_MS + 1), lastStopReason: 'tool_use' }) }),
      makeSession({ transcript: makeTranscript({ mtimeMs: scannedAt - 1000, hasApiError: true }) }),
    ];
    for (const session of cases) {
      expectStatusMatchesDef(deriveStatus(session, scannedAt));
    }
  });
});

describe('deriveSubagentStatus', () => {
  const scannedAt = 1_000_000_000;

  function makeSub(overrides = {}) {
    return {
      agentId: 'a',
      agentType: 'general-purpose',
      description: null,
      parentAgentId: null,
      spawnDepth: null,
      mtimeMs: null,
      sizeBytes: null,
      lastRole: 'assistant',
      lastStopReason: 'tool_use',
      lastTailKind: 'tool_use',
      lastMsgTsMs: null,
      contextTokens: null,
      ...overrides,
    };
  }

  it('判据与 deriveStatus 共用同一段核心逻辑：tool_use → working', () => {
    expect(deriveSubagentStatus(makeSub({ mtimeMs: scannedAt - 1000 }), scannedAt).code).toBe('working');
  });

  it('lastRole 为 null → unknown', () => {
    expect(deriveSubagentStatus(makeSub({ lastRole: null, mtimeMs: scannedAt - 1000 }), scannedAt).code).toBe('unknown');
  });

  it('mtimeMs 为 null 时退到 lastMsgTsMs', () => {
    const status = deriveSubagentStatus(makeSub({ mtimeMs: null, lastMsgTsMs: scannedAt - 1000 }), scannedAt);
    expect(status.code).toBe('working');
  });

  it('mtimeMs 与 lastMsgTsMs 都为 null → unknown（subagent 没有 startedAt 这层退路）', () => {
    const status = deriveSubagentStatus(makeSub({ mtimeMs: null, lastMsgTsMs: null }), scannedAt);
    expect(status.code).toBe('unknown');
  });

  it('SubagentDigest 没有 hasApiError 字段，不会误触发 failed 分支', () => {
    const status = deriveSubagentStatus(makeSub({ mtimeMs: scannedAt - 1000, lastStopReason: 'end_turn' }), scannedAt);
    expect(status.code).toBe('needs-input'); // 而不是 failed
  });
});

describe('buildSubagentTree', () => {
  const report = loadFixtureReport();
  const workingSession = report.sessions.find((s) => s.sessionId === 'sid-working');

  /** 就地构造一个最小可用的 SubagentDigest。 */
  function makeNode(overrides = {}) {
    return {
      agentId: 'x',
      agentType: null,
      description: null,
      parentAgentId: null,
      spawnDepth: null,
      mtimeMs: null,
      sizeBytes: null,
      lastRole: null,
      lastStopReason: null,
      lastTailKind: null,
      lastMsgTsMs: null,
      contextTokens: null,
      ...overrides,
    };
  }

  it('夹具会话②：2 个 root，root1 有 3 个 children，depth 正确', () => {
    const { roots, orphans } = buildSubagentTree(workingSession.subagents);
    expect(orphans).toEqual([]);
    expect(roots).toHaveLength(2);

    const root1 = roots.find((r) => r.agentId === 'root1');
    const root2 = roots.find((r) => r.agentId === 'root2');
    expect(root1.depth).toBe(1);
    expect(root2.depth).toBe(1);
    expect(root1.children).toHaveLength(3);
    for (const child of root1.children) expect(child.depth).toBe(2);

    // 兄弟排序：mtimeMs 降序，相同时按 agentId 升序；child2 明显更旧（8 分钟没动）排最后。
    expect(root1.children.map((c) => c.agentId)).toEqual(['child1', 'child3', 'child2']);
  });

  it('父 id 指向不存在的 agent（孤儿）→ 进 orphans，不丢失', () => {
    const { roots, orphans } = buildSubagentTree([makeNode({ agentId: 'a', parentAgentId: 'ghost' })]);
    expect(roots).toEqual([]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].agentId).toBe('a');
    expect(orphans[0].depth).toBe(1);
  });

  it('环（A→B→A）不死循环，两个节点都进 orphans', () => {
    const { roots, orphans } = buildSubagentTree([
      makeNode({ agentId: 'a', parentAgentId: 'b' }),
      makeNode({ agentId: 'b', parentAgentId: 'a' }),
    ]);
    expect(roots).toEqual([]);
    expect(orphans.map((n) => n.agentId).sort()).toEqual(['a', 'b']);
  });

  it('三节点环（A→B→C→A）同样不死循环，全部进 orphans', () => {
    const { roots, orphans } = buildSubagentTree([
      makeNode({ agentId: 'a', parentAgentId: 'c' }),
      makeNode({ agentId: 'b', parentAgentId: 'a' }),
      makeNode({ agentId: 'c', parentAgentId: 'b' }),
    ]);
    expect(roots).toEqual([]);
    expect(orphans.map((n) => n.agentId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('重复 agentId → 只保留第一个出现的', () => {
    const { roots } = buildSubagentTree([
      makeNode({ agentId: 'x', description: '第一个' }),
      makeNode({ agentId: 'x', description: '第二个（应被丢弃）' }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].description).toBe('第一个');
  });

  it('spawnDepth 缺失时 depth 仍按树结构算对', () => {
    const { roots } = buildSubagentTree([
      makeNode({ agentId: 'root', spawnDepth: undefined }),
      makeNode({ agentId: 'child', parentAgentId: 'root', spawnDepth: undefined }),
    ]);
    expect(roots[0].depth).toBe(1);
    expect(roots[0].children[0].depth).toBe(2);
  });

  it('兄弟排序：mtimeMs 降序、null 排最后、相同则 agentId 升序', () => {
    const { roots } = buildSubagentTree([
      makeNode({ agentId: 'c', mtimeMs: null }),
      makeNode({ agentId: 'a', mtimeMs: 100 }),
      makeNode({ agentId: 'b', mtimeMs: 100 }),
      makeNode({ agentId: 'd', mtimeMs: 200 }),
    ]);
    expect(roots.map((n) => n.agentId)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('空数组 → { roots: [], orphans: [] }', () => {
    expect(buildSubagentTree([])).toEqual({ roots: [], orphans: [] });
  });
});

describe('groupSessions', () => {
  const report = loadFixtureReport();
  const scannedAt = report.scannedAt;

  it('分组顺序严格按 GROUP_ORDER，空组（completed/stopped）被省略', () => {
    const groups = groupSessions(report.sessions, scannedAt);
    expect(groups.map((g) => g.key)).toEqual(['needs-input', 'working', 'failed', 'fresh', 'idle', 'unknown']);
    expect(groups.some((g) => g.key === 'completed')).toBe(false);
    expect(groups.some((g) => g.key === 'stopped')).toBe(false);
  });

  it('每组的 items 数与 label 正确', () => {
    const groups = groupSessions(report.sessions, scannedAt);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey['needs-input'].items).toHaveLength(2); // sid-needs-input + sid-job(blocked)
    expect(byKey['needs-input'].label).toBe(STATUS_DEFS['needs-input'].label);
    expect(byKey.working.items).toHaveLength(2); // sid-working + sid-no-cpu
    expect(byKey.working.label).toBe(STATUS_DEFS.working.label);
    expect(byKey.failed.items).toHaveLength(1);
    expect(byKey.fresh.items).toHaveLength(1);
    expect(byKey.idle.items).toHaveLength(1);
    expect(byKey.unknown.items).toHaveLength(1);
  });

  it('组内排序：needs-input 组里 sid-job 活动更晚，排在 sid-needs-input 前面', () => {
    const groups = groupSessions(report.sessions, scannedAt);
    const needsInput = groups.find((g) => g.key === 'needs-input');
    expect(needsInput.items.map((s) => s.sessionId)).toEqual(['sid-job', 'sid-needs-input']);
  });

  it('组内排序稳定性：lastActivityMs 相同则按 name 升序（sid-working 与 sid-no-cpu 恰好同 mtimeMs）', () => {
    const groups = groupSessions(report.sessions, scannedAt);
    const working = groups.find((g) => g.key === 'working');
    expect(lastActivityMs(working.items[0])).toBe(lastActivityMs(working.items[1]));
    expect(working.items.map((s) => s.name)).toEqual(['demo-composer-18', 'demo-no-cpu']);
  });

  it('liveness=pid-reused 的会话被排除', () => {
    const pidReused = { ...report.sessions[0], sessionId: 'sid-ghost', liveness: 'pid-reused' };
    expect(groupSessions([pidReused], scannedAt)).toEqual([]);
  });

  it('全部 alive 会话都被分到某个组，不丢会话', () => {
    const groups = groupSessions(report.sessions, scannedAt);
    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    const aliveCount = report.sessions.filter((s) => s.liveness === 'alive').length;
    expect(total).toBe(aliveCount);
  });

  it('合成用例钉住 name 升序：lastActivityMs 完全相同时', () => {
    const base = report.sessions.find((s) => s.sessionId === 'sid-needs-input');
    const s1 = { ...base, sessionId: 's1', name: 'zeta' };
    const s2 = { ...base, sessionId: 's2', name: 'alpha' };
    const groups = groupSessions([s1, s2], scannedAt);
    expect(groups[0].items.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('countNeedsInput / reduceFleetTone', () => {
  const report = loadFixtureReport();
  const scannedAt = report.scannedAt;

  it('夹具里有 2 个 needs-input 会话（sid-needs-input + sid-job）', () => {
    expect(countNeedsInput(report.sessions, scannedAt)).toBe(2);
  });

  it('空列表 → 0', () => {
    expect(countNeedsInput([], scannedAt)).toBe(0);
  });

  it('全是 idle 时 → 0', () => {
    const idleSession = report.sessions.find((s) => s.sessionId === 'sid-idle');
    expect(countNeedsInput([idleSession], scannedAt)).toBe(0);
  });

  it('夹具里最高优先级是 failed（sid-failed，优先级 5 高于 needs-input 的 4）', () => {
    const result = reduceFleetTone(report.sessions, scannedAt);
    expect(result).toEqual({ code: 'failed', tone: STATUS_DEFS.failed.tone });
  });

  it('空列表 → { code: idle, tone: muted }', () => {
    expect(reduceFleetTone([], scannedAt)).toEqual({ code: 'idle', tone: 'muted' });
  });

  it('只有 idle 会话时 → { code: idle, tone: muted }', () => {
    const idleSession = report.sessions.find((s) => s.sessionId === 'sid-idle');
    expect(reduceFleetTone([idleSession], scannedAt)).toEqual({ code: 'idle', tone: STATUS_DEFS.idle.tone });
  });
});

describe('formatAgo', () => {
  const cases = [
    [-100, '刚刚'], // 负数（时钟误差）当 0 处理
    [0, '刚刚'],
    [4999, '刚刚'],
    [5000, '5秒前'],
    [59999, '59秒前'],
    [60000, '1分钟前'],
    [3599999, '59分钟前'],
    [3600000, '1小时前'],
    [86399999, '23小时前'],
    [86400000, '1天前'],
  ];
  for (const [ms, expected] of cases) {
    it(`formatAgo(${ms}) === '${expected}'`, () => {
      expect(formatAgo(ms)).toBe(expected);
    });
  }
});

describe('formatTokens', () => {
  const cases = [
    [null, '—'],
    [undefined, '—'],
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [70424, '70k'],
    // 999999/1000 四舍五入进位到 1000，必须升单位成 1.0M。
    // 显示"1000k"会像是坏了——阈值判断看的是原值、取整发生在判断之后，
    // 中间这道缝隙要在进位后再补一次检查。
    [999999, '1.0M'],
    [1000000, '1.0M'],
    [1234567, '1.2M'],
  ];
  for (const [n, expected] of cases) {
    it(`formatTokens(${n}) === '${expected}'`, () => {
      expect(formatTokens(n)).toBe(expected);
    });
  }
});

describe('formatCpu', () => {
  const cases = [
    [null, '—'],
    [undefined, '—'],
    [0, '0%'],
    [0.2, '<1%'],
    [0.9, '<1%'],
    [1, '1%'],
    [12.4, '12%'],
    [99.6, '100%'],
    [100, '100%'],
  ];
  for (const [pct, expected] of cases) {
    it(`formatCpu(${pct}) === '${expected}'`, () => {
      expect(formatCpu(pct)).toBe(expected);
    });
  }
});
