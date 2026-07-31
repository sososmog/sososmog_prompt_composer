/* ============================================================
 * float.js —— 浮窗交互逻辑
 * ------------------------------------------------------------
 * 从 float.html 内联的 <script type="module"> 搬出来（原来整块 660 行
 * 藏在 html 里，eslint.config.js 完全扫不到，是候选池 key 与主窗口
 * 悄悄漂移一直没被发现的原因之一——见 pool.js 头部注释）。
 *
 * 浮窗不是完整主窗口：没有块编辑器/预览/设置面板，只有一个单文本框
 * + 插入模块/常用句/快速段落三个只读展示列表（点击即复制/粘贴）。
 * 因此它不 import store.js/render.js/events.js（那一整套是主窗口专属
 * 的 DOM 结构），而是与主窗口一起共用 core.js（纯数据/纯函数）、
 * materials.js（素材解析）、pool.js（候选池合成）、sync.js（持久化+
 * 双向同步）、statefile.js（原子写/容错读）、completion.js（补全交互
 * 层）、edit.js 这些不依赖具体 DOM 结构的模块。
 * ============================================================ */
import {
  defaultState,
  normalizeState,
  escapeHtml,
} from './core.js';
import {
  resolveModule as materialsResolveModule,
  resolveSnippet as materialsResolveSnippet,
} from './materials.js';
import { completionPool, commitLearningText } from './pool.js';
import { createStateSync } from './sync.js';
import { attachCompletion } from './completion.js';
import { readState } from './statefile.js';
import { createFleetView } from './fleetView.js';

  /* ============================================================
   * Tauri API 安全获取（浏览器预览时降级，不报错）
   * ============================================================ */
  var TAURI = window.__TAURI__ || null;
  var fsApi = TAURI && TAURI.fs;
  var clipboardApi = TAURI && TAURI.clipboardManager;
  var eventApi = TAURI && TAURI.event;
  var webviewWindowApi = TAURI && TAURI.webviewWindow;
  var coreApi = TAURI && TAURI.core;
  var BaseDirectory = fsApi && fsApi.BaseDirectory;
  function tauriAvailable() { return !!(TAURI && fsApi && BaseDirectory); }

  var currentWin = null;
  if (webviewWindowApi && webviewWindowApi.getCurrentWebviewWindow) {
    try { currentWin = webviewWindowApi.getCurrentWebviewWindow(); } catch (e) { currentWin = null; }
  }

  /* ============================================================
   * 状态：与主窗口共享同一份 composer-state.json，
   * 通过 'composer-state-changed' 事件广播实现实时双向同步。
   * ============================================================ */
  var state = defaultState();

  var $textarea = document.getElementById('fwTextarea');
  var $hlOverlay = document.getElementById('fwHlOverlay');
  var $editorLabel = document.getElementById('fwEditorLabel');
  var $quickWrap = document.getElementById('fwQuickWrap');
  var $moduleWrap = document.getElementById('fwModuleWrap');
  var $snippetWrap = document.getElementById('fwSnippetWrap');
  var $copyBtn = document.getElementById('fwCopyBtn');
  var $clearBtn = document.getElementById('fwClearBtn');
  var $closeBtn = document.getElementById('fwCloseBtn');
  var $minBtn = document.getElementById('fwMinBtn');
  var $orb = document.getElementById('fwMiniOrb');
  var $orbDot = document.getElementById('fwMiniOrbDot');
  var $card = document.getElementById('fwCard');
  var $toast = document.getElementById('fwToast');
  var $autoPasteToggle = document.getElementById('fwAutoPasteToggle');
  var $tabComposeBtn = document.getElementById('fwTabComposeBtn');
  var $tabFleetBtn = document.getElementById('fwTabFleetBtn');
  var $tabFleetBadge = document.getElementById('fwTabFleetBadge');
  var $panelCompose = document.getElementById('fwPanelCompose');
  var $panelFleet = document.getElementById('fwPanelFleet');

  var toastTimer = null;
  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 1500);
  }

  /* ---------- 持久化 + 双向同步：委托给 sync.js（与主窗口 store.js 共用） ----------
   * 浮窗没有设置面板的"保存中…/已保存"状态字，也没有主窗口那套失败防刷屏 toast，
   * 故不传 onStatus；onError 只 console.warn（与浮窗此前的行为一致）。
   * ============================================================ */
  function isEditingLocally() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function setState(payload) { state = normalizeState(payload); }

  var sync = createStateSync({
    fs: fsApi,
    baseDir: BaseDirectory && BaseDirectory.AppData,
    eventApi: eventApi,
    getState: function () { return state; },
    setState: setState,
    onApply: function () { renderAll(); },
    isEditing: isEditingLocally,
    onError: function (err) { console.warn('浮窗持久化失败:', err); },
  });
  sync.start();

  function scheduleSave() { sync.scheduleSave(); }

  function restoreState() {
    if (!tauriAvailable()) { renderAll(); return; }
    readState(fsApi, BaseDirectory.AppData).then(function (res) {
      if (res.status === 'ok' || res.status === 'recovered') state = normalizeState(res.data);
      else state = defaultState();
      renderAll();
      // 坏档提示只由主窗口负责（它带备份文件名、文案更完整），浮窗仅在自己是
      // 唯一可见窗口时也给一句短提示，避免用户以为浮窗内容被无故清空。
      if (res.status === 'corrupt') showToast('存档已损坏，已按默认配置启动');
      else if (res.status === 'recovered') showToast('已从临时文件恢复上次存档');
    });
  }

  // 主题实时同步：主窗口切换主题（或导入偏好）时广播，浮窗即时跟随。
  // 与 state 的广播/回声过滤是两码事（sync.js 只管 composer-state-changed），
  // 这个事件单独监听。同时回写 localStorage，供浮窗下次重开时首帧取到正确主题。
  if (eventApi && eventApi.listen) {
    eventApi.listen('composer-theme-changed', function (evt) {
      var theme = evt && evt.payload && evt.payload.theme;
      var isLight = theme === 'light';
      if (isLight) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('composer-theme', isLight ? 'light' : 'dark'); } catch (e) { /* 存不了就算了，当次已生效 */ }
    }).catch(function () {});
  }

  /* ============================================================
   * 渲染：编辑器
   * ============================================================ */
  function renderEditor() {
    $editorLabel.textContent = state.lang === 'zh' ? '中文正文' : 'English 正文';
    if (document.activeElement !== $textarea) {
      $textarea.value = state.content[state.lang] || '';
    }
    syncOverlay();
  }

  $textarea.addEventListener('input', function () {
    state.content[state.lang] = $textarea.value;
    scheduleSave();
  });

  /* ============================================================
   * 2.5 行内补全（ghost text）：复用主窗口 completion.js 交互层。
   * ------------------------------------------------------------
   * 浮窗是单个不透明 textarea，没有主窗口那套透明 textarea + 高亮
   * overlay。为满足 completion.js「往 overlay 末尾追加灰字 ghost、
   * 靠 renderHighlight 重绘抹除」的契约，这里给 textarea 叠一层镜像
   * overlay：textarea 文字透明只留光标，overlay 显示正文文本。浮窗不
   * 需要 Markdown 高亮，renderHighlight 只把 overlay 内容整体重置为
   * 转义后的正文即可（必须整体重置，否则上次的 ghost span 抹不掉）。
   * 学习数据 state.learning 与主窗口共享同一份 composer-state.json。
   * ============================================================ */

  // overlay 与 textarea 像素对齐重绘：整体重置内容（抹掉上次 ghost）+ 同步滚动。
  // 这就是注入给 completion.js 的 renderHighlight —— 签名 (area, overlay) 一致。
  function renderHighlight(area, overlay) {
    overlay.textContent = area.value;
    overlay.scrollTop = area.scrollTop;
    overlay.scrollLeft = area.scrollLeft;
  }
  // 显式同步 overlay（远端同步后 renderEditor、清空、初始化时用）。日常打字的
  // 同步不在这里挂 input 监听——那会与 completion.js recompute 里的 renderHighlight
  // 抢着重置 overlay、把刚追加的 ghost span 抹掉；打字时的重绘完全交给 completion.js。
  // 这里只补 completion.js 不负责的滚动同步。
  function syncOverlay() { renderHighlight($textarea, $hlOverlay); }
  $textarea.addEventListener('scroll', syncOverlay);

  // 候选池合成（快速段落 / 常用句含内置+自定义 / learned 片段摊平成
  // [{ key, text, source }]、key 统一用 learnKey 归一化）已抽到 pool.js，
  // 与主窗口共用（修掉了两边 key 算法此前不同源的 bug，见该文件头部注释）。
  attachCompletion($textarea, $hlOverlay, {
    getPool: function () { return completionPool(state); },
    getLearning: function () { return state.learning; },
    onLearn: function (next) { state.learning = next; scheduleSave(); },
    getLang: function () { return state.lang; },
    renderHighlight: renderHighlight
  });

  /* ============================================================
   * 渲染：插入模块 / 常用句 列表（只读展示 + 点击复制）
   * ------------------------------------------------------------
   * 解析逻辑（内置 patch 合并 + 自定义查找）已抽到 materials.js，
   * 与主窗口 render.js 共用；此前浮窗这版返回的对象缺 builtin 字段，
   * 现在统一带上（多一个字段无害）。
   * ============================================================ */
  function resolveModule(id) { return materialsResolveModule(state, id); }
  function resolveSnippet(id) { return materialsResolveSnippet(state, id); }

  /* ============================================================
   * 自动粘贴开关：仅浮窗本地生效，存 localStorage，不写入
   * composer-state.json（主窗口没这个功能，别污染同步）。
   * ============================================================ */
  var AUTOPASTE_STORAGE_KEY = 'composer-fw-autopaste';
  var canAutoPaste = !!(coreApi && coreApi.invoke);
  // 新用户（从未存过该 key）默认开启；存过则尊重用户上次的选择（含手动关掉的 '0'）。
  var autoPasteEnabled = true;
  try {
    var savedAutoPaste = window.localStorage.getItem(AUTOPASTE_STORAGE_KEY);
    autoPasteEnabled = savedAutoPaste === null ? true : savedAutoPaste === '1';
  } catch (e) { autoPasteEnabled = true; }

  if ($autoPasteToggle) {
    if (!canAutoPaste) {
      // 非 Tauri 环境（浏览器预览）没有粘贴命令可调，开关禁用并保持关闭
      autoPasteEnabled = false;
      $autoPasteToggle.disabled = true;
    }
    $autoPasteToggle.checked = autoPasteEnabled;
    $autoPasteToggle.addEventListener('change', function () {
      autoPasteEnabled = $autoPasteToggle.checked;
      try { window.localStorage.setItem(AUTOPASTE_STORAGE_KEY, autoPasteEnabled ? '1' : '0'); } catch (e) { /* 存不了就算了，不影响当次使用 */ }
      // 刷新 pill 的提示文案（复制 / 复制并粘贴）
      renderModuleGrid();
      renderQuickGroups();
    });
  }

  function isAutoPasteOn() { return canAutoPaste && autoPasteEnabled; }

  function formatPasteError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return String(err); } catch (e) { return '未知错误'; }
  }

  /* 复制成功后的收尾：若开关打开且提供了 pasteMsg，则再尝试自动粘贴到外部窗口；
   * 否则（或粘贴失败）就只提示复制结果。粘贴失败时降级提示，不让异常往上抛。 */
  function afterCopySucceeded(doneMsg, pasteMsg) {
    if (pasteMsg && isAutoPasteOn()) {
      var delayMs = (state.settings && typeof state.settings.pasteDelayMs === 'number') ? state.settings.pasteDelayMs : 60;
      coreApi.invoke('paste_to_active_window', { delayMs: delayMs }).then(function () {
        showToast(pasteMsg);
      }).catch(function (err) {
        showToast(doneMsg + '（粘贴失败：' + formatPasteError(err) + '）');
      });
    } else {
      showToast(doneMsg);
    }
  }

  // 用户「完整用过一段文本」（复制正文 / 点击 pill 或快速段落复制粘贴）时喂给
  // 学习引擎累计 rawCounts、达阈值自动提炼。commitLearningText（pool.js）总
  // 开关关闭时原样返回入参 learning，据此判断是否需要保存。
  function commitLearningFromText(text) {
    var next = commitLearningText(state, text);
    if (next === state.learning) return;
    state.learning = next;
    scheduleSave();
  }

  /* pasteMsg 为可选参数：传了才会在自动粘贴开启时触发粘贴，
   * 编辑器工具栏的“复制”按钮不传，保持纯复制不变。
   * 所有复制/粘贴出口都汇聚到这里，故在此统一喂学习引擎 commit —— 覆盖
   * 复制按钮 + 插入模块 / 常用句 / 快速段落 pill（即「点击即粘贴」）双出口。 */
  function copyToClipboard(text, doneMsg, pasteMsg) {
    commitLearningFromText(text);
    if (clipboardApi && clipboardApi.writeText) {
      clipboardApi.writeText(text).then(function () { afterCopySucceeded(doneMsg, pasteMsg); }).catch(function () { fallbackCopy(text, doneMsg, pasteMsg); });
    } else {
      fallbackCopy(text, doneMsg, pasteMsg);
    }
  }
  function fallbackCopy(text, doneMsg, pasteMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { afterCopySucceeded(doneMsg, pasteMsg); }).catch(function () { showToast('复制失败'); });
    } else { showToast('复制失败：当前环境不支持'); }
  }

  function renderModuleGrid() {
    var lang = state.lang;
    $moduleWrap.innerHTML = '';
    var mods = state.moduleOrder.map(resolveModule).filter(Boolean).filter(function (m) { return !m.hidden; });
    if (mods.length === 0) {
      $moduleWrap.innerHTML = '<span class="fw-empty-hint">暂无可用模块</span>';
      return;
    }
    mods.forEach(function (mod) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'fw-pill';
      pill.title = isAutoPasteOn() ? '点击复制并粘贴到外部窗口' : '点击复制到剪贴板';
      var label = mod.label[lang] || mod.label.zh || mod.label.en || '';
      pill.innerHTML = '<span class="fw-pill-plus">+</span><span class="fw-pill-label">' + escapeHtml(label) + '</span>';
      pill.addEventListener('click', function () {
        var text = mod.text[lang] || mod.text.zh || mod.text.en || '';
        copyToClipboard(text, '已复制「' + label + '」', '已粘贴「' + label + '」');
      });
      $moduleWrap.appendChild(pill);
    });
  }

  function renderSnippetGrid() {
    var lang = state.lang;
    $snippetWrap.innerHTML = '';
    var snips = state.snippetOrder.map(resolveSnippet).filter(Boolean).filter(function (s) { return !s.hidden; });
    if (snips.length === 0) {
      $snippetWrap.innerHTML = '<span class="fw-empty-hint">暂无可用常用句</span>';
      return;
    }
    snips.forEach(function (snip) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'fw-pill';
      pill.title = snip[lang] || snip.zh || snip.en || '';
      pill.innerHTML = '<span class="fw-pill-label">' + escapeHtml(snip.tag) + '</span>';
      pill.addEventListener('click', function () {
        var text = snip[lang] || snip.zh || snip.en || '';
        copyToClipboard(text, '已复制「' + snip.tag + '」', '已粘贴「' + snip.tag + '」');
      });
      $snippetWrap.appendChild(pill);
    });
  }

  /* ============================================================
   * 渲染：快速段落（可折叠分组，同时只展开一个）
   * 点击段落沿用 pill 的复制/自动粘贴范式，与插入模块/常用句一致。
   * ============================================================ */
  var CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  var openQuickGroupId = null; // 当前展开的分组 id

  function renderQuickGroups() {
    if (!$quickWrap) return;
    var lang = state.lang;
    $quickWrap.innerHTML = '';

    var visible = state.quickGroups.filter(function (g) { return !g.hidden; });
    if (visible.length === 0) {
      $quickWrap.innerHTML = '<span class="fw-empty-hint">暂无快速段落</span>';
      return;
    }
    // 展开的分组若已不可见/被删，收起
    if (openQuickGroupId && !visible.some(function (g) { return g.id === openQuickGroupId; })) {
      openQuickGroupId = null;
    }

    visible.forEach(function (group) {
      var isOpen = group.id === openQuickGroupId;
      var block = document.createElement('div');
      block.className = 'fw-quick-block' + (isOpen ? ' open' : '');

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'fw-qb-head';
      head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      var name = group.label[lang] || group.label.zh || group.label.en || '未命名分组';
      head.innerHTML =
        '<span class="fw-qb-name"></span>' +
        '<span class="fw-qb-count">' + group.items.length + '</span>' +
        '<span class="fw-qb-caret">' + CHEVRON_SVG + '</span>';
      head.querySelector('.fw-qb-name').textContent = name;
      head.title = name;
      head.addEventListener('click', function () {
        openQuickGroupId = isOpen ? null : group.id;
        renderQuickGroups();
      });
      block.appendChild(head);

      if (isOpen) {
        var list = document.createElement('div');
        list.className = 'fw-qb-list';
        if (group.items.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fw-qb-empty';
          empty.textContent = '该分组还没有段落。';
          list.appendChild(empty);
        } else {
          group.items.forEach(function (item) {
            var text = item.text[lang] || item.text.zh || item.text.en || '';
            var itemLabel = item.label[lang] || item.label.zh || item.label.en || '（未命名段落）';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fw-qb-item';
            btn.title = isAutoPasteOn() ? '点击复制并粘贴到外部窗口' : '点击复制到剪贴板';
            var lb = document.createElement('span');
            lb.className = 'fw-qb-item-label';
            lb.textContent = itemLabel;
            var pv = document.createElement('span');
            pv.className = 'fw-qb-item-preview';
            pv.textContent = text.replace(/\s+/g, ' ').trim();
            btn.appendChild(lb);
            btn.appendChild(pv);
            btn.addEventListener('click', function () {
              if (!text) { showToast('该段落还没有内容'); return; }
              copyToClipboard(text, '已复制「' + itemLabel + '」', '已粘贴「' + itemLabel + '」');
            });
            list.appendChild(btn);
          });
        }
        block.appendChild(list);
      }
      $quickWrap.appendChild(block);
    });
  }

  function renderAll() {
    renderEditor();
    renderQuickGroups();
    renderModuleGrid();
    renderSnippetGrid();
    // Agent 面板总开关：不另开事件通道，同步/回填都汇聚到 renderAll，这里
    // 顺带重新应用一次即可（定义见下方 §Agent tab，此时 fleetView 已构造好）。
    applyFleetEnabled();
  }

  /* ============================================================
   * 顶部操作
   * ============================================================ */
  $copyBtn.addEventListener('click', function () {
    var text = $textarea.value || '';
    copyToClipboard(text, '已复制编辑器内容');
  });

  $clearBtn.addEventListener('click', function () {
    if (!$textarea.value) { showToast('正文已经是空的'); return; }
    if (!window.confirm('清空当前正文？')) return;
    $textarea.value = '';
    state.content[state.lang] = '';
    syncOverlay();
    scheduleSave();
    $textarea.focus();
    showToast('已清空正文');
  });

  $closeBtn.addEventListener('click', function () {
    if (currentWin && currentWin.hide) {
      currentWin.hide().then(function () {
        // 通知主窗口 toggle 按钮即时收起激活态，无需等到主窗口重新获得焦点
        if (eventApi && eventApi.emit) {
          eventApi.emit('composer-float-visibility', { visible: false }).catch(function () {});
        }
      }).catch(function () {});
    }
  });

  /* ------------------------------------------------------------
   * 缩小为图标 / 恢复：把整个浮窗窗口 setSize 到小圆钮尺寸，点圆钮原地恢复。
   * 尺寸全程走逻辑像素（innerSize 是物理像素，需除以 scaleFactor），
   * 否则高 DPI 下反复缩放会漂移。tauri.conf.json 的 minWidth/minHeight
   * 已降到 52，setSize 可直接缩到位，无需运行时 setMinSize。
   * ------------------------------------------------------------ */
  var MINI = { w: 52, h: 52 };
  var DEFAULT_SIZE = { w: 380, h: 520 };  // 无记录时的兜底
  var prevSize = null;
  var isMini = false;
  var busy = false;

  // Tauri v2 的 LogicalSize：优先 dpi 命名空间，回退 window 命名空间
  function LogicalSize(w, h) {
    var dpi = TAURI && TAURI.dpi;
    var winApi = TAURI && TAURI.window;
    var Ctor = (dpi && dpi.LogicalSize) || (winApi && winApi.LogicalSize);
    if (!Ctor) return null;
    return new Ctor(w, h);
  }

  function collapse() {
    if (!currentWin || isMini || busy) return;
    if (!currentWin.setSize) { showToast('当前环境不支持缩小'); return; }
    var mini = LogicalSize(MINI.w, MINI.h);
    if (!mini) { showToast('当前环境不支持缩小'); return; }
    busy = true;
    // 先切 UI 为圆钮（同步、不依赖窗口 API 成败），再缩窗口，避免出现
    // “窗口已变小但内容还是完整卡片”的残缺中间态。
    isMini = true;
    $card.classList.add('is-mini');
    fleetView.refreshSchedule(); // 缩成小球：Agent tab 的轮询立刻降到精简档
    Promise.all([currentWin.innerSize(), currentWin.scaleFactor()]).then(function (r) {
      var s = r[0], f = r[1] || 1;
      prevSize = { w: Math.round(s.width / f), h: Math.round(s.height / f) };
      return currentWin.setSize(LogicalSize(MINI.w, MINI.h));
    }).catch(function () {
      // 缩窗口失败则回滚 UI
      isMini = false;
      $card.classList.remove('is-mini');
      showToast('缩小失败');
    }).finally(function () { busy = false; });
  }

  function expand() {
    if (!currentWin || !isMini || busy) return;
    busy = true;
    // 同 collapse：先恢复 UI，再放大窗口
    isMini = false;
    $card.classList.remove('is-mini');
    fleetView.refreshSchedule(); // 恢复：若停在 Agent tab，轮询立刻回到全量档
    var t = prevSize || DEFAULT_SIZE;
    currentWin.setSize(LogicalSize(t.w, t.h)).then(function () {
      if (currentWin.setFocus) currentWin.setFocus().catch(function () {});
    }).catch(function () {
      showToast('恢复失败');
    }).finally(function () { busy = false; });
  }

  $minBtn.addEventListener('click', collapse);

  // 小圆钮：不用 data-tauri-drag-region（那会把首次单击吞成拖拽起手，
  // 导致需双击才恢复）。改为手动判定：按下后位移超过阈值算拖窗口、
  // 调 startDragging；几乎没动则算点击、恢复浮窗。
  var DRAG_THRESHOLD = 4; // px
  $orb.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var startX = e.clientX, startY = e.clientY;
    var dragging = false;

    function onMove(ev) {
      if (dragging) return;
      if (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
          Math.abs(ev.clientY - startY) > DRAG_THRESHOLD) {
        dragging = true;
        cleanup();
        if (currentWin && currentWin.startDragging) {
          currentWin.startDragging().catch(function () {});
        }
      }
    }
    function onUp() {
      cleanup();
      if (!dragging) expand(); // 没拖动 → 视为点击，恢复浮窗
    }
    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /* ============================================================
   * Agent tab：分组展示本机在跑的 Claude Code 会话。
   * ------------------------------------------------------------
   * 判定/渲染/轮询调度全部委托给 fleetView.js（纯 DOM 层，判定逻辑
   * 又全部来自 fleet.js），float.js 这里只做两件事：
   *   1. tab 切换的 UI（哪个 panel 显示、哪个按钮高亮）+ localStorage
   *      持久化，套路与 composer-fw-autopaste 一致：读不到时给默认值
   *      （编写 tab），存不了就算了不影响当次使用。
   *   2. 把会影响轮询档位的三个状态变化（tab 切换 / 缩成小球 / 恢复）
   *      转发给 fleetView 的 refreshSchedule()，让它立刻按新档位重排
   *      定时器，不必等旧间隔走完。
   * ============================================================ */
  var FW_TAB_STORAGE_KEY = 'composer-fw-tab';
  function loadSavedTab() {
    try {
      var saved = window.localStorage.getItem(FW_TAB_STORAGE_KEY);
      return saved === 'fleet' ? 'fleet' : 'compose'; // 没存过 / 存的是脏值都落回默认编写 tab
    } catch (e) { return 'compose'; }
  }

  function applyTab(tab) {
    var isFleetTab = tab === 'fleet';
    $panelCompose.classList.toggle('is-active', !isFleetTab);
    $panelFleet.classList.toggle('is-active', isFleetTab);
    $tabComposeBtn.classList.toggle('is-active', !isFleetTab);
    $tabFleetBtn.classList.toggle('is-active', isFleetTab);
    $tabComposeBtn.setAttribute('aria-selected', isFleetTab ? 'false' : 'true');
    $tabFleetBtn.setAttribute('aria-selected', isFleetTab ? 'true' : 'false');
  }

  // 用户主动切 tab 才需要 refreshSchedule()：fleetView 构造时已经会立即抓
  // 一次数据，初始按存档 tab 摆放（见下方 applyTab(loadSavedTab())）不需要
  // 再额外触发一轮抓取，否则等于把"立即抓一次"这个设计意图取消掉。
  function switchTab(tab) {
    applyTab(tab);
    try { window.localStorage.setItem(FW_TAB_STORAGE_KEY, tab); } catch (e) { /* 存不了就算了，当次已生效 */ }
    fleetView.refreshSchedule();
  }

  $tabComposeBtn.addEventListener('click', function () { switchTab('compose'); });
  $tabFleetBtn.addEventListener('click', function () { switchTab('fleet'); });

  // 非 Tauri 环境（浏览器预览）没有 invoke，fleetView 内部会据此渲染降级文案
  // 并完全不启动轮询——同 canAutoPaste 的判空写法。
  var fleetInvoke = (coreApi && coreApi.invoke)
    ? function (cmd, args) { return coreApi.invoke(cmd, args); }
    : null;

  var fleetView = createFleetView({
    root: $panelFleet,
    tabButton: $tabFleetBtn,
    badge: $tabFleetBadge,
    orbDot: $orbDot,
    invoke: fleetInvoke,
    // Windows 上 window.hide() 是否触发 visibilitychange 未验证，但这只是
    // 省电优化：判断失败最坏情况是浮窗隐藏时仍以精简档轮询，代价可忽略，
    // 不把它当正确性问题（见 docs/agent-fleet.md §5 C4）。
    getVisibility: function () { return document.visibilityState !== 'hidden'; },
    onError: function (err) { console.warn('Agent fleet 轮询失败:', err); },
    // 构造时的初始值——此刻 state 还是 defaultState()（真实存档要等
    // restoreState() 落地才知道），默认开对应 defaultFleetSettings()。
    // 真正生效的值由下面 applyFleetEnabled() 在每次 renderAll() 里重新
    // 应用一次，这里只是避免"构造出来的一瞬间"是错误默认值。
    enabled: state.settings.fleet.enabled,
  });

  /* Agent 面板总开关（settings.fleet.enabled）：关闭时隐藏 tab 按钮、
   * 停止 fleetView 轮询；若此刻正停在 Agent tab 则强制切回编写 tab——
   * 但用 applyTab 而不是 switchTab，不去动 localStorage 里"上次停留
   * tab"的记忆。这是开关导致的被动切换，不是用户主动选择，重新打开
   * 开关后应该按用户原本的偏好来，不能被这次自动切换污染成"编写"。
   * 由 renderAll() 在每次同步 / 回填之后调用，复用现成的
   * composer-state-changed 广播路径，不另开事件通道。 */
  function applyFleetEnabled() {
    var on = state.settings.fleet.enabled !== false;
    $tabFleetBtn.hidden = !on;
    if (!on && $panelFleet.classList.contains('is-active')) {
      applyTab('compose');
    }
    fleetView.setEnabled(on);
  }

  applyTab(loadSavedTab());

  restoreState();
