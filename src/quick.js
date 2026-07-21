/* ============================================================
 * quick.js —— 快速段落 + 通用管理浮窗（常用句/插入模块）+ 快速段落管理
 * ------------------------------------------------------------
 * 依赖 store.js 的状态/DOM/工具、core.js 的纯函数与 patch 逻辑、
 * render.js 的左栏渲染。对外导出各浮窗的 open/render/close 与
 * 其 overlay 引用（renderAll / events 需要）。
 * ============================================================ */
import {
  icon,
  BUILTIN_BY_ID,
  MODULE_BY_ID,
  newSnippetId,
  newModuleId,
  newQuickGroupId,
  newQuickItemId,
  patchBuiltinSnippet as corePatchBuiltinSnippet,
  patchBuiltinModule as corePatchBuiltinModule,
} from './core.js';
import {
  state,
  scheduleSave,
  showToast,
  insertSnippet,
  $quickWrap,
} from './store.js';
import {
  renderSnippets,
  renderInsertGrid,
  orderedSnippets,
  orderedModules,
} from './render.js';

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
    corePatchBuiltinSnippet(id, state, field, value);
  }
  function updateCustomSnippetField(id, field, value) {
    for (var i = 0; i < state.customSnippets.length; i++) {
      if (state.customSnippets[i].id === id) { state.customSnippets[i][field] = value; return; }
    }
  }

  // 内置模块 patch 清除逻辑已抽离到 core.js（纯函数，显式传入 state）
  function patchBuiltinModule(id, field, value) {
    corePatchBuiltinModule(id, state, field, value);
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
    // 指针可能被设置面板的内嵌 tab 抢走过，打开 overlay 时先指回 overlay 自己的 DOM，
    // 否则无参的 renderSnippetManager 会渲染到 tab 容器而非弹窗。
    $smList = $smOverlay.querySelector('#smList');
    $smAddBtn = $smOverlay.querySelector('#smAdd');
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

    // 同 renderQuickManager：首帧布局未就绪时 scrollHeight 读到 0，下一帧补算。
    requestAnimationFrame(function () {
      if (!$smList) return;
      $smList.querySelectorAll('.sm-text').forEach(autosizeSm);
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
    var h = area.scrollHeight;
    // 容器尚未完成布局时 scrollHeight 可能为 0，此时别把 height 固定成 0px
    // 导致内容被裁切；保留 auto，交给渲染末尾的 rAF 补算。
    if (h > 0) {
      // box-sizing:border-box 下 height 含边框，而 scrollHeight 不含，
      // 直接用会少算上下边框那几像素、末行被切；补上边框宽度。
      var cs = window.getComputedStyle(area);
      var bw = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      area.style.height = (h + bw) + 'px';
    }
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
        txArea.rows = 1; // 高度由 autosizeSm 撑开，rows=2 会让单行内容也占两行
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

    // 首次渲染时容器可能尚未完成布局，textarea 的 scrollHeight 读到 0，
    // 高度撑不开导致多行内容被裁切；下一帧布局就绪后统一补算一次。
    requestAnimationFrame(function () {
      if (!$qmList) return;
      $qmList.querySelectorAll('.sm-text').forEach(autosizeSm);
    });
  }

  function openQuickManager() {
    ensureQuickManager();
    // 同 openManager：指针可能被内嵌 tab 抢走，打开弹窗时先指回 overlay 自己的列表容器。
    $qmList = $qmOverlay.querySelector('#qmList');
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
   * 设置面板内嵌入口：把三个管理器渲染进设置 tab 的容器里，
   * 复用上面 overlay 版本的同一套 render/编辑逻辑（改动仍即时保存）。
   * 做法：在 host 内构建与 overlay 相同的 list + add 结构，并把模块级
   * 指针（$smList/$smAddBtn/SM 或 $qmList）指向这套 DOM，再调对应 render。
   * overlay 的 open* 会在打开时把指针指回自己，两者不会同时可见，安全。
   * ============================================================ */

  // 常用句 / 插入模块：内嵌进设置 tab
  function mountManagerInto(host, adapter) {
    host.innerHTML =
      '<div class="sm-hint sm-embed-hint"></div>' +
      '<div class="sm-list sm-embed-list"></div>' +
      '<div class="sm-foot">' +
        '<button type="button" class="sm-add sm-embed-add">' + icon('plus') + ' <span class="sm-add-label"></span></button>' +
      '</div>';
    host.querySelector('.sm-embed-hint').textContent = adapter.hint;
    host.querySelector('.sm-add-label').textContent = adapter.addLabel;

    // 指针指向内嵌 DOM，后续无参重渲染都打到这里
    $smList = host.querySelector('.sm-embed-list');
    $smAddBtn = host.querySelector('.sm-embed-add');
    SM = adapter;
    $smAddBtn.addEventListener('click', function () { if (SM === adapter) adapter.addCustom(); });
    renderSnippetManager();
  }
  function mountSnippetManagerInto(host) { mountManagerInto(host, snippetAdapter()); }
  function mountModuleManagerInto(host) { mountManagerInto(host, moduleAdapter()); }

  // 快速段落：内嵌进设置 tab
  function mountQuickManagerInto(host) {
    host.innerHTML =
      '<div class="sm-hint sm-embed-hint">分组即左栏可下拉的 block · 勾选决定是否显示 · 点名称/内容可直接编辑 · 用 ↑↓ 调整顺序</div>' +
      '<div class="sm-list sm-embed-list" id="qmListEmbed"></div>' +
      '<div class="sm-foot">' +
        '<button type="button" class="sm-add sm-embed-add-group">' + icon('plus') + ' <span>新增分组</span></button>' +
      '</div>';
    $qmList = host.querySelector('#qmListEmbed');
    host.querySelector('.sm-embed-add-group').addEventListener('click', function () {
      var g = { id: newQuickGroupId(), label: { zh: '新分组', en: 'New group' }, hidden: false, items: [] };
      state.quickGroups.push(g);
      afterQuickChange();
      var last = $qmList.querySelector('.qm-group:last-child .sm-tag');
      if (last) { last.focus(); last.select(); }
    });
    renderQuickManager();
  }

  export {
    // 设置面板内嵌入口
    mountSnippetManagerInto, mountModuleManagerInto, mountQuickManagerInto,
    // 快速段落（左栏）
    renderQuick,
    // 通用管理浮窗
    ensureSnippetManager, snippetAdapter, moduleAdapter, focusLastRow, renderLeft,
    patchBuiltinSnippet, updateCustomSnippetField, patchBuiltinModule,
    updateCustomModuleField, updateCustomModuleHidden,
    openSnippetManager, openModuleManager, openManager, closeSnippetManager,
    moveManagerItem, renderSnippetManager, mkOpBtn, autosizeSm,
    // 快速段落管理浮窗
    moveInArray, afterQuickChange, ensureQuickManager, renderQuickManager,
    openQuickManager, closeQuickManager,
    // overlay 引用（renderAll 判断是否需要重渲染）
    $smOverlay, $qmOverlay,
  };
