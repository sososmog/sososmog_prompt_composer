/* ============================================================
 * attachCompletion 的交互层测试（jsdom）
 * ------------------------------------------------------------
 * completion.js 加载时不跑任何 DOM/Tauri 副作用，所以可以直接 import 并在
 * jsdom 里真的挂到一个 textarea 上驱动。这是 DOM 层第一组真实交互测试——
 * 之前找到的 shown 计数膨胀正好属于「recompute 与学习记账的耦合」，
 * 纯函数单测抓不到。
 * ============================================================ */
import { describe, it, expect, beforeEach } from 'vitest';
import { attachCompletion, splitTail } from '../completion.js';
import { defaultLearning, learn, learnKey, normalizeLearning } from '../core.js';

// 造一个「textarea + overlay」对，以及注入给 attachCompletion 的依赖。
function setup(poolTexts, opts) {
  opts = opts || {};
  const area = document.createElement('textarea');
  const overlay = document.createElement('div');
  document.body.appendChild(overlay);
  document.body.appendChild(area);

  const pool = poolTexts.map((t) => ({ key: learnKey('zh', t), text: t, source: 'learned' }));
  const env = {
    learning: opts.learning || defaultLearning(),
    learnCalls: [],       // 记录每次 onLearn 时 snippets 的快照，便于断言记账次数
    renderCount: 0,
  };

  const deps = {
    getPool: () => pool,
    getLearning: () => env.learning,
    onLearn: (next) => { env.learning = next; env.learnCalls.push(next); },
    getLang: () => 'zh',
    renderHighlight: (a, o) => { env.renderCount++; o.textContent = a.value; },
  };

  const api = attachCompletion(area, overlay, deps);
  return { area, overlay, env, api, pool };
}

// 模拟用户敲一个字符：改 value、把光标放到末尾、派发 input。
function type(area, chunk) {
  area.value += chunk;
  area.setSelectionRange(area.value.length, area.value.length);
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function ghostText(overlay) {
  const el = overlay.querySelector('.cmp-ghost');
  return el ? el.textContent : null;
}

function shownOf(learning, text) {
  const rec = learning.snippets[learnKey('zh', text)];
  return rec ? rec.shown : 0;
}
function acceptedOf(learning, text) {
  const rec = learning.snippets[learnKey('zh', text)];
  return rec ? rec.accepted : 0;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('attachCompletion - ghost 展示', () => {
  it('打出候选前缀后在 overlay 末尾追加灰字 ghost', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    type(area, '请严格');
    expect(ghostText(overlay)).toBe('按照要求的格式输出');
  });

  it('光标不在末尾时不提示', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    area.value = '请严格';
    area.setSelectionRange(1, 1);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ghostText(overlay)).toBeNull();
  });

  it('有选区时不提示', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    area.value = '请严格';
    area.setSelectionRange(0, 3);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ghostText(overlay)).toBeNull();
  });

  it('处在未闭合的代码围栏内不提示', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    type(area, '```\n请严格');
    expect(ghostText(overlay)).toBeNull();
  });

  it('打的字不匹配任何候选时不提示', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    type(area, '完全无关的内容');
    expect(ghostText(overlay)).toBeNull();
  });
});

/* ============================================================
 * 回归：shown 计数膨胀
 * ------------------------------------------------------------
 * recompute 挂在 input 上，原来每敲一个字符都记一次 learn('shown')。
 * 于是同一次展示被计数 N 次（N≈已输入前缀长度），接受率 accepted/shown 被
 * 摊薄到 1/N，比新片段的乐观初始值 0.4 还低 —— 越常用的片段排得越靠后。
 * ============================================================ */
