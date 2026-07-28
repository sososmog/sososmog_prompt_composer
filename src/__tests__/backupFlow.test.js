/* ============================================================
 * backupFlow.test.js —— 导入导出编排层（backup.js）
 * ------------------------------------------------------------
 * 合并策略、schemaVersion 判断、端点闸门这些纯逻辑在 backup.test.js 里
 * 已覆盖；这份测试管 backup.js 自己那层：文件对话框接得对不对、用户取消
 * 时会不会误写、读到坏文件时提示哪一句、确认导入后 state 有没有真的换掉。
 *
 * Tauri API 的注入时机有个坑：backup.js 在**模块顶层**就读了
 * window.__TAURI__.path / .opener（tauriPath / tauriOpener 两个模块级变量），
 * 所以要测这两条路径，必须在 import 之前把 window.__TAURI__ 摆好。
 * store.js 的 fsApi / dialogApi 同理，也是加载时读的。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var rawIndexHtml = readFileSync(path.resolve(here, '../index.html'), 'utf-8');
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}
var BODY_HTML = extractBodyHtml(rawIndexHtml);

// 装一份假的 Tauri：dialog（save/open）+ fs（读写）+ path/opener。
// 每个用例可通过返回的 handles 改写行为、检查调用参数。
function stubTauri(overrides) {
  var o = overrides || {};
  var handles = {
    saved: [],          // [{ filePath, content }]
    savePath: 'C:/fake/out.json',
    openPath: null,     // dialog.open 返回值
    fileText: '',       // readTextFile 返回内容
    revealed: [],
    openedPaths: []
  };
  Object.keys(o).forEach(function (k) { handles[k] = o[k]; });

  handles.dialogSave = vi.fn(function () { return Promise.resolve(handles.savePath); });
  handles.dialogOpen = vi.fn(function () { return Promise.resolve(handles.openPath); });
  handles.writeTextFile = vi.fn(function (fp, content) {
    handles.saved.push({ filePath: fp, content: content });
    return Promise.resolve();
  });
  handles.readTextFile = vi.fn(function () {
    if (handles.readFails) return Promise.reject(new Error('读不了'));
    return Promise.resolve(handles.fileText);
  });
  handles.revealItemInDir = vi.fn(function (p) {
    handles.revealed.push(p);
    if (handles.revealFails) return Promise.reject(new Error('reveal 失败'));
    return Promise.resolve();
  });
  handles.openPathFn = vi.fn(function (p) { handles.openedPaths.push(p); return Promise.resolve(); });
  handles.emit = vi.fn(function () { return Promise.resolve(); });

  window.__TAURI__ = {
    dialog: { save: handles.dialogSave, open: handles.dialogOpen },
    fs: {
      writeTextFile: handles.writeTextFile,
      readTextFile: handles.readTextFile,
      exists: function () { return Promise.resolve(true); },
      mkdir: function () { return Promise.resolve(); },
      rename: function () { return Promise.resolve(); },
      remove: function () { return Promise.resolve(); },
      BaseDirectory: { AppData: 'AppData' }
    },
    path: {
      appDataDir: function () {
        if (handles.appDataFails) return Promise.reject(new Error('拿不到目录'));
        return Promise.resolve('C:/Users/x/AppData/Roaming/composer');
      },
      join: handles.noJoin ? undefined : function () {
        return Promise.resolve(Array.prototype.join.call(arguments, '/'));
      }
    },
    opener: {
      revealItemInDir: handles.noOpener ? undefined : handles.revealItemInDir,
      openPath: handles.openPathFn
    },
    app: { getVersion: function () { return Promise.resolve('0.2.0'); } },
    event: { emit: handles.emit }
  };
  return handles;
}

// 一份最小可导入文件：只带素材库
function makeBundleText(extra) {
  var bundle = {
    app: 'composer',
    type: 'composer-config',
    schemaVersion: 1,
    includes: ['materials'],
    payload: {
      materials: {
        customModules: [{ id: 'im_1', label: { zh: '导入模块', en: 'Imported' }, text: { zh: '导入正文', en: 'body' }, builtin: false, hidden: false }],
        customSnippets: [{ id: 'is_1', tag: '导入常用句', zh: '导入内容', en: 'x', builtin: false, hidden: false }],
        quickGroups: [{ id: 'ig_1', label: { zh: '导入分组', en: 'G' }, hidden: false, items: [] }],
        moduleOrder: ['im_1'],
        snippetOrder: ['is_1'],
        builtinPatches: {},
        modulePatches: {}
      }
    }
  };
  if (extra) Object.keys(extra).forEach(function (k) { bundle[k] = extra[k]; });
  return JSON.stringify(bundle);
}

var events, store, backup;

// 灌 DOM、装 Tauri、再动态 import（顺序不能反，见文件头注释）
async function boot(tauriOverrides) {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;
  var handles = stubTauri(tauriOverrides);

  events = await import('../events.js');
  store = await import('../store.js');
  backup = await import('../backup.js');
  events.renderAll();

  return handles;
}

/* 读最近一条 toast 文本。
 * 不 mock showToast：它是 ESM 命名空间上的只读绑定，spyOn 换不掉 store.js
 * 内部的调用点，而 backup.js 也是 import 进去直接用的。直接读它塞进 DOM 的
 * 节点更可靠，顺带验证了提示真的显示出来了。 */
