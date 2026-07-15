import { describe, it, expect, beforeEach } from 'vitest';
import { loadComposer } from './setup.js';

const { patchBuiltinSnippet, patchBuiltinModule, BUILTIN_SNIPPETS, INSERT_MODULES, defaultState } = loadComposer();

describe('patchBuiltinSnippet', () => {
  let state;
  const b = BUILTIN_SNIPPETS[0]; // { id, tag, zh, en, builtin: true }

  beforeEach(() => {
    state = defaultState();
  });

  it('未知 id 直接忽略，不创建 patch', () => {
    patchBuiltinSnippet('not_exist', state, 'tag', 'x');
    expect(state.builtinPatches).toEqual({});
  });

  it('值与默认相同时不产生 patch', () => {
    patchBuiltinSnippet(b.id, state, 'tag', b.tag);
    expect(state.builtinPatches[b.id]).toBeUndefined();
  });

  it('值与默认不同时写入 patch', () => {
    patchBuiltinSnippet(b.id, state, 'tag', '改过的标签');
    expect(state.builtinPatches[b.id]).toEqual({ tag: '改过的标签' });
  });

  it('改回默认值后 patch 字段被清除', () => {
    patchBuiltinSnippet(b.id, state, 'tag', '改过的标签');
    patchBuiltinSnippet(b.id, state, 'tag', b.tag);
    expect(state.builtinPatches[b.id]).toBeUndefined();
  });

  it('hidden 字段独立处理：true 时设置，false 时删除', () => {
    patchBuiltinSnippet(b.id, state, 'hidden', true);
    expect(state.builtinPatches[b.id]).toEqual({ hidden: true });
    patchBuiltinSnippet(b.id, state, 'hidden', false);
    expect(state.builtinPatches[b.id]).toBeUndefined();
  });

  it('多字段部分清除后仍保留其余非默认字段', () => {
    patchBuiltinSnippet(b.id, state, 'tag', '改标签');
    patchBuiltinSnippet(b.id, state, 'zh', '改中文');
    patchBuiltinSnippet(b.id, state, 'tag', b.tag); // 改回默认，清掉 tag 字段
    expect(state.builtinPatches[b.id]).toEqual({ zh: '改中文' });
  });

  it('所有字段都清空且 hidden 为假时，删除整条 patch 记录', () => {
    patchBuiltinSnippet(b.id, state, 'tag', '改标签');
    patchBuiltinSnippet(b.id, state, 'tag', b.tag);
    expect(state.builtinPatches).toEqual({});
  });
});

describe('patchBuiltinModule', () => {
  let state;
  const m = INSERT_MODULES[0]; // { id, label: {zh,en}, text: {zh,en} }

  beforeEach(() => {
    state = defaultState();
  });

  it('未知 id 直接忽略', () => {
    patchBuiltinModule('not_exist', state, 'labelZh', 'x');
    expect(state.modulePatches).toEqual({});
  });

  it('值与默认相同时不产生 patch（labelZh/labelEn/textZh/textEn 四字段）', () => {
    patchBuiltinModule(m.id, state, 'labelZh', m.label.zh);
    patchBuiltinModule(m.id, state, 'labelEn', m.label.en);
    patchBuiltinModule(m.id, state, 'textZh', m.text.zh);
    patchBuiltinModule(m.id, state, 'textEn', m.text.en);
    expect(state.modulePatches[m.id]).toBeUndefined();
  });

  it('值与默认不同时写入对应字段', () => {
    patchBuiltinModule(m.id, state, 'textEn', 'changed text');
    expect(state.modulePatches[m.id]).toEqual({ textEn: 'changed text' });
  });

  it('hidden 字段独立处理', () => {
    patchBuiltinModule(m.id, state, 'hidden', true);
    expect(state.modulePatches[m.id]).toEqual({ hidden: true });
    patchBuiltinModule(m.id, state, 'hidden', false);
    expect(state.modulePatches[m.id]).toBeUndefined();
  });

  it('全部字段清空后删除整条 patch 记录', () => {
    patchBuiltinModule(m.id, state, 'labelZh', '改名');
    patchBuiltinModule(m.id, state, 'labelZh', m.label.zh);
    expect(state.modulePatches).toEqual({});
  });

  it('同时存在 hidden 和字段 patch 时，清掉字段仍保留 hidden', () => {
    patchBuiltinModule(m.id, state, 'hidden', true);
    patchBuiltinModule(m.id, state, 'labelZh', '改名');
    patchBuiltinModule(m.id, state, 'labelZh', m.label.zh);
    expect(state.modulePatches[m.id]).toEqual({ hidden: true });
  });
});