describe('attachCompletion - shown 记账去重（回归）', () => {
  it('连续打字命中同一条候选，只记一次展示', () => {
    const cand = '请严格按照要求的格式输出';
    const { area, env } = setup([cand]);
    for (const ch of ['请', '严', '格', '按', '照']) type(area, ch);
    expect(shownOf(env.learning, cand)).toBe(1);
  });

  it('采纳一次后接受率是 1/1，不再被前缀长度摊薄', () => {
    const cand = '请严格按照要求的格式输出';
    const { area, env } = setup([cand]);
    for (const ch of ['请', '严', '格', '按', '照']) type(area, ch);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    const shown = shownOf(env.learning, cand);
    const accepted = acceptedOf(env.learning, cand);
    expect(accepted).toBe(1);
    expect(shown).toBe(1);
    expect(accepted / shown).toBe(1); // 修复前这里是 1/5 = 0.2
  });

  it('候选消失再出现算新的一次展示', () => {
    const cand = '请严格按照要求的格式输出';
    const { area, env } = setup([cand]);
    type(area, '请严');
    expect(shownOf(env.learning, cand)).toBe(1);

    // 打一个句读标点结束当前子句 → tail 变空，候选消失
    type(area, '。');
    // 再起一个新子句重新命中
    type(area, '请严');
    expect(shownOf(env.learning, cand)).toBe(2);
  });

  it('失焦后重新命中算新的一次展示', () => {
    const cand = '请严格按照要求的格式输出';
    const { area, env } = setup([cand]);
    type(area, '请严');
    area.dispatchEvent(new Event('blur'));
    type(area, '格');
    expect(shownOf(env.learning, cand)).toBe(2);
  });

  it('候选换人时各自记一次', () => {
    const a = '请严格按照要求的格式输出';
    const b = '不要添加额外说明';
    const { area, env } = setup([a, b]);
    type(area, '请严');
    type(area, '。不要');
    expect(shownOf(env.learning, a)).toBe(1);
    expect(shownOf(env.learning, b)).toBe(1);
  });

  it('Esc 撤掉 ghost 后继续打同一条候选，不再重复记账', () => {
    const cand = '请严格按照要求的格式输出';
    const { area, env } = setup([cand]);
    type(area, '请严');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    type(area, '格');
    expect(shownOf(env.learning, cand)).toBe(1);
  });
});

describe('attachCompletion - 采纳与取消', () => {
  it('Tab 采纳：写入 textarea、光标落到末尾、派发 input', () => {
    const cand = '请严格按照要求的格式输出';
    const { area } = setup([cand]);
    type(area, '请严格');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(area.value).toBe(cand);
    expect(area.selectionStart).toBe(cand.length);
  });

  it('→ 也能采纳', () => {
    const cand = '请严格按照要求的格式输出';
    const { area } = setup([cand]);
    type(area, '请严格');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(area.value).toBe(cand);
  });

  it('Esc 只撤 ghost，不改正文', () => {
    const { area, overlay } = setup(['请严格按照要求的格式输出']);
    type(area, '请严格');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(area.value).toBe('请严格');
    expect(ghostText(overlay)).toBeNull();
  });

  it('Alt+↑/↓（移动块）不被补全层拦截', () => {
    const { area } = setup(['请严格按照要求的格式输出']);
    type(area, '请严格');
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
    area.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(area.value).toBe('请严格'); // 没有被当成采纳
  });

  it('没有 ghost 时 Tab 不被拦截（保留默认的移焦行为）', () => {
    const { area } = setup(['请严格按照要求的格式输出']);
    type(area, '无关内容');
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    area.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  /* 采纳走 insertTextAtCaret：native 模式下浏览器自己派发 input，我们不能再补一次，
   * 否则 recompute / collectText / scheduleSave 会白跑两遍。 */
  it('native 插入模式下不重复派发 input', () => {
    const cand = '请严格按照要求的格式输出';
    const { area } = setup([cand]);
    type(area, '请严格');

    let inputs = 0;
    Object.defineProperty(document, 'execCommand', {
      value: function (cmd, ui, arg) {
        if (cmd !== 'insertText') return false;
        area.value += arg;
        area.setSelectionRange(area.value.length, area.value.length);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      writable: true, configurable: true,
    });
    area.addEventListener('input', () => { inputs++; });
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    delete document.execCommand;

    expect(area.value).toBe(cand);
    expect(inputs).toBe(1);
  });

  it('采纳会记 bigram（前一子句 → 候选）', () => {
    const cand = '不要添加额外说明';
    const { area, env } = setup([cand]);
    type(area, '请严格按照要求的格式输出。不要');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const prefixKey = learnKey('zh', '请严格按照要求的格式输出');
    expect(env.learning.bigrams[prefixKey][learnKey('zh', cand)]).toBe(1);
  });
});

describe('splitTail（与候选池同一套子句边界）', () => {
  it('取最后一个子句边界之后的文本作为 tail', () => {
    expect(splitTail('第一句话。第二句', 'zh').tail).toBe('第二句');
  });
  it('prefixKey 是 tail 之前那条完整子句的 learnKey', () => {
    expect(splitTail('第一句话。第二句', 'zh').prefixKey).toBe(learnKey('zh', '第一句话'));
  });
  it('没有前一子句时 prefixKey 为 null', () => {
    expect(splitTail('只有一句', 'zh').prefixKey).toBeNull();
  });
});

describe('learn 的记账语义（配合去重后的口径）', () => {
  it('accepted 永不超过 shown', () => {
    let L = normalizeLearning(null);
    const k = learnKey('zh', '某条候选文本');
    L = learn('accepted', { candKey: k }, L, 1000);
    expect(L.snippets[k].shown).toBeGreaterThanOrEqual(L.snippets[k].accepted);
  });
});
