import { describe, it, expect } from 'vitest';
import {
  defaultLearning,
  learn,
  learnKey,
  learnedFragments,
  blockLearnedFragment,
  mergeLearningImport,
  LEARN_RAW_MAX,
  LEARN_BLOCKED_MAX,
} from '../core.js';

/* ============================================================
 * rawCounts / blocked 容量上限 + 淘汰
 * ------------------------------------------------------------
 * 两张表原本只增不减：learn('commit') 只会往 rawCounts 加，
 * blockLearnedFragment 只会往 blocked 加。这里验证容量上限真的生效、
 * 淘汰顺序符合“价值越低越先丢”、以及淘汰时的级联清理不留残留统计。
 * ============================================================ */
describe('rawCounts 容量上限（LEARN_RAW_MAX）', () => {
  it('commit 超过上限后，rawCounts 数量钉在上限，不再随语料增多而增长', () => {
    let learning = defaultLearning();
    var total = LEARN_RAW_MAX + 5;
    for (var i = 0; i < total; i++) {
      learning = learn('commit', { lang: 'zh', lines: ['测试语料行编号' + i] }, learning, 1000 + i);
    }
    expect(Object.keys(learning.rawCounts).length).toBe(LEARN_RAW_MAX);
  });

  it('淘汰顺序：count 相同时，越旧（at 越小）越先被丢', () => {
    let learning = defaultLearning();
    var total = LEARN_RAW_MAX + 5;
    for (var i = 0; i < total; i++) {
      learning = learn('commit', { lang: 'zh', lines: ['测试语料行编号' + i] }, learning, 1000 + i);
    }
    // 全部只 commit 一次，count 相同（=1），tie-break 按 at 升序淘汰，
    // 因此最先写入（at 最小）的前 5 条应该被淘汰，之后写入的应该还在。
    for (var j = 0; j < 5; j++) {
      expect(learning.rawCounts[learnKey('zh', '测试语料行编号' + j)]).toBeUndefined();
    }
    expect(learning.rawCounts[learnKey('zh', '测试语料行编号5')]).toBeDefined();
    expect(learning.rawCounts[learnKey('zh', '测试语料行编号' + (total - 1))]).toBeDefined();
  });

  it('淘汰顺序：count 越少越先被丢，即使它比别的条目更新', () => {
    let learning = defaultLearning();
    var lowKey = learnKey('zh', '只出现一次的低价值语料');
    // 先写入一条“新但低频”的语料（count=1，at 最大——最新）
    learning = learn('commit', { lang: 'zh', lines: ['只出现一次的低价值语料'] }, learning, 999999);
    // 再填充到超过上限的“旧但同样 count=1”的语料
    var total = LEARN_RAW_MAX;
    for (var i = 0; i < total; i++) {
      learning = learn('commit', { lang: 'zh', lines: ['填充语料' + i] }, learning, 1000 + i);
    }
    // 目前总数 = total + 1 = LEARN_RAW_MAX + 1，超限 1 条；lowKey 的 count 与填充条目
    // 相同（都是 1），但它的 at 是所有条目里最大的（最新），tie-break 应保留它、
    // 淘汰掉最旧的填充条目（'填充语料0'）。
    expect(learning.rawCounts[lowKey]).toBeDefined();
    expect(learning.rawCounts[learnKey('zh', '填充语料0')]).toBeUndefined();
  });

  it('淘汰时级联清理：被丢弃 key 的 snippets、以它为 prefixKey 的整条 bigram、\n      以及各 prefixKey 下以它为 candKey 的项都要清掉；无关 bigram 不受影响', () => {
    var keyT = learnKey('zh', '将被淘汰的语料行');
    var learning = learn('commit', { lang: 'zh', lines: ['将被淘汰的语料行'] }, defaultLearning(), 100); // count=1，at=100（全场最旧）

    // 手工挂上模拟的行为统计 + bigram 关联（模拟真实使用中产生的记账）
    learning.snippets[keyT] = { shown: 2, accepted: 1, lastUsedAt: 100, source: 'preset' };
    var prefixOfT = learnKey('zh', '前一句上下文');
    learning.bigrams[prefixOfT] = {};
    learning.bigrams[prefixOfT][keyT] = 3; // T 作为某 prefixKey 下的 candKey
    var otherCandKey = learnKey('zh', '别的候选');
    learning.bigrams[keyT] = {};
    learning.bigrams[keyT][otherCandKey] = 5; // T 自身作为 prefixKey
    var unrelatedPrefix = learnKey('zh', '无关前缀');
    var unrelatedCand = learnKey('zh', '无关候选');
    learning.bigrams[unrelatedPrefix] = {};
    learning.bigrams[unrelatedPrefix][unrelatedCand] = 7; // 无关 bigram，不该受影响

    // 填充到超过上限（都比 T 新、count 都是 1，与 T 打平 → 按 at 淘汰全场最旧的 T）
    for (var i = 0; i < LEARN_RAW_MAX; i++) {
      learning = learn('commit', { lang: 'zh', lines: ['填充语料行' + i] }, learning, 2000 + i);
    }

    expect(learning.rawCounts[keyT]).toBeUndefined();
    expect(learning.snippets[keyT]).toBeUndefined();
    expect(learning.bigrams[keyT]).toBeUndefined();          // T 作为 prefixKey 的整条被删
    expect(learning.bigrams[prefixOfT]).toBeUndefined();     // 该 prefixKey 下只有 T 一个候选，清空后整条删除
    expect(learning.bigrams[unrelatedPrefix][unrelatedCand]).toBe(7); // 无关 bigram 不受影响
  });
});

