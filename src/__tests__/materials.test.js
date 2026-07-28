import { describe, it, expect } from 'vitest';
import { defaultState, INSERT_MODULES, BUILTIN_SNIPPETS } from '../core.js';
import {
  resolveModule, orderedModules, visibleModules,
  resolveSnippet, orderedSnippets, visibleSnippets,
} from '../materials.js';

describe('resolveModule', () => {
  it('内置模块无 patch 时返回默认 label/text，且带 builtin:true', () => {
    const state = defaultState();
    const m = INSERT_MODULES[0];
    const r = resolveModule(state, m.id);
    expect(r.builtin).toBe(true);
    expect(r.label).toEqual(m.label);
    expect(r.text).toEqual(m.text);
    expect(r.hidden).toBe(false);
  });

  it('内置模块 patch 覆盖 label/text/hidden 后按 patch 值返回，未覆盖字段仍是默认值', () => {
    const state = defaultState();
    const m = INSERT_MODULES[0];
    state.modulePatches[m.id] = { labelZh: '改过的标签', textEn: 'changed text', hidden: true };
    const r = resolveModule(state, m.id);
    expect(r.label.zh).toBe('改过的标签');
    expect(r.label.en).toBe(m.label.en);
    expect(r.text.en).toBe('changed text');
    expect(r.text.zh).toBe(m.text.zh);
    expect(r.hidden).toBe(true);
  });

  it('自定义模块按 id 查到并返回 builtin:false', () => {
    const state = defaultState();
    state.customModules.push({
      id: 'mc_1', label: { zh: '自定义', en: 'Custom' },
      text: { zh: '正文', en: 'body' }, hidden: false,
    });
    const r = resolveModule(state, 'mc_1');
    expect(r.builtin).toBe(false);
    expect(r.label.zh).toBe('自定义');
    expect(r.text.en).toBe('body');
  });

  it('未知 id 返回 null', () => {
    const state = defaultState();
    expect(resolveModule(state, 'not_exist')).toBeNull();
  });
});

describe('orderedModules / visibleModules', () => {
  it('moduleOrder 里含失效 id 时被过滤掉', () => {
    const state = defaultState();
    state.moduleOrder = [INSERT_MODULES[0].id, 'ghost_id', INSERT_MODULES[1].id];
    expect(orderedModules(state).map((m) => m.id)).toEqual([INSERT_MODULES[0].id, INSERT_MODULES[1].id]);
  });

  it('visibleModules 过滤掉 hidden 的模块，orderedModules 仍保留（供管理浮窗用）', () => {
    const state = defaultState();
    state.modulePatches[INSERT_MODULES[0].id] = { hidden: true };
    expect(visibleModules(state).some((m) => m.id === INSERT_MODULES[0].id)).toBe(false);
    expect(orderedModules(state).some((m) => m.id === INSERT_MODULES[0].id)).toBe(true);
  });
});

describe('resolveSnippet', () => {
  it('内置常用句 patch 覆盖 tag/zh/hidden，未覆盖的 en 仍是默认值，且带 builtin:true', () => {
    const state = defaultState();
    const b = BUILTIN_SNIPPETS[0];
    state.builtinPatches[b.id] = { tag: '改过的标签', zh: '改过的中文', hidden: true };
    const r = resolveSnippet(state, b.id);
    expect(r.builtin).toBe(true);
    expect(r.tag).toBe('改过的标签');
    expect(r.zh).toBe('改过的中文');
    expect(r.en).toBe(b.en);
    expect(r.hidden).toBe(true);
  });

  it('自定义常用句按 id 查到并返回 builtin:false', () => {
    const state = defaultState();
    const c = state.customSnippets[0]; // defaultCustomSnippets 已内置几条种子
    const r = resolveSnippet(state, c.id);
    expect(r.builtin).toBe(false);
    expect(r.tag).toBe(c.tag);
  });

  it('未知 id 返回 null', () => {
    const state = defaultState();
    expect(resolveSnippet(state, 'not_exist')).toBeNull();
  });
});

describe('orderedSnippets / visibleSnippets', () => {
  it('snippetOrder 里含失效 id 时被过滤掉', () => {
    const state = defaultState();
    state.snippetOrder = [BUILTIN_SNIPPETS[0].id, 'ghost', BUILTIN_SNIPPETS[1].id];
    expect(orderedSnippets(state).map((s) => s.id)).toEqual([BUILTIN_SNIPPETS[0].id, BUILTIN_SNIPPETS[1].id]);
  });

  it('visibleSnippets 过滤掉 hidden 的句子，orderedSnippets 仍保留', () => {
    const state = defaultState();
    state.builtinPatches[BUILTIN_SNIPPETS[0].id] = { hidden: true };
    expect(visibleSnippets(state).some((s) => s.id === BUILTIN_SNIPPETS[0].id)).toBe(false);
    expect(orderedSnippets(state).some((s) => s.id === BUILTIN_SNIPPETS[0].id)).toBe(true);
  });
});
