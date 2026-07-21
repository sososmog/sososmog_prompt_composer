import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { normalizeState, defaultState, BUILTIN_SNIPPETS, INSERT_MODULES } = loadComposer();

describe('normalizeState', () => {
  it('空对象输入回退为完整默认状态', () => {
    const s = normalizeState({});
    expect(s.lang).toBe('zh');
    expect(s.content).toEqual(defaultState().content);
    expect(s.customSnippets).toEqual([]);
    expect(s.snippetOrder).toEqual(BUILTIN_SNIPPETS.map((b) => b.id));
    expect(s.moduleOrder).toEqual(INSERT_MODULES.map((m) => m.id));
    expect(s.quickGroups.length).toBe(3);
    expect(s.settings).toEqual(defaultState().settings);
  });

  it('settings.translation 脏值被归一化（未知 provider → custom）', () => {
    const s = normalizeState({ settings: { translation: { provider: 'zzz', apiKey: 'k', model: ' m ' } } });
    expect(s.settings.translation.provider).toBe('custom');
    expect(s.settings.translation.apiKey).toBe('k');
    expect(s.settings.translation.model).toBe('m');
  });

  it('缺失 translation 时补默认（Gemini）', () => {
    const s = normalizeState({ settings: { toggleShortcut: 'Ctrl+Alt+X' } });
    expect(s.settings.translation.provider).toBe('gemini');
    expect(s.settings.translation.protocol).toBe('gemini');
  });

  it('lang 非 en 一律归一为 zh', () => {
    expect(normalizeState({ lang: 'en' }).lang).toBe('en');
    expect(normalizeState({ lang: 'fr' }).lang).toBe('zh');
    expect(normalizeState({ lang: undefined }).lang).toBe('zh');
  });

  it('新格式 content 直接采用，缺失字段补空串', () => {
    const s = normalizeState({ content: { zh: '中文正文' } });
    expect(s.content).toEqual({ zh: '中文正文', en: '' });
  });

  it('旧格式 modules 数组迁移为 content 文本', () => {
    const raw = {
      modules: [
        { label: { zh: '角色', en: 'Role' }, content: { zh: '你是A', en: 'You are A' }, enabled: true },
        { label: { zh: '禁用块', en: 'Disabled' }, content: { zh: 'x', en: 'y' }, enabled: false }
      ]
    };
    const s = normalizeState(raw);
    expect(s.content.zh).toBe('## 角色\n你是A');
    expect(s.content.en).toBe('## Role\nYou are A');
  });

  it('customSnippets 过滤非法项并补齐字段', () => {
    const raw = {
      customSnippets: [
        { tag: '合法', zh: '中文', en: 'en' },
        { tag: 123 }, // 非字符串 tag，过滤掉
        null,
        { tag: '仅text', text: '兼容旧字段' }
      ]
    };
    const s = normalizeState(raw);
    expect(s.customSnippets).toHaveLength(2);
    expect(s.customSnippets[0]).toMatchObject({ tag: '合法', zh: '中文', en: 'en', builtin: false, hidden: false });
    expect(s.customSnippets[1]).toMatchObject({ tag: '仅text', zh: '兼容旧字段', en: '兼容旧字段' });
    expect(s.customSnippets[1].id).toMatch(/^c_/);
  });

  it('builtinPatches 只保留合法内置 id 与合法字段', () => {
    const validId = BUILTIN_SNIPPETS[0].id;
    const raw = {
      builtinPatches: {
        [validId]: { tag: '改名', zh: '改内容', hidden: true, evil: 'x' },
        not_exist_id: { tag: '不该保留' }
      }
    };
    const s = normalizeState(raw);
    expect(s.builtinPatches).toEqual({ [validId]: { tag: '改名', zh: '改内容', hidden: true } });
  });

  it('snippetOrder 保留存档顺序、去重、剔除失效 id，并补齐新出现的 id', () => {
    const b0 = BUILTIN_SNIPPETS[0].id;
    const b1 = BUILTIN_SNIPPETS[1].id;
    const raw = {
      snippetOrder: [b1, b1, 'ghost_id', b0]
    };
    const s = normalizeState(raw);
    expect(s.snippetOrder[0]).toBe(b1);
    expect(s.snippetOrder[1]).toBe(b0);
    expect(s.snippetOrder).not.toContain('ghost_id');
    expect(new Set(s.snippetOrder).size).toBe(s.snippetOrder.length);
    expect(s.snippetOrder).toHaveLength(BUILTIN_SNIPPETS.length);
  });

  it('moduleOrder 保留存档顺序、去重、剔除失效 id，并补齐新出现的 id', () => {
    const m0 = INSERT_MODULES[0].id;
    const m1 = INSERT_MODULES[1].id;
    const raw = {
      moduleOrder: [m1, m1, 'ghost_module', m0]
    };
    const s = normalizeState(raw);
    expect(s.moduleOrder[0]).toBe(m1);
    expect(s.moduleOrder[1]).toBe(m0);
    expect(s.moduleOrder).not.toContain('ghost_module');
    expect(new Set(s.moduleOrder).size).toBe(s.moduleOrder.length);
    expect(s.moduleOrder).toHaveLength(INSERT_MODULES.length);
  });

  it('customModules 过滤非法项并补齐 text 字段', () => {
    const raw = {
      customModules: [
        { label: { zh: '自定义', en: 'Custom' }, text: { zh: '内容' } },
        { label: 'not-an-object' }, // 非法，过滤
        null
      ]
    };
    const s = normalizeState(raw);
    expect(s.customModules).toHaveLength(1);
    expect(s.customModules[0]).toMatchObject({
      label: { zh: '自定义', en: 'Custom' },
      text: { zh: '内容', en: '' },
      builtin: false,
      hidden: false
    });
  });

  it('modulePatches 只保留合法内置模块 id 与合法字段', () => {
    const validId = INSERT_MODULES[0].id;
    const raw = {
      modulePatches: {
        [validId]: { labelZh: '改名', textEn: 'changed', hidden: true, evil: 1 },
        ghost: { labelZh: 'x' }
      }
    };
    const s = normalizeState(raw);
    expect(s.modulePatches).toEqual({ [validId]: { labelZh: '改名', textEn: 'changed', hidden: true } });
  });

  it('quickGroups 合法数组按存档为准，支持空数组表示用户已删空', () => {
    const s1 = normalizeState({ quickGroups: [] });
    expect(s1.quickGroups).toEqual([]);

    const s2 = normalizeState({
      quickGroups: [
        { label: { zh: '组1' }, items: [{ label: { zh: '项1' }, text: { zh: '文本1' } }] },
        'not-an-object',
        null
      ]
    });
    expect(s2.quickGroups).toHaveLength(1);
    expect(s2.quickGroups[0].label).toEqual({ zh: '组1', en: '' });
    expect(s2.quickGroups[0].items[0]).toMatchObject({
      label: { zh: '项1', en: '' },
      text: { zh: '文本1', en: '' }
    });
  });

  it('quickGroups 缺失（老存档升级）时回退默认种子分组', () => {
    const s = normalizeState({});
    expect(s.quickGroups.map((g) => g.id)).toEqual(['qg_open', 'qg_rule', 'qg_close']);
  });

  it('settings.pasteDelayMs 非法值回退默认 60', () => {
    expect(normalizeState({ settings: { pasteDelayMs: 'x' } }).settings.pasteDelayMs).toBe(60);
    expect(normalizeState({ settings: { pasteDelayMs: NaN } }).settings.pasteDelayMs).toBe(60);
    expect(normalizeState({ settings: { pasteDelayMs: Infinity } }).settings.pasteDelayMs).toBe(60);
  });

  it('settings.pasteDelayMs 超出范围时裁剪到 [30, 500] 并取整', () => {
    expect(normalizeState({ settings: { pasteDelayMs: 5 } }).settings.pasteDelayMs).toBe(30);
    expect(normalizeState({ settings: { pasteDelayMs: 9999 } }).settings.pasteDelayMs).toBe(500);
    expect(normalizeState({ settings: { pasteDelayMs: 61.6 } }).settings.pasteDelayMs).toBe(62);
  });

  it('settings.toggleShortcut 空字符串或非字符串回退默认值', () => {
    expect(normalizeState({ settings: { toggleShortcut: '' } }).settings.toggleShortcut).toBe('Ctrl+Alt+C');
    expect(normalizeState({ settings: { toggleShortcut: '   ' } }).settings.toggleShortcut).toBe('Ctrl+Alt+C');
    expect(normalizeState({ settings: { toggleShortcut: 123 } }).settings.toggleShortcut).toBe('Ctrl+Alt+C');
    expect(normalizeState({ settings: { toggleShortcut: 'Ctrl+Shift+X' } }).settings.toggleShortcut).toBe('Ctrl+Shift+X');
  });

  it('老存档无 onboarding 字段时补默认（tourDone:false, hintsSeen:{}）', () => {
    const s = normalizeState({ settings: { toggleShortcut: 'Ctrl+Alt+X' } });
    expect(s.settings.onboarding).toEqual({ tourDone: false, hintsSeen: {} });
  });

  it('onboarding.tourDone 为 true 时保留；脏值一律回退 false', () => {
    expect(normalizeState({ settings: { onboarding: { tourDone: true } } }).settings.onboarding.tourDone).toBe(true);
    expect(normalizeState({ settings: { onboarding: { tourDone: 1 } } }).settings.onboarding.tourDone).toBe(false);
    expect(normalizeState({ settings: { onboarding: { tourDone: 'yes' } } }).settings.onboarding.tourDone).toBe(false);
    expect(normalizeState({ settings: { onboarding: 'nope' } }).settings.onboarding.tourDone).toBe(false);
  });

  it('onboarding.hintsSeen 只保留白名单 key 的 true 值', () => {
    const s = normalizeState({
      settings: { onboarding: { hintsSeen: { langBilingual: true, floatWindow: false, translateKey: true, evil: true } } }
    });
    expect(s.settings.onboarding.hintsSeen).toEqual({ langBilingual: true, translateKey: true });
    expect(s.settings.onboarding.hintsSeen).not.toHaveProperty('evil');
    expect(s.settings.onboarding.hintsSeen).not.toHaveProperty('floatWindow');
  });
});
