/* ============================================================
 * moduleGraph.test.js —— 模块图的求值顺序不再有隐形约束
 * ------------------------------------------------------------
 * events.js ⇄ store.js 是 ESM 循环依赖。以前 events.js 顶层有一批
 * `$xxx.addEventListener(...)` 裸执行语句，引用的 $xxx 是 store.js 里
 * `var $foo = document.getElementById(...)` 的结果。函数声明会整体提升，
 * var 赋值不会——所以若先 import store.js，它顶层那句 import './events.js'
 * 会立刻把 events.js 求值一遍，此时 $langSegmented 还是 undefined，直接抛
 * "Cannot read properties of undefined (reading 'addEventListener')"。
 * 当时只能靠"整张图必须以 events.js 为入口"这条口头约束绕开。
 *
 * 绑定收进 bindEvents() 之后这个约束应该消失了。这份测试就是它的验收
 * 标准：两种 import 顺序都必须能跑通，且接线后交互照样工作。没有它，
 * "约束已解除"只是注释里的一句断言。
 * ============================================================ */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var rawIndexHtml = readFileSync(path.resolve(here, '../index.html'), 'utf-8');
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}
var BODY_HTML = extractBodyHtml(rawIndexHtml);

beforeEach(function () {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;
  document.documentElement.removeAttribute('data-theme');
});

describe('events.js ⇄ store.js 循环依赖：两种入口都安全', function () {
  it('以 events.js 为入口（与生产一致）：import 不抛异常', async function () {
    var events = await import('../events.js');
    var store = await import('../store.js');
    expect(typeof events.bindEvents).toBe('function');
    expect(store.state).toBeTruthy();
  });

  it('以 store.js 为入口（以前会 TypeError）：import 同样不抛异常', async function () {
    var store = await import('../store.js');
    var events = await import('../events.js');
    expect(store.state).toBeTruthy();
    expect(typeof events.bindEvents).toBe('function');
  });

  it('先 import store.js 时也能正常接线并响应点击', async function () {
    var store = await import('../store.js');
    var events = await import('../events.js');
    events.renderAll();
    events.bindEvents();

    // 语言切换按钮是当年最先炸的那个绑定（$langSegmented）
    var before = store.state.lang;
    var other = document.querySelector('#langSegmented button[data-lang]:not([aria-pressed="true"])');
    other.click();
    expect(store.state.lang).not.toBe(before);
  });

  it('单独 import render.js 也不炸（它同在循环里）', async function () {
    var render = await import('../render.js');
    expect(typeof render.renderBlocks).toBe('function');
  });

  it('单独 import quick.js / backup.js / translate.js 都不炸', async function () {
    var quick = await import('../quick.js');
    var backup = await import('../backup.js');
    var translate = await import('../translate.js');
    expect(typeof quick.renderQuick).toBe('function');
    expect(typeof backup.openExportFlow).toBe('function');
    expect(typeof translate.translateCurrentContent).toBe('function');
  });
});

describe('模块顶层不再有副作用', function () {
  it('只 import events.js 不会自动接线（绑定要显式调 bindEvents）', async function () {
    var events = await import('../events.js');
    var store = await import('../store.js');
    events.renderAll();

    // 没调 bindEvents：点语言按钮不该有反应
    var before = store.state.lang;
    var other = document.querySelector('#langSegmented button[data-lang]:not([aria-pressed="true"])');
    other.click();
    expect(store.state.lang).toBe(before);

    // 接线之后才生效
    events.bindEvents();
    document.querySelector('#langSegmented button[data-lang]:not([aria-pressed="true"])').click();
    expect(store.state.lang).not.toBe(before);
  });

  it('只 import 不会触发查更新的定时器（那是 bootstrap 的事）', async function () {
    vi.useFakeTimers();
    await import('../events.js');
    await import('../store.js');
    // 顶层若还留着 setTimeout(checkForUpdate, 3000)，这里就不是 0
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('bindEvents 之后 Ctrl+L 全局快捷键生效', async function () {
    var events = await import('../events.js');
    var store = await import('../store.js');
    events.renderAll();
    events.bindEvents();

    var before = store.state.lang;
    var areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].focus();
    areas[0].dispatchEvent(new KeyboardEvent('keydown', {
      key: 'l', ctrlKey: true, bubbles: true, cancelable: true
    }));
    expect(store.state.lang).not.toBe(before);
  });
});
