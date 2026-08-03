/* ============================================================
 * updateCheck.test.js —— 自动检查更新：只提示、不自动装
 * ------------------------------------------------------------
 * 这条链路以前的实现是「启动 3 秒后静默检查 → 查到就 window.confirm →
 * 点确定立刻 downloadAndInstall + relaunch」。Tauri 里 confirm 是原生
 * 对话框、默认焦点在「确定」，用户启动后正在打字，一个回车就把升级
 * 确认掉了，观感上等于应用自己偷偷升级重启。改成：
 *   ① 检查与安装彻底分开，安装只能由「下载并安装」按钮触发；
 *   ② 是否做启动静默检查由 settings.update.autoCheck 控制。
 * 这份测试就是钉住这两条，防止哪天又被改回自动安装。
 *
 * Tauri API 是 store.js 加载时读的（updaterApi / processApi 都是模块级
 * 变量），所以假 Tauri 必须在动态 import 之前摆好。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultState, normalizeState } from '../core.js';

var here = path.dirname(fileURLToPath(import.meta.url));
var rawIndexHtml = readFileSync(path.resolve(here, '../index.html'), 'utf-8');
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}
var BODY_HTML = extractBodyHtml(rawIndexHtml);

/* 装一份假 Tauri：updater.check 的返回值由用例通过 handles 控制。
 * handles.update 为 null 表示「已是最新」，为对象表示查到了新版本。 */
function stubTauri(overrides) {
  var o = overrides || {};
  var handles = {
    update: null,           // check() resolve 出去的 Update 对象
    checkFails: false,      // check() 直接 reject
    installFails: false,    // downloadAndInstall() reject
    stateText: null         // 存档文件内容（null = 没有存档）
  };
  Object.keys(o).forEach(function (k) { handles[k] = o[k]; });

  handles.downloadAndInstall = vi.fn(function () {
    if (handles.installFails) return Promise.reject(new Error('装不上'));
    return Promise.resolve();
  });
  handles.closeUpdate = vi.fn(function () { return Promise.resolve(); });
  handles.relaunch = vi.fn(function () { return Promise.resolve(); });
  handles.check = vi.fn(function () {
    if (handles.checkFails) return Promise.reject(new Error('网络不通'));
    if (!handles.update) return Promise.resolve(null);
    return Promise.resolve(Object.assign({
      downloadAndInstall: handles.downloadAndInstall,
      close: handles.closeUpdate
    }, handles.update));
  });

  window.__TAURI__ = {
    updater: { check: handles.check },
    process: { relaunch: handles.relaunch },
    fs: {
      writeTextFile: function () { return Promise.resolve(); },
      readTextFile: function () {
        if (handles.stateText == null) return Promise.reject(new Error('没有存档'));
        return Promise.resolve(handles.stateText);
      },
      exists: function () { return Promise.resolve(handles.stateText != null); },
      mkdir: function () { return Promise.resolve(); },
      rename: function () { return Promise.resolve(); },
      remove: function () { return Promise.resolve(); },
      BaseDirectory: { AppData: 'AppData' }
    },
    app: { getVersion: function () { return Promise.resolve('0.2.0'); } },
    event: { emit: function () { return Promise.resolve(); }, listen: function () { return Promise.resolve(function () {}); } }
  };
  return handles;
}

var events, store, handles;

async function boot(overrides) {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;
  document.documentElement.removeAttribute('data-theme');
  // 这条链路最要命的回归就是"没人点确定却装上了"，所以 confirm 一律 stub
  // 成"点了确定"——真被调用到就会走安装，用例便能抓住它。
  window.confirm = vi.fn(function () { return true; });
  handles = stubTauri(overrides);

  events = await import('../events.js');
  store = await import('../store.js');
  events.bindEvents();
  events.renderAll();
  return handles;
}

afterEach(function () {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.__TAURI__;
});

function lastToast() {
  var els = document.querySelectorAll('.toast, #toast');
  return els.length ? els[els.length - 1].textContent : '';
}

// check() → renderUpdateState() 之间隔着两层 Promise，给微任务队列让路
function flush() {
  return Promise.resolve().then(function () {}).then(function () {}).then(function () {});
}

/* ---------------- 存档字段 ---------------- */

describe('settings.update.autoCheck 归一化', function () {
  it('默认开', function () {
    expect(defaultState().settings.update.autoCheck).toBe(true);
    expect(normalizeState({}).settings.update.autoCheck).toBe(true);
  });

  it('老存档没有 update 段时补成默认开（零迁移）', function () {
    var raw = { settings: { toggleShortcut: 'Ctrl+Alt+K', pasteDelayMs: 80 } };
    var s = normalizeState(raw);
    expect(s.settings.update.autoCheck).toBe(true);
    expect(s.settings.toggleShortcut).toBe('Ctrl+Alt+K'); // 其它偏好没被带坏
  });

  it('显式关闭会被保留', function () {
    var s = normalizeState({ settings: { update: { autoCheck: false } } });
    expect(s.settings.update.autoCheck).toBe(false);
  });

  it('脏值回退默认开', function () {
    expect(normalizeState({ settings: { update: 'nope' } }).settings.update.autoCheck).toBe(true);
    expect(normalizeState({ settings: { update: { autoCheck: 'no' } } }).settings.update.autoCheck).toBe(true);
    expect(normalizeState({ settings: { update: {} } }).settings.update.autoCheck).toBe(true);
  });
});