function lastToast() {
  var els = document.querySelectorAll('.toast, #toast');
  return els.length ? els[els.length - 1].textContent : '';
}

afterEach(function () {
  // 用例崩在中途时也要还原：某个用例替换的全局（URL、fetch 等）泄漏出去，
  // 会让后面所有用例连 boot 都跑不起来，报错还指向无辜的那一行。
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.__TAURI__;
});

/* ---------------- 导出 ---------------- */

describe('导出弹窗', function () {
  beforeEach(async function () { await boot(); });

  it('打开后默认选中「迁移配置」，勾选联动到素材库 + 偏好', function () {
    backup.openExportFlow();
    var checked = document.querySelector('input[name="bkPreset"]:checked');
    expect(checked.value).toBe('migrate');

    var on = Array.prototype.filter.call(document.querySelectorAll('.bk-section'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    expect(on).toEqual(['materials', 'preferences']);
  });

  it('指定 presetId 可直接打开对应预设', function () {
    backup.openExportFlow('share');
    expect(document.querySelector('input[name="bkPreset"]:checked').value).toBe('share');
    var on = Array.prototype.filter.call(document.querySelectorAll('.bk-section'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    expect(on).toEqual(['materials']);
  });

  it('切到「完整备份」时三段全勾上', function () {
    backup.openExportFlow();
    var full = document.querySelector('input[name="bkPreset"][value="full"]');
    full.checked = true;
    full.dispatchEvent(new Event('change', { bubbles: true }));

    var on = Array.prototype.filter.call(document.querySelectorAll('.bk-section'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    expect(on).toEqual(['materials', 'preferences', 'content']);
  });

  it('手动改勾选后预设单选被清掉（表示自定义）', function () {
    backup.openExportFlow();
    var one = document.querySelector('.bk-section');
    one.checked = !one.checked;
    one.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.querySelector('input[name="bkPreset"]:checked')).toBe(null);
  });

  it('一项都不勾就点导出：提示且不写文件、弹窗不关', async function () {
    var h = await boot();
    backup.openExportFlow();
    document.querySelectorAll('.bk-section').forEach(function (c) { c.checked = false; });

    document.getElementById('bkExportGo').click();
    await Promise.resolve();

    expect(h.dialogSave).not.toHaveBeenCalled();
    expect(document.getElementById('bkExportGo')).not.toBe(null); // 还开着
  });

  it('Esc 关闭弹窗并从 DOM 移除', function () {
    backup.openExportFlow();
    expect(document.querySelector('.bk-panel')).not.toBe(null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.bk-panel')).toBe(null);
  });
});

describe('导出写文件', function () {
  it('确认后走 dialog.save + writeTextFile，内容是合法 bundle 且不含 API Key', async function () {
    var h = await boot();
    store.state.settings.translation.apiKey = 'sk-must-not-leak';
    backup.openExportFlow('full');

    document.getElementById('bkExportGo').click();
    // 链路：readAppVersion → dialog.save → writeTextFile
    await vi.waitFor(function () { expect(h.saved.length).toBe(1); });

    var written = h.saved[0];
    expect(written.filePath).toBe('C:/fake/out.json');
    var bundle = JSON.parse(written.content);
    expect(bundle.app).toBe('composer');
    expect(bundle.schemaVersion).toBe(1);
    expect(written.content).not.toContain('sk-must-not-leak');
  });

  it('默认文件名：只导素材库时用 library 前缀，否则用 config 前缀', async function () {
    var h = await boot();
    backup.openExportFlow('share');
    document.getElementById('bkExportGo').click();
    await vi.waitFor(function () { expect(h.dialogSave).toHaveBeenCalled(); });
    expect(h.dialogSave.mock.calls[0][0].defaultPath).toMatch(/^composer-library-\d{8}\.json$/);

    var h2 = await boot();
    backup.openExportFlow('migrate');
    document.getElementById('bkExportGo').click();
    await vi.waitFor(function () { expect(h2.dialogSave).toHaveBeenCalled(); });
    expect(h2.dialogSave.mock.calls[0][0].defaultPath).toMatch(/^composer-config-\d{8}\.json$/);
  });

  it('用户在保存对话框点取消：不写任何文件，也不报错', async function () {
    var h = await boot({ savePath: null });
    backup.openExportFlow('share');

    document.getElementById('bkExportGo').click();
    await vi.waitFor(function () { expect(h.dialogSave).toHaveBeenCalled(); });

    expect(h.writeTextFile).not.toHaveBeenCalled();
  });

  it('写盘失败时提示导出失败，不静默吞掉', async function () {
    var h = await boot();
    h.writeTextFile.mockImplementation(function () { return Promise.reject(new Error('磁盘满')); });
    backup.openExportFlow('share');

    document.getElementById('bkExportGo').click();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/导出失败/); });
  });

  it('非 Tauri 环境降级走 Blob 下载（不因缺 dialog 直接崩）', async function () {
    vi.resetModules();
    document.body.innerHTML = BODY_HTML;
    delete window.__TAURI__;
    // 只替换这两个静态方法：jsdom 没实现 createObjectURL，而整体替换 URL
    // 会连构造器一起弄坏（其它用例还要用它）。
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(function () {});

    var ev = await import('../events.js');
    await import('../store.js');
    var bk = await import('../backup.js');
    ev.renderAll();

    // 拦下 <a>.click()，jsdom 里真点会走导航、也拿不到下载文件名
    var clicked = [];
    var realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(function (tag) {
      var el = realCreate(tag);
      if (tag === 'a') el.click = function () { clicked.push(el.download); };
      return el;
    });

    bk.openExportFlow('share');
    document.getElementById('bkExportGo').click();
    await vi.waitFor(function () { expect(clicked.length).toBe(1); });
    expect(clicked[0]).toMatch(/^composer-library-\d{8}\.json$/);
  });
});

/* ---------------- 导入 ---------------- */

describe('导入：选文件与坏文件', function () {
  it('用户取消选择：什么都不做', async function () {
    var h = await boot({ openPath: null });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(h.dialogOpen).toHaveBeenCalled(); });
    expect(h.readTextFile).not.toHaveBeenCalled();
    expect(document.querySelector('#bkImportGo')).toBe(null);
  });

  it('dialog.open 返回数组时取第一项（multiple:false 也有实现返回数组）', async function () {
    var h = await boot({ openPath: ['C:/fake/in.json'], fileText: makeBundleText() });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(h.readTextFile).toHaveBeenCalled(); });
    expect(h.readTextFile.mock.calls[0][0]).toBe('C:/fake/in.json');
  });

  it('文件不是 JSON：提示「已损坏或不是有效的配置文件」，不弹预览', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: '这不是 json{{{' });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/损坏|有效的配置文件/); });
    expect(document.querySelector('#bkImportGo')).toBe(null);
  });

  it('JSON 合法但不是 Composer 文件：提示对应文案', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: JSON.stringify({ hello: 'world' }) });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/不是 Composer/); });
  });

  it('schemaVersion 比本机新：提示先升级应用', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText({ schemaVersion: 999 }) });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/升级/); });
  });

  it('payload 里没有任何已知段：提示没有可导入的内容', async function () {
    // 注意 includes 字段不是判据——validateImportBundle 只看 payload 里真正
    // 存在哪些段，并用结果覆盖写回 includes。所以这里要把 payload 掏空，
    // 光把 includes 写成 [] 是没用的。
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText({ payload: {} }) });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/没有可导入/); });
  });

  it('includes 字段被伪造时以 payload 实际内容为准（不信文件自称）', async function () {
    await boot({
      openPath: 'C:/fake/in.json',
      fileText: makeBundleText({ includes: ['materials', 'preferences', 'content'] })
    });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkSummary')).not.toBe(null); });

    // payload 里只有 materials，摘要不该出现偏好/正文那两行
    var text = document.querySelector('#bkSummary').textContent;
    expect(text).toMatch(/个插入模块/);
    expect(text).not.toMatch(/偏好设置/);
    expect(text).not.toMatch(/正文草稿/);
  });

  it('读文件本身失败：提示换目录重试（沙箱外路径的常见情形）', async function () {
    await boot({ openPath: 'C:/fake/in.json', readFails: true });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/读取文件失败/); });
  });

  it('环境不支持（无 dialog/fs）时明确提示，而不是无声失败', async function () {
    vi.resetModules();
    document.body.innerHTML = BODY_HTML;
    delete window.__TAURI__;
    var ev = await import('../events.js');
    await import('../store.js');
    var bk = await import('../backup.js');
    ev.renderAll();

    bk.openImportFlow();
    var text = document.body.textContent;
    expect(text).toMatch(/不支持导入/);
  });
});

