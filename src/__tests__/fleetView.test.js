/* ============================================================
 * fleetView.test.js —— 浮窗 Agent tab 的 DOM 层测试
 * ------------------------------------------------------------
 * 姿势照 mainWindow.test.js：灌真实 float.html 的 body，假依赖
 * （这里是 invoke / getVisibility，不是全局 Tauri 对象）在 import
 * 之前/调用之前摆好，判定逻辑本身完全不在这里断言——fleet.js 那边
 * 的 fleet.test.js 已经把状态机的每个分支钉死，这里只验"数据结构
 * 对了之后，DOM 画得对不对、轮询节奏对不对、交互会不会被打断"。
 *
 * 两组测试目标不一样，装配方式也不同：
 *   - createFleetView 相关：直接 import 纯函数式的 fleetView.js，
 *     手动传假 invoke/getVisibility，不牵扯 Tauri，也不需要
 *     vi.resetModules()（fleetView.js 没有模块级可变状态，每次调用
 *     createFleetView() 都是全新闭包）。
 *   - tab 切换 + localStorage 持久化：这段逻辑实际写在 float.js 里
 *     （C5），不在 fleetView.js。float.js 是个有大量顶层副作用的
 *     模块（挂事件、起 sync），所以这里改用 mainWindow.test.js 那套
 *     "先灌 DOM 再动态 import"姿势，且不 stub window.__TAURI__——
 *     float.js 自己就有非 Tauri 降级路径（tauriAvailable() 为
 *     false），tab 切换本身也完全不依赖 Tauri，直接吃这条降级路径
 *     测最省事，顺带验证了"非 Tauri 环境不报错"这条 C6 要求。
 *
 * 已知坑（reference-vitest-global-stub-leak）：不整体替换全局对象，
 * afterEach 无条件 unstubAllGlobals + useRealTimers，避免一个用例
 * 崩掉后连坏后面几十个用例、报错行号完全无关。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFleetView } from '../fleetView.js';
import { STATUS_DEFS } from '../fleet.js';
import fleetReportFixture from './fixtures/fleetReport.json';

var here = path.dirname(fileURLToPath(import.meta.url));
var floatHtmlPath = path.resolve(here, '../float.html');
var rawFloatHtml = readFileSync(floatHtmlPath, 'utf-8');

// 同 mainWindow.test.js：module 脚本 jsdom 不会真的执行，留着只会在
// innerHTML 赋值时被当普通文本插入，白占内容，剔掉。
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('float.html 里找不到 <body>，DOM 层测试的地基就没了');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}

var BODY_HTML = extractBodyHtml(rawFloatHtml);

function cloneFixture() {
  return JSON.parse(JSON.stringify(fleetReportFixture));
}

function makeSession(overrides) {
  return Object.assign(
    {
      pid: 1000,
      sessionId: 's1',
      name: 'demo',
      cwd: 'C:/work/demo',
      entrypoint: 'claude-vscode',
      kind: 'interactive',
      startedAt: 1000000,
      cliVersion: '2.1.220',
      liveness: 'alive',
      proc: { cpuPercent: 5, memoryMb: 100, runTimeSec: 10 },
      transcript: {
        sizeBytes: 100,
        mtimeMs: 1000000,
        aiTitle: '占位标题',
        lastPrompt: null,
        gitBranch: 'main',
        model: 'claude-opus-5',
        effort: 'xhigh',
        lastRole: 'assistant',
        lastStopReason: 'tool_use',
        lastTailKind: 'tool_use',
        lastToolNames: [],
        lastMsgTsMs: 1000000,
        hasApiError: false,
        apiErrorStatus: null,
        apiErrorCode: null,
        contextTokens: 1000,
        parseErrors: 0,
      },
      subagents: [],
      job: null,
    },
    overrides
  );
}

function makeReport(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      scannedAt: 1000000,
      configDir: 'C:/demo/.claude',
      sessions: [],
      warnings: [],
    },
    overrides
  );
}

function mountFleetDom() {
  document.body.innerHTML = BODY_HTML;
  document.documentElement.removeAttribute('data-theme');
}

/** @returns {{root: HTMLElement, tabButton: HTMLElement, badge: HTMLElement}} */
function fleetRefs() {
  return {
    root: document.getElementById('fwPanelFleet'),
    tabButton: document.getElementById('fwTabFleetBtn'),
    badge: document.getElementById('fwTabFleetBadge'),
  };
}

function advance(ms) {
  return vi.advanceTimersByTimeAsync(ms);
}

var controller = null;

