(function () {
  'use strict';

  /* ============================================================
   * -1. core.js 纯逻辑层命名空间
   * ============================================================ */
  var Composer = window.Composer || {};

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
  var INSERT_MODULES = Composer.INSERT_MODULES;
  var MODULE_BY_ID = Composer.MODULE_BY_ID;
  var BUILTIN_SNIPPETS = Composer.BUILTIN_SNIPPETS;
  var BUILTIN_BY_ID = Composer.BUILTIN_BY_ID;
  var demoContent = Composer.demoContent;
  var defaultState = Composer.defaultState;
  var newSnippetId = Composer.newSnippetId;
  var newModuleId = Composer.newModuleId;
  var newQuickGroupId = Composer.newQuickGroupId;
  var newQuickItemId = Composer.newQuickItemId;

  /* ============================================================
   * 2. 状态 + 持久化
   * ============================================================ */
  var state = defaultState();
  var view = 'write'; // 'write' | 'preview'
  var saveTimer = null;
  var suppressBroadcast = false; // 收到浮窗广播触发的本地更新，不再二次广播（防回声循环）

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
  var modulesToText = Composer.modulesToText;
  var normalizeState = Composer.normalizeState;

  /* ============================================================
   * 3. token 估算（纯函数已抽离到 core.js）
   * ============================================================ */
  var estimateTokens = Composer.estimateTokens;

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
  var $btnLoadDemo = document.getElementById('btnLoadDemo');
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
  var escapeHtml = Composer.escapeHtml;

  /* ============================================================
   * 5.1 Lucide 风格内联图标：统一图标来源，避免 emoji / 字符占位
   * 用法：icon('trash-2') 返回可直接塞进 innerHTML 的 SVG 字符串
   * ICON_PATHS / icon()：纯数据 / 纯函数已抽离到 core.js
   * ============================================================ */
  var ICON_PATHS = Composer.ICON_PATHS;
  var icon = Composer.icon;

  /* ============================================================
   * 6. 块模型：正文 ⇄ 块 的解析与回写
   * ------------------------------------------------------------
   * 真相源仍是 state.content[lang] 大文本。块只是视图：
   *   parseBlocks(text) 把文本按 "## " 开头切成块（首个 ## 之前的
   *   内容作为一个无标题“前言块”）；编辑/拖拽后由 collectText() 从
   *   DOM 顺序收集各块文本并以空行拼回，写入 state。
   * parseBlocks 纯函数已抽离到 core.js。
   * ============================================================ */
  var parseBlocks = Composer.parseBlocks;

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
      pill.addEventListener('click', function () {
        insertSnippet(snip[lang] || snip.zh || snip.en);
      });
      $snippetWrap.appendChild(pill);
    });
  }

  /* ---------- 快速段落：可下拉的分组 block ---------- */
  var openQuickGroupId = null; // 当前展开的分组 id（同时只展开一个）

  function renderQuick() {
    if (!$quickWrap) return;
    var lang = state.lang;
    $quickWrap.innerHTML = '';

    var visible = state.quickGroups.filter(function (g) { return !g.hidden; });
    if (visible.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'quick-empty';
      empty.textContent = '还没有快速段落，点右上角齿轮添加。';
      $quickWrap.appendChild(empty);
      return;
    }
    // 若当前展开的分组已不可见/被删，收起
    if (openQuickGroupId && !visible.some(function (g) { return g.id === openQuickGroupId; })) {
      openQuickGroupId = null;
    }

    visible.forEach(function (group) {
      var isOpen = group.id === openQuickGroupId;
      var block = document.createElement('div');
      block.className = 'quick-block' + (isOpen ? ' open' : '');

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'qb-head';
      head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      var name = group.label[lang] || group.label.zh || group.label.en || '未命名分组';
      head.innerHTML =
        '<span class="qb-name"></span>' +
        '<span class="qb-count">' + group.items.length + '</span>' +
        '<span class="qb-caret">' + icon('chevron-down') + '</span>';
      head.querySelector('.qb-name').textContent = name;
      head.title = name;
      head.addEventListener('click', function () {
        openQuickGroupId = isOpen ? null : group.id;
        renderQuick();
      });
      block.appendChild(head);

      if (isOpen) {
        var list = document.createElement('div');
        list.className = 'qb-list';
        if (group.items.length === 0) {
          var ie = document.createElement('div');
          ie.className = 'qb-empty';
          ie.textContent = '该分组还没有段落。';
          list.appendChild(ie);
        } else {
          group.items.forEach(function (item) {
            var text = item.text[lang] || item.text.zh || item.text.en || '';
            var itemLabel = item.label[lang] || item.label.zh || item.label.en || '（未命名段落）';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'qb-item';
            btn.title = text;
            var lb = document.createElement('span');
            lb.className = 'qb-item-label';
            lb.textContent = itemLabel;
            var pv = document.createElement('span');
            pv.className = 'qb-item-preview';
            pv.textContent = text.replace(/\s+/g, ' ').trim();
            btn.appendChild(lb);
            btn.appendChild(pv);
            btn.addEventListener('click', function () {
              if (!text) { showToast('该段落还没有内容'); return; }
              insertSnippet(text);
            });
            list.appendChild(btn);
          });
        }
        block.appendChild(list);
      }
      $quickWrap.appendChild(block);
    });
  }

  // 点击 block 之外的区域收起下拉
  document.addEventListener('mousedown', function (e) {
    if (openQuickGroupId === null) return;
    if ($quickWrap && $quickWrap.contains(e.target)) return;
    openQuickGroupId = null;
    renderQuick();
  });

  /* ---------- 通用管理浮窗（常用句 / 插入模块共用） ---------- */
  var $smOverlay = null, $smList = null, $smTitle = null, $smHint = null, $smAddBtn = null;
  var smKeyHandler = null, SM = null;

  function ensureSnippetManager() {
    if ($smOverlay) return;
    $smOverlay = document.createElement('div');
    $smOverlay.className = 'sm-overlay';
    $smOverlay.setAttribute('role', 'dialog');
    $smOverlay.setAttribute('aria-modal', 'true');
    $smOverlay.setAttribute('aria-label', '管理');
    $smOverlay.innerHTML =
      '<div class="sm-panel">' +
        '<div class="sm-head">' +
          '<span class="sm-title" id="smTitle"></span>' +
          '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="sm-hint" id="smHint"></div>' +
        '<div class="sm-list" id="smList"></div>' +
        '<div class="sm-foot">' +
          '<button type="button" class="sm-add" id="smAdd">' + icon('plus') + ' <span class="sm-add-label"></span></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild($smOverlay);
    $smList = $smOverlay.querySelector('#smList');
    $smTitle = $smOverlay.querySelector('#smTitle');
    $smHint = $smOverlay.querySelector('#smHint');
    $smAddBtn = $smOverlay.querySelector('#smAdd');

    $smOverlay.addEventListener('mousedown', function (e) {
      if (e.target === $smOverlay) closeSnippetManager();
    });
    $smOverlay.querySelector('.sm-close').addEventListener('click', closeSnippetManager);
    $smAddBtn.addEventListener('click', function () {
      if (SM) SM.addCustom();
    });
  }

  // ===== 常用句适配器 =====
  function snippetAdapter() {
    return {
      title: '管理常用句',
      hint: '勾选决定是否在左栏显示 · 点标签或内容可直接编辑 · 用 ↑↓ 调整顺序',
      addLabel: '新增自定义常用句',
      tagMax: 20,
      tagPlaceholder: '标签',
      textPlaceholder: function (lang) { return lang === 'zh' ? '中文内容' : 'English content'; },
      order: function () { return state.snippetOrder; },
      ordered: function () {
        var lang = state.lang;
        return orderedSnippets().map(function (s) {
          return { id: s.id, builtin: s.builtin, hidden: s.hidden, tagValue: s.tag, textValue: s[lang] || '' };
        });
      },
      setHidden: function (id, hidden) {
        if (BUILTIN_BY_ID[id]) patchBuiltinSnippet(id, 'hidden', hidden);
        else updateCustomSnippetField(id, 'hidden', hidden);
      },
      setTag: function (id, v) {
        if (BUILTIN_BY_ID[id]) patchBuiltinSnippet(id, 'tag', v);
        else updateCustomSnippetField(id, 'tag', v);
      },
      setText: function (id, v) {
        var lang = state.lang;
        if (BUILTIN_BY_ID[id]) patchBuiltinSnippet(id, lang, v);
        else updateCustomSnippetField(id, lang, v);
      },
      isModified: function (id) {
        var p = state.builtinPatches[id];
        return !!(p && (p.tag !== undefined || p.zh !== undefined || p.en !== undefined || p.hidden));
      },
      reset: function (id) { delete state.builtinPatches[id]; },
      deleteCustom: function (id) {
        for (var i = 0; i < state.customSnippets.length; i++) {
          if (state.customSnippets[i].id === id) { state.customSnippets.splice(i, 1); break; }
        }
        var oi = state.snippetOrder.indexOf(id);
        if (oi >= 0) state.snippetOrder.splice(oi, 1);
      },
      addCustom: function () {
        var c = { id: newSnippetId(), tag: '新常用句', zh: '', en: '', builtin: false, hidden: false };
        state.customSnippets.push(c);
        state.snippetOrder.push(c.id);
        scheduleSave();
        renderSnippetManager();
        renderLeft();
        focusLastRow();
      },
      renderLeft: renderSnippets
    };
  }

  // ===== 插入模块适配器 =====
  function moduleAdapter() {
    return {
      title: '管理插入模块',
      hint: '勾选决定是否在左栏显示 · 点标签或正文可直接编辑 · 用 ↑↓ 调整顺序',
      addLabel: '新增自定义模块',
      tagMax: 20,
      tagPlaceholder: '标签',
      textPlaceholder: function (lang) { return lang === 'zh' ? '插入的中文正文' : 'Inserted English text'; },
      order: function () { return state.moduleOrder; },
      ordered: function () {
        var lang = state.lang;
        return orderedModules().map(function (m) {
          return { id: m.id, builtin: m.builtin, hidden: m.hidden, tagValue: m.label[lang] || '', textValue: m.text[lang] || '' };
        });
      },
      setHidden: function (id, hidden) {
        if (MODULE_BY_ID[id]) patchBuiltinModule(id, 'hidden', hidden);
        else updateCustomModuleHidden(id, hidden);
      },
      setTag: function (id, v) {
        var lang = state.lang;
        if (MODULE_BY_ID[id]) patchBuiltinModule(id, lang === 'zh' ? 'labelZh' : 'labelEn', v);
        else updateCustomModuleField(id, 'label', lang, v);
      },
      setText: function (id, v) {
        var lang = state.lang;
        if (MODULE_BY_ID[id]) patchBuiltinModule(id, lang === 'zh' ? 'textZh' : 'textEn', v);
        else updateCustomModuleField(id, 'text', lang, v);
      },
      isModified: function (id) {
        var p = state.modulePatches[id];
        return !!(p && (p.labelZh !== undefined || p.labelEn !== undefined ||
                        p.textZh !== undefined || p.textEn !== undefined || p.hidden));
      },
      reset: function (id) { delete state.modulePatches[id]; },
      deleteCustom: function (id) {
        for (var i = 0; i < state.customModules.length; i++) {
          if (state.customModules[i].id === id) { state.customModules.splice(i, 1); break; }
        }
        var oi = state.moduleOrder.indexOf(id);
        if (oi >= 0) state.moduleOrder.splice(oi, 1);
      },
      addCustom: function () {
        var m = { id: newModuleId(), label: { zh: '新模块', en: 'New module' }, text: { zh: '', en: '' }, builtin: false, hidden: false };
        state.customModules.push(m);
        state.moduleOrder.push(m.id);
        scheduleSave();
        renderSnippetManager();
        renderLeft();
        focusLastRow();
      },
      renderLeft: renderInsertGrid
    };
  }

  function focusLastRow() {
    var last = $smList && $smList.querySelector('.sm-row:last-child .sm-tag');
    if (last) { last.focus(); last.select(); }
  }
  function renderLeft() { if (SM) SM.renderLeft(); }

  // 内置句 patch 清除逻辑已抽离到 core.js（纯函数，显式传入 state）
  function patchBuiltinSnippet(id, field, value) {
    Composer.patchBuiltinSnippet(id, state, field, value);
  }
  function updateCustomSnippetField(id, field, value) {
    for (var i = 0; i < state.customSnippets.length; i++) {
      if (state.customSnippets[i].id === id) { state.customSnippets[i][field] = value; return; }
    }
  }

  // 内置模块 patch 清除逻辑已抽离到 core.js（纯函数，显式传入 state）
  function patchBuiltinModule(id, field, value) {
    Composer.patchBuiltinModule(id, state, field, value);
  }
  function updateCustomModuleField(id, kind, lang, value) {
    for (var i = 0; i < state.customModules.length; i++) {
      if (state.customModules[i].id === id) { state.customModules[i][kind][lang] = value; return; }
    }
  }
  function updateCustomModuleHidden(id, hidden) {
    for (var i = 0; i < state.customModules.length; i++) {
      if (state.customModules[i].id === id) { state.customModules[i].hidden = hidden; return; }
    }
  }

  function openSnippetManager() { openManager(snippetAdapter()); }
  function openModuleManager() { openManager(moduleAdapter()); }

  function openManager(adapter) {
    ensureSnippetManager();
    SM = adapter;
    $smTitle.textContent = adapter.title;
    $smOverlay.setAttribute('aria-label', adapter.title);
    $smHint.textContent = adapter.hint;
    $smAddBtn.querySelector('.sm-add-label').textContent = adapter.addLabel;
    $smOverlay.classList.add('show');
    renderSnippetManager();
    smKeyHandler = function (e) { if (e.key === 'Escape') closeSnippetManager(); };
    document.addEventListener('keydown', smKeyHandler);
    var first = $smOverlay.querySelector('.sm-close');
    if (first) first.focus();
  }

  function closeSnippetManager() {
    if (!$smOverlay) return;
    $smOverlay.classList.remove('show');
    if (smKeyHandler) { document.removeEventListener('keydown', smKeyHandler); smKeyHandler = null; }
  }

  function moveManagerItem(id, dir) {
    var order = SM.order();
    var i = order.indexOf(id);
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    scheduleSave();
    renderSnippetManager();
    renderLeft();
  }

  function renderSnippetManager() {
    if (!$smList || !SM) return;
    var lang = state.lang;
    var order = SM.order();
    $smList.innerHTML = '';

    SM.ordered().forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'sm-row' + (item.hidden ? ' hidden' : '');
      var resetBtn = null;
      function syncReset() { if (resetBtn) resetBtn.disabled = !SM.isModified(item.id); }

      // 显示/隐藏开关
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sm-chk';
      chk.checked = !item.hidden;
      chk.title = item.hidden ? '已隐藏，勾选以显示' : '已显示，取消勾选以隐藏';
      chk.setAttribute('aria-label', '显示 ' + item.tagValue);
      chk.addEventListener('change', function () {
        SM.setHidden(item.id, !chk.checked);
        scheduleSave();
        renderSnippetManager();
        renderLeft();
      });
      row.appendChild(chk);

      // 主体：标签 + 内容
      var body = document.createElement('div');
      body.className = 'sm-body';

      var tag = document.createElement('input');
      tag.type = 'text';
      tag.className = 'sm-tag';
      tag.value = item.tagValue;
      tag.maxLength = SM.tagMax;
      tag.placeholder = SM.tagPlaceholder;
      tag.setAttribute('aria-label', '标签');
      tag.addEventListener('input', function () {
        SM.setTag(item.id, tag.value);
        syncReset();
        scheduleSave();
        renderLeft();
      });
      body.appendChild(tag);

      var text = document.createElement('textarea');
      text.className = 'sm-text';
      text.rows = 1;
      text.value = item.textValue;
      text.placeholder = SM.textPlaceholder(lang);
      text.setAttribute('aria-label', '内容');
      text.addEventListener('input', function () {
        SM.setText(item.id, text.value);
        autosizeSm(text);
        syncReset();
        scheduleSave();
        renderLeft();
      });
      body.appendChild(text);
      row.appendChild(body);

      // 操作区
      var ops = document.createElement('div');
      ops.className = 'sm-ops';

      var up = mkOpBtn('chevron-up', '上移', idx === 0);
      up.addEventListener('click', function () { moveManagerItem(item.id, -1); });
      var down = mkOpBtn('chevron-down', '下移', idx === order.length - 1);
      down.addEventListener('click', function () { moveManagerItem(item.id, 1); });
      ops.appendChild(up);
      ops.appendChild(down);

      if (item.builtin) {
        resetBtn = mkOpBtn('rotate-ccw', '恢复默认', !SM.isModified(item.id));
        resetBtn.addEventListener('click', function () {
          SM.reset(item.id);
          scheduleSave();
          renderSnippetManager();
          renderLeft();
        });
        ops.appendChild(resetBtn);
      } else {
        var del = mkOpBtn('x', '删除', false);
        del.classList.add('danger');
        del.addEventListener('click', function () {
          SM.deleteCustom(item.id);
          scheduleSave();
          renderSnippetManager();
          renderLeft();
        });
        ops.appendChild(del);
      }
      row.appendChild(ops);

      // 类型标记
      var badge = document.createElement('span');
      badge.className = 'sm-badge' + (item.builtin ? ' builtin' : ' custom');
      badge.textContent = item.builtin ? '内置' : '自定义';
      row.appendChild(badge);

      $smList.appendChild(row);
      autosizeSm(text);
    });
  }

  function mkOpBtn(iconName, title, disabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sm-op';
    b.innerHTML = icon(iconName);
    b.title = title;
    b.setAttribute('aria-label', title);
    if (disabled) b.disabled = true;
    return b;
  }

  function autosizeSm(area) {
    area.style.height = 'auto';
    area.style.height = (area.scrollHeight) + 'px';
  }

  /* ---------- 快速段落管理浮窗（两级嵌套：分组 → 段落） ---------- */
  var $qmOverlay = null, $qmList = null, qmKeyHandler = null;

  function moveInArray(arr, id, dir) {
    var i = -1;
    for (var k = 0; k < arr.length; k++) { if (arr[k].id === id) { i = k; break; } }
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= arr.length) return;
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }

  function afterQuickChange() {
    scheduleSave();
    renderQuickManager();
    renderQuick();
  }

  function ensureQuickManager() {
    if ($qmOverlay) return;
    $qmOverlay = document.createElement('div');
    $qmOverlay.className = 'sm-overlay';
    $qmOverlay.setAttribute('role', 'dialog');
    $qmOverlay.setAttribute('aria-modal', 'true');
    $qmOverlay.setAttribute('aria-label', '管理快速段落');
    $qmOverlay.innerHTML =
      '<div class="sm-panel">' +
        '<div class="sm-head">' +
          '<span class="sm-title">管理快速段落</span>' +
          '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="sm-hint">分组即左栏可下拉的 block · 勾选决定是否显示 · 点名称/内容可直接编辑 · 用 ↑↓ 调整顺序</div>' +
        '<div class="sm-list" id="qmList"></div>' +
        '<div class="sm-foot">' +
          '<button type="button" class="sm-add" id="qmAddGroup">' + icon('plus') + ' <span>新增分组</span></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild($qmOverlay);
    $qmList = $qmOverlay.querySelector('#qmList');

    $qmOverlay.addEventListener('mousedown', function (e) {
      if (e.target === $qmOverlay) closeQuickManager();
    });
    $qmOverlay.querySelector('.sm-close').addEventListener('click', closeQuickManager);
    $qmOverlay.querySelector('#qmAddGroup').addEventListener('click', function () {
      var g = { id: newQuickGroupId(), label: { zh: '新分组', en: 'New group' }, hidden: false, items: [] };
      state.quickGroups.push(g);
      afterQuickChange();
      var last = $qmList.querySelector('.qm-group:last-child .sm-tag');
      if (last) { last.focus(); last.select(); }
    });
  }

  function renderQuickManager() {
    if (!$qmList) return;
    var lang = state.lang;
    $qmList.innerHTML = '';

    if (state.quickGroups.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'qb-empty';
      empty.textContent = '还没有分组，点下方「新增分组」开始。';
      $qmList.appendChild(empty);
      return;
    }

    state.quickGroups.forEach(function (group, gIdx) {
      var wrap = document.createElement('div');
      wrap.className = 'qm-group';

      // 分组头部
      var head = document.createElement('div');
      head.className = 'qm-group-head';

      var order = document.createElement('div');
      order.className = 'qm-order';
      var up = mkOpBtn('chevron-up', '上移分组', gIdx === 0);
      up.addEventListener('click', function () { moveInArray(state.quickGroups, group.id, -1); afterQuickChange(); });
      var down = mkOpBtn('chevron-down', '下移分组', gIdx === state.quickGroups.length - 1);
      down.addEventListener('click', function () { moveInArray(state.quickGroups, group.id, 1); afterQuickChange(); });
      order.appendChild(up); order.appendChild(down);
      head.appendChild(order);

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sm-chk';
      chk.checked = !group.hidden;
      chk.title = '在左栏显示该分组';
      chk.addEventListener('change', function () { group.hidden = !chk.checked; afterQuickChange(); });
      head.appendChild(chk);

      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'sm-tag';
      nameInput.value = group.label[lang] || '';
      nameInput.maxLength = 24;
      nameInput.placeholder = lang === 'zh' ? '分组名称' : 'Group name';
      nameInput.addEventListener('input', function () { group.label[lang] = nameInput.value; scheduleSave(); renderQuick(); });
      head.appendChild(nameInput);

      var delGroup = mkOpBtn('trash-2', '删除分组', false);
      delGroup.classList.add('danger');
      delGroup.addEventListener('click', function () {
        var idx = state.quickGroups.indexOf(group);
        if (idx >= 0) state.quickGroups.splice(idx, 1);
        afterQuickChange();
      });
      head.appendChild(delGroup);
      wrap.appendChild(head);

      // 段落列表
      var itemsBox = document.createElement('div');
      itemsBox.className = 'qm-items';
      group.items.forEach(function (item, iIdx) {
        var row = document.createElement('div');
        row.className = 'qm-item-row';

        var iorder = document.createElement('div');
        iorder.className = 'qm-order';
        var iup = mkOpBtn('chevron-up', '上移', iIdx === 0);
        iup.addEventListener('click', function () { moveInArray(group.items, item.id, -1); afterQuickChange(); });
        var idown = mkOpBtn('chevron-down', '下移', iIdx === group.items.length - 1);
        idown.addEventListener('click', function () { moveInArray(group.items, item.id, 1); afterQuickChange(); });
        iorder.appendChild(iup); iorder.appendChild(idown);
        row.appendChild(iorder);

        var body = document.createElement('div');
        body.className = 'qm-item-body';
        var labInput = document.createElement('input');
        labInput.type = 'text';
        labInput.className = 'sm-tag';
        labInput.value = item.label[lang] || '';
        labInput.maxLength = 24;
        labInput.placeholder = lang === 'zh' ? '段落名称' : 'Paragraph name';
        labInput.addEventListener('input', function () { item.label[lang] = labInput.value; scheduleSave(); renderQuick(); });
        var txArea = document.createElement('textarea');
        txArea.className = 'sm-text';
        txArea.value = item.text[lang] || '';
        txArea.rows = 2;
        txArea.placeholder = lang === 'zh' ? '插入的中文文本（以 ## 开头会作为新块追加）' : 'Inserted English text';
        txArea.addEventListener('input', function () { item.text[lang] = txArea.value; autosizeSm(txArea); scheduleSave(); renderQuick(); });
        body.appendChild(labInput);
        body.appendChild(txArea);
        row.appendChild(body);

        var delItem = mkOpBtn('x', '删除段落', false);
        delItem.classList.add('danger');
        delItem.addEventListener('click', function () {
          var ii = group.items.indexOf(item);
          if (ii >= 0) group.items.splice(ii, 1);
          afterQuickChange();
        });
        row.appendChild(delItem);

        itemsBox.appendChild(row);
        autosizeSm(txArea);
      });
      wrap.appendChild(itemsBox);

      var addItem = document.createElement('button');
      addItem.type = 'button';
      addItem.className = 'qm-add-item';
      addItem.innerHTML = icon('plus') + ' <span>新增段落</span>';
      addItem.addEventListener('click', function () {
        group.items.push({ id: newQuickItemId(), label: { zh: '新段落', en: 'New paragraph' }, text: { zh: '', en: '' } });
        afterQuickChange();
        var rows = wrap.querySelectorAll('.qm-item-row');
        var lastLab = rows.length ? rows[rows.length - 1].querySelector('.sm-tag') : null;
        if (lastLab) { lastLab.focus(); lastLab.select(); }
      });
      wrap.appendChild(addItem);

      $qmList.appendChild(wrap);
    });
  }

  function openQuickManager() {
    ensureQuickManager();
    $qmOverlay.classList.add('show');
    renderQuickManager();
    qmKeyHandler = function (e) { if (e.key === 'Escape') closeQuickManager(); };
    document.addEventListener('keydown', qmKeyHandler);
    var first = $qmOverlay.querySelector('.sm-close');
    if (first) first.focus();
  }

  function closeQuickManager() {
    if (!$qmOverlay) return;
    $qmOverlay.classList.remove('show');
    if (qmKeyHandler) { document.removeEventListener('keydown', qmKeyHandler); qmKeyHandler = null; }
  }

  /* ============================================================
   * 8. 渲染：右栏编辑器 / 预览 / 状态
   * ============================================================ */
  function renderEditor() {
    if (view !== 'preview') renderBlocks();
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
  var hlEscape = Composer.hlEscape;
  var highlightInline = Composer.highlightInline;
  var highlightMarkdown = Composer.highlightMarkdown;

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
  }

  function deleteBlock(card) {
    var area = card.querySelector('.block-textarea');
    // 有内容时二次确认，空块直接删
    if (area && area.value.trim() && !window.confirm('删除这个块？')) return;
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

  /* ============================================================
   * 9. 语言 / 视图切换
   * ============================================================ */
  function setLang(lang) {
    if (state.lang === lang) return;
    // 切换前把当前编辑内容存回（仅编辑模式下 DOM 才是最新）
    if (view !== 'preview') collectText();
    state.lang = lang;
    renderAll();
    scheduleSave();
  }
  function toggleLang() { setLang(state.lang === 'zh' ? 'en' : 'zh'); }

  function renderLangSeg() {
    $langSegmented.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === state.lang ? 'true' : 'false');
    });
  }
  $langSegmented.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-lang]');
    if (b) setLang(b.dataset.lang);
  });

  function setView(v) {
    if (view === v) return;
    if (v === 'preview') collectText(); // 进预览前把块内容存回
    view = v;
    renderViewSeg();
    if (view === 'preview') {
      $blocks.hidden = true;
      $preview.hidden = false;
      renderPreview();
    } else {
      $preview.hidden = true;
      $blocks.hidden = false;
      renderBlocks();
    }
  }
  function toggleView() { setView(view === 'write' ? 'preview' : 'write'); }

  function renderViewSeg() {
    $viewSeg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === view ? 'true' : 'false');
    });
  }
  $viewSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  /* ============================================================
   * 10. 输出：复制 / 下载 / 示例 / 清空
   * ============================================================ */
  function doCopy() {
    if (view !== 'preview') collectText();
    var text = state.content[state.lang] || '';
    var langName = state.lang === 'zh' ? '中文' : 'English';
    if (clipboardApi && clipboardApi.writeText) {
      clipboardApi.writeText(text).then(function () { showToast('已复制' + langName + '提示词'); }).catch(function () { fallbackCopy(text, langName); });
    } else {
      fallbackCopy(text, langName);
    }
  }
  function fallbackCopy(text, langName) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('已复制' + langName + '提示词'); }).catch(function () { showToast('复制失败', true); });
    } else { showToast('复制失败：当前环境不支持', true); }
  }

  function doDownload() {
    if (view !== 'preview') collectText();
    var text = state.content[state.lang] || '';
    var defaultName = state.lang === 'zh' ? 'prompt-zh.md' : 'prompt-en.md';
    var langName = state.lang === 'zh' ? '中文' : 'English';
    if (dialogApi && dialogApi.save && fsApi && fsApi.writeTextFile) {
      dialogApi.save({ defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] })
        .then(function (filePath) {
          if (!filePath) return;
          return fsApi.writeTextFile(filePath, text).then(function () { showToast('已下载' + langName + '提示词'); });
        })
        .catch(function () { showToast('下载失败', true); });
    } else {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast('已下载' + langName + '提示词');
    }
  }

  $btnCopy.addEventListener('click', doCopy);
  $btnDownload.addEventListener('click', doDownload);

  var $btnManageSnippets = document.getElementById('btnManageSnippets');
  if ($btnManageSnippets) $btnManageSnippets.addEventListener('click', openSnippetManager);
  var $btnManageModules = document.getElementById('btnManageModules');
  if ($btnManageModules) $btnManageModules.addEventListener('click', openModuleManager);
  var $btnManageQuick = document.getElementById('btnManageQuick');
  if ($btnManageQuick) $btnManageQuick.addEventListener('click', openQuickManager);

  var $btnCheckUpdate = document.getElementById('btnCheckUpdate');
  if ($btnCheckUpdate) $btnCheckUpdate.addEventListener('click', function () { checkForUpdate(true); });

  /* ============================================================
   * 12.0 设置面板：快捷键录制（项1） + 粘贴前等待 ms（项2）
   * ------------------------------------------------------------
   * 只有主窗口负责把 state.settings.toggleShortcut 应用到 Rust 侧
   * （invoke set_toggle_shortcut），浮窗不做这件事，避免两个窗口在
   * 启动时争相注册同一个全局热键。
   * ============================================================ */
  var $stOverlay = null, $stRecorderBox = null, $stDelayInput = null;
  var stKeyHandler = null;
  var isRecordingShortcut = false;

  // Rust 命令返回 Result<(), String> 时，invoke 失败会直接以该字符串 reject，
  // 不是一个带 .message 的 Error 对象；做个防御性兜底，避免显示 [object Object]。
  function formatInvokeError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return String(err); } catch (e) { return '未知错误'; }
  }

  // accelerator 主键映射：event.code -> Tauri accelerator 里的主键片段。
  // 纯修饰键（Control/Alt/Shift/Meta 本身）不算主键，需要过滤掉。
  var MODIFIER_CODES = {
    ControlLeft: true, ControlRight: true,
    AltLeft: true, AltRight: true,
    ShiftLeft: true, ShiftRight: true,
    MetaLeft: true, MetaRight: true, OSLeft: true, OSRight: true
  };
  var ARROW_CODE_MAP = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  function codeToMainKey(code) {
    if (!code || MODIFIER_CODES[code]) return null;
    if (ARROW_CODE_MAP[code]) return ARROW_CODE_MAP[code];
    if (code === 'Space') return 'Space';
    if (/^F([1-9]|1[0-2])$/.test(code)) return code; // F1..F12 原样
    var km = code.match(/^Key([A-Z])$/);
    if (km) return km[1];
    var dm = code.match(/^Digit([0-9])$/);
    if (dm) return dm[1];
    // 其余（Comma、Period、Minus 等）没有在规格里列出映射，兜底直接去掉前缀分类词，
    // 拿不准的场景宁可让用户重录，也不要生成一个 Tauri 不认识的 accelerator。
    return null;
  }

  function formatAccelerator(e) {
    var mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    var mainKey = codeToMainKey(e.code);
    if (mods.length === 0 || !mainKey) return null;
    return mods.concat([mainKey]).join('+');
  }

  function ensureSettingsPanel() {
    if ($stOverlay) return;
    $stOverlay = document.createElement('div');
    $stOverlay.className = 'sm-overlay';
    $stOverlay.setAttribute('role', 'dialog');
    $stOverlay.setAttribute('aria-modal', 'true');
    $stOverlay.setAttribute('aria-label', '设置');
    $stOverlay.innerHTML =
      '<div class="sm-panel st-panel">' +
        '<div class="sm-head">' +
          '<span class="sm-title">设置</span>' +
          '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="st-body">' +
          '<div class="st-field">' +
            '<span class="st-label">呼出浮窗快捷键</span>' +
            '<span class="st-desc">点击输入框后按下新的组合键（至少一个 Ctrl/Alt/Shift/Super + 一个主键），松开自动保存。</span>' +
            '<div class="st-recorder">' +
              '<div class="st-recorder-box" id="stRecorderBox" tabindex="0" role="button" aria-label="点击录制快捷键"></div>' +
              '<button type="button" class="st-recorder-clear" id="stRecorderReset" title="恢复默认（Ctrl+Alt+C）" aria-label="恢复默认快捷键">' + icon('rotate-ccw') + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="st-field">' +
            '<span class="st-label">粘贴前等待</span>' +
            '<span class="st-desc">自动粘贴前等待焦点切换到目标窗口的时长，切换较慢的电脑可以调大一些。</span>' +
            '<div class="st-delay-row">' +
              '<input type="number" class="st-delay-input" id="stDelayInput" min="30" max="500" step="10" />' +
              '<span class="st-delay-unit">毫秒（30–500）</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="st-foot-hint">改动会立即保存并同步到浮窗。</div>' +
      '</div>';
    document.body.appendChild($stOverlay);
    $stRecorderBox = $stOverlay.querySelector('#stRecorderBox');
    $stDelayInput = $stOverlay.querySelector('#stDelayInput');

    $stOverlay.addEventListener('mousedown', function (e) {
      if (e.target === $stOverlay) closeSettingsPanel();
    });
    $stOverlay.querySelector('.sm-close').addEventListener('click', closeSettingsPanel);

    $stRecorderBox.addEventListener('click', startRecordingShortcut);
    $stRecorderBox.addEventListener('keydown', function (e) {
      // 空格/回车 激活录制态；录制态本身的按键在 startRecordingShortcut 里单独监听
      if (!isRecordingShortcut && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        startRecordingShortcut();
      }
    });

    $stOverlay.querySelector('#stRecorderReset').addEventListener('click', function () {
      applyToggleShortcut('Ctrl+Alt+C');
    });

    $stDelayInput.addEventListener('change', function () {
      var v = parseInt($stDelayInput.value, 10);
      if (!isFinite(v)) v = 60;
      v = Math.min(500, Math.max(30, v));
      $stDelayInput.value = v;
      state.settings.pasteDelayMs = v;
      scheduleSave();
      showToast('粘贴等待时长已更新为 ' + v + ' 毫秒');
    });
  }

  function renderSettingsPanel() {
    if (!$stOverlay || isRecordingShortcut) return;
    $stRecorderBox.textContent = state.settings.toggleShortcut;
    $stDelayInput.value = state.settings.pasteDelayMs;
  }

  function startRecordingShortcut() {
    if (isRecordingShortcut) return;
    isRecordingShortcut = true;
    var previous = state.settings.toggleShortcut;
    $stRecorderBox.classList.add('recording');
    $stRecorderBox.textContent = '请按下快捷键…';

    function finish(newAccelerator) {
      isRecordingShortcut = false;
      $stRecorderBox.classList.remove('recording');
      document.removeEventListener('keydown', onKeydown, true);
      if (newAccelerator) {
        applyToggleShortcut(newAccelerator);
      } else {
        $stRecorderBox.textContent = previous;
      }
    }

    function onKeydown(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { finish(null); return; }
      var accelerator = formatAccelerator(e);
      if (!accelerator) {
        // 无效组合（缺修饰键或缺主键）：提示但保持录制态，让用户重试
        $stRecorderBox.textContent = '无效组合，请至少按 1 个修饰键 + 1 个主键';
        return;
      }
      finish(accelerator);
    }

    document.addEventListener('keydown', onKeydown, true);
  }

  // 应用新快捷键：先本地更新 + 保存 + 广播（前端体验立即生效），
  // 再调用 Rust 命令真正切换全局注册；失败则把显示值回滚为旧值并提示原因。
  function applyToggleShortcut(accelerator) {
    var previous = state.settings.toggleShortcut;
    state.settings.toggleShortcut = accelerator;
    if ($stRecorderBox) $stRecorderBox.textContent = accelerator;
    scheduleSave();

    if (!coreApi || !coreApi.invoke) {
      showToast('当前环境不支持设置全局快捷键（仅桌面应用可用）', true);
      return;
    }
    coreApi.invoke('set_toggle_shortcut', { accelerator: accelerator }).then(function () {
      showToast('快捷键已更新为 ' + accelerator);
    }).catch(function (err) {
      var reason = formatInvokeError(err);
      showToast('快捷键设置失败：' + reason, true);
      // 回滚：注册失败时 Rust 侧会把旧热键重新注册回来（仍可用），
      // 这里只需把前端显示与持久化的值同步回旧值，保持一致。
      state.settings.toggleShortcut = previous;
      if ($stRecorderBox && !isRecordingShortcut) $stRecorderBox.textContent = previous;
      scheduleSave();
    });
  }

  // 启动时把持久化的自定义热键应用到 Rust 侧。只有主窗口做这件事。
  function applyStartupShortcut() {
    if (!coreApi || !coreApi.invoke) return;
    coreApi.invoke('set_toggle_shortcut', { accelerator: state.settings.toggleShortcut }).catch(function (err) {
      var reason = formatInvokeError(err);
      console.warn('启动时应用自定义快捷键失败：', reason);
    });
  }

  function openSettingsPanel() {
    ensureSettingsPanel();
    renderSettingsPanel();
    $stOverlay.classList.add('show');
    stKeyHandler = function (e) { if (e.key === 'Escape' && !isRecordingShortcut) closeSettingsPanel(); };
    document.addEventListener('keydown', stKeyHandler);
    $stRecorderBox.focus();
  }

  function closeSettingsPanel() {
    if (!$stOverlay) return;
    if (isRecordingShortcut) return; // 录制中先不关闭，避免误触丢失操作
    $stOverlay.classList.remove('show');
    if (stKeyHandler) { document.removeEventListener('keydown', stKeyHandler); stKeyHandler = null; }
  }

  var $btnEditorSettings = document.getElementById('btnEditorSettings');
  if ($btnEditorSettings) $btnEditorSettings.addEventListener('click', openSettingsPanel);

  /* ============================================================
   * 12.1 浮窗开关：显示/隐藏 label 为 'float' 的窗口
   * ============================================================ */
  var $btnFloatWindow = document.getElementById('btnFloatWindow');
  if ($btnFloatWindow) {
    if (webviewWindowApi && webviewWindowApi.WebviewWindow) {
      $btnFloatWindow.addEventListener('click', function () {
        var floatWin = webviewWindowApi.WebviewWindow.getByLabel
          ? webviewWindowApi.WebviewWindow.getByLabel('float')
          : null;
        var resolved = floatWin && typeof floatWin.then === 'function' ? floatWin : Promise.resolve(floatWin);
        resolved.then(function (win) {
          if (!win) { showToast('未找到浮窗，请重启应用', true); return; }
          win.isVisible().then(function (visible) {
            if (visible) win.hide(); else win.show().then(function () { win.setFocus(); });
          }).catch(function () { win.show(); });
        }).catch(function () { showToast('浮窗不可用', true); });
      });
    } else {
      // 非 Tauri 环境（浏览器预览）：无浮窗窗口可控制，禁用按钮
      $btnFloatWindow.disabled = true;
      $btnFloatWindow.title = '浮窗（仅桌面应用可用）';
    }
  }

  var $themeToggle = document.getElementById('themeToggle');
  $themeToggle.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    try { localStorage.setItem('composer-theme', dark ? 'light' : 'dark'); } catch (e) {}
  });

  $btnLoadDemo.addEventListener('click', function () {
    state.content = demoContent();
    if (view === 'preview') setView('write');
    renderAll();
    scheduleSave();
    showToast('已载入模板');
  });

  $btnClearAll.addEventListener('click', function () {
    if (!(state.content[state.lang] || '').trim()) { showToast('当前语言正文已经是空的'); return; }
    state.content[state.lang] = '';
    if (view === 'preview') setView('write');
    renderAll();
    scheduleSave();
    showToast('已清空' + (state.lang === 'zh' ? '中文' : 'English') + '正文');
  });

  /* ============================================================
   * 11. 快捷键
   * ============================================================ */
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var key = e.key.toLowerCase();
    if (key === 'l') { e.preventDefault(); toggleLang(); }
    else if (key === 's') { e.preventDefault(); doDownload(); }
    else if (key === 'p') { e.preventDefault(); toggleView(); }
    else if (key === 'c') {
      var sel = window.getSelection && window.getSelection().toString();
      var tag = document.activeElement && document.activeElement.tagName;
      var inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if (!sel && !inField) { e.preventDefault(); doCopy(); }
    }
  });

  /* ============================================================
   * 12. 检查更新
   * ============================================================ */
  var checkingUpdate = false;
  function checkForUpdate(manual) {
    if (!updaterApi) { if (manual) showToast('当前环境不支持自动更新'); return; }
    if (checkingUpdate) return;
    checkingUpdate = true;
    updaterApi.check().then(function (update) {
      checkingUpdate = false;
      if (!update) { if (manual) showToast('已是最新版本'); return; }
      var ok = window.confirm('发现新版本 ' + update.version + '，是否立即下载并安装？\n\n' + (update.body || ''));
      if (!ok) return;
      showToast('正在下载更新…');
      update.downloadAndInstall().then(function () {
        showToast('更新完成，即将重启');
        if (processApi) processApi.relaunch();
      }).catch(function (err) {
        showToast('更新安装失败：' + (err && err.message ? err.message : err), true);
      });
    }).catch(function (err) {
      checkingUpdate = false;
      if (manual) showToast('检查更新失败：' + (err && err.message ? err.message : err), true);
    });
  }

  /* ============================================================
   * 13. 汇总渲染
   * ============================================================ */
  function renderAll() {
    renderLangSeg();
    renderViewSeg();
    renderInsertGrid();
    renderSnippets();
    renderQuick();
    renderEditor();
    if ($smOverlay && $smOverlay.classList.contains('show')) renderSnippetManager();
    if ($qmOverlay && $qmOverlay.classList.contains('show')) renderQuickManager();
    if ($stOverlay && $stOverlay.classList.contains('show')) renderSettingsPanel();
  }

  restoreState();
  setTimeout(function () { checkForUpdate(false); }, 3000);
})();
