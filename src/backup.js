/* ============================================================
 * backup.js —— 配置导入导出（本地文件）编排 + 弹窗 UI
 * ------------------------------------------------------------
 * 纯逻辑（打包 / 校验 / 合并 / 摘要）在 core.js，本文件负责：
 *   - 读环境（localStorage theme、Tauri app 版本）注入 core
 *   - 弹导出面板（预设 + 三段勾选）→ 写文件（dialog.save + fs.writeTextFile）
 *   - 弹导入预览（dialog.open + fs.readTextFile → 校验 → 摘要 → 应用）
 *   - 应用导入：mergeState → setState → scheduleSave（自动广播浮窗）→ renderAll
 *
 * 铁律（对齐方案）：API Key 从不导出；导入永不清空本机 Key。
 *
 * 与 events.js 的循环依赖（renderAll / applyStartupShortcut）在运行时才调用，
 * ESM 循环对函数声明是安全的，与现有 store↔events 循环同理。
 * ============================================================ */
import {
  buildExportBundle,
  validateImportBundle,
  mergeState,
  summarizeImport,
  normalizeState,
  icon,
} from './core.js';
import {
  state,
  setState,
  scheduleSave,
  showToast,
  collectText,
  view,
  fsApi,
  dialogApi,
  tauriAvailable,
  STATE_FILE,
} from './store.js';
import { renderAll, applyStartupShortcut } from './events.js';

/* ============================================================
 * 0. 段落元信息（UI 文案）
 * ============================================================ */
var SECTION_META = {
  materials: { label: '素材库', desc: '插入模块、常用句、快速段落' },
  preferences: { label: '偏好设置', desc: '快捷键、粘贴等待、翻译配置（不含 API Key）、主题' },
  content: { label: '正文草稿', desc: '当前中英文正文内容' }
};

// 导出预设：勾选哪些段。均不含 API Key。
var EXPORT_PRESETS = [
  { id: 'share', label: '分享素材', hint: '只含素材库，适合发给同事或社区', sections: ['materials'] },
  { id: 'migrate', label: '迁移配置', hint: '素材库 + 偏好，换电脑常用（不含草稿）', sections: ['materials', 'preferences'] },
  { id: 'full', label: '完整备份', hint: '连正文草稿一起带走', sections: ['materials', 'preferences', 'content'] }
];

/* ============================================================
 * 1. 环境读取（core 保持纯，副作用值由这里注入）
 * ============================================================ */
function readTheme() {
  try { return localStorage.getItem('composer-theme') || 'dark'; } catch (e) { return 'dark'; }
}

function readAppVersion() {
  var TAURI = window.__TAURI__ || null;
  if (TAURI && TAURI.app && typeof TAURI.app.getVersion === 'function') {
    return TAURI.app.getVersion().catch(function () { return 'unknown'; });
  }
  return Promise.resolve('unknown');
}

function todayStamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function sectionsLabel(sections) {
  return sections.map(function (s) { return SECTION_META[s] ? SECTION_META[s].label : s; }).join('·');
}

/* ============================================================
 * 2. 通用弹窗骨架（复用 .sm-overlay / .sm-panel 惯例）
 * ------------------------------------------------------------
 * 每次打开新建一个 overlay，关闭即移除（导入导出是瞬态操作，不常驻）。
 * 关闭途径：点遮罩空白 / .sm-close / Esc。
 * ============================================================ */