afterEach(function () {
  if (controller && controller.stop) controller.stop();
  controller = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  try {
    window.localStorage.clear();
  } catch (e) {
    /* jsdom 环境下不会失败，兜底忽略 */
  }
});

/* ============================================================
 * 渲染：分组 / 卡片 / 空态 / 降级态 / warnings
 * ============================================================ */
describe('createFleetView：渲染', function () {
  beforeEach(function () {
    mountFleetDom();
    vi.useFakeTimers();
  });

  it('分组标题按 GROUP_ORDER 顺序渲染，空组不出现，卡片数与会话数一致', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var invoke = vi.fn().mockResolvedValue(cloneFixture());
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);

    var titleEls = refs.root.querySelectorAll('.fw-fleet-group-title');
    var labels = Array.prototype.map.call(titleEls, function (el) {
      return el.firstChild.textContent;
    });
    expect(labels).toEqual([
      STATUS_DEFS['needs-input'].label,
      STATUS_DEFS.working.label,
      STATUS_DEFS.failed.label,
      STATUS_DEFS.fresh.label,
      STATUS_DEFS.idle.label,
      STATUS_DEFS.unknown.label,
    ]);
    // completed / stopped 在这份夹具里没有会话落进去，空组不该出现
    expect(labels).not.toContain(STATUS_DEFS.completed.label);
    expect(labels).not.toContain(STATUS_DEFS.stopped.label);

    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(8);
  });

  it('无会话时显示空态文案', async function () {
    var refs = fleetRefs();
    var invoke = vi.fn().mockResolvedValue(makeReport({ sessions: [] }));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    expect(refs.root.querySelector('.fw-fleet-empty').textContent).toBe('没有正在运行的 agent');
  });

  it('非 Tauri 环境（invoke 为空）显示降级文案，且不抛错、不建轮询', function () {
    var refs = fleetRefs();
    expect(function () {
      controller = createFleetView({
        root: refs.root,
        tabButton: refs.tabButton,
        badge: refs.badge,
        invoke: null,
        getVisibility: function () { return true; },
      });
    }).not.toThrow();
    expect(refs.root.querySelector('.fw-fleet-empty').textContent).toBe('此功能需要桌面端');
    // 降级态下 refreshSchedule/stop 必须是安全的空操作
    expect(function () { controller.refreshSchedule(); controller.stop(); }).not.toThrow();
  });

  it('report.warnings 非空时渲染可折叠区域，默认收起，标题带条数', async function () {
    var refs = fleetRefs();
    var report = makeReport({
      sessions: [makeSession({})],
      warnings: [
        { code: 'pid-reused', detail: '占位 A' },
        { code: 'transcript-unparsable', detail: '占位 B' },
      ],
    });
    var invoke = vi.fn().mockResolvedValue(report);
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    var details = refs.root.querySelector('.fw-fleet-warnings');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('警告（2）');
    expect(details.querySelectorAll('li').length).toBe(2);
  });

  it('角标：countNeedsInput 为 0 时隐藏，非 0 时显示数字', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var invoke = vi.fn().mockResolvedValue(makeReport({ sessions: [makeSession({ sessionId: 'a' })] }));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0); // 默认夹具是 working（tool_use 收尾），不需要回话 → 角标应隐藏
    expect(refs.badge.hidden).toBe(true);

    var needsInputSession = makeSession({
      sessionId: 'b',
      transcript: Object.assign({}, makeSession({}).transcript, { lastStopReason: 'end_turn' }),
    });
    invoke.mockResolvedValue(makeReport({ sessions: [needsInputSession] }));
    await advance(2000);
    expect(refs.badge.hidden).toBe(false);
    expect(refs.badge.textContent).toBe('1');
    expect(refs.tabButton.title).toBe('1 个会话等你回话');
  });
});

/* ============================================================
 * 轮询调度：C4
 * ============================================================ */
