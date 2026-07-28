/* ============================================================
 * pool.js —— 行内补全候选池合成 + 学习数据读写入口（纯逻辑）
 * ------------------------------------------------------------
 * 主窗口 store.js 与浮窗各自维护过一份 completionPool，且 key 算法
 * 两边不同源（回归 bug）：
 *   - store.js 旧版：preset 用 `pfx + 原文`（未归一化）当 key；
 *   - 浮窗旧版：preset 用 `learnKey(lang, text)`（归一化过）当 key。
 * 同一句「请使用 Markdown 格式输出。」在两窗口各算出一个不同的 key，
 * shown/accepted 统计被劈成两份；且主窗口池里若有一条内容相同的
 * learned 片段（片段 key 本就是归一化的），会与 preset 的原文 key
 * 不同，导致 seen 去重失效、池里出现重复候选。
 *
 * 本模块统一采用浮窗那一版算法：**preset 的 key 也用 learnKey(lang,
 * text) 归一化生成**——理由：
 *   1. 归一化 key 才能让 preset 与内容相同的 learned 片段落到同一个
 *      桶，seen 去重才真正生效；
 *   2. 与 learnedFragments 产出的片段 key、以及 splitTail 算出的
 *      bigram prefixKey（同为 learnKey(lang, prev)）同源，展示/采纳
 *      记账和 bigram 关联才能在两窗口之间正确合并。
 *
 * 存量数据的影响：主窗口此前用原文 key 记的 preset 的 shown/accepted
 * 统计，升级后与新 key 对不上，相当于那部分 preset 的记账归零重学。
 * 这是可接受的代价（学习数据本就可以再学，且旧账本来就是错的、被
 * 劈成两半的），因此这里不加迁移逻辑，也不动 LEARN_VERSION。
 *
 * 铁律与 core.js 一致：不碰 document，不触发渲染。
 * ============================================================ */
import { BUILTIN_SNIPPETS, learnKey, learnedFragments, learn } from './core.js';

function completionEnabled(state) {
  return !!(state.settings && state.settings.completion && state.settings.completion.enabled);
}

// 把三处素材（快速段落 / 常用句含内置+自定义 / 已提炼 learned 片段）按当前
// 语言摊平成 [{ key, text, source }]。key 一律用 learnKey 归一化生成，
// 与学习数据的 key、splitTail 算出的 bigram prefixKey 同源，保证
// shown/accepted/bigram 能在主窗口与浮窗之间正确合并对上号。
function completionPool(state) {
  if (!completionEnabled(state)) return []; // 总开关关闭：不展示候选，也就不会再产生新的 shown/accepted 记账
  var lang = state.lang;
  var seen = {};
  var pool = [];
  function add(text, source) {
    if (typeof text !== 'string') return;
    var t = text;
    if (t.trim() === '') return;
    var key = learnKey(lang, t);
    if (seen[key]) return;
    seen[key] = true;
    pool.push({ key: key, text: t, source: source });
  }
  // 快速段落
  (state.quickGroups || []).forEach(function (g) {
    (g.items || []).forEach(function (it) {
      var tx = it.text || {};
      add(tx[lang] || tx.zh || tx.en, 'preset');
    });
  });
  // 常用句：内置（含 patch 后的当前值）+ 自定义
  BUILTIN_SNIPPETS.forEach(function (b) {
    var p = (state.builtinPatches && state.builtinPatches[b.id]) || {};
    if (p.hidden) return;
    add((p[lang] !== undefined ? p[lang] : b[lang]) || b.zh || b.en, 'preset');
  });
  (state.customSnippets || []).forEach(function (c) {
    if (c.hidden) return;
    add(c[lang] || c.zh || c.en, 'preset');
  });
  // 自学习片段（读时从整行 rawCounts 现切；片段的 key 本就是 learnKey(lang, text)，
  // 与上面 preset 的 key 算法同源，seen 去重对内容相同的 preset/learned 才会生效）
  var segMode = (state.settings && state.settings.completion && state.settings.completion.segMode) || 'clause';
  learnedFragments(state.learning, lang, { mode: segMode }).forEach(function (s) { add(s.text, 'learned'); });
  return pool;
}

// 用户「完整用过一段文本」（复制/下载正文、浮窗点击即粘贴）时喂给学习引擎，
// 累计 rawCounts、达阈值自动提炼——返回新的 learning。总开关关闭时原样
// 返回入参 learning（不产生新对象），调用方据此判断「是否真的变了、要不要
// scheduleSave」，避免总开关关闭时仍然触发一次无意义的保存。
function commitLearningText(state, text) {
  if (!completionEnabled(state)) return state.learning;
  var lines = String(text == null ? '' : text).split('\n');
  return learn('commit', { lang: state.lang, lines: lines }, state.learning);
}

export { completionEnabled, completionPool, commitLearningText };
