import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const {
  defaultLearning,
  normalizeLearning,
  learnKey,
  getCandidates,
  scoreCandidate,
  rankCandidates,
  learn,
  learnedSnippets,
  isInCodeContext,
} = loadComposer();

// 固定随机源，消除打分扰动带来的抖动，让排序断言稳定。
const noRand = () => 0;

describe('getCandidates', () => {
  const pool = [
    { key: 'zhcommit and push. ', text: 'commit and push. ', source: 'preset' },
    { key: 'zhcreate pr.', text: 'create pr.', source: 'preset' },
    { key: 'zh更新记忆', text: '更新记忆', source: 'preset' },
  ];

  it('前缀命中返回带 remainder 的候选', () => {
    const r = getCandidates('commit', pool);
    expect(r.length).toBe(1);
    expect(r[0].text).toBe('commit and push. ');
    expect(r[0].remainder).toBe(' and push. ');
  });

  it('不命中返回空', () => {
    expect(getCandidates('xyz', pool)).toEqual([]);
  });

  it('空/纯空白输入返回空', () => {
    expect(getCandidates('', pool)).toEqual([]);
    expect(getCandidates('   ', pool)).toEqual([]);
  });

  it('候选去掉首尾空白后再前缀匹配', () => {
    // pool 里 'commit and push. ' 尾部有空格；输入完整前缀仍应命中且 remainder 正确
    const r = getCandidates('commit and push.', pool);
    expect(r.length).toBe(1);
    expect(r[0].remainder).toBe(' ');
  });

  it('候选不比输入长时不返回（没有可补内容）', () => {
    const r = getCandidates('create pr.', pool);
    expect(r).toEqual([]);
  });

  it('中文前缀匹配', () => {
    const r = getCandidates('更新', pool);
    expect(r.length).toBe(1);
    expect(r[0].remainder).toBe('记忆');
  });

  it('pool 非数组时返回空', () => {
    expect(getCandidates('a', null)).toEqual([]);
  });
});

describe('scoreCandidate', () => {
  it('高接受率 > 低接受率', () => {
    const L = defaultLearning();
    L.snippets['hi'] = { shown: 10, accepted: 9, lastUsedAt: 0, source: 'preset' };
    L.snippets['lo'] = { shown: 10, accepted: 1, lastUsedAt: 0, source: 'preset' };
    const now = 1_000_000;
    expect(scoreCandidate('hi', null, L, now, noRand))
      .toBeGreaterThan(scoreCandidate('lo', null, L, now, noRand));
  });

  it('无历史新片段拿到乐观初始分（非 0）', () => {
    const L = defaultLearning();
    const s = scoreCandidate('never-seen', null, L, 1_000_000, noRand);
    expect(s).toBeGreaterThan(0);
  });

  it('bigram 命中的候选加分', () => {
    const L = defaultLearning();
    L.snippets['c'] = { shown: 10, accepted: 5, lastUsedAt: 0, source: 'preset' };
    const now = 1_000_000;
    const base = scoreCandidate('c', null, L, now, noRand);
    L.bigrams['prefix'] = { c: 8, other: 2 };
    const withCtx = scoreCandidate('c', 'prefix', L, now, noRand);
    expect(withCtx).toBeGreaterThan(base);
  });

  it('新近的 > 陈旧的（其余条件相同）', () => {
    const now = 100 * 24 * 60 * 60 * 1000; // 第 100 天
    const L = defaultLearning();
    L.snippets['fresh'] = { shown: 10, accepted: 5, lastUsedAt: now, source: 'preset' };
    L.snippets['stale'] = { shown: 10, accepted: 5, lastUsedAt: 0, source: 'preset' };
    expect(scoreCandidate('fresh', null, L, now, noRand))
      .toBeGreaterThan(scoreCandidate('stale', null, L, now, noRand));
  });
});

