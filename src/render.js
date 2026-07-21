/* ============================================================
 * render.js —— 左栏与右栏编辑器的渲染 + 块拖拽
 * ------------------------------------------------------------
 * 依赖 store.js 的状态/DOM/工具、core.js 的纯函数。汇总渲染
 * renderAll 已移到 events.js，故此模块不反向依赖 quick / events。
 * ============================================================ */
import {
  escapeHtml,
  icon,
  parseBlocks,
  estimateTokens,
  highlightMarkdown,
  MODULE_BY_ID,
  BUILTIN_BY_ID,
} from './core.js';
import {
  state,
  view,
  scheduleSave,
  collectText,
  insertSnippet,
  preserveBlockFocus,
  captureHistory,
  history,
  $insertGrid,
  $snippetWrap,
  $etLabel,
  $editorStat,
  $blocks,
  $preview,
} from './store.js';

  /* ============================================================
   * 7. 渲染：左栏
   * ============================================================ */
  // 把一个 id 解析成可用的模块对象（内置合并覆盖；返回含 hidden 标记）
  function resolveModule(id) {
    var b = MODULE_BY_ID[id];
    if (b) {
      var p = state.modulePatches[id] || {};
      return {
        id: id,
        builtin: true,
        label: {
          zh: typeof p.labelZh === 'string' ? p.labelZh : b.label.zh,
          en: typeof p.labelEn === 'string' ? p.labelEn : b.label.en
        },
        text: {
          zh: typeof p.textZh === 'string' ? p.textZh : b.text.zh,
          en: typeof p.textEn === 'string' ? p.textEn : b.text.en
        },
        hidden: p.hidden === true
      };
    }
    var c = null;
    for (var i = 0; i < state.customModules.length; i++) {
      if (state.customModules[i].id === id) { c = state.customModules[i]; break; }
    }
    if (!c) return null;
    return { id: id, builtin: false, label: { zh: c.label.zh, en: c.label.en }, text: { zh: c.text.zh, en: c.text.en }, hidden: c.hidden === true };
  }

  function orderedModules() {
    return state.moduleOrder.map(resolveModule).filter(Boolean);
  }

  function visibleModules() {
    return orderedModules().filter(function (m) { return !m.hidden; });
  }

  function renderInsertGrid() {
    var lang = state.lang;
    $insertGrid.innerHTML = '';
    visibleModules().forEach(function (mod) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'insert-pill';
      pill.setAttribute('role', 'listitem');
      pill.title = '插入到光标处';
      pill.innerHTML = '<span class="ip-plus">+</span><span>' + escapeHtml(mod.label[lang] || mod.label.zh || mod.label.en) + '</span>';
      preserveBlockFocus(pill);
      pill.addEventListener('click', function () { insertSnippet(mod.text[lang] || mod.text.zh || mod.text.en); });
      $insertGrid.appendChild(pill);
    });
  }

  // 把一个 id 解析成可用的句子对象（内置合并覆盖；返回含 hidden 标记）
  function resolveSnippet(id) {
    var b = BUILTIN_BY_ID[id];
    if (b) {
      var p = state.builtinPatches[id] || {};
      return {
        id: id,
        builtin: true,
        tag: typeof p.tag === 'string' ? p.tag : b.tag,
        zh: typeof p.zh === 'string' ? p.zh : b.zh,
        en: typeof p.en === 'string' ? p.en : b.en,
        hidden: p.hidden === true
      };
    }
    var c = null;
    for (var i = 0; i < state.customSnippets.length; i++) {
      if (state.customSnippets[i].id === id) { c = state.customSnippets[i]; break; }
    }
    if (!c) return null;
    return { id: id, builtin: false, tag: c.tag, zh: c.zh, en: c.en, hidden: c.hidden === true };
  }

  // 按顺序返回全部句子（含隐藏，供管理浮窗使用）
  function orderedSnippets() {
    return state.snippetOrder.map(resolveSnippet).filter(Boolean);
  }

  // 左栏可见句子（排除隐藏）
  function allSnippets() {
    return orderedSnippets().filter(function (s) { return !s.hidden; });
  }

  function renderSnippets() {
    var lang = state.lang;
    $snippetWrap.innerHTML = '';
    allSnippets().forEach(function (snip) {
      var pill = document.createElement('span');
      pill.className = 'snippet-pill';
      pill.title = snip[lang] || snip.zh || snip.en;
      var t = document.createElement('span');
      t.textContent = snip.tag;
      pill.appendChild(t);
      preserveBlockFocus(pill);
      pill.addEventListener('click', function () {
        insertSnippet(snip[lang] || snip.zh || snip.en);
      });
      $snippetWrap.appendChild(pill);
    });
  }
  /* ============================================================
   * 8. 渲染：右栏编辑器 / 预览 / 状态
   * ============================================================ */
  function renderEditor() {
    // 写态与预览态左侧都是可编辑块，两态都渲染块
    renderBlocks();
    $etLabel.textContent = state.lang === 'zh' ? '中文正文' : 'English 正文';
    refreshStat();
    if (view === 'preview') renderPreview();
  }

  /* ---------- 块化编辑器渲染 ---------- */
  function autosize(area) {
    area.style.height = 'auto';
    area.style.height = (area.scrollHeight) + 'px';
  }

  function renderBlocks() {
    var blocks = parseBlocks(state.content[state.lang] || '');
    $blocks.innerHTML = '';

    if (blocks.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'blocks-empty';
      empty.innerHTML = '还没有内容。点左侧「插入模块」快速开始，或直接在下方新建一个块。<br>用 <code>## 标题</code> 组织段落。';
      $blocks.appendChild(empty);
      appendAddBlockButton();
      return;
    }

    blocks.forEach(function (blockText, idx) {
      $blocks.appendChild(buildBlockCard(blockText, idx));
    });
    appendAddBlockButton();
  }

  function appendAddBlockButton() {
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'block-add';
    add.innerHTML = '<span style="font-family:var(--font-mono);color:var(--amber)">+</span> 新建块';
    add.addEventListener('click', function () {
      var text = collectText();
      captureHistory(); // 结构操作（新建块）：改动前存旧快照
      state.content[state.lang] = text ? (text + '\n\n## ') : '## ';
      renderBlocks();
      markLastBlockAsNew();
      refreshStat();
      scheduleSave();
      var areas = $blocks.querySelectorAll('.block-textarea');
      var last = areas[areas.length - 1];
      if (last) { last.focus(); last.setSelectionRange(last.value.length, last.value.length); }
    });
    $blocks.appendChild(add);
  }

  // 给刚新增的最后一个块打上入场动效标记，动画结束后自动移除
  function markLastBlockAsNew() {
    var cards = $blocks.querySelectorAll('.block');
    var last = cards[cards.length - 1];
    if (!last) return;
    last.classList.add('block-enter');
    last.addEventListener('animationend', function handler() {
      last.classList.remove('block-enter');
      last.removeEventListener('animationend', handler);
    });
  }

  function buildBlockCard(blockText, idx) {
    var card = document.createElement('div');
    card.className = 'block';
    card.dataset.idx = idx;

    // gutter：拖拽手柄 + 删除
    var gutter = document.createElement('div');
    gutter.className = 'block-gutter';

    var handle = document.createElement('div');
    handle.className = 'block-handle';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', '拖动排序');
    handle.title = '拖动排序（或 Alt+↑/↓）';
    handle.innerHTML = icon('grip-vertical');
    attachDrag(handle, card);
    gutter.appendChild(handle);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'block-del';
    del.setAttribute('aria-label', '删除此块');
    del.title = '删除此块';
    del.innerHTML = icon('trash-2');
    del.addEventListener('click', function () { deleteBlock(card); });
    gutter.appendChild(del);

    card.appendChild(gutter);

    // body：块内 textarea + 高亮 overlay（同一个 .hl-wrap 内像素对齐叠放）
    var body = document.createElement('div');
    body.className = 'block-body';

    var wrap = document.createElement('div');
    wrap.className = 'hl-wrap';

    var overlay = document.createElement('div');
    overlay.className = 'hl-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var area = document.createElement('textarea');
    area.className = 'block-textarea';
    area.spellcheck = false;
    area.value = blockText;
    area.rows = 1;
    area.setAttribute('aria-label', '块内容');
    area.addEventListener('input', function () {
      autosize(area);
      renderHighlight(area, overlay);
      onBlocksChanged();
    });
    area.addEventListener('scroll', function () { syncOverlayScroll(area, overlay); });
    area.addEventListener('keydown', function (e) {
      // Alt+↑/↓ 移动块
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveBlock(card, e.key === 'ArrowUp' ? -1 : 1);
      }
    });

    wrap.appendChild(overlay);
    wrap.appendChild(area);
    body.appendChild(wrap);
    card.appendChild(body);

    // 初次布局后自适应高度 + 首次高亮
    renderHighlight(area, overlay);
    requestAnimationFrame(function () { autosize(area); });

    return card;
  }

  /* ---------- Markdown 语法高亮：hlEscape / highlightInline / highlightMarkdown
   * 纯函数已抽离到 core.js，overlay 渲染仍在此处（依赖 DOM）。---------- */

  function renderHighlight(area, overlay) {
    overlay.innerHTML = highlightMarkdown(area.value);
    syncOverlayScroll(area, overlay);
  }

  function syncOverlayScroll(area, overlay) {
    overlay.scrollTop = area.scrollTop;
    overlay.scrollLeft = area.scrollLeft;
  }

  // 块内容变化：收集回写（不重建 DOM，避免打断输入）
  function onBlocksChanged() {
    collectText();
    refreshStat();
    scheduleSave();
    // 左右并排预览态：编辑左侧块时实时刷新右侧预览
    if (view === 'preview') renderPreview();
  }

  function deleteBlock(card) {
    var area = card.querySelector('.block-textarea');
    // 有内容时二次确认，空块直接删
    if (area && area.value.trim() && !window.confirm('删除这个块？')) return;
    // 结构操作（删块）：先把当前 DOM（含待删块）收回 state 再入栈，
    // 保证快照是删除前的完整内容，撤销能原样恢复该块。
    collectText();
    captureHistory();
    card.remove();
    collectText();
    refreshStat();
    scheduleSave();
    // 若删空了，重渲染以显示空态
    if ($blocks.querySelectorAll('.block').length === 0) renderBlocks();
  }

  function moveBlock(card, delta) {
    var cards = Array.prototype.slice.call($blocks.querySelectorAll('.block'));
    var i = cards.indexOf(card);
    var j = i + delta;
    if (j < 0 || j >= cards.length) return;
    // 结构操作（移动块）：越界不动，故先判边界再入栈，避免记入空操作。
    collectText();
    captureHistory();
    var focused = document.activeElement === card.querySelector('.block-textarea');
    if (delta < 0) $blocks.insertBefore(card, cards[j]);
    else $blocks.insertBefore(cards[j], card);
    collectText();
    scheduleSave();
    if (focused) { var a = card.querySelector('.block-textarea'); if (a) a.focus(); }
  }

  /* ---------- 块拖拽（按手柄） ---------- */
  var dragBlock = null;

  function attachDrag(handle, card) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      startBlockDrag(card, e);
    });
  }

  // 其它块的“让位”通过 FLIP 实现：记录旧位置 → 改变 DOM 顺序 →
  // 测新位置 → 反向 transform 归位 → 下一帧动画到 0，形成平滑滑动。
  function flipReorder(mutate) {
    var cards = Array.prototype.slice.call($blocks.querySelectorAll('.block'));
    var first = {};
    cards.forEach(function (c) { first[c.dataset.flipId] = c.getBoundingClientRect().top; });

    mutate(); // 改变 DOM 顺序

    cards.forEach(function (c) {
      if (c.classList.contains('dragging')) return; // 被拖块自行跟指针
      var oldTop = first[c.dataset.flipId];
      if (oldTop == null) return;
      var newTop = c.getBoundingClientRect().top;
      var dy = oldTop - newTop;
      if (!dy) return;
      c.classList.remove('flip');
      c.style.transform = 'translateY(' + dy + 'px)';
      // 强制回流后下一帧动画到 0
      requestAnimationFrame(function () {
        c.classList.add('flip');
        c.style.transform = '';
      });
    });
  }

  function startBlockDrag(card, ev) {
    dragBlock = card;
    document.body.style.userSelect = 'none';

    // 结构操作（拖拽排序）：记下拖拽前的完整内容，松手时若顺序真的
    // 变了才入栈；原地放回不产生历史，避免记入空操作。
    collectText();
    var contentBeforeDrag = state.content[state.lang] || '';

    // 给每个块打一个稳定 id 供 FLIP 匹配
    Array.prototype.slice.call($blocks.querySelectorAll('.block')).forEach(function (c, i) {
      c.dataset.flipId = c.dataset.flipId || ('f' + i + '_' + Math.random().toString(36).slice(2, 6));
    });

    var rect = card.getBoundingClientRect();
    var startX = ev.clientX, startY = ev.clientY;
    var offsetY = ev.clientY - rect.top;

    // 占位块：等高，标记被拖块原位
    var placeholder = document.createElement('div');
    placeholder.className = 'block drag-placeholder';
    placeholder.dataset.flipId = 'placeholder';
    placeholder.style.height = rect.height + 'px';
    $blocks.insertBefore(placeholder, card.nextSibling);

    // 被拖块浮起：固定宽度，跟随指针
    var width = rect.width;
    card.classList.add('dragging');
    card.style.width = width + 'px';
    card.style.position = 'fixed';
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    card.style.margin = '0';

    function moveFollow(e) {
      card.style.top = (e.clientY - offsetY) + 'px';
      card.style.left = rect.left + 'px';
    }
    moveFollow(ev);

    function onMove(e) {
      if (!dragBlock) return;
      moveFollow(e);

      // 静止块（排除被拖块与占位块本身），按 DOM 顺序
      var cards = Array.prototype.slice.call($blocks.querySelectorAll('.block'))
        .filter(function (c) { return c !== card && c !== placeholder; });

      // 指针 Y 与各静止块中点比较，决定占位块插到哪个块之前（null=末尾）
      var refNode = null;
      for (var i = 0; i < cards.length; i++) {
        var r = cards[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { refNode = cards[i]; break; }
      }

      // 占位块“在静止块序列中的当前落点”：它下一个静止兄弟（跳过 card）
      var curRef = placeholder.nextElementSibling;
      while (curRef && (curRef === card || !curRef.classList.contains('block'))) {
        curRef = curRef.nextElementSibling;
      }
      // 已在目标位置则不动，避免抖动；否则 FLIP 平滑让位
      if (refNode !== curRef) {
        flipReorder(function () {
          $blocks.insertBefore(placeholder, refNode);
        });
      }
    }

    function onUp() {
      if (!dragBlock) return cleanupListeners();
      // 松手瞬间被拖块的视觉位置（fixed 定位的 top）
      var fromTop = card.getBoundingClientRect().top;

      // 恢复流内定位，放回占位块处，测最终位置
      card.classList.remove('dragging', 'flip');
      card.style.position = '';
      card.style.top = card.style.left = card.style.width = card.style.margin = '';
      $blocks.insertBefore(card, placeholder);
      placeholder.remove();
      var toTop = card.getBoundingClientRect().top;

      // 一次 FLIP：从松手视觉位置平滑落到最终位置
      var dy = fromTop - toTop;
      if (dy) {
        card.style.transform = 'translateY(' + dy + 'px)';
        requestAnimationFrame(function () {
          card.classList.add('flip');
          card.style.transform = '';
        });
      }

      collectText();
      // 顺序真的变化了才补记历史（快照为拖拽前内容）
      if ((state.content[state.lang] || '') !== contentBeforeDrag) {
        history.push(contentBeforeDrag);
      }
      scheduleSave();
      cleanupListeners();
      dragBlock = null;
    }

    function cleanup() {
      if (placeholder && placeholder.parentNode) placeholder.remove();
      if (dragBlock) {
        dragBlock.classList.remove('dragging');
        dragBlock.style.position = '';
        dragBlock.style.top = dragBlock.style.left = dragBlock.style.width = dragBlock.style.margin = '';
      }
      cleanupListeners();
      dragBlock = null;
    }
    function cleanupListeners() {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function refreshStat() {
    var tokens = estimateTokens(state.content[state.lang] || '');
    $editorStat.innerHTML = '<b>~' + tokens + '</b> tokens';
  }

  function renderPreview() {
    var lang = state.lang;
    var raw = state.content[lang] || '';
    $preview.innerHTML = '';

    if (!raw.trim()) {
      var empty = document.createElement('div');
      empty.className = 'editor-preview-empty';
      empty.textContent = '正文为空，先在「编辑」里写点内容。';
      $preview.appendChild(empty);
      return;
    }

    // 按行渲染：## 开头的行做标题色，其余作为纯文本
    var lines = raw.split('\n');
    lines.forEach(function (line, i) {
      if (/^##\s?/.test(line)) {
        var h = document.createElement('span');
        h.className = 'pv-h';
        h.textContent = line;
        $preview.appendChild(h);
      } else {
        $preview.appendChild(document.createTextNode(line));
      }
      if (i < lines.length - 1) $preview.appendChild(document.createTextNode('\n'));
    });
  }

  export {
    // 左栏
    resolveModule, orderedModules, visibleModules, renderInsertGrid,
    resolveSnippet, orderedSnippets, allSnippets, renderSnippets,
    // 编辑器 / 块
    renderEditor, autosize, renderBlocks, appendAddBlockButton,
    markLastBlockAsNew, buildBlockCard, renderHighlight, syncOverlayScroll,
    onBlocksChanged, deleteBlock, moveBlock, attachDrag, flipReorder,
    startBlockDrag, refreshStat, renderPreview,
  };
