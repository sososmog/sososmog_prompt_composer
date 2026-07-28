/* ============================================================
 * mainWindow.test.js —— 主窗口 UI 层的 DOM 层测试
 * ------------------------------------------------------------
 * 为什么现在才有这份测试：events.js 以前在模块顶层直接跑启动逻辑
 * （restoreState + 3 秒后查更新），import 这个文件本身就等于启动一次
 * 真实应用；events.js 顶层还有大量 $xxx.addEventListener(...)，
 * jsdom 里没有真实 DOM 时 document.getElementById 拿到 null，一 import
 * 就 TypeError。events.js 的启动动作已被拆到 bootstrap()（不再是裸执行
 * 语句），但模块顶层的 DOM 绑定语句本身没有动——所以这里的策略是：
 * 先在 jsdom 里把真实 index.html 的 <body> 灌好，再用**动态** import，
 * 让顶层那些 addEventListener 绑到真实节点上，而不必把几十处绑定
 * 挪进函数、把改动面扩大好几倍。
 *
 * DOM 来源：直接读 src/index.html 并抓取 <body> 内容，不手写一份假
 * DOM——手写的迟早会跟真实页面结构漂移，等于测了个不存在的页面。
 * ============================================================ */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var indexHtmlPath = path.resolve(here, '../index.html');
var rawIndexHtml = readFileSync(indexHtmlPath, 'utf-8');

// 抓 <body>…</body> 内容，并剔除 <script> 标签——module 脚本 jsdom 不会
// 真的执行（不支持解析外部 ESM 图），留着也没用，只会在 innerHTML 赋值时
// 被当成普通文本节点插入，白占内容。
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>，DOM 层测试的地基就没了');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}

var BODY_HTML = extractBodyHtml(rawIndexHtml);

// 给块内 textarea 派发一次「模拟按下组合键」的 keydown，bubbles:true 确保
// 能冒泡到 events.js 挂在 document 上的全局快捷键监听器。
function dispatchKeydown(target, opts) {
  var evt = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts));
  target.dispatchEvent(evt);
  return evt;
}

var events, store;

beforeEach(async function () {
  // vitest 的隔离粒度是"每个测试文件"，同一文件内模块图默认共享——
  // store.js 的 state 是模块级变量，不重置就会跨用例串数据。
  // resetModules() 之后重新动态 import，每个用例都拿到全新的模块实例
  // （包括 core.js 里 snippetSeq/moduleSeq/quickSeq 这几个自增计数器，
  // 也会归零重来）。本文件里没有用例会新建自定义常用句/模块/快速段落
  // 走到这几个计数器生成 id，所以它们归零对断言没有影响，不必特殊处理。
  vi.resetModules();

  // 重建真实 DOM：先清空整份 body 再灌入抓来的原始结构，保证每个用例
  // 面对的是"刚打开应用"那份干净 HTML，不会残留上一个用例 append 到
  // body 里的设置面板/管理浮窗等节点。
  document.body.innerHTML = BODY_HTML;
  document.documentElement.removeAttribute('data-theme');

  // jsdom 的 window.confirm 默认返回 undefined（打印 "Not implemented" 警告），
  // 相当于永远点了"取消"——删块/清空正文这类会用到它的路径测不了"确认后生效"。
  // 默认 stub 成"确认"，需要测"取消"分支的用例自行覆盖成 () => false。
  window.confirm = vi.fn(function () { return true; });

  // 顶层还有大量 $xxx.addEventListener 的绑定语句（这次重构刻意没动），
  // 必须等 DOM 就绪后才动态 import，绑定才能挂到上面刚灌好的真实节点上。
  //
  // 导入顺序有讲究，必须先 import events.js（与生产环境一致：main.js
  // 只 import events.js 作为入口）。events.js ⇄ store.js 是循环依赖：
  // 若反过来先 import store.js，store.js 顶层对 events.js 的 import 会
  // 触发 events.js 求值，而 events.js 顶层的 $langSegmented.addEventListener
  // 会在 store.js 自己那句 `var $langSegmented = document.getElementById(...)`
  // 真正执行之前就跑到——此时 $langSegmented 还是 undefined，直接 TypeError。
  // 以 events.js 为入口时，store.js 的循环 import 靠"函数声明整体提升"
  // 安全接住（renderAll/applyStartupShortcut 是 function 声明，未执行到
  // 也已可调用），$langSegmented 这类 var 赋值则会在 events.js 自己的顶层
  // 语句跑到之前，随着 store.js 完整求值一次性就绪。
  // render.js 不需要单独 import：它已经在 store.js 的顶层 import 链路里
  // 被一并带入（本文件只通过 store/events 暴露的接口驱动交互，render.js
  // 的渲染函数都由它们内部调用，测试代码不必直接持有 render 的命名空间）。
  events = await import('../events.js');
  store = await import('../store.js');
});

