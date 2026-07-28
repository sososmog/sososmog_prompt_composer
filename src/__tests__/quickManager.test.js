/* ============================================================
 * quickManager.test.js —— 素材管理浮窗（quick.js）的 DOM 层测试
 * ------------------------------------------------------------
 * §4 的纯函数（materialOps.test.js）保证了数据变换本身正确；这份测试
 * 管的是另一半：点击按钮到底有没有接上那些函数，改完之后左栏有没有跟着
 * 重渲染。两者都断了才会出现「点了删除、弹窗里没了、下次打开又回来」
 * 这类只在真机上才发现的问题。
 *
 * DOM 与 import 顺序的约束同 mainWindow.test.js：先灌真实 index.html 的
 * <body>，再动态 import，且必须先 import events.js（events.js ⇄ store.js
 * 是循环依赖，反过来会在 store.js 的 var 赋值前触发 events.js 顶层绑定）。
 * ============================================================ */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var rawIndexHtml = readFileSync(path.resolve(here, '../index.html'), 'utf-8');

function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>，DOM 层测试的地基就没了');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}
var BODY_HTML = extractBodyHtml(rawIndexHtml);

// 在输入框/文本域里模拟用户键入：直接赋 value 不会触发 input 监听。
function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

var events, store, quick;

beforeEach(async function () {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;
  window.confirm = vi.fn(function () { return true; });

  events = await import('../events.js');
  store = await import('../store.js');
  quick = await import('../quick.js');
  events.renderAll();
});

/* ---------- 快速段落管理浮窗：分组 / 段落的增删改排序 ---------- */

describe('快速段落管理浮窗：打开与渲染', function () {
  it('打开后每个分组渲染一行，段落数与 state 一致', function () {
    quick.openQuickManager();

    var groups = document.querySelectorAll('#qmList .qm-group');
    expect(groups.length).toBe(store.state.quickGroups.length);
    expect(groups.length).toBeGreaterThan(0);

    var firstItems = groups[0].querySelectorAll('.qm-item-row');
    expect(firstItems.length).toBe(store.state.quickGroups[0].items.length);
  });

  it('Esc 关闭浮窗（show class 摘掉）', function () {
    quick.openQuickManager();
    var overlay = document.querySelector('#qmList').closest('.sm-overlay');
    expect(overlay.classList.contains('show')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.classList.contains('show')).toBe(false);
  });
});

describe('快速段落管理浮窗：新增', function () {
  it('点「新增分组」后 state 多一个分组，弹窗与左栏都跟着更新', function () {
    quick.openQuickManager();
    var before = store.state.quickGroups.length;
    var leftBefore = document.querySelectorAll('#quickWrap .quick-block').length;

    document.getElementById('qmAddGroup').click();

    expect(store.state.quickGroups.length).toBe(before + 1);
    expect(document.querySelectorAll('#qmList .qm-group').length).toBe(before + 1);
    // 新分组默认可见（hidden:false），左栏应立刻多出一个 block
    expect(document.querySelectorAll('#quickWrap .quick-block').length).toBe(leftBefore + 1);
  });

  it('点分组内「新增段落」后该分组多一条，其他分组不受影响', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];
    var g1 = store.state.quickGroups[1];
    var before0 = g0.items.length;
    var before1 = g1.items.length;

    document.querySelectorAll('#qmList .qm-group')[0].querySelector('.qm-add-item').click();

    expect(g0.items.length).toBe(before0 + 1);
    expect(g1.items.length).toBe(before1);
    expect(document.querySelectorAll('#qmList .qm-group')[0]
      .querySelectorAll('.qm-item-row').length).toBe(before0 + 1);
  });

  it('新增的分组/段落 id 唯一，连点两次不会撞', function () {
    quick.openQuickManager();
    document.getElementById('qmAddGroup').click();
    document.getElementById('qmAddGroup').click();

    var ids = store.state.quickGroups.map(function (g) { return g.id; });
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('快速段落管理浮窗：删除', function () {
  it('删掉分组后 state 与左栏同步减少，其余分组内容不变', function () {
    quick.openQuickManager();
    var before = store.state.quickGroups.length;
    var victimId = store.state.quickGroups[0].id;
    var survivorId = store.state.quickGroups[1].id;
    var survivorItems = store.state.quickGroups[1].items.length;

    document.querySelectorAll('#qmList .qm-group')[0].querySelector('.sm-op.danger').click();

    expect(store.state.quickGroups.length).toBe(before - 1);
    expect(store.state.quickGroups.some(function (g) { return g.id === victimId; })).toBe(false);
    var survivor = store.state.quickGroups.find(function (g) { return g.id === survivorId; });
    expect(survivor.items.length).toBe(survivorItems);
  });

  it('删掉段落只影响所在分组，且删的是被点那一条', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];
    var before = g0.items.length;
    expect(before).toBeGreaterThan(1); // 演示数据得有至少两条，否则这个用例测不到"删对了哪条"
    var victimId = g0.items[0].id;
    var keepId = g0.items[1].id;

    var rows = document.querySelectorAll('#qmList .qm-group')[0].querySelectorAll('.qm-item-row');
    rows[0].querySelector('.sm-op.danger').click();

    expect(g0.items.length).toBe(before - 1);
    expect(g0.items.some(function (i) { return i.id === victimId; })).toBe(false);
    expect(g0.items[0].id).toBe(keepId);
  });

  it('把某个分组的段落删空后，弹窗仍能继续给它新增（不卡死）', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];
    var groupEl = function () { return document.querySelectorAll('#qmList .qm-group')[0]; };

    while (g0.items.length > 0) {
      groupEl().querySelectorAll('.qm-item-row')[0].querySelector('.sm-op.danger').click();
    }
    expect(g0.items).toEqual([]);

    groupEl().querySelector('.qm-add-item').click();
    expect(g0.items.length).toBe(1);
  });
});

