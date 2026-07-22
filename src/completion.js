/* ============================================================
 * completion.js —— 编辑区行内补全（ghost text）交互层（v0.2）
 * ------------------------------------------------------------
 * 纯逻辑（候选筛选/打分/学习）在 core.js；本模块只负责 DOM 侧：
 *   - 打字时算出当前应展示的候选，把“剩余文本”作为灰字 ghost
 *     追加到该块已有的高亮 overlay 末尾（复用同一排版，天然接光标后）；
 *   - 键盘接管：Tab / → 采纳，Esc 取消；
 *   - 只在光标位于块文本末尾、且不在代码区时提示。
 *
 * ghost 只是视觉预览：不进 textarea.value、不进 state、不进 collectText，
 * 采纳时才真正写入并派发 input 事件走既有的高亮/回写/保存链路。
 * ============================================================ */
import {
  getCandidates,
  rankCandidates,
  learn,
  isInCodeContext,
  learnKey,
} from './core.js';

// 取“当前行光标前的最后一个词”作为补全触发的输入尾巴（inputTail），
// 以及它之前那个词作为 bigram 上下文前缀（prefixWord）。
// 分词以空白为界；中文没有空格，则整行尾（自上一空白起）都算一个词。
function splitTail(textBeforeCaret) {
  var lineStart = textBeforeCaret.lastIndexOf('\n') + 1;
  var line = textBeforeCaret.slice(lineStart);
  // 末尾的词：从最后一段非空白起
  var m = line.match(/(\S+)\s*$/);
  if (!m) return { tail: '', prefix: '' };
  var tail = m[1];
  // 前缀词：tail 之前那个非空白段
  var before = line.slice(0, line.length - m[0].length);
  var pm = before.match(/(\S+)\s*$/);
  var prefix = pm ? pm[1] : '';
  return { tail: tail, prefix: prefix };
}

/**
 * 把补全能力挂到一个块的 textarea 上。
 * @param {HTMLTextAreaElement} area   块内 textarea
 * @param {HTMLElement} overlay        与之像素对齐的高亮 overlay
 * @param {object} deps 注入依赖：
 *   - getPool(): 返回候选池 [{ key, text, source }]（events.js 合成）
 *   - getLearning(): 返回当前 learning 对象
 *   - onLearn(nextLearning): 学习数据变更写回并持久化
 *   - getLang(): 返回当前语言 'zh' | 'en'
 *   - renderHighlight(area, overlay): 复用 render.js 的高亮重绘（不含 ghost）
 */
export function attachCompletion(area, overlay, deps) {
  var current = null; // 当前展示的候选 { key, remainder }

  function clearGhost() {
    if (!current) return;
    current = null;
    // 重绘一次高亮，抹掉 ghost span
    deps.renderHighlight(area, overlay);
  }

  function showGhost(remainder) {
    // 在高亮 overlay 末尾追加灰字 ghost span。renderHighlight 已重绘正文高亮，
    // 这里只补 ghost，保证它接在正文之后、光标之后。
    var span = document.createElement('span');
    span.className = 'cmp-ghost';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = remainder;
    overlay.appendChild(span);
  }

  function recompute() {
    // 先清旧 ghost（renderHighlight 会重绘正文，顺带抹掉上次的 ghost span）
    deps.renderHighlight(area, overlay);
    current = null;

    var value = area.value;
    var caret = area.selectionStart;
    // 仅当无选区、且光标在文本末尾时提示
    if (caret !== area.selectionEnd) return;
    if (caret !== value.length) return;

    var before = value.slice(0, caret);
    if (isInCodeContext(before)) return; // 代码区不打扰

    var parts = splitTail(before);
    if (!parts.tail) return;

    var lang = deps.getLang();
    var pool = deps.getPool() || [];
    var cands = getCandidates(parts.tail, pool);
    if (cands.length === 0) return;

    var ranked = rankCandidates(cands, parts.prefix ? learnKey(lang, parts.prefix) : '', deps.getLearning(), Date.now());
    var top = ranked[0];
    if (!top || !top.remainder) return;

    current = { key: top.key, remainder: top.remainder, prefixKey: parts.prefix ? learnKey(lang, parts.prefix) : '' };
    showGhost(top.remainder);
    // 记一次展示
    deps.onLearn(learn('shown', { candKey: top.key }, deps.getLearning()));
  }

  function accept() {
    if (!current) return false;
    var remainder = current.remainder;
    var candKey = current.key;
    var prefixKey = current.prefixKey;
    current = null;

    // 真正写入 textarea：把剩余文本插到光标处（此时光标在末尾）
    var caret = area.selectionStart;
    area.value = area.value.slice(0, caret) + remainder + area.value.slice(caret);
    var newCaret = caret + remainder.length;
    area.setSelectionRange(newCaret, newCaret);
    // 派发 input，走既有的 autosize / 高亮重绘 / 回写 state / 保存链路
    area.dispatchEvent(new Event('input', { bubbles: true }));

    // 记一次采纳（含 bigram）
    deps.onLearn(learn('accepted', { candKey: candKey, prefixKey: prefixKey }, deps.getLearning()));
    return true;
  }

  area.addEventListener('input', recompute);
  // 光标移动（点击/方向键）也要重算：光标离开末尾就该撤掉 ghost
  area.addEventListener('click', recompute);
  area.addEventListener('blur', clearGhost);

  area.addEventListener('keydown', function (e) {
    // Alt+↑/↓ 是移动块，交给现有 handler，别抢
    if (e.altKey) return;

    if (current) {
      // 有 ghost 时：Tab / → 采纳
      if (e.key === 'Tab' || e.key === 'ArrowRight') {
        e.preventDefault();
        accept();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        clearGhost();
        return;
      }
      // 其余按键（含继续打字、↑↓←、退格）都先撤掉 ghost，让默认行为进行；
      // 继续打字会触发 input → recompute 重新算候选。
      clearGhost();
    }
  });

  // 返回一个卸载钩子（当前架构块是整体重建的，暂用不到，留作扩展）
  return { clearGhost: clearGhost };
}
