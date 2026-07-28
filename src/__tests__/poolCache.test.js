import { describe, it, expect } from 'vitest';
import { defaultState, learn, BUILTIN_SNIPPETS } from '../core.js';
import { completionPool, invalidateCompletionPool } from '../pool.js';

/* ============================================================
 * 候选池缓存（性能优化）
 * ------------------------------------------------------------
 * completionPool 在 completion.js 里挂在 textarea 的 input 事件上，理论上
 * 每敲一个字符都会调一次；不缓存的话每次都要重新遍历语料切片段，语料一大
 * 就会拖慢输入。这里验证：
 *   1. 同一 state 连续调用命中缓存（同一个数组引用，没有重算）；
 *   2. 语料 / 语言 / segMode / 素材（含"原地改字段"这种数组引用不变的
 *      改法）任何一处变化都必须让缓存失效（返回新引用，且内容正确）；
 *   3. invalidateCompletionPool 能强制下一次重算；
 *   4. 总开关关闭期间不读写缓存，不影响重新开启后命中之前的结果。
 * ============================================================ */
describe('completionPool 缓存', () => {
  it('同一 state 连续调用两次返回同一个数组引用（缓存命中，不重算）', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    const pool2 = completionPool(state);
    expect(pool2).toBe(pool1);
  });

  it('语料变化（跨过自动提炼阈值出现新 learned 片段）后缓存失效，新结果内容正确', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    const text = '这是一条足够长且会被反复使用的测试文本';
    for (let i = 0; i < 3; i++) {
      state.learning = learn('commit', { lang: 'zh', lines: [text] }, state.learning, 1000 + i);
    }
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool1.some((p) => p.text === text)).toBe(false); // 旧引用不受后续变化影响
    expect(pool2.some((p) => p.text === text)).toBe(true);
  });

  it('learn 只记 shown/accepted（不碰 rawCounts）也会换一个新的 learning 引用，同样让缓存失效', () => {
    // 验证「learn 系列函数一律返回新对象、不原地改入参」——这是引用比对可靠的前提。
    const state = defaultState();
    const pool1 = completionPool(state);
    const learningBefore = state.learning;
    state.learning = learn('shown', { candKey: 'zh不存在的候选' }, state.learning);
    expect(state.learning).not.toBe(learningBefore); // learn() 返回新对象
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
  });

  it('lang 切换后缓存失效，返回对应语言内容', () => {
    const state = defaultState();
    const poolZh = completionPool(state);
    state.lang = 'en';
    const poolEn = completionPool(state);
    expect(poolEn).not.toBe(poolZh);
    const bMd = BUILTIN_SNIPPETS.find((b) => b.id === 'b_md');
    expect(poolEn.some((p) => p.text === bMd.en)).toBe(true);
    expect(poolEn.some((p) => p.text === bMd.zh)).toBe(false);
  });

  it('segMode 切换（clause → word）后缓存失效，word 模式产出更多片段', () => {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return; // 环境不支持则跳过
    const state = defaultState();
    const text = '这是一段没有任何标点符号仅供测试使用的长句子文本内容';
    for (let i = 0; i < 3; i++) {
      state.learning = learn('commit', { lang: 'zh', lines: [text] }, state.learning, 2000 + i);
    }
    const poolClause = completionPool(state);
    state.settings.completion.segMode = 'word';
    const poolWord = completionPool(state);
    expect(poolWord).not.toBe(poolClause);
    expect(poolWord.length).toBeGreaterThan(poolClause.length);
  });

  it('原地改自定义常用句的文本字段（quick.js updateCustomSnippetField 的写法）后缓存失效', () => {
    // 数组引用不变（只改数组里某个对象的字段），验证素材签名不是只靠引用比对。
    const state = defaultState();
    const pool1 = completionPool(state);
    const target = state.customSnippets[0];
    const oldText = target.zh;
    target.zh = oldText + '（已修改，用于测试缓存失效）';
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool2.some((p) => p.text === target.zh)).toBe(true);
    expect(pool1.some((p) => p.text === oldText)).toBe(true); // 旧引用不受后续修改污染
  });

  it('新增/删除自定义常用句（数组长度变化）后缓存失效', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    state.customSnippets.push({
      id: 'c_extra_for_test', tag: '临时测试句', zh: '这是新增的测试常用句用于验证缓存失效', en: '', builtin: false, hidden: false,
    });
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool2.some((p) => p.text === '这是新增的测试常用句用于验证缓存失效')).toBe(true);
  });

  it('builtinPatches 变化（隐藏内置常用句）后缓存失效', () => {
    const state = defaultState();
    const b = BUILTIN_SNIPPETS[0];
    const pool1 = completionPool(state);
    expect(pool1.some((p) => p.text === b.zh)).toBe(true);
    state.builtinPatches[b.id] = { hidden: true };
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool2.some((p) => p.text === b.zh)).toBe(false);
  });

  it('原地改快速段落文本后缓存失效', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    const item = state.quickGroups[0].items[0];
    item.text.zh = item.text.zh + '追加内容用于测试';
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool2.some((p) => p.text === item.text.zh)).toBe(true);
  });

  it('invalidateCompletionPool 强制下一次调用重算（内容不变，但换了一个新数组）', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    invalidateCompletionPool();
    const pool2 = completionPool(state);
    expect(pool2).not.toBe(pool1);
    expect(pool2).toEqual(pool1);
  });

  it('总开关关闭期间不读写缓存；重新开启后若素材/语料都没变仍命中之前的缓存', () => {
    const state = defaultState();
    const pool1 = completionPool(state);
    state.settings.completion.enabled = false;
    expect(completionPool(state)).toEqual([]);
    state.settings.completion.enabled = true;
    const pool2 = completionPool(state);
    expect(pool2).toBe(pool1);
  });
});