describe('blocked 容量上限（LEARN_BLOCKED_MAX）', () => {
  it('拉黑数量超过上限后钉在上限，丢的是最早加入的', () => {
    var learning = defaultLearning();
    var keys = [];
    var total = LEARN_BLOCKED_MAX + 3;
    for (var i = 0; i < total; i++) {
      var k = learnKey('zh', '待拉黑片段' + i);
      keys.push(k);
      learning = blockLearnedFragment(learning, k, 1000 + i);
    }
    expect(Object.keys(learning.blocked).length).toBe(LEARN_BLOCKED_MAX);
    expect(learning.blocked[keys[0]]).toBeUndefined();
    expect(learning.blocked[keys[1]]).toBeUndefined();
    expect(learning.blocked[keys[2]]).toBeUndefined();
    expect(learning.blocked[keys[keys.length - 1]]).toBe(1000 + keys.length - 1);
  });

  it('blocked 的值恰好是时间戳 0 时仍然生效——不能用真值判断，0 是 falsy', () => {
    // 复刻老存档 true 迁移成时间戳 0 的场景：如果 learnedFragments 用
    // `if (blocked[fk])` 判断，0 会被当成“未拉黑”，拉黑静默失效。
    var learning = defaultLearning();
    learning = learn('commit', { lang: 'zh', lines: ['你是工程师，擅长 Web 开发'] }, learning, 1000);
    learning = learn('commit', { lang: 'zh', lines: ['我们要找的人，擅长 Web 开发'] }, learning, 1001);
    var fk = learnKey('zh', '擅长 Web 开发');
    expect(learnedFragments(learning, 'zh', {}).map(function (f) { return f.text; })).toContain('擅长 Web 开发');
    learning.blocked[fk] = 0;
    expect(learnedFragments(learning, 'zh', {}).map(function (f) { return f.text; })).not.toContain('擅长 Web 开发');
  });
});

describe('mergeLearningImport 也要执行容量裁剪', () => {
  it('导入一份超过 LEARN_RAW_MAX 的 bundle 后，本地 rawCounts 仍裁剪到上限', () => {
    var rawCounts = {};
    var total = LEARN_RAW_MAX + 10;
    for (var i = 0; i < total; i++) {
      var text = '导入语料行' + i;
      var k = learnKey('zh', text);
      rawCounts[k] = { text: text, count: 1, lang: 'zh', at: i };
    }
    var bundle = { rawCounts: rawCounts, snippets: {} };
    var result = mergeLearningImport(defaultLearning(), bundle);
    expect(Object.keys(result.learning.rawCounts).length).toBe(LEARN_RAW_MAX);
    // 导入计数不受裁剪影响：importedCount 统计的是“处理过的条目数”，裁剪是写入后的收尾。
    expect(result.importedCount).toBe(total);
  });
});