function openDialog(ariaLabel, innerHtml) {
  var overlay = document.createElement('div');
  overlay.className = 'sm-overlay show';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', ariaLabel);
  overlay.innerHTML = '<div class="sm-panel bk-panel">' + innerHtml + '</div>';
  document.body.appendChild(overlay);

  function close() {
    if (!overlay) return;
    document.removeEventListener('keydown', keyHandler);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function keyHandler(e) { if (e.key === 'Escape') close(); }

  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  var closeBtn = overlay.querySelector('.sm-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', keyHandler);

  return { overlay: overlay, close: close };
}

/* ============================================================
 * 3. 导出流程
 * ============================================================ */
function openExportFlow(presetId) {
  var initial = EXPORT_PRESETS[1]; // 默认「迁移配置」
  if (presetId) {
    for (var i = 0; i < EXPORT_PRESETS.length; i++) if (EXPORT_PRESETS[i].id === presetId) initial = EXPORT_PRESETS[i];
  }

  var presetHtml = EXPORT_PRESETS.map(function (p) {
    return '<label class="bk-preset">' +
      '<input type="radio" name="bkPreset" value="' + p.id + '"' + (p.id === initial.id ? ' checked' : '') + ' />' +
      '<span class="bk-preset-main"><span class="bk-preset-label">' + p.label + '</span>' +
      '<span class="bk-preset-hint">' + p.hint + '</span></span></label>';
  }).join('');

  var sectionHtml = Object.keys(SECTION_META).map(function (key) {
    var m = SECTION_META[key];
    var checked = initial.sections.indexOf(key) !== -1;
    return '<label class="bk-check"><input type="checkbox" class="bk-section" value="' + key + '"' + (checked ? ' checked' : '') + ' />' +
      '<span class="bk-check-main"><span class="bk-check-label">' + m.label + '</span>' +
      '<span class="bk-check-desc">' + m.desc + '</span></span></label>';
  }).join('');

  var html =
    '<div class="sm-head"><span class="sm-title">导出配置</span>' +
      '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button></div>' +
    '<div class="bk-body">' +
      '<div class="bk-group"><div class="bk-group-title">快速选择</div>' + presetHtml + '</div>' +
      '<div class="bk-group"><div class="bk-group-title">包含内容</div>' + sectionHtml + '</div>' +
      '<p class="bk-note">导出文件不含 API Key，可放心分享给他人。</p>' +
    '</div>' +
    '<div class="sm-foot bk-foot">' +
      '<button type="button" class="bk-btn bk-btn-primary" id="bkExportGo">' + icon('upload') + '<span>导出为文件</span></button>' +
    '</div>';

  var dlg = openDialog('导出配置', html);
  var overlay = dlg.overlay;
  var presetRadios = overlay.querySelectorAll('input[name="bkPreset"]');
  var sectionChecks = overlay.querySelectorAll('.bk-section');

  // 选预设 → 联动勾选
  presetRadios.forEach(function (r) {
    r.addEventListener('change', function () {
      var p = null;
      for (var i = 0; i < EXPORT_PRESETS.length; i++) if (EXPORT_PRESETS[i].id === r.value) p = EXPORT_PRESETS[i];
      if (!p) return;
      sectionChecks.forEach(function (c) { c.checked = p.sections.indexOf(c.value) !== -1; });
    });
  });
  // 手动改勾选 → 清掉预设单选（表示自定义）
  sectionChecks.forEach(function (c) {
    c.addEventListener('change', function () { presetRadios.forEach(function (r) { r.checked = false; }); });
  });

  overlay.querySelector('#bkExportGo').addEventListener('click', function () {
    var sections = [];
    sectionChecks.forEach(function (c) { if (c.checked) sections.push(c.value); });
    if (sections.length === 0) { showToast('请至少选择一项要导出的内容', true); return; }
    dlg.close();
    doExport(sections);
  });
}

function doExport(sections) {
  // 编辑模式下把 DOM 里未收回的输入并入 state，确保导出的是最新正文
  if (view !== 'preview') { try { collectText(); } catch (e) { /* 无 DOM/预览态 */ } }

  readAppVersion().then(function (appVersion) {
    var bundle = buildExportBundle(state, {
      sections: sections,
      appVersion: appVersion,
      exportedAt: new Date().toISOString(),
      theme: readTheme()
    });
    var text = JSON.stringify(bundle, null, 2);
    var defaultName = (sections.length === 1 && sections[0] === 'materials')
      ? 'composer-library-' + todayStamp() + '.json'
      : 'composer-config-' + todayStamp() + '.json';
    var summary = sectionsLabel(sections);

    if (dialogApi && dialogApi.save && fsApi && fsApi.writeTextFile) {
      dialogApi.save({ defaultPath: defaultName, filters: [{ name: 'Composer 配置', extensions: ['json'] }] })
        .then(function (filePath) {
          if (!filePath) return;
          return fsApi.writeTextFile(filePath, text).then(function () {
            showToast('已导出配置（' + summary + '）');
          });
        })
        .catch(function () { showToast('导出失败', true); });
    } else {
      // 非 Tauri 预览环境降级（复用 doDownload 模式）
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast('已导出配置（' + summary + '）');
    }
  });
}

/* ============================================================
 * 4. 导入流程
 * ============================================================ */
var IMPORT_ERROR_MSG = {
  'not-object': '文件无法读取，可能已损坏或不是有效的配置文件。',
  'not-composer': '这不是 Composer 的配置文件。',
  'bad-schema': '文件版本信息无效，无法导入。',
  'too-new': '此文件由更新版本的 Composer 导出，请先升级应用后再导入。',
  'no-sections': '文件里没有可导入的内容。'
};

function openImportFlow() {
  if (!(dialogApi && dialogApi.open && fsApi && fsApi.readTextFile)) {
    showToast('当前环境不支持导入', true);
    return;
  }
  dialogApi.open({ multiple: false, directory: false, filters: [{ name: 'Composer 配置', extensions: ['json'] }] })
    .then(function (selected) {
      if (!selected) return; // 用户取消
      var filePath = Array.isArray(selected) ? selected[0] : selected;
      return fsApi.readTextFile(filePath).then(function (text) {
        var raw;
        try { raw = JSON.parse(text); }
        catch (e) { showToast(IMPORT_ERROR_MSG['not-object'], true); return; }
        var res = validateImportBundle(raw);
        if (!res.ok) { showToast(IMPORT_ERROR_MSG[res.code] || '文件无法导入', true); return; }
        openImportPreview(res.bundle);
      });
    })
    .catch(function () { showToast('读取文件失败，请把文件放到桌面/文档/下载目录后重试', true); });
}

function openImportPreview(bundle) {
  // 预览态可切换的选项（默认 合并 + 保留两份）
  var optState = { mode: 'merge', conflict: 'rename' };

  var html =
    '<div class="sm-head"><span class="sm-title">导入配置</span>' +
      '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button></div>' +
    '<div class="bk-body">' +
      '<div class="bk-summary" id="bkSummary"></div>' +
      '<div class="bk-group"><div class="bk-group-title">应用方式</div>' +
        '<label class="bk-radio"><input type="radio" name="bkMode" value="merge" checked /> ' +
          '<span>合并 —— 并入本机现有内容，保留你已有的</span></label>' +
        '<label class="bk-radio"><input type="radio" name="bkMode" value="replace" /> ' +
          '<span>覆盖 —— 用文件内容整体替换本机对应部分</span></label>' +
      '</div>' +
      '<div class="bk-group" id="bkConflictGroup"><div class="bk-group-title">遇到同名素材时</div>' +
        '<label class="bk-radio"><input type="radio" name="bkConflict" value="rename" checked /> ' +
          '<span>保留两份（导入项改名并存，不丢数据）</span></label>' +
        '<label class="bk-radio"><input type="radio" name="bkConflict" value="skip" /> ' +
          '<span>跳过（保留本机的）</span></label>' +
        '<label class="bk-radio"><input type="radio" name="bkConflict" value="overwrite" /> ' +
          '<span>覆盖（用导入的替换本机同名项）</span></label>' +
      '</div>' +
    '</div>' +
    '<div class="sm-foot bk-foot">' +
      '<button type="button" class="bk-btn bk-btn-primary" id="bkImportGo">' + icon('check') + '<span>确认导入</span></button>' +
    '</div>';

  var dlg = openDialog('导入配置', html);
  var overlay = dlg.overlay;
  var $summary = overlay.querySelector('#bkSummary');
  var $conflictGroup = overlay.querySelector('#bkConflictGroup');

  function renderSummary() {
    var sum = summarizeImport(state, bundle, { mode: optState.mode, conflict: optState.conflict, sections: bundle.includes });
    var parts = [];
    if (sum.materials) {
      var m = sum.materials;
      function line(label, c) {
        if (c.incoming === 0) return '';
        var conf = c.conflicts > 0 ? '（其中 ' + c.conflicts + ' 项与现有同名）' : '';
        return '<li>' + c.incoming + ' ' + label + conf + '</li>';
      }
      parts.push(line('个插入模块', m.modules));
      parts.push(line('条常用句', m.snippets));
      parts.push(line('个快速段落分组', m.quickGroups));
    }
    if (sum.preferences) parts.push('<li>偏好设置（不含 API Key，本机密钥保留）</li>');
    if (sum.content) parts.push('<li>正文草稿' + (optState.mode === 'merge' ? '（合并模式下保留本机正文）' : '') + '</li>');
    var body = parts.filter(Boolean).join('');
    $summary.innerHTML = '<div class="bk-summary-title">将导入：</div><ul class="bk-summary-list">' +
      (body || '<li>（无可导入项）</li>') + '</ul>';
    // 覆盖模式下同名策略无意义，禁用冲突分组
    var isReplace = optState.mode === 'replace';
    $conflictGroup.style.opacity = isReplace ? '0.45' : '';
    $conflictGroup.querySelectorAll('input').forEach(function (r) { r.disabled = isReplace; });
  }

  overlay.querySelectorAll('input[name="bkMode"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) { optState.mode = r.value; renderSummary(); } });
  });
  overlay.querySelectorAll('input[name="bkConflict"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) { optState.conflict = r.value; renderSummary(); } });
  });

  overlay.querySelector('#bkImportGo').addEventListener('click', function () {
    dlg.close();
    applyImported(bundle, { mode: optState.mode, conflict: optState.conflict, sections: bundle.includes });
  });

  renderSummary();
}