describe('createFleetView：轮询调度', function () {
  beforeEach(function () {
    mountFleetDom();
    vi.useFakeTimers();
  });

  it('可见 && 停在 Agent tab：每 2s 一次，参数为全量（不带 opts）', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var invoke = vi.fn().mockResolvedValue(makeReport({}));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });

    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith('list_agent_sessions');

    await advance(2000);
    expect(invoke).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('切到编写 tab 后降到 8s 一次，且参数带 cpu:false', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var invoke = vi.fn().mockResolvedValue(makeReport({}));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    // 模拟 float.js 的 switchTab('compose')：面板失去 is-active，随后
    // 通知 fleetView 立刻按新档位重排（不用等旧的 2s 间隔走完）。
    refs.root.classList.remove('is-active');
    controller.refreshSchedule();

    var before = invoke.mock.calls.length;
    await advance(7999);
    expect(invoke).toHaveBeenCalledTimes(before); // 还没到 8s，不该发
    await advance(1);
    expect(invoke).toHaveBeenCalledTimes(before + 1);
    expect(invoke).toHaveBeenLastCalledWith('list_agent_sessions', { opts: { cpu: false } });

    var before2 = invoke.mock.calls.length;
    await advance(8000);
    expect(invoke).toHaveBeenCalledTimes(before2 + 1); // 之后持续按 8s 一次
  });

  it('缩成小球时即使停在 Agent tab 也降到精简档', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    document.getElementById('fwCard').classList.add('is-mini');
    var invoke = vi.fn().mockResolvedValue(makeReport({}));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    await advance(2000); // 快档间隔内不该再发
    expect(invoke).toHaveBeenCalledTimes(1);
    await advance(6000); // 累计满 8s 才发第二次
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('list_agent_sessions', { opts: { cpu: false } });
  });

  it('不可见时完全不抓取，不管过多久', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var visible = true;
    var invoke = vi.fn().mockResolvedValue(makeReport({}));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return visible; },
    });
    await advance(0);
    var before = invoke.mock.calls.length;
    visible = false;
    await advance(60000);
    expect(invoke).toHaveBeenCalledTimes(before);
  });

  it('单飞：上一次请求未回来时，到点也不会重复发起', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var resolveFn;
    var invoke = vi.fn(function () {
      return new Promise(function (resolve) { resolveFn = resolve; });
    });
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    await advance(2000); // 到了下一个该发请求的时刻，但上一次还没 resolve
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveFn(makeReport({}));
    await advance(0); // flush 掉 resolve 之后的 .then 链
    await advance(2000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('失败退避 2s→4s→8s→16s→30s 封顶，且旧卡片不被清空', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var shouldFail = false;
    var goodReport = makeReport({ sessions: [makeSession({})] });
    var invoke = vi.fn(function () {
      return shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve(goodReport);
    });
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
      onError: function () {},
    });

    await advance(0); // 首次成功，落地 1 张卡片
    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(1);

    shouldFail = true;
    var steps = [2000, 2000, 4000, 8000, 16000, 30000, 30000];
    var expectedCalls = 1;
    for (var i = 0; i < steps.length; i += 1) {
      await advance(steps[i]);
      expectedCalls += 1;
      expect(invoke).toHaveBeenCalledTimes(expectedCalls);
      // 全程失败，卡片必须还是旧的那 1 张，错误横条必须亮着
      expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(1);
      expect(refs.root.querySelector('.fw-fleet-error').hidden).toBe(false);
    }

    // 恢复成功：横条收起，failCount 复位（不直接可测，但至少验证不再报错态）
    shouldFail = false;
    await advance(30000);
    expect(refs.root.querySelector('.fw-fleet-error').hidden).toBe(true);
    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(1);
  });

  it('schemaVersion 不匹配：停止轮询并显示提示', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var invoke = vi.fn().mockResolvedValue(makeReport({ schemaVersion: 2 }));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    var el = refs.root.querySelector('.fw-fleet-schema-error');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('版本不一致，请重启应用');

    var callsAfterMismatch = invoke.mock.calls.length;
    await advance(60000);
    expect(invoke.mock.calls.length).toBe(callsAfterMismatch); // 彻底停了，不会再重试
  });
});

/* ============================================================
 * C4 附：重渲染不能打断交互
 * ============================================================ */
