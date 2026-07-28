/* ============================================================
 * blockRoundTrip.test.js —— 「正文文本 ⇄ 块视图」往返的契约测试
 * ------------------------------------------------------------
 * 真相源是 state.content[lang] 这一大段文本，块只是视图：
 *   parseBlocks(text) 切成块 → 渲染成一排 textarea → collectText() 从 DOM
 *   顺序收回来拼成文本写回 state。
 *
 * 这条往返**刻意不是无损的**（理由见 store.js 里 collectText 上方的长注释：
 * 无损保留会让拖拽排序后段落间距错乱，因为「块间空行」在 parseBlocks 里归属
 * 于前一块的尾部、是跟着位置而不是跟着块的）。既然是有意的归一化，就必须把
 * 它钉死成契约 —— 否则将来有人「顺手改一下」既不会有测试报警、也说不清究竟
 * 哪种行为才是对的。
 *
 * 因此本文件的用例分两类：
 *   1. 归一化契约：明确断言"会被改成什么样"（改动 collectText 会让它们失败，
 *      这是有意的提醒）；
 *   2. 不可篡改契约：无论如何都不能动用户内容的部分 —— 尤其是代码围栏里的
 *      文本（此前真出过 bug：不认围栏、把代码块切成两块并往围栏里插空行）。
 * ============================================================ */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var BODY_HTML = readFileSync(path.resolve(here, '../index.html'), 'utf-8')
  .match(/<body[^>]*>([\s\S]*)<\/body>/i)[1]
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

var events, store;

beforeEach(async function () {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;
  window.confirm = vi.fn(function () { return true; });
  // 必须先 import events.js：它与 store.js 是 ESM 循环依赖，反过来会因为
  // store.js 的 `var $foo = getElementById(...)` 尚未赋值而抛错。
  // 详见 store.js 头部的「求值顺序约束」。
  events = await import('../events.js');
  store = await import('../store.js');
});

// 把一段正文灌进当前语言，渲染成块，再收回来，返回收回后的文本。
function roundTrip(text) {
  store.state.content[store.state.lang] = text;
  events.renderAll();
  return store.collectText();
}

function blockValues() {
  return Array.prototype.slice
    .call(document.querySelectorAll('#blocks .block-textarea'))
    .map(function (a) { return a.value; });
}

describe('往返契约：归一化（这些断言"就该是"当前行为，改了要慎重）', function () {
  it('段落之间恒为一个空行：原本 3 个空行被压成 1 个', function () {
    const out = roundTrip('## A\n内容A\n\n\n\n## B\n内容B');
    expect(out).toBe('## A\n内容A\n\n## B\n内容B');
  });

  it('原本只用单换行分隔的两个标题，回写后之间多出一个空行', function () {
    const out = roundTrip('## A\n内容A\n## B\n内容B');
    expect(out).toBe('## A\n内容A\n\n## B\n内容B');
  });

  it('归一化是幂等的：再走一次往返结果不变（不会累积空行）', function () {
    const once = roundTrip('## A\n内容A\n\n\n## B\n内容B');
    const twice = roundTrip(once);
    expect(twice).toBe(once);
    expect(roundTrip(twice)).toBe(once);
  });

  it('文档末尾的空白被去掉', function () {
    expect(roundTrip('## A\n内容A\n\n\n')).toBe('## A\n内容A');
  });

  it('整块只有空白的块被丢弃', function () {
    // 中间那段只有空行，不会变成一张空卡片
    const out = roundTrip('## A\n内容A\n\n   \n\n## B\n内容B');
    expect(out).toBe('## A\n内容A\n\n## B\n内容B');
    expect(blockValues().length).toBe(2);
  });

  it('前言块（首个 ## 之前的内容）被当作独立一块并保留在最前', function () {
    const out = roundTrip('开场白一句\n\n## A\n内容A');
    expect(blockValues()[0]).toContain('开场白一句');
    expect(out).toBe('开场白一句\n\n## A\n内容A');
  });
});

describe('往返契约：不可篡改用户内容', function () {
  it('回归：代码围栏内的 ## 不切块，围栏内容一字不动', function () {
    const text = '## 示例\n下面是代码：\n```md\n## 这是示例里的标题\n正文\n```\n结束';
    const out = roundTrip(text);
    expect(blockValues().length).toBe(1);      // 修复前会切成 2 块
    expect(out).toBe(text);                    // 修复前会往围栏里插入一个空行
  });

  it('回归：围栏内的空行不被当作块尾空白吃掉', function () {
    // 围栏里刻意留空行，且围栏不在块的最末尾
    const text = '## 输出格式\n```md\n第一段\n\n第二段\n```\n以上。';
    expect(roundTrip(text)).toBe(text);
  });

  it('未闭合的围栏：其后内容全部归入同一块，内容不丢', function () {
    const text = '## A\n```\n还在代码里\n## 看着像标题其实不是';
    const out = roundTrip(text);
    expect(blockValues().length).toBe(1);
    expect(out).toBe(text);
  });

  it('多段围栏交替时块边界正确、内容不变', function () {
    const text = '## A\n```\nx\n```\n中间\n```\ny\n```\n\n## B\n内容B';
    const out = roundTrip(text);
    expect(blockValues().length).toBe(2);
    expect(out).toBe(text);
  });

  it('块内的行首空格 / 缩进列表不被吃掉', function () {
    const text = '## 规则\n- 第一条\n  - 嵌套一条\n    继续缩进';
    expect(roundTrip(text)).toBe(text);
  });

  it('三级及以上标题不作为块边界，整段保持一块', function () {
    const text = '## 角色\n### 子标题\n正文\n#### 更深一层\n正文2';
    const out = roundTrip(text);
    expect(blockValues().length).toBe(1);
    expect(out).toBe(text);
  });

  it('一份典型提示词（含代码模板）整篇往返稳定', function () {
    const text = [
      '## 角色',
      '你是一名工程师。',
      '',
      '## 输出格式',
      '按下面的模板输出：',
      '```markdown',
      '## 结论',
      '（一句话）',
      '',
      '## 理由',
      '- 第一点',
      '```',
      '',
      '## 约束',
      '不要编造。',
    ].join('\n');
    const out = roundTrip(text);
    expect(blockValues().length).toBe(3);   // 角色 / 输出格式（含整段代码）/ 约束
    expect(out).toBe(text);
    expect(roundTrip(out)).toBe(text);      // 幂等
  });
});

describe('往返契约：编辑后回写', function () {
  it('改某个块的内容后 collectText 写回 state', function () {
    roundTrip('## A\n内容A\n\n## B\n内容B');
    const areas = document.querySelectorAll('#blocks .block-textarea');
    areas[1].value = '## B\n改过的内容B';
    areas[1].dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.state.content[store.state.lang]).toBe('## A\n内容A\n\n## B\n改过的内容B');
  });

  it('把某块清空后，该块在下次渲染时消失且不留空行', function () {
    roundTrip('## A\n内容A\n\n## B\n内容B');
    const areas = document.querySelectorAll('#blocks .block-textarea');
    areas[0].value = '';
    areas[0].dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.state.content[store.state.lang]).toBe('## B\n内容B');
  });
});
