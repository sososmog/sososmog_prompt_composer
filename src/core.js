/* ============================================================
 * core.js —— 纯逻辑层（无 DOM 依赖）
 * ------------------------------------------------------------
 * 从 index.html 抽离出来的预设数据 / 纯函数。作为 ES module，
 * 通过文件末尾的 export 暴露；index.html / float.html 以
 * <script type="module"> import，测试直接 import。
 *
 * 铁律：这里的内容必须保持"纯"——不引用 document、不引用任何
 * DOM 变量、不触发渲染。任何需要这些的逻辑都应留在 UI 层。
 * ============================================================ */

/* ============================================================
   * 1. 预设：可插入的模块片段 / 常用句 / 示例正文
   * ============================================================ */
  var INSERT_MODULES = [
    { id: 'm_role', label: { zh: '角色', en: 'Role' },
      text: { zh: '## 角色\n你是……，擅长……。', en: '## Role\nYou are …, skilled in ….' } },
    { id: 'm_scenario', label: { zh: '场景', en: 'Scenario' },
      text: { zh: '## 场景\n使用场景：……。目标用户是……。', en: '## Scenario\nScenario: …. Target users are ….' } },
    { id: 'm_problem', label: { zh: '问题', en: 'Problem' },
      text: { zh: '## 问题\n当前遇到的问题：……。', en: '## Problem\nThe current problem: ….' } },
    { id: 'm_outcome', label: { zh: '需求效果', en: 'Outcome' },
      text: { zh: '## 需求效果\n期望达成的效果：……。', en: '## Desired outcome\nDesired outcome: ….' } },
    { id: 'm_solution', label: { zh: '解决方案', en: 'Solution' },
      text: { zh: '## 解决方案\n建议的解决方案：……。', en: '## Solution\nProposed solution: ….' } },
    { id: 'm_rules', label: { zh: '规则', en: 'Rules' },
      text: { zh: '## 规则\n- 始终……\n- 绝不……', en: '## Rules\n- Always …\n- Never …' } },
    { id: 'm_workflow', label: { zh: '工作流程', en: 'Workflow' },
      text: { zh: '## 工作流程\n1. ……\n2. ……\n3. ……', en: '## Workflow\n1. …\n2. …\n3. …' } },
    { id: 'm_format', label: { zh: '输出格式', en: 'Format' },
      text: { zh: '## 输出格式\n以……形式输出。', en: '## Output format\nOutput in ….' } },
    { id: 'm_examples', label: { zh: '示例', en: 'Examples' },
      text: { zh: '## 示例\n输入：……\n输出：……', en: '## Examples\nInput: …\nOutput: …' } },
    { id: 'm_constraints', label: { zh: '约束', en: 'Constraints' },
      text: { zh: '## 约束\n不要……。', en: '## Constraints\nDo not ….' } }
  ];
  var MODULE_BY_ID = {};
  INSERT_MODULES.forEach(function (m) { MODULE_BY_ID[m.id] = m; });

  var BUILTIN_SNIPPETS = [
    { id: 'b_step',     tag: '分步思考', zh: '请先一步步思考，再给出最终答案。', en: 'Think step by step, then give the final answer.', builtin: true },
    { id: 'b_concl',    tag: '先给结论', zh: '请先给出结论，再展开说明理由。', en: 'State the conclusion first, then explain the reasoning.', builtin: true },
    { id: 'b_concise',  tag: '保持简洁', zh: '回答请保持简洁，避免冗余表述。', en: 'Keep the answer concise and avoid redundancy.', builtin: true },
    { id: 'b_tone',     tag: '语气专业', zh: '请使用专业、客观的语气。', en: 'Use a professional and objective tone.', builtin: true },
    { id: 'b_example',  tag: '举例说明', zh: '请结合具体例子进行说明。', en: 'Illustrate with concrete examples.', builtin: true },
    { id: 'b_bullets',  tag: '分点列出', zh: '请使用分点列表清晰呈现。', en: 'Present the answer as a clear bulleted list.', builtin: true },
    { id: 'b_beginner', tag: '面向新手', zh: '面向零基础用户解释。', en: 'Explain for a complete beginner.', builtin: true },
    { id: 'b_nofab',    tag: '不要编造', zh: '不确定时如实说明，不要编造。', en: 'If uncertain, say so — do not make things up.', builtin: true },
    { id: 'b_md',       tag: 'Markdown', zh: '请使用 Markdown 格式输出。', en: 'Format the output using Markdown.', builtin: true },
    { id: 'b_limit',    tag: '限制字数', zh: '请将回答控制在 200 字以内。', en: 'Limit the response to about 200 words.', builtin: true }
  ];
  var BUILTIN_BY_ID = {};
  BUILTIN_SNIPPETS.forEach(function (b) { BUILTIN_BY_ID[b.id] = b; });

  // 快速段落：两级结构（分组 → 段落）。作为用户可完全增删改的数据，
  // 首次运行时以下面这些分组作为种子写入 state.quickGroups。
  function defaultQuickGroups() {
    return [
      { id: 'qg_open', label: { zh: '开场铺垫', en: 'Opening' }, hidden: false, items: [
        { id: 'qi_bg', label: { zh: '背景说明', en: 'Background' },
          text: { zh: '## 背景\n以下是本次任务的背景信息：……', en: '## Background\nHere is the background for this task: …' } },
        { id: 'qi_task', label: { zh: '任务概述', en: 'Task overview' },
          text: { zh: '## 任务\n请完成以下任务：……', en: '## Task\nPlease complete the following task: …' } }
      ] },
      { id: 'qg_rule', label: { zh: '约束要求', en: 'Constraints' }, hidden: false, items: [
        { id: 'qi_fmt', label: { zh: '严格遵循格式', en: 'Follow the format' },
          text: { zh: '请严格按照要求的格式输出，不要添加额外说明。', en: 'Follow the required format strictly; do not add extra commentary.' } },
        { id: 'qi_src', label: { zh: '仅用给定信息', en: 'Only given info' },
          text: { zh: '只依据我提供的信息作答，缺少信息时明确指出。', en: 'Answer only from the information I provide; flag anything missing.' } }
      ] },
      { id: 'qg_close', label: { zh: '收尾追问', en: 'Wrap-up' }, hidden: false, items: [
        { id: 'qi_check', label: { zh: '完成前自检', en: 'Self-check' },
          text: { zh: '给出答案前，请先自检是否满足上述所有要求。', en: 'Before answering, self-check that all the above requirements are met.' } },
        { id: 'qi_ask', label: { zh: '不清楚先追问', en: 'Ask if unclear' },
          text: { zh: '如有不清楚之处，请先向我提问澄清，再开始。', en: 'If anything is unclear, ask me to clarify before starting.' } }
      ] }
    ];
  }

  function demoContent() {
    return {
      zh: '## 角色\n你是一名资深全栈工程师，擅长 Web 产品开发与代码审查。你服务的对象是产品团队的开发者。\n\n## 场景\n使用场景：在现有 SaaS 产品中新增一个功能模块。\n\n## 需求效果\n期望达成的效果：……\n\n## 解决方案\n请围绕以下方向给出方案：技术选型、接口设计、关键实现步骤。\n\n## 输出格式\n以 Markdown 输出，并附上示例代码。',
      en: '## Role\nYou are a senior full-stack engineer, skilled in web product development and code review. You serve developers on the product team.\n\n## Scenario\nScenario: adding a new feature module to an existing SaaS product.\n\n## Desired outcome\nDesired outcome: …\n\n## Solution\nPropose a solution along these lines: tech stack choice, API design, key implementation steps.\n\n## Output format\nOutput in Markdown, and include sample code.'
    };
  }

  function defaultState() {
    return {
      lang: 'zh',
      content: demoContent(),
      customSnippets: [],
      builtinPatches: {},                              // { builtinId: {tag?, zh?, en?, hidden?} }
      snippetOrder: BUILTIN_SNIPPETS.map(function (b) { return b.id; }),
      customModules: [],
      modulePatches: {},                               // { moduleId: {labelZh?, labelEn?, textZh?, textEn?, hidden?} }
      moduleOrder: INSERT_MODULES.map(function (m) { return m.id; }),
      quickGroups: defaultQuickGroups(),               // 快速段落分组（用户可完全增删改）
      settings: {                                      // 阶段4：可自定义的快捷键 + 粘贴前等待时长
        toggleShortcut: 'Ctrl+Alt+C',
        pasteDelayMs: 60
      }
    };
  }

  var snippetSeq = 0;
  function newSnippetId() {
    snippetSeq++;
    return 'c_' + Date.now().toString(36) + '_' + snippetSeq.toString(36);
  }
  var moduleSeq = 0;
  function newModuleId() {
    moduleSeq++;
    return 'mc_' + Date.now().toString(36) + '_' + moduleSeq.toString(36);
  }
  var quickSeq = 0;
  function newQuickGroupId() {
    quickSeq++;
    return 'qg_' + Date.now().toString(36) + '_' + quickSeq.toString(36);
  }
  function newQuickItemId() {
    quickSeq++;
    return 'qi_' + Date.now().toString(36) + '_' + quickSeq.toString(36);
  }

  // 兼容旧存档：旧版是 modules 数组，编译成一份大文本。
  function modulesToText(modules, lang) {
    if (!Array.isArray(modules)) return '';
    return modules
      .filter(function (m) { return m && m.enabled !== false; })
      .map(function (m) {
        var label = (m.label && (m.label[lang] || m.label.zh || m.label.en)) || '';
        var body = (m.content && (m.content[lang] || '')) || '';
        return '## ' + label + '\n' + body;
      })
      .join('\n\n');
  }

  function normalizeState(raw) {
    var s = defaultState();
    s.lang = (raw.lang === 'en') ? 'en' : 'zh';

    if (raw.content && typeof raw.content === 'object' &&
        (typeof raw.content.zh === 'string' || typeof raw.content.en === 'string')) {
      // 新格式
      s.content = { zh: raw.content.zh || '', en: raw.content.en || '' };
    } else if (Array.isArray(raw.modules)) {
      // 旧格式迁移
      s.content = { zh: modulesToText(raw.modules, 'zh'), en: modulesToText(raw.modules, 'en') };
    }

    if (Array.isArray(raw.customSnippets)) {
      s.customSnippets = raw.customSnippets
        .filter(function (sn) { return sn && typeof sn.tag === 'string'; })
        .map(function (sn) {
          return {
            id: (typeof sn.id === 'string' && sn.id) ? sn.id : newSnippetId(),
            tag: sn.tag,
            zh: typeof sn.zh === 'string' ? sn.zh : (sn.text || ''),
            en: typeof sn.en === 'string' ? sn.en : (sn.text || ''),
            builtin: false,
            hidden: sn.hidden === true
          };
        });
    }

    // 内置句覆盖（隐藏 / 改标签 / 改内容）
    s.builtinPatches = {};
    if (raw.builtinPatches && typeof raw.builtinPatches === 'object') {
      Object.keys(raw.builtinPatches).forEach(function (id) {
        if (!BUILTIN_BY_ID[id]) return;
        var p = raw.builtinPatches[id];
        if (!p || typeof p !== 'object') return;
        var clean = {};
        if (typeof p.tag === 'string') clean.tag = p.tag;
        if (typeof p.zh === 'string') clean.zh = p.zh;
        if (typeof p.en === 'string') clean.en = p.en;
        if (p.hidden === true) clean.hidden = true;
        s.builtinPatches[id] = clean;
      });
    }

    // 顺序：以存档顺序为准，去掉失效 id，再把新出现的补到末尾
    var validIds = {};
    BUILTIN_SNIPPETS.forEach(function (b) { validIds[b.id] = true; });
    s.customSnippets.forEach(function (c) { validIds[c.id] = true; });
    var order = [];
    var seen = {};
    if (Array.isArray(raw.snippetOrder)) {
      raw.snippetOrder.forEach(function (id) {
        if (typeof id === 'string' && validIds[id] && !seen[id]) { order.push(id); seen[id] = true; }
      });
    }
    // 补齐：先内置再自定义，保持各自默认顺序
    BUILTIN_SNIPPETS.forEach(function (b) { if (!seen[b.id]) { order.push(b.id); seen[b.id] = true; } });
    s.customSnippets.forEach(function (c) { if (!seen[c.id]) { order.push(c.id); seen[c.id] = true; } });
    s.snippetOrder = order;

    // 自定义插入模块
    if (Array.isArray(raw.customModules)) {
      s.customModules = raw.customModules
        .filter(function (m) { return m && m.label && typeof m.label === 'object'; })
        .map(function (m) {
          var t = (m.text && typeof m.text === 'object') ? m.text : {};
          return {
            id: (typeof m.id === 'string' && m.id) ? m.id : newModuleId(),
            label: { zh: m.label.zh || '', en: m.label.en || '' },
            text: { zh: typeof t.zh === 'string' ? t.zh : '', en: typeof t.en === 'string' ? t.en : '' },
            builtin: false,
            hidden: m.hidden === true
          };
        });
    }

    // 内置模块覆盖
    s.modulePatches = {};
    if (raw.modulePatches && typeof raw.modulePatches === 'object') {
      Object.keys(raw.modulePatches).forEach(function (id) {
        if (!MODULE_BY_ID[id]) return;
        var p = raw.modulePatches[id];
        if (!p || typeof p !== 'object') return;
        var clean = {};
        if (typeof p.labelZh === 'string') clean.labelZh = p.labelZh;
        if (typeof p.labelEn === 'string') clean.labelEn = p.labelEn;
        if (typeof p.textZh === 'string') clean.textZh = p.textZh;
        if (typeof p.textEn === 'string') clean.textEn = p.textEn;
        if (p.hidden === true) clean.hidden = true;
        s.modulePatches[id] = clean;
      });
    }

    // 模块顺序
    var mValid = {};
    INSERT_MODULES.forEach(function (m) { mValid[m.id] = true; });
    s.customModules.forEach(function (m) { mValid[m.id] = true; });
    var mOrder = [];
    var mSeen = {};
    if (Array.isArray(raw.moduleOrder)) {
      raw.moduleOrder.forEach(function (id) {
        if (typeof id === 'string' && mValid[id] && !mSeen[id]) { mOrder.push(id); mSeen[id] = true; }
      });
    }
    INSERT_MODULES.forEach(function (m) { if (!mSeen[m.id]) { mOrder.push(m.id); mSeen[m.id] = true; } });
    s.customModules.forEach(function (m) { if (!mSeen[m.id]) { mOrder.push(m.id); mSeen[m.id] = true; } });
    s.moduleOrder = mOrder;

    // 快速段落分组：存档里有合法数组则以存档为准（含空数组，尊重用户删空）；
    // 缺失（老存档升级）时用默认种子填充。
    if (Array.isArray(raw.quickGroups)) {
      s.quickGroups = raw.quickGroups
        .filter(function (g) { return g && typeof g === 'object'; })
        .map(function (g) {
          var lab = (g.label && typeof g.label === 'object') ? g.label : {};
          var items = Array.isArray(g.items) ? g.items : [];
          return {
            id: (typeof g.id === 'string' && g.id) ? g.id : newQuickGroupId(),
            label: { zh: typeof lab.zh === 'string' ? lab.zh : '', en: typeof lab.en === 'string' ? lab.en : '' },
            hidden: g.hidden === true,
            items: items
              .filter(function (it) { return it && typeof it === 'object'; })
              .map(function (it) {
                var il = (it.label && typeof it.label === 'object') ? it.label : {};
                var tx = (it.text && typeof it.text === 'object') ? it.text : {};
                return {
                  id: (typeof it.id === 'string' && it.id) ? it.id : newQuickItemId(),
                  label: { zh: typeof il.zh === 'string' ? il.zh : '', en: typeof il.en === 'string' ? il.en : '' },
                  text: { zh: typeof tx.zh === 'string' ? tx.zh : '', en: typeof tx.en === 'string' ? tx.en : '' }
                };
              })
          };
        });
    } else {
      s.quickGroups = defaultQuickGroups();
    }

    // 阶段4：设置项——快捷键 + 粘贴前等待时长，做好防御性校验，任何脏值都回退默认
    s.settings = { toggleShortcut: 'Ctrl+Alt+C', pasteDelayMs: 60 };
    if (raw.settings && typeof raw.settings === 'object') {
      if (typeof raw.settings.toggleShortcut === 'string' && raw.settings.toggleShortcut.trim() !== '') {
        s.settings.toggleShortcut = raw.settings.toggleShortcut;
      }
      var delay = raw.settings.pasteDelayMs;
      if (typeof delay === 'number' && isFinite(delay)) {
        s.settings.pasteDelayMs = Math.min(500, Math.max(30, Math.round(delay)));
      }
    }

    return s;
  }

  /* ============================================================
   * 2.1 内置句 / 内置模块 patch 清除逻辑
   * ------------------------------------------------------------
   * 与默认值相同则从 patch 里删掉对应字段，避免存档里堆积冗余覆盖；
   * 字段全部清空后连整条 patch 记录一起删除。
   * ============================================================ */
  function patchBuiltinSnippet(id, state, field, value) {
    var b = BUILTIN_BY_ID[id];
    if (!b) return;
    var p = state.builtinPatches[id] || {};
    if (field === 'hidden') { if (value) p.hidden = true; else delete p.hidden; }
    else { if (value === b[field]) delete p[field]; else p[field] = value; }
    if (p.tag === undefined && p.zh === undefined && p.en === undefined && !p.hidden) delete state.builtinPatches[id];
    else state.builtinPatches[id] = p;
  }

  function patchBuiltinModule(id, state, field, value) {
    var b = MODULE_BY_ID[id];
    if (!b) return;
    var defVal;
    if (field === 'labelZh') defVal = b.label.zh;
    else if (field === 'labelEn') defVal = b.label.en;
    else if (field === 'textZh') defVal = b.text.zh;
    else if (field === 'textEn') defVal = b.text.en;
    var p = state.modulePatches[id] || {};
    if (field === 'hidden') { if (value) p.hidden = true; else delete p.hidden; }
    else { if (value === defVal) delete p[field]; else p[field] = value; }
    if (p.labelZh === undefined && p.labelEn === undefined &&
        p.textZh === undefined && p.textEn === undefined && !p.hidden) delete state.modulePatches[id];
    else state.modulePatches[id] = p;
  }

  /* ============================================================
   * 3. token 估算
   * ============================================================ */
  function estimateTokens(text) {
    if (!text) return 0;
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.codePointAt(i);
      var isCjk = (code >= 0x3000 && code <= 0x303f) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef);
      if (isCjk) cjk++; else other++;
    }
    return Math.round(cjk * 1.6 + other / 4);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ============================================================
   * 5.1 Lucide 风格内联图标：统一图标来源，避免 emoji / 字符占位
   * 用法：icon('trash-2') 返回可直接塞进 innerHTML 的 SVG 字符串
   * ============================================================ */
  var ICON_PATHS = {
    'copy': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'eraser': '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'moon': '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 15"/>',
    'rotate-ccw': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'grip-vertical': '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
    'settings': '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'
  };
  function icon(name, extraAttrs) {
    var body = ICON_PATHS[name];
    if (!body) return '';
    var attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extraAttrs ? ' ' + extraAttrs : '');
    return '<svg ' + attrs + '>' + body + '</svg>';
  }

  /* ============================================================
   * 6. 块模型：正文 ⇄ 块 的解析
   * ------------------------------------------------------------
   * 真相源仍是 state.content[lang] 大文本。块只是视图：
   *   parseBlocks(text) 把文本按 "## " 开头切成块（首个 ## 之前的
   *   内容作为一个无标题“前言块”）。
   * ============================================================ */
  function parseBlocks(text) {
    text = text || '';
    if (!text.trim()) return [];
    var lines = text.split('\n');
    var blocks = [];
    var cur = null;
    lines.forEach(function (line) {
      if (/^##\s/.test(line) || /^##$/.test(line)) {
        if (cur !== null) blocks.push(cur);
        cur = line;
      } else {
        if (cur === null) cur = line;            // 前言块
        else cur += '\n' + line;
      }
    });
    if (cur !== null) blocks.push(cur);
    // 去掉纯空白块（多为块间的空行）
    return blocks.filter(function (b) { return b.trim() !== ''; });
  }

  /* ---------- Markdown 语法高亮：轻量正则 ---------- */
  // 转义 HTML 特殊字符，防止用户输入被当成标签解析（XSS 防护）。
  // 注意：这里刻意只转义 & < >，不转义引号——高亮结果全部落在元素的
  // 文本内容位置（span 之间），不进入任何属性值，故无需像通用的
  // escapeHtml 那样转义 " '；两者语义不同，不可互相替换。
  function hlEscape(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 对单行做行内高亮（粗体/斜体/行内代码/链接），返回已转义 + 包裹好 span 的 HTML
  // 行内代码先临时替换成“私有区字符包裹序号”的占位符，待粗体/斜体规则
  // 处理完之后再还原为高亮 span；私有区字符正常输入几乎不会产生，
  // 用它做占位符边界，比直接用纯数字更不容易和正文本身的数字冲突。
  function highlightInline(line) {
    var escaped = hlEscape(line);
    var codeTokens = [];
    // 行内代码优先处理并保护其内容不被粗体/斜体规则二次匹配
    escaped = escaped.replace(/`([^`\n]+)`/g, function (m, code) {
      codeTokens.push('<span class="hl-code">`' + code + '`</span>');
      return '' + (codeTokens.length - 1) + '';
    });
    // 链接 [text](url)
    escaped = escaped.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, function (m, t, u) {
      return '<span class="hl-link-text">[' + t + ']</span><span class="hl-link-url">(' + u + ')</span>';
    });
    // 粗体 **x**
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<span class="hl-bold">**$1**</span>');
    // 斜体 *x*（用 lookbehind/lookahead 界定 * 边界，避免消费前导字符
    // 而漏掉相邻斜体，如 *a* *b* 中的第二段）
    escaped = escaped.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<span class="hl-italic">*$1*</span>');
    // 还原行内代码 token
    escaped = escaped.replace(/(\d+)/g, function (m, i) { return codeTokens[+i]; });
    return escaped;
  }

  // 整块文本 → 高亮 HTML（按行处理：标题/列表/引用/代码围栏识别行首，其余走行内高亮）
  function highlightMarkdown(text) {
    var lines = text.split('\n');
    var inFence = false;
    var out = lines.map(function (line) {
      // 代码块围栏 ```
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return '<span class="hl-fence">' + hlEscape(line) + '</span>';
      }
      if (inFence) return '<span class="hl-fence">' + hlEscape(line) + '</span>';

      // 标题 #, ##, ### ...
      var hMatch = line.match(/^(#{1,6})(\s.*)?$/);
      if (hMatch) return '<span class="hl-h">' + hlEscape(line) + '</span>';

      // 引用 >
      var qMatch = line.match(/^(\s*>\s?)(.*)$/);
      if (qMatch) return '<span class="hl-quote">' + hlEscape(qMatch[1]) + '</span>' + highlightInline(qMatch[2]);

      // 列表 -, *, 1.
      var lMatch = line.match(/^(\s*)([-*]|\d+\.)(\s+)(.*)$/);
      if (lMatch) {
        return hlEscape(lMatch[1]) + '<span class="hl-list">' + hlEscape(lMatch[2]) + '</span>' + hlEscape(lMatch[3]) + highlightInline(lMatch[4]);
      }

      return highlightInline(line);
    });
    return out.join('\n');
  }

  /* ============================================================
   * 6.1 结构级 Undo/Redo 历史栈（纯逻辑，无 DOM）
   * ------------------------------------------------------------
   * 只负责快照字符串的入栈/出栈/裁剪，不知道 state、不碰 DOM。
   * 一个快照 = 某次结构操作发生前的 state.content[lang] 字符串。
   * 捕获/恢复/重渲染的时机由 UI 层（store/render/events）驱动。
   *
   * 语言切换语义：见 UI 层——切语言时整体 reset() 清空两栈，避免
   * 跨语言的快照写回当前语言导致内容串味。
   * ============================================================ */
  function createHistory(limit) {
    var cap = (typeof limit === 'number' && limit > 0) ? limit : 50;
    var undoStack = [];
    var redoStack = [];

    return {
      // 结构操作“即将改变 content 之前”调用：推入旧快照并清空 redo。
      // 标准编辑器语义：撤销后又做新操作，被撤销的分支不能再重做。
      push: function (snapshot) {
        undoStack.push(snapshot);
        if (undoStack.length > cap) undoStack.shift(); // 超上限丢最旧
        redoStack.length = 0;
      },
      // 撤销：把“当前内容”存进 redo，弹出并返回上一个快照。空栈返回 null。
      undo: function (current) {
        if (undoStack.length === 0) return null;
        redoStack.push(current);
        if (redoStack.length > cap) redoStack.shift();
        return undoStack.pop();
      },
      // 重做：把“当前内容”存回 undo，弹出并返回下一个快照。空栈返回 null。
      redo: function (current) {
        if (redoStack.length === 0) return null;
        undoStack.push(current);
        if (undoStack.length > cap) undoStack.shift();
        return redoStack.pop();
      },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      // 清空两栈（如切换语言时）。
      reset: function () { undoStack.length = 0; redoStack.length = 0; }
    };
  }

  /* ============================================================
   * 导出（ES module）
   * ============================================================ */
  export {
    INSERT_MODULES,
    MODULE_BY_ID,
    BUILTIN_SNIPPETS,
    BUILTIN_BY_ID,
    demoContent,
    defaultState,
    defaultQuickGroups,
    newSnippetId,
    newModuleId,
    newQuickGroupId,
    newQuickItemId,
    modulesToText,
    normalizeState,
    estimateTokens,
    parseBlocks,
    patchBuiltinSnippet,
    patchBuiltinModule,
    escapeHtml,
    ICON_PATHS,
    icon,
    hlEscape,
    highlightInline,
    highlightMarkdown,
    createHistory,
  };