describe('快速段落管理浮窗：排序', function () {
  it('下移分组后 state 顺序与左栏顺序同时改变', function () {
    quick.openQuickManager();
    var firstId = store.state.quickGroups[0].id;
    var secondId = store.state.quickGroups[1].id;

    // .qm-order 里第一个是上移、第二个是下移
    var ops = document.querySelectorAll('#qmList .qm-group')[0]
      .querySelector('.qm-group-head .qm-order').querySelectorAll('.sm-op');
    ops[1].click();

    expect(store.state.quickGroups[0].id).toBe(secondId);
    expect(store.state.quickGroups[1].id).toBe(firstId);
  });

  it('首个分组的「上移」按钮是 disabled，末个分组的「下移」是 disabled', function () {
    quick.openQuickManager();
    var groups = document.querySelectorAll('#qmList .qm-group');
    var firstOps = groups[0].querySelector('.qm-group-head .qm-order').querySelectorAll('.sm-op');
    var lastOps = groups[groups.length - 1].querySelector('.qm-group-head .qm-order').querySelectorAll('.sm-op');

    expect(firstOps[0].disabled).toBe(true);
    expect(lastOps[1].disabled).toBe(true);
  });

  it('下移段落后分组内顺序改变，段落不会串到别的分组', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];
    var g1 = store.state.quickGroups[1];
    var g1Count = g1.items.length;
    var a = g0.items[0].id;
    var b = g0.items[1].id;

    var rows = document.querySelectorAll('#qmList .qm-group')[0].querySelectorAll('.qm-item-row');
    rows[0].querySelector('.qm-order').querySelectorAll('.sm-op')[1].click();

    expect(g0.items[0].id).toBe(b);
    expect(g0.items[1].id).toBe(a);
    expect(g1.items.length).toBe(g1Count);
  });

  it('上移到顶后按钮变 disabled，序列不再变化', function () {
    quick.openQuickManager();
    var lastIdx = store.state.quickGroups.length - 1;
    var movingId = store.state.quickGroups[lastIdx].id;

    for (var n = 0; n < lastIdx; n++) {
      // 每次重渲染后 DOM 都是新的，按当前 state 下标去认行（分组名可能重复，
      // 不能靠名称找）
      var idx = store.state.quickGroups.findIndex(function (g) { return g.id === movingId; });
      document.querySelectorAll('#qmList .qm-group')[idx]
        .querySelector('.qm-group-head .qm-order').querySelectorAll('.sm-op')[0].click();
    }

    expect(store.state.quickGroups[0].id).toBe(movingId);
    var topOps = document.querySelectorAll('#qmList .qm-group')[0]
      .querySelector('.qm-group-head .qm-order').querySelectorAll('.sm-op');
    expect(topOps[0].disabled).toBe(true);
  });
});