/* ---------------- 手动检查：查到新版本 ---------------- */

describe('查到新版本时只提示，不安装', function () {
  beforeEach(async function () {
    await boot({ update: { version: '0.9.0', body: '修了几个坑' } });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
  });

  it('不弹 confirm、不下载安装', function () {
    expect(handles.check).toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(handles.downloadAndInstall).not.toHaveBeenCalled();
    expect(handles.relaunch).not.toHaveBeenCalled();
  });

  it('关于页出现带版本号的安装按钮和更新说明', function () {
    var install = document.getElementById('stInstallUpdate');
    expect(install.hidden).toBe(false);
    expect(install.textContent).toContain('0.9.0');
    expect(document.getElementById('stUpdateNote').hidden).toBe(false);
    expect(document.getElementById('stUpdateBody').textContent).toBe('修了几个坑');
  });

  it('侧栏设置按钮和关于 tab 都挂上小红点', function () {
    expect(document.getElementById('btnEditorSettings').classList.contains('has-update')).toBe(true);
    expect(document.querySelector('.st-nav-item[data-tab="about"]').classList.contains('has-update')).toBe(true);
  });

  it('点了安装按钮才下载并重启', async function () {
    document.getElementById('stInstallUpdate').click();
    await flush();
    expect(handles.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(handles.relaunch).toHaveBeenCalledTimes(1);
  });

  it('安装失败时提示错误，按钮恢复可点（不至于卡死在"正在下载"）', async function () {
    handles.installFails = true;
    document.getElementById('stInstallUpdate').click();
    await flush();
    expect(lastToast()).toContain('更新安装失败');
    var install = document.getElementById('stInstallUpdate');
    expect(install.disabled).toBe(false);
    expect(install.hidden).toBe(false);
  });
});

/* ---------------- 手动检查：其它分支 ---------------- */

describe('手动检查的其它结果', function () {
  it('已是最新时提示一句，安装按钮保持隐藏、无红点', async function () {
    await boot({ update: null });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(lastToast()).toContain('已是最新版本');
    expect(document.getElementById('stInstallUpdate').hidden).toBe(true);
    expect(document.getElementById('btnEditorSettings').classList.contains('has-update')).toBe(false);
  });

  it('检查失败时报错，不留下半个安装入口', async function () {
    await boot({ checkFails: true });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(lastToast()).toContain('检查更新失败');
    expect(document.getElementById('stInstallUpdate').hidden).toBe(true);
    expect(document.getElementById('stCheckUpdate').disabled).toBe(false);
  });

  it('查到后又查一次、这次服务端说没有新版本：清掉提示并释放 Update 句柄', async function () {
    await boot({ update: { version: '0.9.0', body: '' } });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(document.getElementById('stInstallUpdate').hidden).toBe(false);

    handles.update = null;
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(document.getElementById('stInstallUpdate').hidden).toBe(true);
    expect(document.getElementById('btnEditorSettings').classList.contains('has-update')).toBe(false);
    expect(handles.closeUpdate).toHaveBeenCalled();
  });

  it('更新说明为空时不显示空白说明框', async function () {
    await boot({ update: { version: '0.9.0', body: '   ' } });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(document.getElementById('stUpdateBody').hidden).toBe(true);
  });

  it('查到的 update 对象缺 version 时，视为没查到新版本（不留下裸的"v"按钮）', async function () {
    await boot({ update: { version: '', body: '修了几个坑' } });
    events.openSettingsPanel();
    document.getElementById('stCheckUpdate').click();
    await flush();
    expect(document.getElementById('stInstallUpdate').hidden).toBe(true);
    expect(document.getElementById('stUpdateNote').hidden).toBe(true);
    expect(document.getElementById('btnEditorSettings').classList.contains('has-update')).toBe(false);
  });
});

/* ---------------- 开关 ---------------- */

describe('「启动时自动检查更新」开关', function () {
  it('设置面板回填当前值，勾掉后写进 state', async function () {
    await boot();
    events.openSettingsPanel();
    var box = document.getElementById('stUpdateAutoCheck');
    expect(box.checked).toBe(true);           // 默认开

    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.state.settings.update.autoCheck).toBe(false);
    expect(lastToast()).toContain('已关闭自动检查更新');

    // 重新渲染面板时读回的是新值，不会跳回默认
    events.openSettingsPanel();
    expect(document.getElementById('stUpdateAutoCheck').checked).toBe(false);
  });

  it('开关打开时，启动 3 秒后会静默查一次', async function () {
    var saved = defaultState();
    saved.settings.update.autoCheck = true;
    await boot({ stateText: JSON.stringify(saved) });
    vi.useFakeTimers();
    events.bootstrap();
    vi.advanceTimersByTime(3000);
    expect(handles.check).toHaveBeenCalledTimes(1);
  });

  it('开关关闭时，启动后不联网检查', async function () {
    var saved = defaultState();
    saved.settings.update.autoCheck = false;
    await boot({ stateText: JSON.stringify(saved) });
    store.state.settings.update.autoCheck = false;
    vi.useFakeTimers();
    events.bootstrap();
    vi.advanceTimersByTime(3000);
    expect(handles.check).not.toHaveBeenCalled();
  });
});
