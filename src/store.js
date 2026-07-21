/* ============================================================
 * store.js —— 运行时状态 + 持久化 + 双向同步 + 基础 DOM/工具
 * ------------------------------------------------------------
 * 主窗口最底层模块：持有可变状态（state / view）、Tauri API 句柄、
 * DOM 引用、toast、块模型的正文回写与片段插入。纯逻辑从 core.js
 * import。渲染函数由 render.js 提供（运行时调用，ESM 循环依赖安全）。
 * ============================================================ */
import {
  INSERT_MODULES,
  MODULE_BY_ID,
  BUILTIN_SNIPPETS,
  BUILTIN_BY_ID,
  demoContent,
  defaultState,
  newSnippetId,
  newModuleId,
  newQuickGroupId,
  newQuickItemId,
  modulesToText,
  normalizeState,
  estimateTokens,
  escapeHtml,
  ICON_PATHS,
  icon,
  parseBlocks,
  createHistory,
} from './core.js';
import {
  renderBlocks,
  markLastBlockAsNew,
  refreshStat,
  autosize,
  onBlocksChanged,
} from './render.js';
import { renderAll, applyStartupShortcut } from './events.js';

  /* ============================================================
   * 0. Tauri API 安全获取（浏览器中预览时降级）
   * ============================================================ */
  var TAURI = window.__TAURI__ || null;
  var fsApi = TAURI && TAURI.fs;
  var dialogApi = TAURI && TAURI.dialog;
  var clipboardApi = TAURI && TAURI.clipboardManager;
  var updaterApi = TAURI && TAURI.updater;
  var processApi = TAURI && TAURI.process;
  var eventApi = TAURI && TAURI.event;
  var webviewWindowApi = TAURI && TAURI.webviewWindow;
  var coreApi = TAURI && TAURI.core;

  var BaseDirectory = fsApi && fsApi.BaseDirectory;
  var STATE_FILE = 'composer-state.json';
  function tauriAvailable() { return !!(TAURI && fsApi && BaseDirectory); }

  /* ============================================================
   * 1. 预设：可插入的模块片段 / 常用句 / 示例正文
   * ------------------------------------------------------------
   * 纯数据 / 纯函数已抽离到 core.js，此处通过 window.Composer 引用。
   * ============================================================ */

  /* ============================================================
   * 2. 状态 + 持久化
   * ============================================================ */
  var state = defaultState();
  var view = 'write'; // 'write' | 'preview'
  var saveTimer = null;
  var suppressBroadcast = false; // 收到浮窗广播触发的本地更新，不再二次广播（防回声循环）

  /* ============================================================
   * 2.1 结构级 Undo/Redo：历史栈实例 + 捕获/恢复接口
   * ------------------------------------------------------------
   * 栈只存在运行时内存（core.js 的 createHistory），不进 state、
   * 不进 persistState，重启即清空。捕获时机：每个结构操作“即将改变
   * state.content 之前”调 captureHistory()。撤销/重做走 doUndo/doRedo
   * （在 events.js 里接快捷键），恢复内容后由 applyContentSnapshot
   * 重渲染块视图并防抖保存。
   *
   * 语言切换语义：setLang 时调 history.reset() 清空两栈——快照只存
   * 当前语言单串，跨语言复用会把别的语言的快照写回当前语言导致串味，
   * 故切语言前先把“切换本身”入栈、切换后清空历史（详见 events.js）。
   * ============================================================ */
  var history = createHistory(50);

  // 结构操作前：把“改动前”的当前语言 content 推入撤销栈。
  // 正常结构操作只改当前语言，存单语言即可；若将来某操作会改到非当前
  // 语言的内容，需另行捕获对应语言的快照（目前没有这类操作）。
  function captureHistory() {
    history.push(state.content[state.lang] || '');
  }

  // 撤销/重做后：用快照整体替换当前语言 content，重渲染块视图并防抖保存。
  // 走的是与其它结构操作一致的重渲染路径（由调用方传入 rerender 回调，
  // 避免 store 反向依赖 render/events 造成的调用时序问题）。
  function applyContentSnapshot(snapshot, rerender) {
    state.content[state.lang] = snapshot;
    if (typeof rerender === 'function') rerender();
    scheduleSave();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistState, 300);
  }

  var appDataEnsured = false;
  function ensureAppDataDir() {
    if (appDataEnsured || !fsApi.mkdir) return Promise.resolve();
    return fsApi.mkdir('.', { baseDir: BaseDirectory.AppData, recursive: true })
      .then(function () { appDataEnsured = true; })
      .catch(function () { appDataEnsured = true; });
  }

  function persistState() {
    if (!tauriAvailable()) return;
    var payload = JSON.stringify(state, null, 2);
    ensureAppDataDir().then(function () {
      return fsApi.writeTextFile(STATE_FILE, payload, { baseDir: BaseDirectory.AppData });
    }).then(function () {
      if (eventApi && eventApi.emit && !suppressBroadcast) {
        eventApi.emit('composer-state-changed', state).catch(function () {});
      }
    }).catch(function (err) { console.warn('持久化失败:', err); });
  }

  /* ---------- 实时双向同步：监听浮窗（或另一端）广播的 state ----------
   * 协议：任一窗口在 state 变更并防抖保存落盘后，emit 'composer-state-changed'
   * 事件，payload 为完整的最新 state。另一端 listen 到后以事件携带的 state
   * 为准整体替换本地内存 state 并重渲染——不去反过来读盘，避免与对端写盘竞态。
   *
   * 关键保护：若本窗口此刻正在编辑（焦点在某个输入框/文本域），立即整体替换 +
   * 重渲染会打断输入、丢失光标，且会用远端 state 冲掉本地尚未防抖保存的输入。
   * 因此正在编辑时不立即应用，而是把最新 payload 暂存到 pendingRemoteState，
   * 等本窗口失去输入焦点后再 flush 应用。这样只同步“没在编辑的那一端”。
   *
   * suppressBroadcast 确保远端更新触发的本地渲染不会再次广播，避免 A→B→A 回声。
   * ============================================================ */
  var pendingRemoteState = null;

  function isEditingLocally() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function applyRemoteState(payload) {
    suppressBroadcast = true;
    state = normalizeState(payload);
    renderAll();
    suppressBroadcast = false;
  }

  function flushPendingRemoteState() {
    if (pendingRemoteState && !isEditingLocally()) {
      var payload = pendingRemoteState;
      pendingRemoteState = null;
      applyRemoteState(payload);
    }
  }

  if (eventApi && eventApi.listen) {
    eventApi.listen('composer-state-changed', function (evt) {
      var payload = evt && evt.payload;
      if (!payload || typeof payload !== 'object') return;
      if (isEditingLocally()) {
        // 正在编辑：暂存最新一份，待失焦后应用（后到的覆盖先到的，只保留最新）
        pendingRemoteState = payload;
        return;
      }
      applyRemoteState(payload);
    }).catch(function () {});
    // 失焦后把暂存的远端 state flush 掉；用捕获阶段确保 activeElement 已更新
    document.addEventListener('focusout', function () {
      // focusout 触发时 activeElement 可能尚未切换，延到下一微/宏任务再判断
      setTimeout(flushPendingRemoteState, 0);
    });
  }

  function restoreState() {
    if (!tauriAvailable()) { renderAll(); return; }
    fsApi.exists(STATE_FILE, { baseDir: BaseDirectory.AppData })
      .then(function (exists) {
        if (!exists) throw new Error('no-state-file');
        return fsApi.readTextFile(STATE_FILE, { baseDir: BaseDirectory.AppData });
      })
      .then(function (text) {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') state = normalizeState(parsed);
      })
      .catch(function () { state = defaultState(); })
      .then(function () {
        renderAll();
        // state 就绪后，把持久化的自定义热键应用到 Rust 侧。只有主窗口做这件事
        // （float.html 没有这段逻辑），避免两个窗口在启动时竞相注册同一个全局热键。
        applyStartupShortcut();
      });
  }

  // modulesToText / normalizeState：纯迁移逻辑已抽离到 core.js

  /* ============================================================
   * 3. token 估算（纯函数已抽离到 core.js）
   * ============================================================ */

  /* ============================================================
   * 4. DOM
   * ============================================================ */
  var $insertGrid = document.getElementById('insertGrid');
  var $snippetWrap = document.getElementById('snippetWrap');
  var $quickWrap = document.getElementById('quickWrap');
  var $langSegmented = document.getElementById('langSegmented');
  var $viewSeg = document.getElementById('viewSeg');
  var $etLabel = document.getElementById('etLabel');
  var $editorStat = document.getElementById('editorStat');
  var $blocks = document.getElementById('blocks');
  var $preview = document.getElementById('editorPreview');
  var $btnCopy = document.getElementById('btnCopy');
  var $btnDownload = document.getElementById('btnDownload');
  var $btnClearAll = document.getElementById('btnClearAll');
  var $toast = document.getElementById('toast');

  /* ============================================================
   * 5. Toast
   * ============================================================ */
  var toastTimer = null;
  function showToast(msg, isErr) {
    $toast.textContent = msg;
    $toast.classList.toggle('err', !!isErr);
    $toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 1800);
  }

  // escapeHtml：纯函数已抽离到 core.js

  /* ============================================================
   * 5.1 Lucide 风格内联图标：统一图标来源，避免 emoji / 字符占位
   * 用法：icon('trash-2') 返回可直接塞进 innerHTML 的 SVG 字符串
   * ICON_PATHS / icon()：纯数据 / 纯函数已抽离到 core.js
   * ============================================================ */

  /* ============================================================
   * 6. 块模型：正文 ⇄ 块 的解析与回写
   * ------------------------------------------------------------
   * 真相源仍是 state.content[lang] 大文本。块只是视图：
   *   parseBlocks(text) 把文本按 "## " 开头切成块（首个 ## 之前的
   *   内容作为一个无标题“前言块”）；编辑/拖拽后由 collectText() 从
   *   DOM 顺序收集各块文本并以空行拼回，写入 state。
   * parseBlocks 纯函数已抽离到 core.js。
   * ============================================================ */

  // 从 DOM 中所有块 textarea 收集文本，拼成正文并写回 state。
  function collectText() {
    var areas = $blocks.querySelectorAll('.block-textarea');
    var parts = [];
    areas.forEach(function (a) {
      var v = a.value.replace(/\s+$/, ''); // 去块尾多余空白，避免累积空行
      if (v !== '') parts.push(v);
    });
    var text = parts.join('\n\n');
    state.content[state.lang] = text;
    return text;
  }

  // 在当前聚焦块的光标处插入片段；无聚焦块则新建一个块（追加到末尾）。
  function insertSnippet(snippet) {
    var active = document.activeElement;
    var isBlockArea = active && active.classList && active.classList.contains('block-textarea');
    var isModuleTemplate = snippet.slice(0, 2) === '##';

    if (isBlockArea && !isModuleTemplate) {
      // 短句：插入到当前块光标处
      var el = active;
      var start = el.selectionStart, end = el.selectionEnd;
      var before = el.value.slice(0, start);
      var pre = (before.length > 0 && !before.endsWith('\n')) ? '\n' : '';
      var insertText = pre + snippet;
      el.value = before + insertText + el.value.slice(end);
      var caret = before.length + insertText.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      autosize(el);
      onBlocksChanged();
    } else {
      // 模块模板，或未聚焦任何块：作为新块追加
      var text = collectText();
      captureHistory(); // 结构操作（新建块）：改动前存旧快照
      var joined = text ? (text + '\n\n' + snippet) : snippet;
      state.content[state.lang] = joined;
      renderBlocks();
      markLastBlockAsNew();
      refreshStat();
      scheduleSave();
      // 聚焦新块末尾
      var areas = $blocks.querySelectorAll('.block-textarea');
      var last = areas[areas.length - 1];
      if (last) { last.focus(); last.setSelectionRange(last.value.length, last.value.length); }
    }
  }

  // view 是可变的模块级绑定；跨模块（events.js）需要修改时走此 setter，
  // 避免 ESM 里从外部直接给 import 的绑定赋值（不被允许）。
  function setViewValue(v) { view = v; }

  export {
    // Tauri 句柄与环境
    TAURI, fsApi, dialogApi, clipboardApi, updaterApi, processApi,
    eventApi, webviewWindowApi, coreApi, BaseDirectory, STATE_FILE, tauriAvailable,
    // 可变状态
    state, view, setViewValue,
    // 持久化 / 同步
    scheduleSave, persistState, restoreState,
    isEditingLocally, applyRemoteState, flushPendingRemoteState,
    // 结构级 Undo/Redo
    history, captureHistory, applyContentSnapshot,
    // DOM 引用
    $insertGrid, $snippetWrap, $quickWrap, $langSegmented, $viewSeg,
    $etLabel, $editorStat, $blocks, $preview,
    $btnCopy, $btnDownload, $btnClearAll, $toast,
    // 工具 / 块模型
    showToast, collectText, insertSnippet,
    // 从 core 透传（供下游模块复用，避免各处重复 import 同一批）
    INSERT_MODULES, MODULE_BY_ID, BUILTIN_SNIPPETS, BUILTIN_BY_ID,
    demoContent, defaultState, newSnippetId, newModuleId,
    newQuickGroupId, newQuickItemId, modulesToText, normalizeState,
    estimateTokens, escapeHtml, ICON_PATHS, icon, parseBlocks,
  };