describe('快速段落管理浮窗：编辑与可见性', function () {
  it('改分组名称后 state 更新，左栏 block 标题同步', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];

    typeInto(document.querySelectorAll('#qmList .qm-group')[0].querySelector('.sm-tag'), '改过的分组名');

    expect(g0.label.zh).toBe('改过的分组名');
    var names = Array.prototype.map.call(
      document.querySelectorAll('#quickWrap .quick-block .qb-name'),
      function (el) { return el.textContent; }
    );
    expect(names).toContain('改过的分组名');
  });

  it('改段落正文后 state 更新（左栏点它插入的就是这段新文本）', function () {
    quick.openQuickManager();
    var item = store.state.quickGroups[0].items[0];

    var row = document.querySelectorAll('#qmList .qm-group')[0].querySelectorAll('.qm-item-row')[0];
    typeInto(row.querySelector('.sm-text'), '换成新的正文内容。');

    expect(item.text.zh).toBe('换成新的正文内容。');
  });

  it('取消勾选分组后 hidden 置真、左栏不再显示它，重新勾选可恢复', function () {
    quick.openQuickManager();
    var g0 = store.state.quickGroups[0];
    var leftBefore = document.querySelectorAll('#quickWrap .quick-block').length;

    var chk = document.querySelectorAll('#qmList .qm-group')[0].querySelector('.sm-chk');
    chk.checked = false;
    chk.dispatchEvent(new Event('change', { bubbles: true }));

    expect(g0.hidden).toBe(true);
    expect(document.querySelectorAll('#quickWrap .quick-block').length).toBe(leftBefore - 1);

    var chk2 = document.querySelectorAll('#qmList .qm-group')[0].querySelector('.sm-chk');
    chk2.checked = true;
    chk2.dispatchEvent(new Event('change', { bubbles: true }));

    expect(g0.hidden).toBe(false);
    expect(document.querySelectorAll('#quickWrap .quick-block').length).toBe(leftBefore);
  });

  it('隐藏全部分组后左栏显示空态提示，而不是空白一片', function () {
    quick.openQuickManager();
    store.state.quickGroups.forEach(function (g) { g.hidden = true; });
    quick.renderQuick();

    expect(document.querySelectorAll('#quickWrap .quick-block').length).toBe(0);
    expect(document.querySelector('#quickWrap .quick-empty')).not.toBe(null);
  });
});

describe('快速段落左栏：展开与插入', function () {
  it('点分组头展开列出段落，再点收起（同时只展开一个）', function () {
    var blocks = document.querySelectorAll('#quickWrap .quick-block');
    expect(blocks[0].querySelector('.qb-list')).toBe(null);

    blocks[0].querySelector('.qb-head').click();
    var opened = document.querySelectorAll('#quickWrap .quick-block')[0];
    expect(opened.classList.contains('open')).toBe(true);
    expect(opened.querySelectorAll('.qb-item').length).toBe(store.state.quickGroups[0].items.length);

    // 展开第二个，第一个应自动收起
    document.querySelectorAll('#quickWrap .quick-block')[1].querySelector('.qb-head').click();
    var after = document.querySelectorAll('#quickWrap .quick-block');
    expect(after[0].classList.contains('open')).toBe(false);
    expect(after[1].classList.contains('open')).toBe(true);
  });

  it('点段落把文本插进正文', function () {
    var blocks = document.querySelectorAll('#quickWrap .quick-block');
    blocks[0].querySelector('.qb-head').click();
    var firstItemText = store.state.quickGroups[0].items[0].text.zh;
    expect(firstItemText).toBeTruthy();

    var areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].focus();
    areas[0].setSelectionRange(areas[0].value.length, areas[0].value.length);

    document.querySelectorAll('#quickWrap .quick-block')[0].querySelectorAll('.qb-item')[0].click();

    expect(store.state.content.zh).toContain(firstItemText.trim().slice(0, 8));
  });

  it('点了空内容的段落只提示、不插入空白', function () {
    var g0 = store.state.quickGroups[0];
    g0.items[0].text.zh = '';
    quick.renderQuick();
    var before = store.state.content.zh;

    document.querySelectorAll('#quickWrap .quick-block')[0].querySelector('.qb-head').click();
    document.querySelectorAll('#quickWrap .quick-block')[0].querySelectorAll('.qb-item')[0].click();

    expect(store.state.content.zh).toBe(before);
  });

  it('删掉当前展开的分组后不残留展开态（回归：openQuickGroupId 悬空）', function () {
    document.querySelectorAll('#quickWrap .quick-block')[0].querySelector('.qb-head').click();
    expect(document.querySelectorAll('#quickWrap .quick-block.open').length).toBe(1);

    quick.openQuickManager();
    document.querySelectorAll('#qmList .qm-group')[0].querySelector('.sm-op.danger').click();

    expect(document.querySelectorAll('#quickWrap .quick-block.open').length).toBe(0);
  });
});