function applyImported(bundle, opts) {
  // 应用前把未收回的编辑并入 state，避免 renderAll 用旧内容覆盖用户刚敲的字
  if (view !== 'preview') { try { collectText(); } catch (e) { /* 无 DOM/预览态 */ } }

  var prevShortcut = state.settings.toggleShortcut;
  var merged = mergeState(state, bundle, opts);
  var next = normalizeState(merged);

  setState(next);        // 替换内存 state（内部再 normalize，幂等）
  scheduleSave();        // 落盘 + emit 广播浮窗（suppressBroadcast=false）
  renderAll();           // 本窗口重渲染

  // 应用 theme（不在 state，单独存 localStorage + documentElement）
  if (opts.sections.indexOf('preferences') !== -1 &&
      bundle.payload.preferences && typeof bundle.payload.preferences.theme === 'string') {
    applyTheme(bundle.payload.preferences.theme);
  }

  // 若快捷键变了，把新热键推到 Rust 侧（与启动路径一致）
  if (tauriAvailable() && state.settings.toggleShortcut !== prevShortcut) {
    try { applyStartupShortcut(); } catch (e) { /* 非 Tauri 或命令缺失 */ }
  }

  showToast('已导入配置（' + sectionsLabel(bundle.includes) + '）');
}

function applyTheme(theme) {
  var isLight = theme === 'light';
  if (isLight) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'dark');
  try { localStorage.setItem('composer-theme', isLight ? 'light' : 'dark'); } catch (e) { /* 存储不可用，主题仍已生效于当前会话 */ }
  // 导入偏好也可能改主题，广播给浮窗即时跟随（与 events.js themeToggle 同事件）
  var eventApi = window.__TAURI__ && window.__TAURI__.event;
  if (eventApi && eventApi.emit) {
    eventApi.emit('composer-theme-changed', { theme: isLight ? 'light' : 'dark' }).catch(function () {});
  }
}

