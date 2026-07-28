/* ============================================================
 * edit.js —— textarea 文本插入（保住浏览器原生撤销栈）
 * ------------------------------------------------------------
 * 直接给 el.value 赋值会清空该元素的原生 undo 栈（Chromium / WebView2 行为），
 * 于是插入之后 Ctrl+Z 既撤销不了这次插入、也撤销不了之前手打的字。而主窗口的
 * 全局 Ctrl+Z 处理器在焦点位于 textarea 时会主动让位给原生撤销 —— 两头都不接，
 * 结果是「点常用句插入」和「Tab 采纳补全」这两个动作彻底无法撤销。
 *
 * document.execCommand('insertText') 走的是「用户编辑」路径：插入会进入原生
 * 撤销栈，并由浏览器自动派发 input 事件。它虽被标记为 deprecated，但在
 * WebView2 / WebKit 上仍是唯一能保住撤销栈的插入方式，且失败可安全降级。
 *
 * 无 DOM 副作用（加载时不碰 document），可在 jsdom 里单测。
 * ============================================================ */

/**
 * 往 textarea / input 的当前光标处（有选区则替换选区）插入文本。
 * @returns {'native'|'fallback'} 'native' 表示走了 execCommand，浏览器已自行
 *   派发 input 事件，调用方**不要**再手动派发；'fallback' 表示直接改了 value，
 *   调用方需自行派发 input 以驱动后续的高亮/回写/保存链路。
 */
export function insertTextAtCaret(el, text) {
  var value = el.value == null ? '' : String(el.value);
  var start = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
  var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  var str = text == null ? '' : String(text);

  // execCommand 要求元素持有焦点且选区就在它里面
  if (typeof el.focus === 'function') el.focus();
  try {
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start, end);
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
      if (document.execCommand('insertText', false, str)) return 'native';
    }
  } catch (_e) {
    // 某些环境（含 jsdom）没有实现或直接抛错，落到下面的降级路径
  }

  var before = value.slice(0, start);
  el.value = before + str + value.slice(end);
  var caret = before.length + str.length;
  if (typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret);
  return 'fallback';
}