/* ---------- 通用管理器（常用句 / 插入模块）---------- */

describe('常用句管理器', function () {
  it('打开后每条常用句一行，含内置与自定义', function () {
    quick.openSnippetManager();
    var rows = document.querySelectorAll('.sm-overlay.show .sm-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.sm-overlay.show .sm-badge.builtin').length).toBeGreaterThan(0);
  });

  it('新增自定义常用句后 customSnippets 与 snippetOrder 同时增长', function () {
    quick.openSnippetManager();
    var beforeList = store.state.customSnippets.length;
    var beforeOrder = store.state.snippetOrder.length;

    document.getElementById('smAdd').click();

    expect(store.state.customSnippets.length).toBe(beforeList + 1);
    expect(store.state.snippetOrder.length).toBe(beforeOrder + 1);
  });

  it('删除自定义常用句后 order 里不留孤儿 id（左栏与管理器顺序才不会错位）', function () {
    quick.openSnippetManager();
    document.getElementById('smAdd').click();
    var added = store.state.customSnippets[store.state.customSnippets.length - 1];

    // 找到这条新增项所在行的删除按钮（自定义项的操作区第三个是删除）
    var rows = document.querySelectorAll('.sm-overlay.show .sm-row');
    var target = null;
    rows.forEach(function (r) {
      if (r.querySelector('.sm-tag').value === added.tag &&
          r.querySelector('.sm-badge.custom')) target = r;
    });
    expect(target).not.toBe(null);
    target.querySelector('.sm-op.danger').click();

    expect(store.state.snippetOrder).not.toContain(added.id);
    expect(store.state.customSnippets.some(function (s) { return s.id === added.id; })).toBe(false);
  });

  it('改内置句标签写进 builtinPatches，恢复默认按钮随之可用', function () {
    quick.openSnippetManager();
    var row = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (!row && r.querySelector('.sm-badge.builtin')) row = r;
    });

    typeInto(row.querySelector('.sm-tag'), '我改的标签');
    expect(Object.keys(store.state.builtinPatches).length).toBeGreaterThan(0);

    // 重新渲染后该行的"恢复默认"按钮应可点
    quick.renderSnippetManager();
    var again = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (!again && r.querySelector('.sm-tag').value === '我改的标签') again = r;
    });
    var ops = again.querySelectorAll('.sm-op');
    expect(ops[ops.length - 1].disabled).toBe(false);

    ops[ops.length - 1].click(); // 恢复默认
    expect(store.state.builtinPatches).toEqual({});
  });

  it('上移常用句改变 snippetOrder，首行上移按钮 disabled', function () {
    quick.openSnippetManager();
    var order = store.state.snippetOrder;
    var second = order[1];
    var first = order[0];

    var rows = document.querySelectorAll('.sm-overlay.show .sm-row');
    rows[1].querySelectorAll('.sm-op')[0].click(); // 第二行上移

    expect(store.state.snippetOrder[0]).toBe(second);
    expect(store.state.snippetOrder[1]).toBe(first);
    expect(document.querySelectorAll('.sm-overlay.show .sm-row')[0]
      .querySelectorAll('.sm-op')[0].disabled).toBe(true);
  });

  it('取消勾选后左栏该 pill 消失', function () {
    quick.openSnippetManager();
    var leftBefore = document.querySelectorAll('#snippetWrap .snippet-pill').length;

    var chk = document.querySelectorAll('.sm-overlay.show .sm-row')[0].querySelector('.sm-chk');
    chk.checked = false;
    chk.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.querySelectorAll('#snippetWrap .snippet-pill').length).toBe(leftBefore - 1);
  });
});

