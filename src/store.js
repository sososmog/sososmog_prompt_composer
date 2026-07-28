/* ============================================================
 * store.js —— 运行时状态 + 持久化 + 双向同步 + 基础 DOM/工具
 * ------------------------------------------------------------
 * 主窗口最底层模块：持有可变状态（state / view）、Tauri API 句柄、
 * DOM 引用、toast、块模型的正文回写与片段插入。纯逻辑从 core.js
 * import。渲染函数由 render.js 提供（运行时调用，ESM 循环依赖安全）。
 *
 * 本文件与 events.js 是 ESM 循环依赖，但两边模块顶层都只有声明——
 * events.js 的事件绑定收在 bindEvents()、启动动作收在 bootstrap()，
 * 都由调用方显式触发。所以不存在"谁的顶层代码依赖谁的顶层变量"这种
 * 求值顺序耦合，两个文件按任意顺序 import 都不会出错
 * （moduleGraph.test.js 钉住了这一点）。
 * ============================================================ */
import {
  INSERT_MODULES,
  BUILTIN_SNIPPETS,
  demoContent,
  defaultState,
  normalizeState,
  estimateTokens,
  parseBlocks,
  createHistory,
  learnedFragmentsForManage,
  blockLearnedFragment,
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
import { STATE_FILE, readState } from './statefile.js';
import { insertTextAtCaret } from './edit.js';
import { completionEnabled as poolCompletionEnabled, completionPool as poolCompletionPool, commitLearningText } from './pool.js';
import { createStateSync } from './sync.js';

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
  // STATE_FILE 由 statefile.js 统一定义（正档 / .tmp / 坏档备份三个名字在一处）
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

  /* ============================================================
   * 2.1 结构级 Undo/Redo：历史栈实例 + 捕获/恢复接口
   * ------------------------------------------------------------
   * 栈只存在运行时内存（core.js 的 createHistory），不进 state、
   * 不落盘持久化，重启即清空。捕获时机：每个结构操作“即将改变
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

  /* ---------- 持久化 + 双向同步：委托给 sync.js ----------
   * 防抖写盘 / emit-listen 广播 / 回声过滤 / 正在编辑时暂存远端更新，这套逻辑
   * 主窗口与浮窗此前各写一份、容易漂移（sync.js 头部注释记录了已修的时序 bug）。
   * 现在两边共用 createStateSync 工厂，这里只负责注入本窗口的依赖：
   * fs 句柄、getState/setState 读写本模块的 state 变量、onApply 触发 renderAll、
   * isEditing 判断是否正在编辑、onStatus/onError 对接下面的保存状态广播与 toast。
   * ============================================================ */
  function isEditingLocally() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  // 本地主动整体替换内存 state（如配置导入、sync 应用远端更新）。
  // 与远端应用的区别在调用方：backup.js 直接调用时不置 suppressBroadcast——
  // 导入是本窗口发起的变更，落盘后应正常 emit('composer-state-changed')
  // 把新 state 广播给浮窗；调用方需自行 scheduleSave() + renderAll()。
  // sync.js 内部调用（应用远端广播）时，suppressBroadcast 由 sync.js 自己
  // 在调用前后置位，本函数不用关心。
  function setState(nextRaw) {
    state = normalizeState(nextRaw);
  }

  // emitSaveStatus('error') 唯一的消费者是 events.js 的 refreshFootHint，而它只在设置面板
  // 停在“管理”类 tab 时才把文案显示出来——平时写盘失败（磁盘满/权限/文件被占用）用户完全
  // 看不到，会误以为已经保存。这个标记只用来防刷屏：同一轮连续失败（每 300ms 防抖重试一次）
  // 只弹一次 toast，成功一次后复位，下次再失败还能再弹。
  var lastPersistFailed = false;

  var sync = createStateSync({
    fs: fsApi,
    baseDir: BaseDirectory && BaseDirectory.AppData,
    eventApi: eventApi,
    getState: function () { return state; },
    setState: setState,
    // 包一层而不是直接传 renderAll：renderAll 来自 events.js，与本模块是 ESM
    // 循环依赖。虽然函数声明在链接阶段就已初始化、直接传值目前也能拿到，但
    // 「求值时刻取到的那个值」这种依赖过于隐晦；惰性调用与其它循环依赖处
    // （applyContentSnapshot 收 rerender 回调）的做法保持一致。
    onApply: function () { renderAll(); },
    isEditing: isEditingLocally,
    onStatus: function (status) {
      if (status === 'saved') lastPersistFailed = false; // 写盘恢复正常，下次再失败可以再次提醒
      emitSaveStatus(status);
    },
    onError: function (err) {
      console.warn('持久化失败:', err);
      emitSaveStatus('error');
      // 只在“从非 error 转入 error”这一刻弹一次；连续失败不会每 300ms 刷一条 toast。
      if (!lastPersistFailed) {
        lastPersistFailed = true;
        showToast('保存失败，改动可能丢失。请检查磁盘空间或配置文件是否被占用', true);
      }
    },
  });
  sync.start();

  function scheduleSave() { sync.scheduleSave(); }
  // 主动丢弃暂存的远端 state（本地正在发起编辑时调用，如 insertSnippet）。
  function discardPendingRemoteState() { sync.discardPending(); }

  // 返回 Promise，state 就绪并首次 renderAll 完成后 resolve；
  // events.js 据此在正确时机触发新手引导（此时演示数据卡片已渲染）。
  function restoreState() {
    if (!tauriAvailable()) { renderAll(); return Promise.resolve(); }
    return readState(fsApi, BaseDirectory.AppData)
      .then(function (res) {
        if (res.status === 'ok' || res.status === 'recovered') {
          state = normalizeState(res.data);
        } else {
          state = defaultState();
        }
        // 存档异常必须让用户知道：以前这里是静默 defaultState()，用户下一次编辑
        // 就把默认值写回正档、原数据彻底消失还毫无提示。延后一拍再弹，等首帧
        // renderAll 之后 toast 才不会被启动渲染盖掉。
        if (res.status === 'recovered') {
          setTimeout(function () {
            showToast('上次退出时存档未写完，已从临时文件恢复' + (res.backup ? '（坏档已备份为 ' + res.backup + '）' : ''), true);
          }, 400);
        } else if (res.status === 'corrupt') {
          setTimeout(function () {
            showToast(res.backup
              ? '存档文件已损坏，已备份为 ' + res.backup + '，本次以默认配置启动'
              : '存档文件已损坏且无法备份，本次以默认配置启动', true);
          }, 400);
        }
      })
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
    // 上面 createStateSync 的 onError 回调定义在本文件更靠前的位置且调用了
    // showToast——函数声明整体提升，运行期没问题（onError 只会在真正发生写盘
    // 失败时才被调用，那时 $toast 早已取到）。这里仍加一层兜底：万一将来有
    // 模块加载阶段就调用 showToast 的路径，避免直接抛错。
    if (!$toast) return;
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

  /* 从 DOM 中所有块 textarea 收集文本，拼成正文并写回 state。
   *
   * 「块 → 文本」这一步是**刻意做归一化的**，不是无损还原，契约如下
   *（有测试钉住，见 blockRoundTrip.test.js —— 改动这里会让那些用例失败，
   *  这是有意的提醒，不是误报）：
   *   1. 每块去掉尾部空白；
   *   2. 块之间一律用恰好一个空行（'\n\n'）连接；
   *   3. 整块全是空白的块被丢弃。
   * 于是：段落间原本有 3 个空行会被压成 1 个，原本只用单换行分隔的两个
   * "## 标题" 之间会多出一个空行。
   *
   * 为什么不做无损保留（试过，结论是得不偿失）：parseBlocks 把「块之间的
   * 空行」归属到**前一块的尾部**，也就是说间距是跟着「位置」而不是跟着
   * 「块本身」的。若为了保真而让每块带上自己的尾部空行，拖拽排序后这些
   * 空行会跟着块一起搬走 —— 把 A(后面有空行) B(后面没有) 换成 B A，结果
   * 是 B 和 A 之间没有空行、而文档末尾多出一个空行，段落间距肉眼错乱。
   * 相比之下「段落间距恒为一个空行」是可预期的、也符合这个工具的用途
   * （产出提示词），并且天然避免了「渲染→回写」反复循环时空行不断累积。
   *
   * 真正会篡改内容的那个 bug（不认 ``` 围栏、把代码块拦腰切成两块并往围栏里
   * 插空行）已单独修掉，见 core.js 的 parseBlocks —— 围栏内的文本现在整块
   * 落在同一个 textarea 里，上面的规则 1 只作用于块的最末尾，不会伸进围栏。
   */
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
    // 旧更新都已过时）。否则失焦时 sync.js 的 flushPending 会用它 renderAll，
    // 覆盖掉这次插入——表现为“插了却跳走、像没插入、要再点一次”。插入后本窗口
    // 自己会 scheduleSave 广播最新态，浮窗照常同步，方向正确。
    discardPendingRemoteState();

    var active = document.activeElement;
    var isBlockArea = active && active.classList && active.classList.contains('block-textarea');
    var isModuleTemplate = snippet.slice(0, 2) === '##';

    if (isBlockArea && !isModuleTemplate) {
      // 短句：插入到当前块光标处
      var el = active;
      var before = el.value.slice(0, el.selectionStart);
      var pre = (before.length > 0 && !before.endsWith('\n')) ? '\n' : '';

      // 先把 DOM 里的现值收回 state 再入栈，快照才是"插入之前"的完整内容。
      // 以前这条路径完全不入栈，而程序化改 value 又会清空原生撤销栈，导致
      // 「点常用句插入」既没有结构级撤销、也没有原生撤销 —— 彻底撤不回来。
      collectText();
      captureHistory();

      // insertTextAtCaret 优先走 execCommand('insertText')：插入会进入原生撤销栈，
      // 且由浏览器自行派发 input。降级路径直接改 value，需要我们手动派发 ——
      // 块的高亮 overlay / 自适应高度 / 内容回写全挂在 input handler 上
      // （见 render.js buildBlockCard），不派发的话新插入的字会因 overlay 未重画
      // 而"隐形"（透明 textarea 上没上色，仅选中态可见）。
      var mode = insertTextAtCaret(el, pre + snippet);
      if (mode !== 'native') el.dispatchEvent(new Event('input', { bubbles: true }));
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
   * ============================================================ */
  // 候选池合成（快速段落 / 常用句含内置+自定义 / 已提炼 learned 片段摊平成
  // [{ key, text, source }]、key 统一用 learnKey 归一化）已抽到 pool.js，
  // 与浮窗共用；这里的两个函数是薄包装，只负责把 state 传进去。
  function completionEnabled() { return poolCompletionEnabled(state); }

  function completionPool() { return poolCompletionPool(state); }

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
  // 达阈值自动提炼。由 events.js 的 doCopy/doDownload 调用。commitLearningText
  // （pool.js）总开关关闭时原样返回入参 learning，据此判断是否需要保存。
  function commitLearningFromText(text) {
    var next = commitLearningText(state, text);
    if (next === state.learning) return;
    state.learning = next;
    scheduleSave();
  }

  /* ============================================================
   * 2.0.2 自学习数据管理（设置面板「自学习」tab 用）
   * ============================================================ */
  // 片段管理列表：两种语言各取一次再合并，按最近使用时间降序（跨语言统一排）。
  // 管理列表固定用 clause 粒度（不随 segMode 变 word）：给用户看/删的是「学到的短语」，
  // word 模式的词级后缀是机器内部的接续起点，逐条管理无意义。
  function getLearnedFragmentsForManage() {
    var zh = learnedFragmentsForManage(state.learning, 'zh', { mode: 'clause' });
    var en = learnedFragmentsForManage(state.learning, 'en', { mode: 'clause' });
    return zh.concat(en).sort(function (a, b) { return b.lastUsedAt - a.lastUsedAt; });
  }

  function blockLearnedFragmentByKey(key) {
    state.learning = blockLearnedFragment(state.learning, key);
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
    fsApi, dialogApi, clipboardApi, updaterApi, processApi,
    eventApi, webviewWindowApi, coreApi, STATE_FILE, tauriAvailable,
    // 可变状态
    state, view, setViewValue,
    // 持久化 / 同步
    scheduleSave, restoreState, onSaveStatus, setState,
    // 结构级 Undo/Redo
    history, captureHistory, applyContentSnapshot,
    // DOM 引用
    $insertGrid, $snippetWrap, $quickWrap, $langSegmented, $viewSeg,
    $etLabel, $editorStat, $blocks, $preview,
    $btnCopy, $btnDownload, $btnClearAll,
    // 工具 / 块模型
    showToast, collectText, insertSnippet, preserveBlockFocus,
    // 行内补全（v0.2）
    completionPool, makeCompletionDeps, commitLearningFromText, completionEnabled,
    // 自学习数据管理（设置面板用）
    getLearnedFragmentsForManage, blockLearnedFragmentByKey, clearAllLearning,
    exportLearningBundle, importLearningBundle,
    // 从 core 透传（供下游模块复用，避免各处重复 import 同一批）
    INSERT_MODULES, BUILTIN_SNIPPETS,
    demoContent, defaultState,
    normalizeState, estimateTokens, parseBlocks,
  };
