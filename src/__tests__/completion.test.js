import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';
// splitTail 在 completion.js（UI 逻辑层但不触 DOM，jsdom 环境下可直接 import）。
import { splitTail } from '../completion.js';

const {
  defaultLearning,
  normalizeLearning,
  normalizeLearnText,
  learnKey,
  segmentClause,
  segmentText,
  clauseTailParts,
  learnedFragments,
  getCandidates,
  scoreCandidate,
  rankCandidates,
  learn,
  learnedSnippets,
  buildLearningExportBundle,
  validateLearningImportBundle,
  mergeLearningImport,
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

  it('version 高于当前或缺失时重置（无法安全迁移）', () => {
    const stale = { version: 999, snippets: { k: { shown: 5, accepted: 3 } }, bigrams: {}, rawCounts: {} };
    expect(normalizeLearning(stale)).toEqual(defaultLearning());
    const noVer = { snippets: { k: { shown: 5, accepted: 3 } }, bigrams: {}, rawCounts: {} };
    expect(normalizeLearning(noVer)).toEqual(defaultLearning());
  });

  it('脏字段被兜底为合法值', () => {
    const dirty = {
      version: 2,
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

describe('normalizeLearnText（合并去重的归一化）', () => {
  it('连续空白压成单空格并 trim', () => {
    expect(normalizeLearnText('  你是一名   资深工程师  ')).toBe('你是一名 资深工程师');
  });

  it('全角标点归一为半角', () => {
    expect(normalizeLearnText('擅长开发，尤其熟悉'))
      .toBe(normalizeLearnText('擅长开发,尤其熟悉'));
  });

  it('去句末孤立标点', () => {
    expect(normalizeLearnText('请严格按格式输出'))
      .toBe(normalizeLearnText('请严格按格式输出。'));
  });

  it('英文大小写归一', () => {
    expect(normalizeLearnText('use TypeScript')).toBe(normalizeLearnText('use typescript'));
    expect(normalizeLearnText('use TypeScript')).toBe('use typescript');
  });

  it('不去中文词间空格（保守：仅压连续空白）', () => {
    // 单个词间空格保留（压缩只针对“连续”空白），故这两者不视为同一句
    expect(normalizeLearnText('你是一名 资深工程师'))
      .not.toBe(normalizeLearnText('你是一名资深工程师'));
  });

  it('learnKey 对格式差异的同一句落到同一 key', () => {
    expect(learnKey('zh', '擅长开发，尤其熟悉Web。'))
      .toBe(learnKey('zh', '擅长开发,尤其熟悉web'));
  });

  it('learnKey 语言前缀仍区分中英', () => {
    expect(learnKey('zh', 'hello world')).not.toBe(learnKey('en', 'hello world'));
  });
});

describe('commit 在 v2 下合并格式差异', () => {
  it('三种格式差异的同一句累计到同一条、达阈值提炼', () => {
    let L = defaultLearning();
    // 同一句、三种写法：全角/半角标点、多空格、大小写差异
    L = learn('commit', { lang: 'zh', lines: ['擅长 Web 开发，尤其熟悉 TypeScript'] }, L, 1000);
    L = learn('commit', { lang: 'zh', lines: ['擅长 Web 开发,尤其熟悉 typescript'] }, L, 1001);
    L = learn('commit', { lang: 'zh', lines: ['擅长 Web 开发，尤其熟悉 TypeScript。'] }, L, 1002);
    const rk = learnKey('zh', '擅长 Web 开发，尤其熟悉 TypeScript');
    expect(Object.keys(L.rawCounts).length).toBe(1); // 合并成一条
    expect(L.rawCounts[rk].count).toBe(3);
    expect(L.snippets[rk]).toBeDefined();
    expect(L.snippets[rk].source).toBe('learned');
    // text 保留第一次见到的原文
    expect(L.rawCounts[rk].text).toBe('擅长 Web 开发，尤其熟悉 TypeScript');
  });

  it('整行纯标点/纯空白（归一化后为空）不学，不同行不会被错误合并', () => {
    let L = defaultLearning();
    // 三行语义无关、各自长度 >=4 通过过短过滤，但归一化后都为空
    L = learn('commit', { lang: 'zh', lines: ['。。。。'] }, L, 1000);
    L = learn('commit', { lang: 'zh', lines: ['!!!!!'] }, L, 1001);
    L = learn('commit', { lang: 'zh', lines: ['?? ?? ??'] }, L, 1002);
    expect(Object.keys(L.rawCounts).length).toBe(0); // 一条都不学
    expect(Object.keys(L.snippets).length).toBe(0);  // 更不会提炼成候选
  });
});

describe('migrateLearningV1toV2（存量数据迁移）', () => {
  // 构造 v1 结构：手工用旧式 key（未归一化）。旧 learnKey 是「langPfx + U+0001 + trim后原文」。
  const SEP = '';
  function v1Key(lang, rawText) { return lang + SEP + rawText; }

  it('normalizeLearning 对 version:1 触发迁移而非重置', () => {
    const kA = v1Key('zh', '一句测试用的原始文本内容');
    const v1 = {
      version: 1,
      snippets: { [kA]: { shown: 5, accepted: 2, lastUsedAt: 9, source: 'learned' } },
      bigrams: {},
      rawCounts: { [kA]: { text: '一句测试用的原始文本内容', count: 3, lang: 'zh' } },
    };
    const out = normalizeLearning(v1);
    expect(out.version).toBe(2);
    // 数据没被清空
    const nk = learnKey('zh', '一句测试用的原始文本内容');
    expect(out.rawCounts[nk]).toBeDefined();
    expect(out.rawCounts[nk].count).toBe(3);
    expect(out.snippets[nk].source).toBe('learned');
  });

  it('两条仅格式差异的 v1 条目迁移后合并、计数相加', () => {
    const k1 = v1Key('zh', '擅长开发，尤其熟悉Web');   // 全角逗号
    const k2 = v1Key('zh', '擅长开发,尤其熟悉web');    // 半角逗号 + 小写
    const v1 = {
      version: 1,
      snippets: {
        [k1]: { shown: 4, accepted: 2, lastUsedAt: 100, source: 'preset' },
        [k2]: { shown: 3, accepted: 1, lastUsedAt: 200, source: 'learned' },
      },
      bigrams: {},
      rawCounts: {
        [k1]: { text: '擅长开发，尤其熟悉Web', count: 2, lang: 'zh' },
        [k2]: { text: '擅长开发,尤其熟悉web', count: 2, lang: 'zh' },
      },
    };
    const out = normalizeLearning(v1);
    const nk = learnKey('zh', '擅长开发，尤其熟悉Web');
    expect(Object.keys(out.rawCounts).length).toBe(1);
    expect(out.rawCounts[nk].count).toBe(4);             // 2 + 2
    expect(out.snippets[nk].shown).toBe(7);              // 4 + 3
    expect(out.snippets[nk].accepted).toBe(3);           // 2 + 1
    expect(out.snippets[nk].lastUsedAt).toBe(200);       // max
    expect(out.snippets[nk].source).toBe('learned');     // 任一 learned 则 learned
  });

  it('合并使计数达阈值时补提炼 learned 片段', () => {
    // 两条各 2 次、原本都未达阈值 3、且都无 learned snippet；归一化后同 key → 合并成 4 次
    const k1 = v1Key('zh', '这是同一句仅标点不同的话。');
    const k2 = v1Key('zh', '这是同一句仅标点不同的话');
    const v1 = {
      version: 1,
      snippets: {},
      bigrams: {},
      rawCounts: {
        [k1]: { text: '这是同一句仅标点不同的话。', count: 2, lang: 'zh' },
        [k2]: { text: '这是同一句仅标点不同的话', count: 2, lang: 'zh' },
      },
    };
    const out = normalizeLearning(v1);
    const nk = learnKey('zh', '这是同一句仅标点不同的话');
    expect(out.rawCounts[nk].count).toBe(4);
    expect(out.snippets[nk]).toBeDefined();
    expect(out.snippets[nk].source).toBe('learned');
  });

  it('bigrams 的 prefixKey 与 candKey 都被重映射合并', () => {
    const pfx1 = v1Key('zh', '前缀，');
    const pfx2 = v1Key('zh', '前缀');
    const cand1 = v1Key('zh', '候选。');
    const cand2 = v1Key('zh', '候选');
    const v1 = {
      version: 1,
      snippets: {},
      bigrams: { [pfx1]: { [cand1]: 3 }, [pfx2]: { [cand2]: 2 } },
      rawCounts: {},
    };
    const out = normalizeLearning(v1);
    const npfx = learnKey('zh', '前缀');
    const ncand = learnKey('zh', '候选');
    expect(Object.keys(out.bigrams).length).toBe(1);
    expect(out.bigrams[npfx][ncand]).toBe(5); // 3 + 2
  });

  it('不含分隔符的脏 key 在迁移中被丢弃', () => {
    const v1 = {
      version: 1,
      snippets: { plainbad: { shown: 1, accepted: 1, lastUsedAt: 0, source: 'learned' } },
      bigrams: {},
      rawCounts: { plainbad: { text: '脏数据没有分隔符前缀', count: 5, lang: 'zh' } },
    };
    const out = normalizeLearning(v1);
    expect(Object.keys(out.rawCounts).length).toBe(0);
    expect(Object.keys(out.snippets).length).toBe(0);
  });
});

describe('导入导出（含 v1/v2 兼容）', () => {
  it('导出 bundle 版本为当前 LEARN_VERSION 且只含 learned', () => {
    let L = defaultLearning();
    const line = '一句会被提炼成learned的测试话语';
    for (let i = 0; i < 3; i++) L = learn('commit', { lang: 'zh', lines: [line] }, L, 1000 + i);
    const bundle = buildLearningExportBundle(L);
    expect(bundle.kind).toBe('composer-learning');
    expect(bundle.version).toBe(2);
    const nk = learnKey('zh', line);
    expect(bundle.rawCounts[nk]).toBeDefined();
  });

  it('validate 接受 v1 / v2，拒绝更高版本与非法', () => {
    const base = { kind: 'composer-learning', snippets: {}, rawCounts: {} };
    expect(validateLearningImportBundle({ ...base, version: 1 }).ok).toBe(true);
    expect(validateLearningImportBundle({ ...base, version: 2 }).ok).toBe(true);
    expect(validateLearningImportBundle({ ...base, version: 3 }).code).toBe('too-new');
    expect(validateLearningImportBundle({ ...base, version: 0 }).code).toBe('bad-schema');
    expect(validateLearningImportBundle({ version: 2 }).code).toBe('not-learning');
    expect(validateLearningImportBundle(null).code).toBe('not-object');
  });

  it('导入按新 key 重算：v1 bundle 的条目与本地 v2 同一句合并', () => {
    // 本地已有一条 v2 数据
    let L = defaultLearning();
    const line = '共享的同一句话仅格式略有差异';
    for (let i = 0; i < 3; i++) L = learn('commit', { lang: 'zh', lines: [line] }, L, 1000 + i);

    // 模拟一个 v1 导出 bundle：key 未归一化、文本是同一句的另一种写法
    const v1RawKey = 'zh共享的同一句话仅格式略有差异。'; // 末尾多句号
    const bundle = {
      kind: 'composer-learning', version: 1,
      snippets: { [v1RawKey]: { shown: 2, accepted: 1, lastUsedAt: 5000, source: 'learned' } },
      rawCounts: { [v1RawKey]: { text: '共享的同一句话仅格式略有差异。', count: 4, lang: 'zh' } },
    };
    const { learning, importedCount } = mergeLearningImport(L, bundle);
    const nk = learnKey('zh', line);
    expect(importedCount).toBe(1);
    expect(Object.keys(learning.rawCounts).length).toBe(1); // 合并成一条
    expect(learning.rawCounts[nk].count).toBe(3 + 4);
    expect(learning.rawCounts[nk].text).toBe(line);         // 保留本地原文
  });
});

/* ============================================================
 * 步骤一（P1）：读时子句切分 —— 句中可接续 + bigram 对中文生效
 * ============================================================ */
describe('segmentClause（子句切分）', () => {
  it('按句读标点切子句，单空格不拆散', () => {
    expect(segmentClause('你是一名工程师，擅长 Web 开发'))
      .toEqual(['你是一名工程师', '擅长 Web 开发']);
    // 关键：擅长 Web 开发 内部是单空格，绝不能被拆成 擅长 / Web / 开发
    expect(segmentClause('擅长 Web 开发')).toEqual(['擅长 Web 开发']);
  });

  it('连续 2 个及以上空格才作边界', () => {
    expect(segmentClause('foo  bar')).toEqual(['foo', 'bar']);   // 双空格拆
    expect(segmentClause('foo bar')).toEqual(['foo bar']);       // 单空格不拆
  });

  it('换行/制表/全角空格都是边界', () => {
    expect(segmentClause('甲甲\n乙乙\t丙丙　丁丁')).toEqual(['甲甲', '乙乙', '丙丙', '丁丁']);
  });

  it('纯标点 / 空串 → []', () => {
    expect(segmentClause('。。。')).toEqual([]);
    expect(segmentClause('，,! ? ；')).toEqual([]);
    expect(segmentClause('')).toEqual([]);
    expect(segmentClause(null)).toEqual([]);
  });
});

describe('segmentText（切分入口）', () => {
  it('默认（不传 mode）与 segmentClause 一致', () => {
    const s = '你是一名工程师，擅长 Web 开发';
    expect(segmentText(s)).toEqual(segmentClause(s));
  });
  // word 模式行为见「步骤二（P2）」测试块。
});

describe('clauseTailParts（供 splitTail 复用）', () => {
  it('取最后一个子句作 tail、其前一子句作 prev', () => {
    expect(clauseTailParts('工程师，擅长 Web')).toEqual({ tail: '擅长 Web', prev: '工程师' });
  });
  it('无边界时整段为 tail、prev 为空', () => {
    expect(clauseTailParts('擅长 Web 开发')).toEqual({ tail: '擅长 Web 开发', prev: '' });
  });
  it('tail 去前导空白、保留尾部空白', () => {
    const p = clauseTailParts('前一句，  擅长 Web ');
    expect(p.tail).toBe('擅长 Web ');   // 前导双空格去掉，尾部单空格保留
    expect(p.prev).toBe('前一句');
  });
});

describe('learnedFragments（读时片段池）', () => {
  it('同一子句出现在 2 行（各 count 1）→ 进池（lines>=2）', () => {
    let L = defaultLearning();
    L = learn('commit', { lang: 'zh', lines: ['擅长 Web 开发，尤其熟悉后端架构'] }, L, 1000);
    L = learn('commit', { lang: 'zh', lines: ['我需要一个人，擅长 Web 开发'] }, L, 1001);
    const frags = learnedFragments(L, 'zh', {});
    const texts = frags.map((f) => f.text);
    expect(texts).toContain('擅长 Web 开发');
    // 其余只出现 1 行、count 1 的子句不进池
    expect(texts).not.toContain('尤其熟悉后端架构');
    const hit = frags.find((f) => f.text === '擅长 Web 开发');
    expect(hit.lines).toBe(2);
    expect(hit.count).toBe(2);
  });

  it('单行 count 3、子句 lines=1 → 也进池（count>=minCount）', () => {
    let L = defaultLearning();
    for (let i = 0; i < 3; i++) L = learn('commit', { lang: 'zh', lines: ['请务必仔细检查代码逻辑'] }, L, 2000 + i);
    const frags = learnedFragments(L, 'zh', {});
    const hit = frags.find((f) => f.text === '请务必仔细检查代码逻辑');
    expect(hit).toBeDefined();
    expect(hit.lines).toBe(1);
    expect(hit.count).toBe(3);
  });

  it('片段字符数 < minLen(4) 被过滤', () => {
    let L = defaultLearning();
    for (let i = 0; i < 3; i++) L = learn('commit', { lang: 'zh', lines: ['行，我们开始处理这个任务吧'] }, L, 3000 + i);
    const frags = learnedFragments(L, 'zh', {});
    const texts = frags.map((f) => f.text);
    expect(texts).not.toContain('行');                 // 单字子句被过滤
    expect(texts).toContain('我们开始处理这个任务吧');   // 长子句进池
  });

  it('只返回对应语言的片段', () => {
    let L = defaultLearning();
    for (let i = 0; i < 3; i++) {
      L = learn('commit', { lang: 'zh', lines: ['一句中文的重复内容够长'] }, L, 4000 + i);
      L = learn('commit', { lang: 'en', lines: ['a repeated english clause'] }, L, 5000 + i);
    }
    expect(learnedFragments(L, 'zh', {}).map((f) => f.text)).toContain('一句中文的重复内容够长');
    expect(learnedFragments(L, 'zh', {}).map((f) => f.text)).not.toContain('a repeated english clause');
    expect(learnedFragments(L, 'en', {}).map((f) => f.text)).toContain('a repeated english clause');
  });
});

describe('端到端：片段池 → getCandidates 命中句中片段', () => {
  it('从句中「擅长 Web」能补出「 开发」（复现痛点）', () => {
    let L = defaultLearning();
    L = learn('commit', { lang: 'zh', lines: ['你是一名工程师，擅长 Web 开发'] }, L, 1000);
    L = learn('commit', { lang: 'zh', lines: ['我们要找的人，擅长 Web 开发'] }, L, 1001);
    const frags = learnedFragments(L, 'zh', {});
    const pool = frags.map((f) => ({ key: f.key, text: f.text, source: f.source }));
    const cands = getCandidates('擅长 Web', pool);
    const hit = cands.find((c) => c.text === '擅长 Web 开发');
    expect(hit).toBeDefined();
    expect(hit.remainder).toBe(' 开发');
  });
});

describe('splitTail（completion.js，子句为单位）', () => {
  it('句中光标：tail=当前子句，prefixKey=上一子句', () => {
    const p = splitTail('工程师，擅长 Web', 'zh');
    expect(p.tail).toBe('擅长 Web');
    expect(p.prefixKey).toBe(learnKey('zh', '工程师'));
  });
  it('无上一子句时 prefixKey 为 null', () => {
    const p = splitTail('擅长 Web 开发', 'zh');
    expect(p.tail).toBe('擅长 Web 开发');
    expect(p.prefixKey).toBe(null);
  });
});

/* ============================================================
 * 步骤二（P2）：词级切分（opt-in，Intl.Segmenter + 特性探测回退）
 * ============================================================ */
describe('segmentText word 模式', () => {
  it('无 Intl.Segmenter 时 word 结果 == clause 结果（回退正确）', () => {
    const orig = Intl.Segmenter;
    try {
      Intl.Segmenter = undefined; // 模拟旧环境（如无 Intl.Segmenter 的老 macOS）
      const s = '今天天气很好我们出去玩吧';
      expect(segmentText(s, { mode: 'word' })).toEqual(segmentClause(s));
    } finally {
      Intl.Segmenter = orig;
    }
  });

  it('有 Intl.Segmenter 时，无标点长句能从词起点接续', () => {
    if (typeof Intl.Segmenter !== 'function') return; // 环境不支持则跳过（回退已单测）
    const s = '今天天气很好我们出去玩吧';
    const segs = segmentText(s, { mode: 'word' });
    expect(segs).toContain(s);                 // 整条子句始终保留
    expect(segs.length).toBeGreaterThan(1);    // 产出了词起点后缀
    // 至少有一个后缀是整句的「真后缀」（从某个词的起点切到句末）
    expect(segs.some((x) => x !== s && s.endsWith(x))).toBe(true);
  });

  it('word 模式后缀数受 maxStarts 限制（防膨胀）', () => {
    if (typeof Intl.Segmenter !== 'function') return;
    const s = '一二三四五六七八九十甲乙丙丁';
    const segs = segmentText(s, { mode: 'word', maxStarts: 2 });
    // 整条子句 + 至多 maxStarts 个后缀
    expect(segs.length).toBeLessThanOrEqual(1 + 2);
  });

  it('clause 模式不产出词后缀（word 是 opt-in）', () => {
    const s = '今天天气很好我们出去玩吧';
    expect(segmentText(s, { mode: 'clause' })).toEqual(segmentClause(s));
    expect(segmentText(s)).toEqual(segmentClause(s));
  });
});
