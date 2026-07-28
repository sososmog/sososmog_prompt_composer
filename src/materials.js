/* ============================================================
 * materials.js —— 素材解析：按 id 合成模块 / 常用句（纯逻辑）
 * ------------------------------------------------------------
 * 主窗口 render.js 与浮窗各自维护过一份几乎相同的 resolveModule /
 * resolveSnippet（内置 patch 合并 + 自定义项查找），两处实现曾经
 * 悄悄漂移（浮窗版本返回对象缺 builtin 字段）。这里统一成一份，
 * 显式接收 state（不从任何地方 import state），两边都传各自的 state
 * 调用即可，行为保证一致，也便于单测。
 *
 * 铁律与 core.js 一致：不碰 document，不触发渲染。
 * ============================================================ */
import { MODULE_BY_ID, BUILTIN_BY_ID } from './core.js';

// 把一个 id 解析成可用的模块对象（内置合并覆盖 patch；返回含 hidden 标记）。
// 内置与自定义都统一带上 builtin 字段，供管理浮窗区分「恢复默认」还是「删除」。
function resolveModule(state, id) {
  var b = MODULE_BY_ID[id];
  if (b) {
    var p = state.modulePatches[id] || {};
    return {
      id: id,
      builtin: true,
      label: {
        zh: typeof p.labelZh === 'string' ? p.labelZh : b.label.zh,
        en: typeof p.labelEn === 'string' ? p.labelEn : b.label.en
      },
      text: {
        zh: typeof p.textZh === 'string' ? p.textZh : b.text.zh,
        en: typeof p.textEn === 'string' ? p.textEn : b.text.en
      },
      hidden: p.hidden === true
    };
  }
  var c = null;
  for (var i = 0; i < state.customModules.length; i++) {
    if (state.customModules[i].id === id) { c = state.customModules[i]; break; }
  }
  if (!c) return null;
  return { id: id, builtin: false, label: { zh: c.label.zh, en: c.label.en }, text: { zh: c.text.zh, en: c.text.en }, hidden: c.hidden === true };
}

// 按 state.moduleOrder 顺序返回全部模块（含隐藏，供管理浮窗使用）；失效 id 被过滤掉。
function orderedModules(state) {
  return state.moduleOrder.map(function (id) { return resolveModule(state, id); }).filter(Boolean);
}

// 左栏可见模块（排除隐藏）
function visibleModules(state) {
  return orderedModules(state).filter(function (m) { return !m.hidden; });
}

// 把一个 id 解析成可用的句子对象（内置合并覆盖 patch；返回含 hidden 标记）
function resolveSnippet(state, id) {
  var b = BUILTIN_BY_ID[id];
  if (b) {
    var p = state.builtinPatches[id] || {};
    return {
      id: id,
      builtin: true,
      tag: typeof p.tag === 'string' ? p.tag : b.tag,
      zh: typeof p.zh === 'string' ? p.zh : b.zh,
      en: typeof p.en === 'string' ? p.en : b.en,
      hidden: p.hidden === true
    };
  }
  var c = null;
  for (var i = 0; i < state.customSnippets.length; i++) {
    if (state.customSnippets[i].id === id) { c = state.customSnippets[i]; break; }
  }
  if (!c) return null;
  return { id: id, builtin: false, tag: c.tag, zh: c.zh, en: c.en, hidden: c.hidden === true };
}

// 按 state.snippetOrder 顺序返回全部句子（含隐藏，供管理浮窗使用）
function orderedSnippets(state) {
  return state.snippetOrder.map(function (id) { return resolveSnippet(state, id); }).filter(Boolean);
}

// 左栏可见句子（排除隐藏）
function visibleSnippets(state) {
  return orderedSnippets(state).filter(function (s) { return !s.hidden; });
}

export {
  resolveModule, orderedModules, visibleModules,
  resolveSnippet, orderedSnippets, visibleSnippets,
};
