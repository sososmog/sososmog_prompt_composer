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
  learn,
  learnedSnippets,
  learnedSnippetsForManage,
  removeLearnedSnippet,
  clearLearning,
  buildLearningExportBundle,
  validateLearningImportBundle,
  mergeLearningImport,
} from './core.js';
import {
  renderBlocks,
  markLastBlockAsNew,
  refreshStat,
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
  // Tauri 的 emit 会把事件回送给发送方自己。本窗口不该被自己刚保存的广播
  // 反过来打断（尤其正在编辑时会暂存进 pendingRemoteState，失焦时 flush 触发
  // 全量 renderAll，恰好打断“插入模块后紧接着的第二次插入”）。记住最近若干条
  // 自己广播出去的 payload 序列化，listen 收到内容命中的即判为自我回声、跳过。
  // 用队列而非单值：回声到达时机不定，两次连续保存会让单值被后者覆盖、漏过滤。
  var recentBroadcasts = [];
  var RECENT_BROADCAST_MAX = 6;

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

  // 保存状态订阅：设置面板据此显示“保存中… / 已保存”。
  // status 取值：'saving'（已排期尚未落盘）| 'saved'（已写盘）| 'error'（写盘失败）。
  var saveListeners = [];
  function onSaveStatus(fn) {
    if (typeof fn === 'function') saveListeners.push(fn);
    return function () {
      var i = saveListeners.indexOf(fn);
      if (i >= 0) saveListeners.splice(i, 1);
    };
  }
  function emitSaveStatus(status) {
    for (var i = 0; i < saveListeners.length; i++) {
      try { saveListeners[i](status); } catch (e) { /* 监听器自身异常不影响保存 */ }
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    emitSaveStatus('saving');
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
    // 非 Tauri（浏览器预览）无盘可写，直接视作“已保存”以免状态字卡在“保存中…”。
    if (!tauriAvailable()) { emitSaveStatus('saved'); return; }
    var payload = JSON.stringify(state, null, 2);
    ensureAppDataDir().then(function () {
      return fsApi.writeTextFile(STATE_FILE, payload, { baseDir: BaseDirectory.AppData });
    }).then(function () {
      if (eventApi && eventApi.emit && !suppressBroadcast) {
        // 记录本次广播指纹，供 listen 端滤掉自我回声
        recentBroadcasts.push(payload);
        if (recentBroadcasts.length > RECENT_BROADCAST_MAX) recentBroadcasts.shift();
        eventApi.emit('composer-state-changed', state).catch(function () {});
      }
      emitSaveStatus('saved');
    }).catch(function (err) { console.warn('持久化失败:', err); emitSaveStatus('error'); });
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

  // 本地主动整体替换内存 state（如配置导入）。与 applyRemoteState 的区别：
  // 不置 suppressBroadcast——导入是本窗口发起的变更，落盘后应正常
  // emit('composer-state-changed') 把新 state 广播给浮窗。调用方拿到后需自行
  // scheduleSave()（触发写盘+广播）和 renderAll()（本窗口重渲染）。
  function setState(nextRaw) {
    state = normalizeState(nextRaw);
  }

  function flushPendingRemoteState() {
    if (pendingRemoteState && !isEditingLocally()) {
      var payload = pendingRemoteState;
      pendingRemoteState = null;
      applyRemoteState(payload);
    }
  }

  // 主动丢弃暂存的远端 state（本地正在发起编辑时调用）。
  function discardPendingRemoteState() { pendingRemoteState = null; }

  if (eventApi && eventApi.listen) {
    eventApi.listen('composer-state-changed', function (evt) {
      var payload = evt && evt.payload;
      if (!payload || typeof payload !== 'object') return;
      // 过滤自我回声：命中本窗口近期广播过的任一指纹即忽略（是自己发的，本地
      // state 已经是它，无需再 apply，更不能在编辑中暂存后打断后续操作）。
      var fp = JSON.stringify(payload, null, 2);
      var hitIdx = recentBroadcasts.indexOf(fp);
      if (hitIdx !== -1) {
        recentBroadcasts.splice(hitIdx, 1); // 消费掉，避免误吃后续同内容的真实更新
        return;
      }
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

  // 返回 Promise，state 就绪并首次 renderAll 完成后 resolve；
  // events.js 据此在正确时机触发新手引导（此时演示数据卡片已渲染）。
  function restoreState() {
    if (!tauriAvailable()) { renderAll(); return Promise.resolve(); }
    return fsApi.exists(STATE_FILE, { baseDir: BaseDirectory.AppData })
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
    // 用户正在主动插入内容：丢弃任何尚未 apply 的远端 state（自我回声或浮窗的
    // 旧更新都已过时）。否则失焦时 flushPendingRemoteState 会用它 renderAll，
    // 覆盖掉这次插入——表现为“插了却跳走、像没插入、要再点一次”。插入后本窗口
    // 自己会 scheduleSave 广播最新态，浮窗照常同步，方向正确。
    discardPendingRemoteState();

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
      // 直接改 textarea.value 不会触发 input 事件，而块的高亮 overlay / 自适应
      // 高度 / 内容回写都挂在 input handler 上（见 render.js buildBlockCard）。
      // 派发一次 input 让那套逻辑跑起来，否则新插入文字因 overlay 未重画而“隐形”
      // （透明 textarea 上没上色，仅选中态可见）。
      el.dispatchEvent(new Event('input', { bubbles: true }));
      scrollBlockIntoView(el);
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
      scrollBlockIntoView(last);
    }
  }

  // 把某个块 textarea 所在的块卡片滚进视口。
  // 延到下一帧再滚：此前刚发生 focus()/setSelectionRange()（浏览器可能已
  // 自行滚过一次）、autosize 改块高、新块入场动画改布局——若同步滚，读到的
  // 是尚未稳定的旧布局，视觉上像“没生效”。rAF 后布局落定，再显式滚动。
  // block:'nearest'：已完整可见就不动，被裁到视口外才平滑滚出，避免乱跳。
  function scrollBlockIntoView(area) {
    if (!area || typeof area.closest !== 'function') return;
    var card = area.closest('.block') || area;
    if (typeof card.scrollIntoView !== 'function') return;
    var raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame : function (fn) { return setTimeout(fn, 0); };
    raf(function () {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // 给「点击后要往当前编辑块插入内容」的触发元素（左栏常用句 pill、快速段落
  // 按钮等）挂上防夺焦：mousedown 默认行为会把焦点从块 textarea 移到被点元素，
  // 导致 insertSnippet 里 document.activeElement 不再是块、短句被迫走“新建块”
  // 而非“插到光标处”。在 mousedown 阶段 preventDefault 即可保住原焦点，
  // 同时不影响 click 事件照常触发。仅当原焦点确实在某个块 textarea 时才拦，
  // 避免影响其它正常点击聚焦。
  function preserveBlockFocus(el) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener('mousedown', function (e) {
      var a = document.activeElement;
      if (a && a.classList && a.classList.contains('block-textarea')) {
        e.preventDefault();
      }
    });
  }

  // view 是可变的模块级绑定；跨模块（events.js）需要修改时走此 setter，
  // 避免 ESM 里从外部直接给 import 的绑定赋值（不被允许）。
  function setViewValue(v) { view = v; }

  /* ============================================================
   * 2.5 行内补全：候选池合成 + 学习数据读写（供 completion.js 注入）
   * ------------------------------------------------------------
   * 把三处素材（快速段落 / 常用句含内置+自定义 / 已提炼 learned 片段）
   * 按当前语言摊平成 [{ key, text, source }] 候选池。key 带语言前缀
   * （learnKey 同款：'zh'/'en' +  + 文本），与学习数据的 key 一致，
   * 保证 shown/accepted/bigram 能正确对上号。
   * ============================================================ */
  function completionEnabled() {
    return !!(state.settings && state.settings.completion && state.settings.completion.enabled);
  }

  function completionPool() {
    if (!completionEnabled()) return []; // 总开关关闭：不展示候选，也就不会再产生新的 shown/accepted 记账
    var lang = state.lang;
    var pfx = (lang === 'en' ? 'en' : 'zh') + '';
    var seen = {};
    var pool = [];
    // explicitKey：learned 片段传入其归一化学习 key（与 L.snippets 里的统计
    // key 一致），使 scoreCandidate / learn('shown'|'accepted') 能对上历史账。
    // preset 不传，仍按原文重算 key（preset 全程用原文 key，自洽）。
    function add(text, source, explicitKey) {
      if (typeof text !== 'string') return;
      var t = text;
      if (t.trim() === '') return;
      var key = explicitKey != null ? explicitKey : pfx + t;
      if (seen[key]) return;
      seen[key] = true;
      pool.push({ key: key, text: t, source: source });
    }
    // 快速段落
    (state.quickGroups || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        var tx = it.text || {};
        add(tx[lang] || tx.zh || tx.en, 'preset');
      });
    });
    // 常用句：内置（含 patch 后的当前值）+ 自定义
    BUILTIN_SNIPPETS.forEach(function (b) {
      var p = (state.builtinPatches && state.builtinPatches[b.id]) || {};
      if (p.hidden) return;
      add((p[lang] !== undefined ? p[lang] : b[lang]) || b.zh || b.en, 'preset');
    });
    (state.customSnippets || []).forEach(function (c) {
      if (c.hidden) return;
      add(c[lang] || c.zh || c.en, 'preset');
    });
    // 自学习提炼出的 learned 片段
    learnedSnippets(state.learning, lang).forEach(function (s) { add(s.text, 'learned', s.key); });
    return pool;
  }

  // 给 completion.js 用的依赖对象：读候选池 / 读写学习数据 / 读当前语言 /
  // 复用 render 的高亮重绘（由调用方在 render.js 里注入，避免 store→render 循环）。
  function makeCompletionDeps(renderHighlight) {
    return {
      getPool: completionPool,
      getLearning: function () { return state.learning; },
      onLearn: function (next) { state.learning = next; scheduleSave(); },
      getLang: function () { return state.lang; },
      renderHighlight: renderHighlight
    };
  }

  // 用户“完整用过一句”（复制/下载正文）时喂给学习引擎，累计 rawCounts、
  // 达阈值自动提炼。由 events.js 的 doCopy/doDownload 调用。
  function commitLearningFromText(text) {
    if (!completionEnabled()) return; // 总开关关闭：不再记账
    var lines = String(text == null ? '' : text).split('\n');
    state.learning = learn('commit', { lang: state.lang, lines: lines }, state.learning);
    scheduleSave();
  }

  /* ============================================================
   * 2.0.2 自学习数据管理（设置面板「自学习」tab 用）
   * ============================================================ */
  function getLearnedSnippetsForManage() {
    return learnedSnippetsForManage(state.learning);
  }

  function removeLearnedSnippetByKey(key) {
    state.learning = removeLearnedSnippet(state.learning, key);
    scheduleSave();
  }

  function clearAllLearning() {
    state.learning = clearLearning();
    scheduleSave();
  }

  function exportLearningBundle() {
    return buildLearningExportBundle(state.learning);
  }

  // 校验 + 合并导入的自学习数据；返回 { ok, code? , importedCount? }
  function importLearningBundle(raw) {
    var res = validateLearningImportBundle(raw);
    if (!res.ok) return res;
    var merged = mergeLearningImport(state.learning, raw);
    state.learning = merged.learning;
    scheduleSave();
    return { ok: true, importedCount: merged.importedCount };
  }

  export {
    // Tauri 句柄与环境
    TAURI, fsApi, dialogApi, clipboardApi, updaterApi, processApi,
    eventApi, webviewWindowApi, coreApi, BaseDirectory, STATE_FILE, tauriAvailable,
    // 可变状态
    state, view, setViewValue,
    // 持久化 / 同步
    scheduleSave, persistState, restoreState, onSaveStatus,
    isEditingLocally, applyRemoteState, flushPendingRemoteState, setState,
    // 结构级 Undo/Redo
    history, captureHistory, applyContentSnapshot,
    // DOM 引用
    $insertGrid, $snippetWrap, $quickWrap, $langSegmented, $viewSeg,
    $etLabel, $editorStat, $blocks, $preview,
    $btnCopy, $btnDownload, $btnClearAll, $toast,
    // 工具 / 块模型
    showToast, collectText, insertSnippet, preserveBlockFocus,
    // 行内补全（v0.2）
    completionPool, makeCompletionDeps, commitLearningFromText, completionEnabled,
    // 自学习数据管理（设置面板用）
    getLearnedSnippetsForManage, removeLearnedSnippetByKey, clearAllLearning,
    exportLearningBundle, importLearningBundle,
    // 从 core 透传（供下游模块复用，避免各处重复 import 同一批）
    INSERT_MODULES, MODULE_BY_ID, BUILTIN_SNIPPETS, BUILTIN_BY_ID,
    demoContent, defaultState, newSnippetId, newModuleId,
    newQuickGroupId, newQuickItemId, modulesToText, normalizeState,
    estimateTokens, escapeHtml, ICON_PATHS, icon, parseBlocks,
  };
