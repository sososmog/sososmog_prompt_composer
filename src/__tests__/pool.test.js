import { describe, it, expect } from 'vitest';
import { defaultState, learn, learnKey, BUILTIN_SNIPPETS } from '../core.js';
import { completionPool, completionEnabled, commitLearningText } from '../pool.js';

describe('completionPool - key 归一化（回归：主窗口与浮窗 key 不同源的 bug）', () => {
  it('preset 候选的 key 严格等于 learnKey(lang, text)', () => {
    const state = defaultState();
    const pool = completionPool(state);
    const presets = pool.filter((p) => p.source === 'preset');
    expect(presets.length).toBeGreaterThan(0);
    presets.forEach((p) => {
      expect(p.key).toBe(learnKey(state.lang, p.text));
    });
  });

  it('一条 preset 与一条内容相同（仅标点/大小写差异）的 learned 片段，在池里只出现一次', () => {
    // 复刻 PR 描述里的真实 bug 场景：内置常用句 b_md 的原文「请使用 Markdown 格式输出。」，
    // learned 片段是同一句仅大小写/标点不同的「请使用 markdown 格式输出」（无句号、Markdown 小写）。
    // 归一化前二者 key 不同（各算各的），会在池里出现两条几乎一样的候选；
    // 归一化后 learnKey 相同，seen 去重才会真正生效，只留一条。
    const state = defaultState();
    const bMd = BUILTIN_SNIPPETS.find((b) => b.id === 'b_md');
    expect(bMd.zh).toBe('请使用 Markdown 格式输出。');
    const variant = '请使用 markdown 格式输出'; // 与 bMd.zh 归一化后同 key
    expect(learnKey('zh', variant)).toBe(learnKey('zh', bMd.zh));

    // 喂三次 commit，跨过自动提炼阈值（LEARN_PROMOTE_THRESHOLD=3），
    // 让它作为 learned 片段出现在候选池里。
    let learning = state.learning;
    for (let i = 0; i < 3; i++) {
      learning = learn('commit', { lang: 'zh', lines: [variant] }, learning);
    }
    state.learning = learning;

    const pool = completionPool(state);
    const hits = pool.filter((p) => p.key === learnKey('zh', bMd.zh));
    expect(hits.length).toBe(1); // 修复前这里会是 2（一条 preset 原文 key + 一条 learned 归一化 key）
  });

  it('hidden 的常用句不进池', () => {
    const state = defaultState();
    const b = BUILTIN_SNIPPETS[0];
    state.builtinPatches[b.id] = { hidden: true };
    const pool = completionPool(state);
    expect(pool.some((p) => p.text === b.zh)).toBe(false);
  });

  it('hidden 的内置 patch 应用后也不进池（同上，patch 覆盖文本时按覆盖后判断）', () => {
    const state = defaultState();
    const b = BUILTIN_SNIPPETS[1];
    state.builtinPatches[b.id] = { zh: '被隐藏的自定义文案', hidden: true };
    const pool = completionPool(state);
    expect(pool.some((p) => p.text === '被隐藏的自定义文案')).toBe(false);
  });

  it('空文本（快速段落/自定义常用句）不进池', () => {
    const state = defaultState();
    state.quickGroups.push({
      id: 'qg_test', label: { zh: '测试', en: 'test' }, hidden: false,
      items: [{ id: 'qi_empty', label: { zh: '空', en: 'empty' }, text: { zh: '   ', en: '' } }],
    });
    state.customSnippets.push({ id: 'c_empty', tag: '空句', zh: '', en: '', builtin: false, hidden: false });
    const pool = completionPool(state);
    expect(pool.some((p) => p.text.trim() === '')).toBe(false);
  });

  it('总开关关闭时返回空数组', () => {
    const state = defaultState();
    state.settings.completion.enabled = false;
    expect(completionPool(state)).toEqual([]);
    expect(completionEnabled(state)).toBe(false);
  });

  it('语言切换时取对应语言的文本', () => {
    const state = defaultState();
    const b = BUILTIN_SNIPPETS[0];
    state.lang = 'en';
    const pool = completionPool(state);
    expect(pool.some((p) => p.text === b.en)).toBe(true);
    expect(pool.some((p) => p.text === b.zh)).toBe(false);
  });
});

describe('commitLearningText', () => {
  it('总开关关闭时原样返回入参 learning（不产生新对象，调用方据此判断是否需要保存）', () => {
    const state = defaultState();
    state.settings.completion.enabled = false;
    const next = commitLearningText(state, '这是一条测试文本');
    expect(next).toBe(state.learning);
  });

  it('总开关开启时按行喂给学习引擎，产生新的 learning 对象', () => {
    const state = defaultState();
    const next = commitLearningText(state, '这是一条足够长的测试文本');
    expect(next).not.toBe(state.learning);
    const key = learnKey('zh', '这是一条足够长的测试文本');
    expect(next.rawCounts[key].count).toBe(1);
  });
});