describe('导入预览与应用', function () {
  it('预览列出将导入的素材条数', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText() });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkSummary')).not.toBe(null); });

    var text = document.querySelector('#bkSummary').textContent;
    expect(text).toMatch(/个插入模块/);
    expect(text).toMatch(/条常用句/);
    expect(text).toMatch(/个快速段落分组/);
  });

  it('默认是「合并 + 保留两份」', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText() });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });

    expect(document.querySelector('input[name="bkMode"]:checked').value).toBe('merge');
    expect(document.querySelector('input[name="bkConflict"]:checked').value).toBe('rename');
  });

  it('切到「覆盖」后同名策略被禁用（此时选它没有意义）', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText() });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });

    var replace = document.querySelector('input[name="bkMode"][value="replace"]');
    replace.checked = true;
    replace.dispatchEvent(new Event('change', { bubbles: true }));

    var disabled = Array.prototype.every.call(
      document.querySelectorAll('#bkConflictGroup input'),
      function (r) { return r.disabled; }
    );
    expect(disabled).toBe(true);
  });

  it('确认导入后素材真的进了 state，且弹窗关闭', async function () {
    await boot({ openPath: 'C:/fake/in.json', fileText: makeBundleText() });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });

    var before = store.state.customSnippets.length;
    document.getElementById('bkImportGo').click();

    expect(store.state.customSnippets.length).toBe(before + 1);
    expect(store.state.customSnippets.some(function (s) { return s.tag === '导入常用句'; })).toBe(true);
    expect(document.querySelector('#bkImportGo')).toBe(null);
  });

  it('导入永不清空本机 API Key（铁律）', async function () {
    await boot({
      openPath: 'C:/fake/in.json',
      fileText: makeBundleText({
        includes: ['materials', 'preferences'],
        payload: {
          materials: { customModules: [], customSnippets: [], quickGroups: [], moduleOrder: [], snippetOrder: [], builtinPatches: {}, modulePatches: {} },
          preferences: { translation: { provider: 'custom', protocol: 'openai', baseUrl: '', model: 'm' } }
        }
      })
    });
    store.state.settings.translation.apiKey = 'sk-local-keep-me';

    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });
    document.getElementById('bkImportGo').click();

    expect(store.state.settings.translation.apiKey).toBe('sk-local-keep-me');
  });

  it('陌生翻译接口地址：默认不勾选、摘要写明「不导入」，勾上后才导入', async function () {
    var bundleText = makeBundleText({
      includes: ['preferences'],
      payload: {
        preferences: {
          translation: { provider: 'custom', protocol: 'openai', baseUrl: 'https://evil.example.com/v1', model: 'm' }
        }
      }
    });
    await boot({ openPath: 'C:/fake/in.json', fileText: bundleText });
    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });

    var chk = document.querySelector('#bkImportEndpoint');
    expect(chk).not.toBe(null);
    expect(chk.checked).toBe(false);
    expect(document.querySelector('#bkSummary').textContent).toMatch(/不导入/);

    chk.checked = true;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('#bkSummary').textContent).toMatch(/已确认导入/);

    document.getElementById('bkImportGo').click();
    expect(store.state.settings.translation.baseUrl).toBe('https://evil.example.com/v1');
  });

  it('不勾选陌生地址时，本机翻译接口保持原样', async function () {
    var bundleText = makeBundleText({
      includes: ['preferences'],
      payload: {
        preferences: {
          translation: { provider: 'custom', protocol: 'openai', baseUrl: 'https://evil.example.com/v1', model: 'm' }
        }
      }
    });
    await boot({ openPath: 'C:/fake/in.json', fileText: bundleText });
    store.state.settings.translation.baseUrl = 'https://my-own.example.com/v1';

    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });
    document.getElementById('bkImportGo').click();

    expect(store.state.settings.translation.baseUrl).toBe('https://my-own.example.com/v1');
  });

  it('导入偏好里的 theme 会应用到 documentElement 并广播', async function () {
    var bundleText = makeBundleText({
      includes: ['preferences'],
      payload: { preferences: { theme: 'light', translation: { provider: 'custom', protocol: 'openai', baseUrl: '', model: '' } } }
    });
    var h = await boot({ openPath: 'C:/fake/in.json', fileText: bundleText });
    document.documentElement.setAttribute('data-theme', 'dark');

    backup.openImportFlow();
    await vi.waitFor(function () { expect(document.querySelector('#bkImportGo')).not.toBe(null); });
    document.getElementById('bkImportGo').click();

    expect(document.documentElement.getAttribute('data-theme')).toBe(null); // light
    expect(h.emit).toHaveBeenCalledWith('composer-theme-changed', { theme: 'light' });
  });
});

