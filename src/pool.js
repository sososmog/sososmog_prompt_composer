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
 * ------------------------------------------------------------
 * 候选池缓存（性能）
 * ------------------------------------------------------------
 * completionPool(state) 被 completion.js 的 recompute() 挂在 textarea
 * 的 input 事件上，理论上每敲一个字符都会调一次。它内部的 learnedFragments
 * 要遍历整份 rawCounts、对每一行做 segmentText 切片段再聚合——实测 300 行
 * 语料、word 模式下单次耗时 18.7ms，且随语料行数线性增长，语料涨到上千行
 * 会让每次按键都出现能感知到的卡顿。这里用一个模块级单条缓存避免同一份
 * 素材 + 语料被重复合成。
 *
 * 缓存失效判据分两类，取舍如下：
 *
 *   1) state.learning —— 用**引用比对**。
 *      可靠的前提：core.js 的 learn()/blockLearnedFragment()/
 *      removeLearnedSnippet() 一律先 normalizeLearning() 整体重建一份新
 *      结构、再在新结构上改，不会原地改入参（已逐一读过 core.js 源码确认）。
 *      语料变了引用必变，没变引用必不变，O(1) 且不会漏判。
 *      语料（rawCounts）才是真正的大头（几百到几千行），能用 O(1) 的引用
 *      比对兜住是这份缓存收益的主要来源，因此**不对语料做内容级 hash**——
 *      如果连语料也要逐行 hash，性能就和不缓存没有本质区别了。
 *
 *   2) 素材（quickGroups / customSnippets / builtinPatches）—— **不能只靠
 *      引用比对**。管理面板改常用句内容是原地改数组里对象的某个字段
 *      （quick.js 的 updateCustomSnippetField：
 *        state.customSnippets[i][field] = value），数组引用本身不变，
 *      纯引用比对会漏掉这次改动、缓存就是旧的。改素材的地方（quick.js）
 *      不在本次可改文件范围内，无法在那一侧显式调用失效，因此这里退而
 *      求其次：对素材做一个**廉价但足够敏感**的签名——对常用句 / 快速
 *      段落 / 内置 patch 的文本字段逐字符做滚动 hash，任何一个字改了签名
 *      就变（只用长度之和判断不够：改一个字长度不变，会漏判）。素材统共
 *      几十条、字符总量几百到几千，这个 hash 的开销比“每次按键都重新
 *      遍历几千行语料重切一次候选池”低两三个数量级，可以忽略。
 *      同时导出 invalidateCompletionPool()，供将来在改素材的地方（比如
 *      quick.js）显式调用；但当前实现的正确性**不依赖**它——即使没人调
 *      用它，素材签名也能独立兜住失效判定，这里只是多留一个显式失效的
 *      口子。
 *
 * 铁律与 core.js 一致：不碰 document，不触发渲染。
 * ============================================================ */
import { BUILTIN_SNIPPETS, learnKey, learnedFragments, learn } from './core.js';

function completionEnabled(state) {
  return !!(state.settings && state.settings.completion && state.settings.completion.enabled);
}

// 逐字符滚动 hash（经典的 Java 字符串 hashCode 算法），`| 0` 把结果收敛到
// 32 位有符号整数防止溢出。只用来判断“内容变没变”，不追求抗碰撞强度。
function hashStr(h, str) {
  var s = String(str == null ? '' : str);
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// 素材签名：见文件头“候选池缓存”注释里“为什么不能只靠引用比对”的说明。
// 开销 O(素材条数 + 素材文本总长度)，相对遍历几千行语料可忽略不计。
function materialsSignature(state) {
  var h = 0;
  var quickGroups = state.quickGroups || [];
  h = hashStr(h, 'qg' + quickGroups.length);
  quickGroups.forEach(function (g) {
    var items = g.items || [];
    h = hashStr(h, (g.hidden ? '1' : '0') + 'i' + items.length);
    items.forEach(function (it) {
      var tx = it.text || {};
      h = hashStr(h, (tx.zh || '') + '' + (tx.en || '') + '');
    });
  });
  var patches = state.builtinPatches || {};
  var pKeys = Object.keys(patches).sort();
  h = hashStr(h, 'bp' + pKeys.length);
  pKeys.forEach(function (id) {
    var p = patches[id] || {};
    h = hashStr(h, id + '=' + (p.hidden ? '1' : '0') + (p.zh || '') + '' + (p.en || '') + '');
  });
  var customs = state.customSnippets || [];
  h = hashStr(h, 'cs' + customs.length);
  customs.forEach(function (c) {
    h = hashStr(h, (c.hidden ? '1' : '0') + (c.zh || '') + '' + (c.en || '') + '');
  });
  return h;
}

// 候选池单条缓存：{ lang, segMode, learningRef, materialsHash, pool }。
// 命中时直接返回上次那个数组引用（单测据此断言“没有重算”：两次调用拿到
// 同一个数组引用）。
var poolCache = null;

// 供将来在素材改动处（比如 quick.js）显式调用；当前实现的正确性不依赖它，
// 见文件头“候选池缓存”注释。
function invalidateCompletionPool() {
  poolCache = null;
}

// 把三处素材（快速段落 / 常用句含内置+自定义 / 已提炼 learned 片段）按当前
// 语言摊平成 [{ key, text, source }]。key 一律用 learnKey 归一化生成，
// 与学习数据的 key、splitTail 算出的 bigram prefixKey 同源，保证
// shown/accepted/bigram 能在主窗口与浮窗之间正确合并对上号。
function buildCompletionPool(state, lang, segMode) {
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
  learnedFragments(state.learning, lang, { mode: segMode }).forEach(function (s) { add(s.text, 'learned'); });
  return pool;
}

function completionPool(state) {
  if (!completionEnabled(state)) return []; // 总开关关闭：不展示候选，也就不会再产生新的 shown/accepted 记账
  var lang = state.lang;
  var segMode = (state.settings && state.settings.completion && state.settings.completion.segMode) || 'clause';
  var learningRef = state.learning;
  var materialsHash = materialsSignature(state);

  if (poolCache && poolCache.lang === lang && poolCache.segMode === segMode &&
      poolCache.learningRef === learningRef && poolCache.materialsHash === materialsHash) {
    return poolCache.pool; // 命中：语料引用没变、素材签名没变，直接复用上次结果，不重算
  }

  var pool = buildCompletionPool(state, lang, segMode);
  poolCache = { lang: lang, segMode: segMode, learningRef: learningRef, materialsHash: materialsHash, pool: pool };
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

export { completionEnabled, completionPool, commitLearningText, invalidateCompletionPool };