describe('插入模块管理器', function () {
  it('新增自定义模块后 customModules 与 moduleOrder 同时增长', function () {
    quick.openModuleManager();
    var beforeList = store.state.customModules.length;
    var beforeOrder = store.state.moduleOrder.length;

    document.getElementById('smAdd').click();

    expect(store.state.customModules.length).toBe(beforeList + 1);
    expect(store.state.moduleOrder.length).toBe(beforeOrder + 1);
  });

  it('改自定义模块正文只写当前语言那一支', function () {
    quick.openModuleManager();
    document.getElementById('smAdd').click();
    var added = store.state.customModules[store.state.customModules.length - 1];

    var row = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (r.querySelector('.sm-badge.custom') && r.querySelector('.sm-tag').value === added.label.zh) row = r;
    });
    typeInto(row.querySelector('.sm-text'), '中文正文');

    expect(added.text.zh).toBe('中文正文');
    expect(added.text.en).toBe(''); // 另一语言不受影响
  });

  it('删除自定义模块后 moduleOrder 同步剔除', function () {
    quick.openModuleManager();
    document.getElementById('smAdd').click();
    var added = store.state.customModules[store.state.customModules.length - 1];

    var row = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (r.querySelector('.sm-badge.custom') && r.querySelector('.sm-tag').value === added.label.zh) row = r;
    });
    row.querySelector('.sm-op.danger').click();

    expect(store.state.moduleOrder).not.toContain(added.id);
    expect(store.state.customModules.some(function (m) { return m.id === added.id; })).toBe(false);
  });

  it('改内置模块标签写进 modulePatches，恢复默认后清空', function () {
    quick.openModuleManager();
    var row = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (!row && r.querySelector('.sm-badge.builtin')) row = r;
    });

    typeInto(row.querySelector('.sm-tag'), '改过的模块名');
    expect(Object.keys(store.state.modulePatches).length).toBeGreaterThan(0);

    quick.renderSnippetManager();
    var again = null;
    document.querySelectorAll('.sm-overlay.show .sm-row').forEach(function (r) {
      if (!again && r.querySelector('.sm-tag').value === '改过的模块名') again = r;
    });
    var ops = again.querySelectorAll('.sm-op');
    ops[ops.length - 1].click();

    expect(store.state.modulePatches).toEqual({});
  });
});

/* ---------- 设置面板内嵌版：与 overlay 版共用同一套 render ---------- */

describe('设置面板内嵌管理器', function () {
  it('内嵌快速段落管理器后，新增分组同样生效', function () {
    var host = document.createElement('div');
    document.body.appendChild(host);
    quick.mountQuickManagerInto(host);

    var before = store.state.quickGroups.length;
    expect(host.querySelectorAll('.qm-group').length).toBe(before);

    host.querySelector('.sm-embed-add-group').click();

    expect(store.state.quickGroups.length).toBe(before + 1);
    expect(host.querySelectorAll('.qm-group').length).toBe(before + 1);
  });

  it('内嵌常用句管理器后，新增自定义句同样生效', function () {
    var host = document.createElement('div');
    document.body.appendChild(host);
    quick.mountSnippetManagerInto(host);

    var before = store.state.customSnippets.length;
    host.querySelector('.sm-embed-add').click();

    expect(store.state.customSnippets.length).toBe(before + 1);
  });

  it('内嵌之后再打开 overlay 版，渲染打到 overlay 而不是内嵌容器（回归：模块级指针被抢）', function () {
    var host = document.createElement('div');
    document.body.appendChild(host);
    quick.mountQuickManagerInto(host);
    var embeddedBefore = host.querySelectorAll('.qm-group').length;

    quick.openQuickManager();
    document.getElementById('qmAddGroup').click();

    // overlay 的列表反映了新增；内嵌容器停在打开 overlay 前的状态，
    // 不会被重复渲染，也不会出现"新增打到看不见的那份 DOM 上"。
    expect(document.querySelectorAll('#qmList .qm-group').length).toBe(embeddedBefore + 1);
    expect(host.querySelectorAll('.qm-group').length).toBe(embeddedBefore);
  });
});