describe('rankCandidates', () => {
  it('按分数降序，且不改变数量', () => {
    const L = defaultLearning();
    L.snippets['a'] = { shown: 10, accepted: 1, lastUsedAt: 0, source: 'preset' };
    L.snippets['b'] = { shown: 10, accepted: 9, lastUsedAt: 0, source: 'preset' };
    const cands = [
      { key: 'a', text: 'aaa', source: 'preset', remainder: 'aa' },
      { key: 'b', text: 'bbb', source: 'preset', remainder: 'bb' },
    ];
    const ranked = rankCandidates(cands, null, L, 1_000_000, noRand);
    expect(ranked.length).toBe(2);
    expect(ranked[0].key).toBe('b'); // 高接受率排前
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('入参非数组返回空', () => {
    expect(rankCandidates(null, null, defaultLearning(), 0, noRand)).toEqual([]);
  });
});

describe('learn', () => {
  it('shown 使 shown+1 且不改入参', () => {
    const L0 = defaultLearning();
    const L1 = learn('shown', { candKey: 'k' }, L0, 1000);
    expect(L1.snippets['k'].shown).toBe(1);
    expect(L0.snippets['k']).toBeUndefined(); // 原对象未被改动
  });

  it('accepted 使 accepted+1、更新 lastUsedAt、写 bigram', () => {
    let L = defaultLearning();
    L = learn('shown', { candKey: 'k' }, L, 1000);
    L = learn('accepted', { candKey: 'k', prefixKey: 'p' }, L, 2000);
    expect(L.snippets['k'].accepted).toBe(1);
    expect(L.snippets['k'].lastUsedAt).toBe(2000);
    expect(L.bigrams['p']['k']).toBe(1);
  });

  it('accepted 时展示数不小于采纳数（防御）', () => {
    let L = defaultLearning();
    L = learn('accepted', { candKey: 'k' }, L, 1000); // 未 shown 直接 accepted
    expect(L.snippets['k'].shown).toBeGreaterThanOrEqual(L.snippets['k'].accepted);
  });

  it('commit 累计 rawCounts，达阈值提炼 learned 片段', () => {
    let L = defaultLearning();
    const line = '这是一句会被重复提交的话';
    const rk = learnKey('zh', line);
    for (let i = 0; i < 3; i++) {
      L = learn('commit', { lang: 'zh', lines: [line] }, L, 1000 + i);
    }
    expect(L.rawCounts[rk].count).toBe(3);
    expect(L.snippets[rk]).toBeDefined();
    expect(L.snippets[rk].source).toBe('learned');
  });

  it('commit 忽略过短的行', () => {
    let L = defaultLearning();
    L = learn('commit', { lang: 'zh', lines: ['ab', '  ', ''] }, L, 1000);
    expect(Object.keys(L.rawCounts).length).toBe(0);
  });

  it('未达阈值不提炼', () => {
    let L = defaultLearning();
    const line = '只提交两次的一句话内容';
    const rk = learnKey('zh', line);
    L = learn('commit', { lang: 'zh', lines: [line] }, L, 1000);
    L = learn('commit', { lang: 'zh', lines: [line] }, L, 1001);
    expect(L.rawCounts[rk].count).toBe(2);
    expect(L.snippets[rk]).toBeUndefined();
  });
});

describe('learnedSnippets', () => {
  it('只返回对应语言的 learned 片段', () => {
    let L = defaultLearning();
    const zhLine = '中文重复提交的一句话内容';
    const enLine = 'an english repeated sentence';
    for (let i = 0; i < 3; i++) {
      L = learn('commit', { lang: 'zh', lines: [zhLine] }, L, 1000 + i);
      L = learn('commit', { lang: 'en', lines: [enLine] }, L, 2000 + i);
    }
    const zh = learnedSnippets(L, 'zh');
    const en = learnedSnippets(L, 'en');
    expect(zh.map((s) => s.text)).toContain(zhLine);
    expect(zh.map((s) => s.text)).not.toContain(enLine);
    expect(en.map((s) => s.text)).toContain(enLine);
  });
});

describe('normalizeLearning', () => {
  it('空/非法输入回退合法结构', () => {
    expect(normalizeLearning(undefined)).toEqual(defaultLearning());
    expect(normalizeLearning(null)).toEqual(defaultLearning());
    expect(normalizeLearning([])).toEqual(defaultLearning());
    expect(normalizeLearning('x')).toEqual(defaultLearning());
  });

  it('version 不符时重置', () => {
    const stale = { version: 999, snippets: { k: { shown: 5, accepted: 3 } }, bigrams: {}, rawCounts: {} };
    expect(normalizeLearning(stale)).toEqual(defaultLearning());
  });

  it('脏字段被兜底为合法值', () => {
    const dirty = {
      version: 1,
      snippets: { k: { shown: 'x', accepted: null, source: 'weird' }, bad: 42 },
      bigrams: { p: { c: -3, ok: 2 }, junk: 'nope' },
      rawCounts: { r: { text: 'hi there friend', count: 'nan', lang: 'zz' }, bad: { count: 1 } },
    };
    const out = normalizeLearning(dirty);
    expect(out.snippets['k'].shown).toBe(0);
    expect(out.snippets['k'].accepted).toBe(0);
    expect(out.snippets['k'].source).toBe('preset'); // 未知 source 归为 preset
    expect(out.snippets['bad']).toBeUndefined();
    expect(out.bigrams['p']).toEqual({ ok: 2 }); // 负计数被剔除
    expect(out.bigrams['junk']).toBeUndefined();
    expect(out.rawCounts['r'].count).toBe(0);
    expect(out.rawCounts['r'].lang).toBe('zh'); // 未知语言归为 zh
    expect(out.rawCounts['bad']).toBeUndefined(); // 缺 text 被丢弃
  });
});

describe('isInCodeContext', () => {
  it('未闭合围栏内判为代码区', () => {
    expect(isInCodeContext('前文\n```js\nconst a = 1')).toBe(true);
  });

  it('闭合围栏之后不是代码区', () => {
    expect(isInCodeContext('```js\nconst a = 1\n```\n普通文字')).toBe(false);
  });

  it('本行内未闭合反引号判为代码区', () => {
    expect(isInCodeContext('这里有 `code')).toBe(true);
  });

  it('本行内成对反引号不是代码区', () => {
    expect(isInCodeContext('这里有 `code` 然后继续')).toBe(false);
  });

  it('纯普通文本不是代码区', () => {
    expect(isInCodeContext('普通的一句话')).toBe(false);
    expect(isInCodeContext('')).toBe(false);
  });
});