/* ============================================================
 * 5. 配置文件位置：显示路径 + 在系统文件管理器里打开
 * ------------------------------------------------------------
 * 配置存在 AppData 目录（与程序目录分离，更新不影响）。这里让用户
 * 能直接看到路径、并一键打开该目录（选中 state 文件），方便手动备份。
 * path 是核心 API；打开目录用 opener 插件的 revealItemInDir。
 * ============================================================ */
var tauriPath = (window.__TAURI__ && window.__TAURI__.path) || null;
var tauriOpener = (window.__TAURI__ && window.__TAURI__.opener) || null;

// 返回 Promise<配置文件绝对路径字符串>；非 Tauri 或失败时 resolve(null)。
function getConfigFilePath() {
  if (!tauriPath || typeof tauriPath.appDataDir !== 'function') return Promise.resolve(null);
  return tauriPath.appDataDir()
    .then(function (dir) {
      if (tauriPath.join) return tauriPath.join(dir, STATE_FILE);
      // 兜底：手工拼接（appDataDir 通常不带尾分隔符）
      var sep = dir.indexOf('\\') !== -1 ? '\\' : '/';
      return dir.replace(/[\\/]$/, '') + sep + STATE_FILE;
    })
    .catch(function () { return null; });
}

// 在系统文件管理器里打开配置目录并选中 state 文件。
function openConfigFolder() {
  if (!tauriOpener || typeof tauriOpener.revealItemInDir !== 'function') {
    showToast('当前环境不支持打开文件夹', true);
    return;
  }
  getConfigFilePath().then(function (filePath) {
    if (!filePath) { showToast('无法定位配置文件位置', true); return; }
    // reveal 选中文件；若文件尚未落盘（首次未保存），退回打开其所在目录
    tauriOpener.revealItemInDir(filePath).catch(function () {
      if (tauriPath && tauriPath.appDataDir && tauriOpener.openPath) {
        return tauriPath.appDataDir().then(function (dir) { return tauriOpener.openPath(dir); });
      }
      throw new Error('reveal failed');
    }).catch(function () { showToast('打开文件夹失败', true); });
  });
}

export {
  openExportFlow,
  openImportFlow,
  getConfigFilePath,
  openConfigFolder,
};
