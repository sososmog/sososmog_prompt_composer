import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { insertTextAtCaret } from '../edit.js';

/* jsdom 根本没有实现 document.execCommand（属性不存在，spyOn 会直接报错），
 * 所以用赋值 + 收尾 delete 的方式模拟真实 WebView2 环境。
 * 这也顺带证明了降级路径在 jsdom 下是默认走的那条。 */
function stubExecCommand(impl) {
  Object.defineProperty(document, 'execCommand', {
    value: impl, writable: true, configurable: true,
  });
}
function clearExecCommand() {
  if ('execCommand' in document) delete document.execCommand;
}

function mkArea(value, start, end) {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  el.value = value;
  el.setSelectionRange(start == null ? value.length : start, end == null ? (start == null ? value.length : start) : end);
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { clearExecCommand(); });

describe('insertTextAtCaret - 降级路径（jsdom 没有 execCommand）', () => {
  it('在光标处插入，光标落到插入内容之后', () => {
    const el = mkArea('abcdef', 3);
    expect(insertTextAtCaret(el, 'XY')).toBe('fallback');
    expect(el.value).toBe('abcXYdef');
    expect(el.selectionStart).toBe(5);
    expect(el.selectionEnd).toBe(5);
  });

  it('有选区时替换选区', () => {
    const el = mkArea('abcdef', 1, 4);
    insertTextAtCaret(el, 'Z');
    expect(el.value).toBe('aZef');
    expect(el.selectionStart).toBe(2);
  });

  it('末尾插入', () => {
    const el = mkArea('abc');
    insertTextAtCaret(el, '!');
    expect(el.value).toBe('abc!');
    expect(el.selectionStart).toBe(4);
  });

  it('空串插入不改内容，光标停在原处', () => {
    const el = mkArea('abc', 2);
    insertTextAtCaret(el, '');
    expect(el.value).toBe('abc');
    expect(el.selectionStart).toBe(2);
  });

  it('多行文本与换行前缀', () => {
    const el = mkArea('第一行', 3);
    insertTextAtCaret(el, '\n第二行\n第三行');
    expect(el.value).toBe('第一行\n第二行\n第三行');
  });

  it('null / undefined 当空串处理，不抛', () => {
    const el = mkArea('abc', 1);
    expect(() => insertTextAtCaret(el, null)).not.toThrow();
    expect(el.value).toBe('abc');
  });

  it('插入后元素获得焦点（后续键盘操作要落在这里）', () => {
    const el = mkArea('abc', 3);
    insertTextAtCaret(el, 'd');
    expect(document.activeElement).toBe(el);
  });
});

describe('insertTextAtCaret - native 路径', () => {
  it('execCommand 成功时返回 native 且不自己改 value（由浏览器完成插入）', () => {
    const el = mkArea('abc', 3);
    const args = [];
    // 模拟 WebView2/Chromium：execCommand('insertText') 生效并自行派发 input
    stubExecCommand(function (cmd, ui, arg) {
      args.push([cmd, ui, arg]);
      if (cmd !== 'insertText') return false;
      el.value += arg;                                     // 浏览器代劳
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    let inputs = 0;
    el.addEventListener('input', () => { inputs++; });

    expect(insertTextAtCaret(el, 'XYZ')).toBe('native');
    expect(el.value).toBe('abcXYZ');
    expect(inputs).toBe(1);      // 只有浏览器派发的那一次，调用方不该再补一次
    expect(args).toEqual([['insertText', false, 'XYZ']]);
  });

  it('execCommand 返回 false 时降级，内容仍被正确插入', () => {
    const el = mkArea('abc', 1);
    stubExecCommand(function () { return false; });
    expect(insertTextAtCaret(el, 'Q')).toBe('fallback');
    expect(el.value).toBe('aQbc');
  });

  it('execCommand 抛异常时降级，不把异常抛给调用方', () => {
    const el = mkArea('abc', 1);
    stubExecCommand(function () { throw new Error('nope'); });
    expect(insertTextAtCaret(el, 'Q')).toBe('fallback');
    expect(el.value).toBe('aQbc');
  });
});