describe('主窗口 DOM 层：渲染', function () {
  it('renderAll 之后左栏与编辑器区域渲染正确', function () {
    // 不调用 bootstrap()：bootstrap 会触发 restoreState 之后靠双重
    // requestAnimationFrame 延迟弹出的新手引导，在测试的同步断言窗口内
    // 摸不到、又可能在若干 tick 后才真的把引导层 append 进当前 body、
    // 干扰到下一个用例。直接调 renderAll() 就足以验证渲染逻辑本身，
    // defaultState() 已经带了演示数据，不需要走一遍存档恢复。
    events.renderAll();

    expect(document.querySelectorAll('#insertGrid .insert-pill').length).toBe(10);
    expect(document.querySelectorAll('#snippetWrap .snippet-pill').length).toBe(16);
    expect(document.querySelectorAll('#quickWrap .quick-block').length).toBe(4);
    expect(document.querySelectorAll('#blocks .block').length).toBeGreaterThan(0);
    expect(document.getElementById('editorStat').textContent).toMatch(/tokens/);
  });
});

describe('主窗口 DOM 层：插入片段', function () {
  it('焦点在块内时插入到光标处，不新建块', function () {
    events.renderAll();
    var areasBefore = document.querySelectorAll('#blocks .block-textarea');
    var countBefore = areasBefore.length;
    var first = areasBefore[0];
    first.focus();
    first.setSelectionRange(first.value.length, first.value.length);

    store.insertSnippet('一步步分析思考。');

    var areasAfter = document.querySelectorAll('#blocks .block-textarea');
    expect(areasAfter.length).toBe(countBefore); // 没有新建块
    expect(areasAfter[0].value).toContain('一步步分析思考。');
  });

  it('没有焦点块时插入会追加为新块', function () {
    events.renderAll();
    var areasBefore = document.querySelectorAll('#blocks .block-textarea');
    var countBefore = areasBefore.length;
    // 显式失焦，模拟"当前没有聚焦在任何块 textarea 里"
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    // 这里特意用带 "## " 前缀的模块模板文本，而不是普通常用句：store.js
    // 的 insertSnippet 在"未聚焦/模块模板"分支里统一用 "\n\n" 拼接后整体
    // 交给 parseBlocks 重新切块，块边界只认 "## " 开头的行——普通常用句
    // 没有这个前缀，拼接后会被并进最后一块的尾部（内容变多但不长出新卡片）；
    // 只有像"插入模块"pill 那样带 "## " 前缀的文本，才会真的切出一张独立
    // 新卡片。这里选它是为了让"追加为新块"这个分支产生可断言的块数变化。
    store.insertSnippet('## 约束\n不要出现敏感词。');

    var areasAfter = document.querySelectorAll('#blocks .block-textarea');
    expect(areasAfter.length).toBe(countBefore + 1);
    expect(areasAfter[areasAfter.length - 1].value).toContain('不要出现敏感词。');
  });

  it('插入片段后可用 doUndo 撤销回插入前的内容（回归用例）', function () {
    events.renderAll();
    var before = store.state.content.zh;
    var areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].focus();
    areas[0].setSelectionRange(areas[0].value.length, areas[0].value.length);

    store.insertSnippet('一步步分析思考。');
    expect(store.state.content.zh).not.toBe(before);

    events.doUndo();
    expect(store.state.content.zh).toBe(before);
  });
});