/* ---------------- 配置文件位置 ---------------- */

describe('配置文件位置', function () {
  it('getConfigFilePath 用 path.join 拼出完整路径', async function () {
    await boot();
    var p = await backup.getConfigFilePath();
    expect(p).toContain('AppData');
    expect(p).toMatch(/composer/);
  });

  it('没有 path.join 时手工拼接，且不出现重复分隔符', async function () {
    await boot({ noJoin: true });
    var p = await backup.getConfigFilePath();
    expect(p).not.toMatch(/\/\//);
    expect(p.split('/').filter(Boolean).length).toBeGreaterThan(2);
  });

  it('appDataDir 失败时 resolve(null) 而不是抛异常', async function () {
    await boot({ appDataFails: true });
    var p = await backup.getConfigFilePath();
    expect(p).toBe(null);
  });

  it('非 Tauri 环境返回 null', async function () {
    vi.resetModules();
    document.body.innerHTML = BODY_HTML;
    delete window.__TAURI__;
    var ev = await import('../events.js');
    await import('../store.js');
    var bk = await import('../backup.js');
    ev.renderAll();

    await expect(bk.getConfigFilePath()).resolves.toBe(null);
  });

  it('openConfigFolder 调 revealItemInDir 并带上配置文件路径', async function () {
    var h = await boot();
    backup.openConfigFolder();
    await vi.waitFor(function () { expect(h.revealed.length).toBe(1); });
    expect(h.revealed[0]).toContain('AppData');
  });

  it('reveal 失败时退回打开所在目录（文件还没落盘的情形）', async function () {
    var h = await boot({ revealFails: true });
    backup.openConfigFolder();
    await vi.waitFor(function () { expect(h.openedPaths.length).toBe(1); });
    expect(h.openedPaths[0]).toContain('AppData');
  });

  it('opener 插件缺失时提示不支持，不抛异常', async function () {
    await boot({ noOpener: true });
    backup.openConfigFolder();
    expect(lastToast()).toMatch(/不支持打开文件夹/);
  });

  it('定位不到配置文件时提示无法定位', async function () {
    await boot({ appDataFails: true });
    backup.openConfigFolder();
    await vi.waitFor(function () { expect(lastToast()).toMatch(/无法定位/); });
  });
});
