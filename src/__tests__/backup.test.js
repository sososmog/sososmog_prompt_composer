import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const {
  buildExportBundle, validateImportBundle, mergeState, summarizeImport,
  defaultState, normalizeState, EXPORT_SCHEMA_VERSION,
} = loadComposer();

// 造一个带自定义素材 + 已填 Key 的 state（不依赖 id 生成器的具体值）
function stateWithMaterials() {
  const s = defaultState();
  s.customModules = [
    { id: 'mc_1', label: { zh: '角色设定', en: 'Role' }, text: { zh: 'zh', en: 'en' }, builtin: false, hidden: false },
  ];
  s.moduleOrder = s.moduleOrder.concat(['mc_1']);
  s.customSnippets = [
    { id: 'c_1', tag: '我的常用句', zh: 'zh', en: 'en', builtin: false, hidden: false },
  ];
  s.snippetOrder = s.snippetOrder.concat(['c_1']);
  s.settings.translation.apiKey = 'LOCAL-KEY';
  s.settings.toggleShortcut = 'Ctrl+Alt+Z';
  return s;
}

// 用 core 的 buildExportBundle 造导入文件，再手工塞入项，避免手写信封
function bundleFrom(state, sections, mutate) {
  const b = buildExportBundle(state, { sections, appVersion: '9.9.9', exportedAt: '2026-01-01T00:00:00.000Z' });
  if (mutate) mutate(b);
  return b;
}