describe('主窗口 DOM 层：全局快捷键在弹窗内让位（回归用例）', function () {
  it('焦点在设置面板输入框里时，Ctrl+L 不切换语言；焦点在块内时才切换', function () {
    events.renderAll();
    var langBefore = store.state.lang;

    events.openSettingsPanel();
    var trKeyInput = document.getElementById('stTrKey');
    trKeyInput.focus();
    dispatchKeydown(trKeyInput, { key: 'l', ctrlKey: true });
    // 弹窗打开且焦点在其输入框里：footer 快捷键说明的是"编辑正文时"的场景，
    // 设置面板里没有"切语言"这回事，全局处理器必须让位，否则会把面板里
    // 正在填的内容用 renderSettingsPanel 的旧值整个覆盖掉。
    expect(store.state.lang).toBe(langBefore);

    events.closeSettingsPanel();
    var areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].focus();
    dispatchKeydown(areas[0], { key: 'l', ctrlKey: true });
    // footer 明确宣传 Ctrl+L 在编辑正文时可用，不能被弹窗让位逻辑连带禁掉。
    expect(store.state.lang).not.toBe(langBefore);
  });
});

describe('主窗口 DOM 层：翻译设置用 input 立即提交（回归用例）', function () {
  it('在 #stTrKey 里派发 input 后 state 立即更新，且 renderAll 不会用旧值覆盖输入框', function () {
    events.renderAll();
    events.openSettingsPanel();
    var trKeyInput = document.getElementById('stTrKey');

    trKeyInput.value = 'sk-test-key-123';
    trKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    // 不需要失焦（change 事件）就该立即写回——粘贴进 Key 还没来得及失焦时，
    // 若期间触发一次 renderAll（比如切了语言），旧代码会用 state 里的旧值
    // 把刚粘的 Key 整个覆盖掉。
    expect(store.state.settings.translation.apiKey).toBe('sk-test-key-123');

    events.renderAll();
    expect(document.getElementById('stTrKey').value).toBe('sk-test-key-123');
  });
});

describe('主窗口 DOM 层：块操作', function () {
  it('Alt+下 移动块后顺序变化并回写 state', function () {
    events.renderAll();
    var areasBefore = document.querySelectorAll('#blocks .block-textarea');
    var firstValue = areasBefore[0].value;
    var secondValue = areasBefore[1].value;

    dispatchKeydown(areasBefore[0], { key: 'ArrowDown', altKey: true });

    var areasAfter = document.querySelectorAll('#blocks .block-textarea');
    expect(areasAfter[0].value).toBe(secondValue);
    expect(areasAfter[1].value).toBe(firstValue);
    // moveBlock 内部会 collectText() 回写，state.content 应体现新顺序
    var zh = store.state.content.zh;
    expect(zh.indexOf(secondValue.slice(0, 6))).toBeLessThan(zh.indexOf(firstValue.slice(0, 6)));
  });

  it('删除块（确认框返回 true）后块数减少，且可用 doUndo 恢复', function () {
    events.renderAll();
    var before = store.state.content.zh;
    var countBefore = document.querySelectorAll('#blocks .block').length;

    var delBtn = document.querySelectorAll('#blocks .block-del')[0];
    delBtn.click(); // window.confirm 已在 beforeEach 里 stub 成返回 true

    expect(document.querySelectorAll('#blocks .block').length).toBe(countBefore - 1);

    events.doUndo();
    expect(store.state.content.zh).toBe(before);
  });
});

describe('主窗口 DOM 层：语言切换', function () {
  it('切到 en 后 etLabel 文案更新，且撤销/重做两栈被清空', function () {
    events.renderAll();
    var areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].focus();
    areas[0].setSelectionRange(areas[0].value.length, areas[0].value.length);
    store.insertSnippet('一步步分析思考。'); // 造一条可撤销的历史，验证切语言真的清空了它
    expect(store.history.canUndo()).toBe(true);

    events.setLang('en');

    expect(document.getElementById('etLabel').textContent).toBe('English 正文');
    expect(store.history.canUndo()).toBe(false);
  });
});

describe('主窗口 DOM 层：视图切换', function () {
  it("setView('preview') 后 .editor-surface 带 is-split，预览区不再隐藏", function () {
    events.renderAll();
    var surface = document.querySelector('.editor-surface');
    expect(surface.classList.contains('is-split')).toBe(false);
    expect(document.getElementById('editorPreview').classList.contains('is-hidden')).toBe(true);

    events.setView('preview');

    expect(surface.classList.contains('is-split')).toBe(true);
    expect(document.getElementById('editorPreview').classList.contains('is-hidden')).toBe(false);
  });
});
