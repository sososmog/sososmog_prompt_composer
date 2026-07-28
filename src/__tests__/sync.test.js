import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStateSync } from '../sync.js';

/* 假 fs：与 statefile.test.js 同款，记录调用顺序、可模拟写盘失败/延迟。
 * sync.js 内部走 writeStateAtomic（真实实现），故假 fs 需要 writeTextFile/
 * rename/mkdir 这套接口，行为与 Tauri fs 插件对齐。 */
function fakeFs(opts) {
  opts = opts || {};
  var files = {};
  var calls = [];
  var fs = {
    files: files,
    calls: calls,
    mkdir: function () { calls.push('mkdir'); return Promise.resolve(); },
    writeTextFile: function (name, text) {
      calls.push('write:' + name);
      if (opts.writeImpl) return opts.writeImpl(name, text);
      if (opts.failWrite) return Promise.reject(new Error('disk full'));
      files[name] = text;
      return Promise.resolve();
    },
    rename: function (from, to) {
      calls.push('rename:' + from + '->' + to);
      files[to] = files[from];
      delete files[from];
      return Promise.resolve();
    },
  };
  return fs;
}

// 假 eventApi：listen 记住回调供测试手动触发，emit 记录发出去的内容。
function fakeEventApi() {
  var listeners = {};
  var emitted = [];
  return {
    listeners: listeners,
    emitted: emitted,
    listen: function (event, handler) {
      listeners[event] = handler;
      return Promise.resolve(function () {});
    },
    emit: function (event, payload) {
      emitted.push({ event: event, payload: payload });
      return Promise.resolve();
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('scheduleSave 防抖', () => {
  it('连续多次 scheduleSave 只写一次盘', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi: null,
      getState: () => ({ a: 1 }), setState: () => {}, onApply: () => {}, isEditing: () => false,
    });
    sync.scheduleSave();
    sync.scheduleSave();
    sync.scheduleSave();
    await vi.advanceTimersByTimeAsync(300);
    const writes = fs.calls.filter((c) => c.startsWith('write:'));
    expect(writes.length).toBe(1);
  });

  it('onStatus 依次收到 saving → saved', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    const statuses = [];
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi: null,
      getState: () => ({}), setState: () => {}, onApply: () => {}, isEditing: () => false,
      onStatus: (s) => statuses.push(s),
    });
    sync.scheduleSave();
    expect(statuses).toEqual(['saving']);
    await vi.advanceTimersByTimeAsync(300);
    expect(statuses).toEqual(['saving', 'saved']);
  });
});

describe('时序 bug 回归：emit 的内容必须与写盘指纹一致', () => {
  it('写盘 Promise resolve 之前 state 又被改动，emit 出去的仍是写盘那一刻的旧快照', async () => {
    const fs = fakeFs();
    var releaseWrite;
    fs.writeTextFile = function (name, text) {
      fs.calls.push('write:' + name);
      return new Promise((resolve) => {
        releaseWrite = () => { fs.files[name] = text; resolve(); };
      });
    };
    var state = { count: 1 };
    const eventApi = fakeEventApi();
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi,
      getState: () => state, setState: (s) => { state = s; }, onApply: () => {}, isEditing: () => false,
    });

    const pending = sync.persistNow();
    // 等 ensureAppDataDir 的微任务链走完，真正调用到 fs.writeTextFile（否则
    // releaseWrite 此刻还没被赋值）。用宏任务 tick 确保所有排队的微任务已跑完。
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 写盘 promise 尚未 resolve 前，用户又敲了字（state 引用被换掉）
    state = { count: 2 };
    releaseWrite();
    await pending;

    expect(eventApi.emitted.length).toBe(1);
    // 发出去的必须是 persistNow 调用那一刻的快照（count:1），不是此刻的 state（count:2）
    expect(eventApi.emitted[0].payload).toEqual({ count: 1 });
  });
});

describe('回声过滤', () => {
  it('收到自己刚广播过的指纹时判定为回声，不触发 onApply', async () => {
    const fs = fakeFs();
    const eventApi = fakeEventApi();
    let applyCount = 0;
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi,
      getState: () => ({ x: 1 }),
      setState: () => { applyCount++; },
      onApply: () => { applyCount++; },
      isEditing: () => false,
    });
    sync.start();
    await sync.persistNow(); // 广播一次，记下 { x: 1 } 的指纹

    const handler = eventApi.listeners['composer-state-changed'];
    handler({ payload: { x: 1 } }); // 与刚广播的内容一致 → 回声
    expect(applyCount).toBe(0);
  });

  it('内容不同的远端更新（非回声）正常触发 apply', async () => {
    const fs = fakeFs();
    const eventApi = fakeEventApi();
    let applied = null;
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi,
      getState: () => ({ x: 1 }),
      setState: (s) => { applied = s; },
      onApply: () => {},
      isEditing: () => false,
    });
    sync.start();
    await sync.persistNow();

    const handler = eventApi.listeners['composer-state-changed'];
    handler({ payload: { x: 2 } }); // 内容不同，不是回声
    expect(applied).toEqual({ x: 2 });
  });
});

describe('正在编辑时暂存远端更新', () => {
  it('编辑中收到远端更新先暂存，flushPending 后才 apply', () => {
    const fs = fakeFs();
    const eventApi = fakeEventApi();
    let editing = true;
    let applied = null;
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi,
      getState: () => ({}),
      setState: (s) => { applied = s; },
      onApply: () => {},
      isEditing: () => editing,
    });
    sync.start();

    const handler = eventApi.listeners['composer-state-changed'];
    handler({ payload: { remote: true } });
    expect(applied).toBeNull(); // 正在编辑：暂存，未应用

    editing = false;
    sync.flushPending();
    expect(applied).toEqual({ remote: true });
  });

  it('discardPending 后，flushPending 不会应用被丢弃的远端 state', () => {
    const fs = fakeFs();
    const eventApi = fakeEventApi();
    let editing = true;
    let applied = null;
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi,
      getState: () => ({}),
      setState: (s) => { applied = s; },
      onApply: () => {},
      isEditing: () => editing,
    });
    sync.start();

    const handler = eventApi.listeners['composer-state-changed'];
    handler({ payload: { remote: true } });
    sync.discardPending();

    editing = false;
    sync.flushPending();
    expect(applied).toBeNull();
  });
});

describe('写盘失败', () => {
  it('写盘失败调用 onError，而不是抛异常/静默吞掉', async () => {
    const fs = fakeFs({ failWrite: true });
    let caught = null;
    const sync = createStateSync({
      fs, baseDir: 'AppData', eventApi: null,
      getState: () => ({}), setState: () => {}, onApply: () => {}, isEditing: () => false,
      onError: (err) => { caught = err; },
    });
    await expect(sync.persistNow()).resolves.toBeUndefined();
    expect(caught).toBeTruthy();
    expect(caught.message).toBe('disk full');
  });
});

describe('非 Tauri 环境（fs/baseDir 缺失）', () => {
  it('persistNow 直接视为已保存，不写盘也不广播', async () => {
    const eventApi = fakeEventApi();
    const statuses = [];
    const sync = createStateSync({
      fs: null, baseDir: null, eventApi,
      getState: () => ({}), setState: () => {}, onApply: () => {}, isEditing: () => false,
      onStatus: (s) => statuses.push(s),
    });
    await sync.persistNow();
    expect(statuses).toEqual(['saved']);
    expect(eventApi.emitted.length).toBe(0);
  });
});