describe('createFleetView：重渲染不打断交互', function () {
  beforeEach(function () {
    mountFleetDom();
    vi.useFakeTimers();
  });

  it('焦点在面板内时跳过内容重建，下一 tick 再来', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var reportA = makeReport({
      sessions: [makeSession({ sessionId: 'a' })],
      warnings: [{ code: 'pid-reused', detail: '占位' }],
    });
    var reportB = makeReport({
      sessions: [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })],
      warnings: [{ code: 'pid-reused', detail: '占位' }],
    });
    var invoke = vi.fn().mockResolvedValueOnce(reportA).mockResolvedValue(reportB);
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);
    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(1);

    var summary = refs.root.querySelector('.fw-fleet-warnings summary');
    summary.focus();
    expect(document.activeElement).toBe(summary);

    await advance(2000); // 本该重建成 2 张卡片，但焦点守卫应跳过
    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(1);
    expect(document.activeElement).toBe(summary); // 焦点也没被打断

    summary.blur();
    await advance(2000); // 焦点挪走后，下一 tick 正常重建
    expect(refs.root.querySelectorAll('.fw-fleet-card').length).toBe(2);
  });

  it('重建前后保持列表容器的 scrollTop', async function () {
    var refs = fleetRefs();
    refs.root.classList.add('is-active');
    var sessions = [];
    for (var i = 0; i < 10; i += 1) sessions.push(makeSession({ sessionId: 's' + i }));
    var invoke = vi.fn().mockResolvedValue(makeReport({ sessions: sessions }));
    controller = createFleetView({
      root: refs.root,
      tabButton: refs.tabButton,
      badge: refs.badge,
      invoke: invoke,
      getVisibility: function () { return true; },
    });
    await advance(0);

    var list = refs.root.querySelector('.fw-fleet-list');
    // jsdom 不做真实布局，scrollTop 的 getter/setter 在这里就是个纯存储槎，
    // 用 defineProperty 显式给一对读写实现，避免依赖"jsdom 会不会自己
    // clamp 到 0"这种未定义细节——只要证明"重建前读到的值 === 重建后
    // 写回新节点的值"，就够了。
    var stored = 42;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: function () { return stored; },
      set: function (v) { stored = v; },
    });

    await advance(2000); // 触发下一轮重建（数据不变也会整体重建，MVP 全量重建）
    var newList = refs.root.querySelector('.fw-fleet-list');
    expect(newList).not.toBe(list); // 确认真的是全新节点，不是同一个元素凑巧值没变
    expect(newList.scrollTop).toBe(42);
  });
});

/* ============================================================
 * float.js：tab 切换 + localStorage 持久化（C5）
 * ------------------------------------------------------------
 * 这段逻辑本身在 float.js 里，不在 fleetView.js，但按任务约束这是
 * 唯一允许新增/修改的测试文件，所以并到这里。用非 Tauri 降级路径
 * 装配（tab 切换本身不需要 Tauri），顺带覆盖 C6"非 Tauri 环境不
 * 报错"。
 * ============================================================ */
describe('float.js：tab 切换与持久化', function () {
  beforeEach(function () {
    vi.resetModules();
    mountFleetDom();
  });

  it('没存过 tab 偏好时默认停在编写 tab', async function () {
    await import('../float.js');
    expect(document.getElementById('fwPanelCompose').classList.contains('is-active')).toBe(true);
    expect(document.getElementById('fwPanelFleet').classList.contains('is-active')).toBe(false);
    expect(document.getElementById('fwTabComposeBtn').classList.contains('is-active')).toBe(true);
    expect(document.getElementById('fwTabComposeBtn').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('fwTabFleetBtn').getAttribute('aria-selected')).toBe('false');
  });

  it('点击 Agent tab 后切换面板高亮，并把选择写进 localStorage', async function () {
    await import('../float.js');
    document.getElementById('fwTabFleetBtn').click();

    expect(document.getElementById('fwPanelFleet').classList.contains('is-active')).toBe(true);
    expect(document.getElementById('fwPanelCompose').classList.contains('is-active')).toBe(false);
    expect(document.getElementById('fwTabFleetBtn').getAttribute('aria-selected')).toBe('true');
    expect(window.localStorage.getItem('composer-fw-tab')).toBe('fleet');

    // 切回编写 tab，持久化也要跟着变
    document.getElementById('fwTabComposeBtn').click();
    expect(document.getElementById('fwPanelCompose').classList.contains('is-active')).toBe(true);
    expect(window.localStorage.getItem('composer-fw-tab')).toBe('compose');
  });

  it('重开浮窗时按上次存档的 tab 恢复', async function () {
    window.localStorage.setItem('composer-fw-tab', 'fleet');
    await import('../float.js');
    expect(document.getElementById('fwPanelFleet').classList.contains('is-active')).toBe(true);
    expect(document.getElementById('fwPanelCompose').classList.contains('is-active')).toBe(false);
  });

  it('存的是脏值时落回默认编写 tab（没存过时用默认值的同一条防线）', async function () {
    window.localStorage.setItem('composer-fw-tab', 'not-a-real-tab');
    await import('../float.js');
    expect(document.getElementById('fwPanelCompose').classList.contains('is-active')).toBe(true);
    expect(document.getElementById('fwPanelFleet').classList.contains('is-active')).toBe(false);
  });

  it('非 Tauri 环境下 Agent 面板显示降级文案，不抛错', async function () {
    await import('../float.js');
    document.getElementById('fwTabFleetBtn').click();
    expect(document.getElementById('fwPanelFleet').querySelector('.fw-fleet-empty').textContent).toBe(
      '此功能需要桌面端'
    );
  });
});