describe('buildExportBundle', () => {
  it('信封字段齐全，includes 与 sections 一致', () => {
    const b = buildExportBundle(stateWithMaterials(), {
      sections: ['materials', 'preferences'], appVersion: '1.2.3',
      exportedAt: '2026-07-21T00:00:00.000Z', theme: 'dark',
    });
    expect(b.app).toBe('composer');
    expect(b.type).toBe('composer-config');
    expect(b.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(b.appVersion).toBe('1.2.3');
    expect(b.exportedAt).toBe('2026-07-21T00:00:00.000Z');
    expect(b.includes).toEqual(['materials', 'preferences']);
    expect(b.payload.materials).toBeTruthy();
    expect(b.payload.preferences).toBeTruthy();
    expect(b.payload.content).toBeUndefined();
  });

  it('API Key 永不导出，containsApiKey 恒 false', () => {
    const b = buildExportBundle(stateWithMaterials(), { sections: ['preferences'] });
    expect(b.payload.preferences.translation.apiKey).toBe('');
    expect(b.containsApiKey).toBe(false);
    // 其它翻译字段仍导出
    expect(b.payload.preferences.translation.provider).toBe('gemini');
    expect(b.payload.preferences.toggleShortcut).toBe('Ctrl+Alt+Z');
  });

  it('不改动原 state（深拷贝）', () => {
    const s = stateWithMaterials();
    buildExportBundle(s, { sections: ['preferences'] });
    expect(s.settings.translation.apiKey).toBe('LOCAL-KEY');
  });

  it('theme 注入进 preferences；未注入为 null', () => {
    expect(buildExportBundle(defaultState(), { sections: ['preferences'], theme: 'light' }).payload.preferences.theme).toBe('light');
    expect(buildExportBundle(defaultState(), { sections: ['preferences'] }).payload.preferences.theme).toBeNull();
  });

  it('sections 缺省为 素材库+偏好', () => {
    const b = buildExportBundle(defaultState(), {});
    expect(b.includes).toEqual(['materials', 'preferences']);
  });

  it('content 段包含 lang 与双语正文', () => {
    const b = buildExportBundle(defaultState(), { sections: ['content'] });
    expect(b.payload.content.lang).toBe('zh');
    expect(typeof b.payload.content.content.zh).toBe('string');
  });
});

describe('validateImportBundle', () => {
  it('非对象 -> not-object', () => {
    expect(validateImportBundle(null).code).toBe('not-object');
    expect(validateImportBundle('x').code).toBe('not-object');
    expect(validateImportBundle([]).code).toBe('not-object');
  });

  it('缺 app/type/payload -> not-composer', () => {
    expect(validateImportBundle({ foo: 1 }).code).toBe('not-composer');
    expect(validateImportBundle({ app: 'composer', type: 'composer-config' }).code).toBe('not-composer');
    expect(validateImportBundle({ app: 'other', type: 'composer-config', payload: {}, schemaVersion: 1 }).code).toBe('not-composer');
  });

  it('schemaVersion 非法 -> bad-schema', () => {
    const b = bundleFrom(defaultState(), ['materials']);
    b.schemaVersion = 0;
    expect(validateImportBundle(b).code).toBe('bad-schema');
    b.schemaVersion = 1.5;
    expect(validateImportBundle(b).code).toBe('bad-schema');
  });

  it('版本过高 -> too-new', () => {
    const b = bundleFrom(defaultState(), ['materials']);
    b.schemaVersion = EXPORT_SCHEMA_VERSION + 1;
    expect(validateImportBundle(b).code).toBe('too-new');
  });

  it('payload 无任何已知段 -> no-sections', () => {
    const b = bundleFrom(defaultState(), ['materials']);
    b.payload = { garbage: {} };
    expect(validateImportBundle(b).code).toBe('no-sections');
  });

  it('正常文件 -> ok，includes 收敛为真实存在的段', () => {
    const b = bundleFrom(defaultState(), ['materials', 'preferences']);
    const r = validateImportBundle(b);
    expect(r.ok).toBe(true);
    expect(r.bundle.includes).toEqual(['materials', 'preferences']);
  });
});

describe('mergeState - 素材库合并（自定义模块/常用句，按名称判重）', () => {
  function targetState() {
    // 本机已有一个同名模块「角色设定」（不同 id）
    const s = defaultState();
    s.customModules = [
      { id: 'mc_local', label: { zh: '角色设定', en: 'Role' }, text: { zh: '本机', en: 'local' }, builtin: false, hidden: false },
    ];
    s.moduleOrder = s.moduleOrder.concat(['mc_local']);
    return s;
  }
  function importBundleWithSameName() {
    const src = defaultState();
    src.customModules = [
      { id: 'mc_import', label: { zh: '角色设定', en: 'Role' }, text: { zh: '导入', en: 'imported' }, builtin: false, hidden: false },
    ];
    src.moduleOrder = src.moduleOrder.concat(['mc_import']);
    return bundleFrom(src, ['materials']);
  }

  it('rename（默认）：同名两份并存，导入项被改名且新 id', () => {
    const next = normalizeState(mergeState(targetState(), importBundleWithSameName(), { conflict: 'rename' }));
    const mods = next.customModules;
    expect(mods.length).toBe(2);
    const names = mods.map((m) => m.label.zh).sort();
    expect(names).toContain('角色设定');
    expect(names.some((n) => n.indexOf('导入') !== -1)).toBe(true);
    // 本机原项内容保留
    expect(mods.find((m) => m.label.zh === '角色设定').text.zh).toBe('本机');
  });

  it('skip：同名跳过，仅保留本机', () => {
    const next = mergeState(targetState(), importBundleWithSameName(), { conflict: 'skip' });
    expect(next.customModules.length).toBe(1);
    expect(next.customModules[0].text.zh).toBe('本机');
  });

  it('overwrite：同名覆盖内容，保留本机旧 id', () => {
    const next = mergeState(targetState(), importBundleWithSameName(), { conflict: 'overwrite' });
    expect(next.customModules.length).toBe(1);
    expect(next.customModules[0].id).toBe('mc_local'); // 旧 id 保留
    expect(next.customModules[0].text.zh).toBe('导入');  // 内容被覆盖
  });

  it('无冲突项：直接并入并追加到 order 末尾', () => {
    const target = defaultState();
    const src = defaultState();
    src.customSnippets = [{ id: 'c_x', tag: '独一无二', zh: 'a', en: 'b', builtin: false, hidden: false }];
    src.snippetOrder = src.snippetOrder.concat(['c_x']);
    const next = normalizeState(mergeState(target, bundleFrom(src, ['materials']), {}));
    const added = next.customSnippets.find((s) => s.tag === '独一无二');
    expect(added).toBeTruthy();
    expect(next.snippetOrder[next.snippetOrder.length - 1]).toBe(added.id);
  });
});

describe('mergeState - 快速段落分组合并', () => {
  it('同名分组默认 rename，新组内 items 全新 id', () => {
    const target = defaultState();
    const firstGroupLabel = target.quickGroups[0].label.zh;
    const src = defaultState(); // src 的分组名与 target 相同 -> 冲突
    const next = normalizeState(mergeState(target, bundleFrom(src, ['materials']), { conflict: 'rename' }));
    const sameName = next.quickGroups.filter((g) => g.label.zh === firstGroupLabel);
    expect(sameName.length).toBe(1); // 原名只剩一个
    expect(next.quickGroups.length).toBeGreaterThan(target.quickGroups.length);
  });

  it('skip：同名分组全跳过，数量不变', () => {
    const target = defaultState();
    const src = defaultState();
    const next = mergeState(target, bundleFrom(src, ['materials']), { conflict: 'skip' });
    expect(next.quickGroups.length).toBe(target.quickGroups.length);
  });
});

describe('mergeState - 内置 patch 合并', () => {
  it('合并模式下本机已有该 id 的 patch 保留本机，仅补本机没有的', () => {
    const target = defaultState();
    target.builtinPatches = { b_step: { tag: '本机改名' } };
    const src = defaultState();
    src.builtinPatches = { b_step: { tag: '导入改名' }, b_concise: { hidden: true } };
    const next = mergeState(target, bundleFrom(src, ['materials']), {});
    expect(next.builtinPatches.b_step.tag).toBe('本机改名'); // 保留本机
    expect(next.builtinPatches.b_concise.hidden).toBe(true); // 补入本机没有的
  });
});

describe('mergeState - 偏好合并与 apiKey 边界', () => {
  it('导入偏好一律保留本机 apiKey（导入文件无 Key）', () => {
    const target = defaultState();
    target.settings.translation.apiKey = 'MY-LOCAL-KEY';
    const src = defaultState();
    src.settings.translation.provider = 'groq';
    src.settings.translation.model = 'llama-x';
    const next = mergeState(target, bundleFrom(src, ['preferences']), {});
    expect(next.settings.translation.apiKey).toBe('MY-LOCAL-KEY'); // 本机 Key 不被清空
    expect(next.settings.translation.model).toBe('llama-x');        // 其它字段采用导入值
  });

  it('导入 toggleShortcut / pasteDelayMs 采用导入值', () => {
    const target = defaultState();
    const src = defaultState();
    src.settings.toggleShortcut = 'Ctrl+Alt+M';
    src.settings.pasteDelayMs = 120;
    const next = mergeState(target, bundleFrom(src, ['preferences']), {});
    expect(next.settings.toggleShortcut).toBe('Ctrl+Alt+M');
    expect(next.settings.pasteDelayMs).toBe(120);
  });

  it('onboarding 不被导入重置', () => {
    const target = defaultState();
    target.settings.onboarding.tourDone = true;
    const src = defaultState(); // tourDone: false
    const next = mergeState(target, bundleFrom(src, ['preferences']), {});
    expect(next.settings.onboarding.tourDone).toBe(true);
  });
});

describe('mergeState - 覆盖模式', () => {
  it('replace：素材段整体替换', () => {
    const target = defaultState();
    target.customModules = [{ id: 'mc_old', label: { zh: '旧模块', en: '' }, text: { zh: '', en: '' }, builtin: false, hidden: false }];
    const src = defaultState();
    src.customModules = [{ id: 'mc_new', label: { zh: '新模块', en: '' }, text: { zh: '', en: '' }, builtin: false, hidden: false }];
    const next = normalizeState(mergeState(target, bundleFrom(src, ['materials']), { mode: 'replace' }));
    expect(next.customModules.length).toBe(1);
    expect(next.customModules[0].label.zh).toBe('新模块');
  });

  it('replace + content：采用导入正文与 lang', () => {
    const target = defaultState();
    const src = defaultState();
    src.content = { zh: '导入中文', en: '' };
    src.lang = 'en';
    const next = mergeState(target, bundleFrom(src, ['content']), { mode: 'replace' });
    expect(next.content.zh).toBe('导入中文');
    expect(next.lang).toBe('en');
  });

  it('merge + content：保留本机正文（不覆盖当次草稿）', () => {
    const target = defaultState();
    target.content = { zh: '本机正文', en: '' };
    const src = defaultState();
    src.content = { zh: '导入正文', en: '' };
    const next = mergeState(target, bundleFrom(src, ['content']), { mode: 'merge' });
    expect(next.content.zh).toBe('本机正文');
  });
});

describe('summarizeImport', () => {
  it('统计 incoming 条数与同名冲突数', () => {
    const target = defaultState();
    target.customModules = [{ id: 'mc_l', label: { zh: '角色设定', en: '' }, text: { zh: '', en: '' }, builtin: false, hidden: false }];
    const src = defaultState();
    src.customModules = [
      { id: 'mc_a', label: { zh: '角色设定', en: '' }, text: { zh: '', en: '' }, builtin: false, hidden: false }, // 冲突
      { id: 'mc_b', label: { zh: '全新模块', en: '' }, text: { zh: '', en: '' }, builtin: false, hidden: false }, // 不冲突
    ];
    const sum = summarizeImport(target, bundleFrom(src, ['materials']), {});
    expect(sum.materials.modules.incoming).toBe(2);
    expect(sum.materials.modules.conflicts).toBe(1);
  });

  it('preferences 段标注不含 Key、保留本机 Key', () => {
    const sum = summarizeImport(defaultState(), bundleFrom(defaultState(), ['preferences']), {});
    expect(sum.preferences.includesApiKey).toBe(false);
    expect(sum.preferences.keptLocalApiKey).toBe(true);
  });
});

describe('端到端：导出再导入不损坏', () => {
  it('完整备份导出 -> 覆盖导入后仍是合法 state', () => {
    const s = stateWithMaterials();
    const b = buildExportBundle(s, { sections: ['materials', 'preferences', 'content'] });
    const r = validateImportBundle(b);
    expect(r.ok).toBe(true);
    const next = normalizeState(mergeState(defaultState(), r.bundle, { mode: 'replace' }));
    // 素材迁移过来
    expect(next.customModules.some((m) => m.label.zh === '角色设定')).toBe(true);
    // 偏好迁移（Key 不在文件里，导入后本机默认空）
    expect(next.settings.toggleShortcut).toBe('Ctrl+Alt+Z');
    expect(next.settings.translation.apiKey).toBe('');
    // 结构合法：order 覆盖所有项
    expect(next.moduleOrder.filter((id) => id === next.customModules.find((m) => m.label.zh === '角色设定').id).length).toBe(1);
  });
});
