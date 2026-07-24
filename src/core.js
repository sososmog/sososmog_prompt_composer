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
      text: { zh: '## 角色\n你是 ，擅长 。', en: '## Role\nYou are …, skilled in ….' } },
    { id: 'm_scenario', label: { zh: '场景', en: 'Scenario' },
      text: { zh: '## 场景\n使用场景：。目标用户是 。', en: '## Scenario\nScenario: …. Target users are ….' } },
    { id: 'm_problem', label: { zh: '问题', en: 'Problem' },
      text: { zh: '## 问题\n当前遇到的问题：。', en: '## Problem\nThe current problem: ….' } },
    { id: 'm_outcome', label: { zh: '需求效果', en: 'Outcome' },
      text: { zh: '## 需求效果\n期望达成的效果： 。', en: '## Desired outcome\nDesired outcome: ….' } },
    { id: 'm_solution', label: { zh: '解决方案', en: 'Solution' },
      text: { zh: '## 解决方案\n建议的解决方案： 。', en: '## Solution\nProposed solution: ….' } },
    { id: 'm_rules', label: { zh: '规则', en: 'Rules' },
      text: { zh: '## 规则\n- 始终\n- 绝不', en: '## Rules\n- Always …\n- Never …' } },
    { id: 'm_workflow', label: { zh: '工作流程', en: 'Workflow' },
      text: { zh: '## 工作流程\n1. \n2. \n3. ', en: '## Workflow\n1. …\n2. …\n3. …' } },
    { id: 'm_format', label: { zh: '输出格式', en: 'Format' },
      text: { zh: '## 输出格式\n以 形式输出。', en: '## Output format\nOutput in ….' } },
    { id: 'm_examples', label: { zh: '示例', en: 'Examples' },
      text: { zh: '## 示例\n输入： \n输出： ', en: '## Examples\nInput: …\nOutput: …' } },
    { id: 'm_constraints', label: { zh: '约束', en: 'Constraints' },
      text: { zh: '## 约束\n不要 。', en: '## Constraints\nDo not ….' } }
  ];
  var MODULE_BY_ID = {};
  INSERT_MODULES.forEach(function (m) { MODULE_BY_ID[m.id] = m; });

  var BUILTIN_SNIPPETS = [
    { id: 'b_step',     tag: '分步思考/分析', zh: '一步步分析思考。', en: 'Think step by step, then give the final answer.', builtin: true },
    { id: 'b_concl',    tag: '结论-理由', zh: '先给出结论，再展开说明理由。', en: 'State the conclusion first, then explain the reasoning.', builtin: true },
    { id: 'b_concise',  tag: '保持简洁', zh: '回答保持简洁，避免冗余表述。', en: 'Keep the answer concise and avoid redundancy.', builtin: true },
    { id: 'b_tone',     tag: '语气专业', zh: '使用专业、客观的语气。', en: 'Use a professional and objective tone.', builtin: true },
    { id: 'b_example',  tag: '举例说明', zh: '结合具体例子进行说明。', en: 'Illustrate with concrete examples.', builtin: true },
    { id: 'b_bullets',  tag: '分点列出', zh: '使用分点列表清晰呈现。', en: 'Present the answer as a clear bulleted list.', builtin: true },
    { id: 'b_beginner', tag: '面向新手', zh: '面向零基础用户解释。', en: 'Explain for a complete beginner.', builtin: true },
    { id: 'b_nofab',    tag: '不要编造', zh: '不确定时如实说明，不要编造。', en: 'If uncertain, say so — do not make things up.', builtin: true },
    { id: 'b_md',       tag: 'Markdown', zh: '请使用 Markdown 格式输出。', en: 'Format the output using Markdown.', builtin: true },
    { id: 'b_limit',    tag: '限制字数', zh: '请将回答控制在 200 字以内。', en: 'Limit the response to about 200 words.', builtin: true }
  ];
  var BUILTIN_BY_ID = {};
  BUILTIN_SNIPPETS.forEach(function (b) { BUILTIN_BY_ID[b.id] = b; });

  // 内置的“自定义常用句”种子：区别于 BUILTIN_SNIPPETS（不可删、只能改），
  // 这些是以自定义句身份写入 state.customSnippets 的，用户可完全增删改。
  // ID 用稳定的可读 slug，snippetOrder 里按需穿插在内置句之间。
  function defaultCustomSnippets() {
    return [
      { id: 'c_face_user', tag: '面向用户', zh: '你面向的是没有技术背景的用户。', en: '', builtin: false, hidden: false },
      { id: 'c_confirm',   tag: '二次确认', zh: '不确定和不清楚的地方，需要向我确认。', en: '', builtin: false, hidden: false },
      { id: 'c_bg',        tag: '背景',     zh: '背景如下：\n', en: '', builtin: false, hidden: false },
      { id: 'c_req',       tag: '需求',     zh: '我要实现的需求如下：\n', en: '', builtin: false, hidden: false },
      { id: 'c_scene',     tag: '场景',     zh: '用户使用的场景如下：\n', en: '', builtin: false, hidden: false },
      { id: 'c_divider',   tag: '---',      zh: '------\n', en: '', builtin: false, hidden: false }
    ];
  }

  // 快速段落：两级结构（分组 → 段落）。作为用户可完全增删改的数据，
  // 首次运行时以下面这些分组作为种子写入 state.quickGroups。
  function defaultQuickGroups() {
    return [
      { id: 'qg_git', label: { zh: 'Git', en: 'New group' }, hidden: false, items: [
        { id: 'qi_cp', label: { zh: 'cp', en: 'New paragraph' },
          text: { zh: 'commit and push. ', en: '' } },
        { id: 'qi_update', label: { zh: 'update', en: 'New paragraph' },
          text: { zh: 'update the memory.', en: '' } },
        { id: 'qi_umcp', label: { zh: 'um cp', en: 'New paragraph' },
          text: { zh: 'update the memory, then commit and push.', en: '' } },
        { id: 'qi_pr', label: { zh: 'pr', en: 'New paragraph' },
          text: { zh: 'create pr.', en: '' } },
        { id: 'qi_merge', label: { zh: 'merge to ', en: 'New paragraph' },
          text: { zh: 'merge to main.', en: '' } },
        { id: 'qi_all', label: { zh: 'all', en: 'New paragraph' },
          text: { zh: 'update the memory, then commit and push, create pr for me.', en: '' } },
        { id: 'qi_newfeat', label: { zh: 'newFeat', en: 'New paragraph' },
          text: { zh: '从main切一个新的分支，我要实现的需求是 ，名字你自己取，切到新的分支上。', en: '' } }
      ] },
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

  // 首次使用时载入的演示数据。首卡是引导语，其余是一份填得像样的、
  // 可直接拿去用的完整提示词成品——让新用户“打开就看到成品长什么样”。
  // 中英文两份结构对应，本身也是“双语并行”的活样例。
  function demoContent() {
    return {
      zh: '## 👋 这是一份示例提示词\n下面几张卡片是一份填好的完整提示词，你可以直接改成自己的，或删掉重来。\n试试点左侧的「插入模块」，往正文里加一块积木 —— 这就是 Composer 的用法。\n\n## 角色\n你是一名资深全栈工程师，擅长 Web 产品开发与代码审查，尤其熟悉 TypeScript、React 与 Node.js。你的沟通对象是产品团队里经验尚浅的开发者，请用清晰、耐心的方式解释。\n\n## 场景\n我们正在一个已上线的 SaaS 后台里新增「团队成员邀请」功能：管理员可以填入邮箱发送邀请，被邀请人点击链接后加入团队并被赋予指定角色。前端用 React，后端是 Node.js + PostgreSQL。\n\n## 需求效果\n请给出这个功能的完整实现方案，包含：数据库表结构设计、后端接口（邀请、接受邀请、撤销邀请）、前端交互流程，以及邀请链接的安全性考量（如过期与防重放）。\n\n## 约束\n- 不要引入新的第三方服务，只用现有技术栈。\n- 邀请链接必须有有效期，且不可被猜测。\n- 关键代码请配简短中文注释。\n\n## 输出格式\n先用一段话概述整体思路，再分「数据库 / 后端接口 / 前端 / 安全」四部分展开，每部分附关键示例代码（TypeScript）。',
      en: '## Role\nYou are a senior full-stack engineer skilled in web product development and code review. You serve as a developer for the product team.\n\n## Scenario\nScenario: Adding a new feature module to an existing SaaS product.\n\n## Expected Result\nExpected result: …\n\n## Solution\nPropose solutions in the following aspects: technology stack selection, API design, key implementation steps.\n\n## Output Format\nOutput in Markdown format, including sample code.'
    };
  }

  /* ============================================================
   * 1.1 翻译功能：LLM 提供商预设 + 默认配置
   * ------------------------------------------------------------
   * 模型名 / baseURL / key 全部可配置（免费层模型目录变动频繁，写死
   * 容易某天 404）。这里只提供“选预设时自动填入”的默认值，用户可覆盖。
   *   - protocol 'gemini'：Google 原生 generateContent 端点，走 URL 上
   *     的 ?key= 鉴权，强制 JSON 用 generationConfig.responseMimeType。
   *   - protocol 'openai'：OpenAI 兼容 /chat/completions，Bearer 鉴权，
   *     强制 JSON 用 response_format:{type:'json_object'}。GLM / Groq /
   *     OpenRouter 都走这条，仅 baseURL 与模型名不同。
   * ============================================================ */
  var TRANSLATE_PROVIDERS = [
    { id: 'gemini', label: 'Google Gemini', protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    { id: 'glm', label: 'GLM 智谱', protocol: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'groq', label: 'Groq', protocol: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { id: 'openrouter', label: 'OpenRouter', protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { id: 'custom', label: '自定义（OpenAI 兼容）', protocol: 'openai',
      baseUrl: '', model: '' }
  ];
  var TRANSLATE_PROVIDER_BY_ID = {};
  TRANSLATE_PROVIDERS.forEach(function (p) { TRANSLATE_PROVIDER_BY_ID[p.id] = p; });

  function defaultTranslateSettings() {
    var g = TRANSLATE_PROVIDER_BY_ID.glm;
    return {
      provider: 'glm',          // 预设 id，见 TRANSLATE_PROVIDERS
      protocol: g.protocol,     // 'gemini' | 'openai'
      baseUrl: g.baseUrl,
      model: g.model,
      apiKey: '',               // 用户填写；持久化进本地 state 文件，不硬编码进源码
      overwrite: true           // 覆盖已有译文（默认勾选）
    };
  }

  /* ============================================================
   * 1.2 新手引导状态
   * ------------------------------------------------------------
   * tourDone   —— 首次启动的最短路径引导是否已完成/跳过（true 后不再自动弹）
   * hintsSeen  —— 上下文轻提示是否已展示过：{ [key]: true }
   * 三个上下文提示 key 定义在 ONBOARDING_HINT_KEYS，供 UI 层与归一化白名单共用。
   * ============================================================ */
  var ONBOARDING_HINT_KEYS = ['langBilingual', 'floatWindow', 'translateKey'];

  function defaultOnboarding() {
    return { tourDone: false, hintsSeen: {} };
  }

  /* ============================================================
   * 1.3 行内补全总开关（默认开）
   * ============================================================ */
  function defaultCompletionSettings() {
    // segMode：读时切分粒度。'clause'（默认）按句读标点切子句；
    // 'word' 为 opt-in 增强，对无标点长句再按词起点切（见 segmentText）。
    return { enabled: true, segMode: 'clause' };
  }

  function defaultState() {
    return {
      lang: 'zh',
      content: demoContent(),
      customSnippets: defaultCustomSnippets(),         // 内置的自定义常用句种子（用户可增删改）
      builtinPatches: {},                              // { builtinId: {tag?, zh?, en?, hidden?} }
      // 内置句在前、自定义句在后（与 normalizeState 的补齐规则一致）
      snippetOrder: BUILTIN_SNIPPETS.map(function (b) { return b.id; })
        .concat(defaultCustomSnippets().map(function (c) { return c.id; })),
      customModules: [],
      modulePatches: {},                               // { moduleId: {labelZh?, labelEn?, textZh?, textEn?, hidden?} }
      moduleOrder: INSERT_MODULES.map(function (m) { return m.id; }),
      quickGroups: defaultQuickGroups(),               // 快速段落分组（用户可完全增删改）
      settings: {                                      // 阶段4：可自定义的快捷键 + 粘贴前等待时长
        toggleShortcut: 'Ctrl+Alt+C',
        pasteDelayMs: 60,
        translation: defaultTranslateSettings(),       // 翻译：LLM 提供商配置
        onboarding: defaultOnboarding(),                // 新手引导：是否已完成/各上下文提示是否看过
        completion: defaultCompletionSettings()        // 行内补全（自学习）总开关，默认开
      },
      learning: defaultLearning()                      // v0.2：行内补全的本地自学习数据
    };
  }

  /* ============================================================
   * 2.0 行内补全：本地自学习数据（v0.2）
   * ------------------------------------------------------------
   * 三张表（全本地、进 composer-state.json，不联网、不导出）：
   *   snippets  key -> { shown, accepted, lastUsedAt, source }
   *             候选被展示/采纳的计数，接受率是排序主信号。
   *   bigrams   prefixKey -> { candKey: count }
   *             “打了某前缀词之后采纳了哪条候选”，让同一前缀按语境分推。
   *   rawCounts rawKey -> { text, count, lang }
   *             用户完整提交过的整行文本及频次，够阈值自动提炼成 learned 片段。
   * key 一律带语言前缀（如 'zh文本'），中英文各学各的、互不污染。
   * ============================================================ */

  // 可调参数：打分权重 / 新片段乐观初始接受率 / 新近度半衰期 / 自提炼阈值。
  var LEARN_W_ACCEPT = 0.5;      // 接受率权重
  var LEARN_W_BIGRAM = 0.3;      // 上下文（bigram）关联度权重
  var LEARN_W_RECENCY = 0.2;     // 时间新近度权重
  var LEARN_OPTIMISTIC = 0.4;    // 无历史新片段的乐观初始接受率（否则新东西永远排不上）
  var LEARN_JITTER = 0.02;       // 探索用的微小随机扰动幅度
  var LEARN_RECENCY_HALFLIFE_MS = 14 * 24 * 60 * 60 * 1000; // 新近度半衰期 14 天
  var LEARN_PROMOTE_THRESHOLD = 3; // 原始整行重复达到此次数，提炼成 learned 片段
  var LEARN_VERSION = 2;           // v2：key 改用归一化文本，同一句的空白/标点/大小写差异合并计数

  // 读时切分（片段补全）可调参数：片段进池的长度 / 跨行复用 / 单行高频阈值。
  var LEARN_FRAG_MIN_LEN = 4;      // 片段字符数下限（过短命中噪声大）
  var LEARN_FRAG_MIN_LINES = 2;    // 片段出现在 ≥ 此数量的不同行 → 进池（跨句复用信号）

  // 全角标点 → 半角映射（仅用于归一化 key，不改展示文本）。
  var FULL_TO_HALF = {
    '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':',
    '（': '(', '）': ')', '【': '[', '】': ']', '“': '"', '”': '"',
    '‘': "'", '’': "'", '、': ',', '「': '[', '」': ']', '『': '[', '』': ']',
    '《': '<', '》': '>', '～': '~'
  };

  // 归一化文本：仅用于计算 key（判定“是不是同一句”），不改写展示 / 补全用的原文。
  // 处理：全角标点→半角、连续空白压成单空格、去句末孤立标点、英文转小写。
  // 不去中文词间空格（风险 > 收益）。同一句仅格式差异的行由此合并计数。
  function normalizeLearnText(text) {
    var t = String(text == null ? '' : text);
    t = t.replace(/[，。！？；：、（）【】“”‘’「」『』《》～]/g, function (ch) {
      return FULL_TO_HALF[ch] || ch;
    });
    t = t.replace(/\s+/g, ' ').trim();      // 连续空白（含全半角、tab）压成单空格
    t = t.replace(/[\s.,;:!?]+$/, '');       // 去句末孤立标点 / 尾随空白
    return t.toLowerCase();                  // 仅 key 用；大小写不该区分两条候选
  }

  // key：用不可打印分隔符（U+0001）拼语言前缀，避免与正文内容碰撞。
  // v2 起 text 部分先经 normalizeLearnText 归一化，使同一句的格式差异落到同一 key。
  var LEARN_KEY_SEP = '';
  function learnKeyParts(key) {
    // 从既有 key 反解出 [langPrefix, normText]，供 v1→v2 迁移重算 key 用。
    var k = String(key == null ? '' : key);
    var idx = k.indexOf(LEARN_KEY_SEP);
    if (idx === -1) return null;             // 不含分隔符：非法/旧格式，交由调用方丢弃
    return { lang: k.slice(0, idx) === 'en' ? 'en' : 'zh', text: k.slice(idx + 1) };
  }

  function learnKey(lang, text) {
    return (lang === 'en' ? 'en' : 'zh') + LEARN_KEY_SEP + normalizeLearnText(text);
  }

  function defaultLearning() {
    return { version: LEARN_VERSION, snippets: {}, bigrams: {}, rawCounts: {} };
  }

  // 归一化：任何脏值都回退到合法结构。version 处理：
  //   === LEARN_VERSION(2)：结构清洗后直接用。
  //   === 1：结构清洗 + v1→v2 迁移（按新 learnKey 重算 key，同 key 合并计数），旧数据不丢。
  //   其它 / 缺失：无法安全迁移，重置（学习数据可再学）。
  function normalizeLearning(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultLearning();
    if (raw.version !== LEARN_VERSION && raw.version !== 1) return defaultLearning();

    // 第一步：结构清洗（脏值兜底），保持原 key 不动。
    var out = defaultLearning();
    if (raw.snippets && typeof raw.snippets === 'object') {
      Object.keys(raw.snippets).forEach(function (k) {
        var r = raw.snippets[k];
        if (!r || typeof r !== 'object') return;
        out.snippets[k] = {
          shown: numOr(r.shown, 0),
          accepted: numOr(r.accepted, 0),
          lastUsedAt: numOr(r.lastUsedAt, 0),
          source: r.source === 'learned' ? 'learned' : 'preset'
        };
      });
    }
    if (raw.bigrams && typeof raw.bigrams === 'object') {
      Object.keys(raw.bigrams).forEach(function (pk) {
        var m = raw.bigrams[pk];
        if (!m || typeof m !== 'object') return;
        var clean = {};
        Object.keys(m).forEach(function (ck) {
          var n = numOr(m[ck], 0);
          if (n > 0) clean[ck] = n;
        });
        if (Object.keys(clean).length) out.bigrams[pk] = clean;
      });
    }
    if (raw.rawCounts && typeof raw.rawCounts === 'object') {
      Object.keys(raw.rawCounts).forEach(function (rk) {
        var r = raw.rawCounts[rk];
        if (!r || typeof r !== 'object' || typeof r.text !== 'string') return;
        out.rawCounts[rk] = {
          text: r.text,
          count: numOr(r.count, 0),
          lang: r.lang === 'en' ? 'en' : 'zh'
        };
      });
    }

    // 第二步：v1 数据按新归一化 key 重算并合并（v2 数据 key 已经是归一化的，跳过）。
    if (raw.version === 1) out = migrateLearningV1toV2(out);
    return out;
  }

  // 把（已结构清洗的）v1 learning 按新 learnKey 重算 key、同 key 合并，产出 v2 结构。
  // 依据：v1/v2 的 key 都是「langPrefix + U+0001 + text」，仅 text 段的归一化程度不同；
  // 从旧 key 反解出 lang + oldText，对 oldText 走 learnKey 即得新 key，同 key 计数相加。
  function migrateLearningV1toV2(v1) {
    var out = defaultLearning();
    // 旧 key -> 新 key 映射，供 bigrams 重映射复用（避免重复反解 + 归一化）。
    var remap = {};
    function newKeyOf(oldKey) {
      if (Object.prototype.hasOwnProperty.call(remap, oldKey)) return remap[oldKey];
      var parts = learnKeyParts(oldKey);
      var nk = parts ? learnKey(parts.lang, parts.text) : null;
      remap[oldKey] = nk;
      return nk;
    }

    // rawCounts：同新 key 计数相加；text 保留最先遇到的原文（展示更自然），lang 沿用。
    Object.keys(v1.rawCounts).forEach(function (ok) {
      var nk = newKeyOf(ok);
      if (!nk) return;
      var r = v1.rawCounts[ok];
      var tgt = out.rawCounts[nk];
      if (!tgt) out.rawCounts[nk] = { text: r.text, count: r.count, lang: r.lang };
      else tgt.count += r.count;
    });

    // snippets：同新 key，shown/accepted 相加、lastUsedAt 取 max、source 有 learned 则 learned。
    Object.keys(v1.snippets).forEach(function (ok) {
      var nk = newKeyOf(ok);
      if (!nk) return;
      var s = v1.snippets[ok];
      var tgt = out.snippets[nk];
      if (!tgt) {
        out.snippets[nk] = { shown: s.shown, accepted: s.accepted, lastUsedAt: s.lastUsedAt, source: s.source };
      } else {
        tgt.shown += s.shown;
        tgt.accepted += s.accepted;
        tgt.lastUsedAt = Math.max(tgt.lastUsedAt, s.lastUsedAt);
        if (s.source === 'learned') tgt.source = 'learned';
      }
    });
    // 合并后可能有条目 rawCounts 达阈值但尚无 learned snippet（原本分散未达阈值），补提炼。
    Object.keys(out.rawCounts).forEach(function (nk) {
      var r = out.rawCounts[nk];
      if (r.count >= LEARN_PROMOTE_THRESHOLD && !out.snippets[nk]) {
        out.snippets[nk] = { shown: 0, accepted: 0, lastUsedAt: 0, source: 'learned' };
      }
    });

    // bigrams：prefixKey 与 candKey 都用新 key 重映射，计数相加。
    Object.keys(v1.bigrams).forEach(function (opk) {
      var npk = newKeyOf(opk);
      if (!npk) return;
      var m = v1.bigrams[opk];
      var tgt = out.bigrams[npk] || (out.bigrams[npk] = {});
      Object.keys(m).forEach(function (ock) {
        var nck = newKeyOf(ock);
        if (!nck) return;
        tgt[nck] = (tgt[nck] || 0) + m[ock];
      });
      if (Object.keys(tgt).length === 0) delete out.bigrams[npk];
    });

    return out;
  }

  function numOr(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }

  /* ============================================================
   * 2.0.1a 读时切分（片段补全）
   * ------------------------------------------------------------
   * 整行语料（rawCounts）读取时才切成更小候选单位，落盘不含片段。
   * 子句边界 = 中英句读标点 + 换行/制表 + 全角空格 + 连续 2 个及以上空格。
   * 单个空格绝不作边界，否则 “擅长 Web 开发” 会被拆成 擅长 / Web / 开发。
   * ============================================================ */
  var CLAUSE_BOUNDARY = /(?:[，。！？；：、,.!?;:\n\r\t\u3000]| {2,})+/;
  var CLAUSE_BOUNDARY_G = /(?:[，。！？；：、,.!?;:\n\r\t\u3000]| {2,})+/g;

  // 把一段文本按子句边界切开，各段 trim、丢空串。纯标点 / 空串 → []。
  function segmentClause(text) {
    var t = String(text == null ? '' : text);
    if (t === '') return [];
    var parts = t.split(CLAUSE_BOUNDARY);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      if (seg !== '') out.push(seg);
    }
    return out;
  }

  // 通用切分入口。当前只做子句切分；opts.mode === 'word' 的词级增强见 P2。
  // 保持函数签名稳定，上层（候选池 / learnedFragments）传 { mode } 即可平滑升级。
  function segmentText(text, opts) {
    opts = opts || {};
    return segmentClause(text);
  }

  // 求「splitTail 用的两段」：当前（可能未结束的）子句 + 它之前那条完整子句。
  // - tail：最后一个子句边界之后到末尾的文本，去前导空白（与 segmentClause 的
  //   trim 对齐，否则原文前缀比对差一个空格就不中）；不去尾部空白。
  // - prev：tail 之前那条非空子句原文（供上层算 bigram prefixKey）；无则 ''。
  // 与候选池共用同一套子句边界（CLAUSE_BOUNDARY），不许各写一份正则。
  function clauseTailParts(textBeforeCaret) {
    var t = String(textBeforeCaret == null ? '' : textBeforeCaret);
    var re = new RegExp(CLAUSE_BOUNDARY_G.source, 'g');
    var lastStart = -1, lastEnd = 0, m;
    while ((m = re.exec(t)) !== null) {
      lastStart = m.index;
      lastEnd = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;   // 防御：理论上边界非空，稳妥兜底
    }
    var tail = t.slice(lastEnd).replace(/^\s+/, '');
    var beforeSegs = segmentClause(lastStart === -1 ? '' : t.slice(0, lastStart));
    var prev = beforeSegs.length ? beforeSegs[beforeSegs.length - 1] : '';
    return { tail: tail, prev: prev };
  }

  /* ============================================================
   * 2.0.1 补全引擎：四个纯函数（无 DOM，供 Vitest 覆盖）
   * ============================================================ */

  // 从候选池筛出“能接上当前行尾输入”的项。
  // inputTail：当前行光标前、最后一个词（或整行尾）；pool：[{ key, text, source }]。
  // v0.2 用前缀匹配（候选去掉首尾空白后以 inputTail 开头），且候选要比输入长（有内容可补）。
  function getCandidates(inputTail, pool) {
    var tail = String(inputTail == null ? '' : inputTail);
    if (tail.trim() === '') return [];
    if (!Array.isArray(pool)) return [];
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      if (!c || typeof c.text !== 'string') continue;
      var cand = c.text.replace(/^\s+/, '');
      if (cand.length <= tail.length) continue;
      if (cand.slice(0, tail.length) === tail) {
        out.push({ key: c.key, text: c.text, source: c.source || 'preset', remainder: cand.slice(tail.length) });
      }
    }
    return out;
  }

  // 给单个候选打分：接受率 / bigram 上下文 / 新近度 加权 + 微小扰动。
  // prefixWord：inputTail 之前那个词（上下文键），用于 bigram 关联。
  function scoreCandidate(candKey, prefixKey, learning, now, rand) {
    var L = learning || defaultLearning();
    now = numOr(now, Date.now());
    var rec = L.snippets[candKey];

    // 接受率：无历史给乐观初始值，否则 accepted/shown。
    var acceptRate;
    if (!rec || rec.shown === 0) acceptRate = LEARN_OPTIMISTIC;
    else acceptRate = rec.accepted / rec.shown;

    // 上下文关联度：该前缀下这条候选被采纳的占比。
    var bigram = 0;
    if (prefixKey && L.bigrams[prefixKey]) {
      var m = L.bigrams[prefixKey];
      var total = 0;
      Object.keys(m).forEach(function (k) { total += m[k]; });
      if (total > 0) bigram = (m[candKey] || 0) / total;
    }

    // 新近度：按半衰期指数衰减，越近越接近 1。
    var recency = 0;
    if (rec && rec.lastUsedAt > 0) {
      var age = Math.max(0, now - rec.lastUsedAt);
      recency = Math.pow(0.5, age / LEARN_RECENCY_HALFLIFE_MS);
    }

    var jitter = LEARN_JITTER * (typeof rand === 'function' ? rand() : Math.random());
    return LEARN_W_ACCEPT * acceptRate + LEARN_W_BIGRAM * bigram + LEARN_W_RECENCY * recency + jitter;
  }

  // 对候选按分数降序排序，返回带 score 的新数组（不改入参）。
  function rankCandidates(candidates, prefixKey, learning, now, rand) {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map(function (c) {
        return { key: c.key, text: c.text, source: c.source, remainder: c.remainder,
                 score: scoreCandidate(c.key, prefixKey, learning, now, rand) };
      })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // 纯更新学习数据：输入旧 learning，返回新 learning（深拷贝改动部分，不改入参）。
  // action='shown' payload={candKey}
  // action='accepted' payload={candKey, prefixKey}
  // action='commit'   payload={lang, lines:[...]}，逐行累计 rawCounts，够阈值提炼 learned 片段
  function learn(action, payload, learning, now) {
    var L = normalizeLearning(learning);   // 顺带兜底，保证输出结构干净
    now = numOr(now, Date.now());
    payload = payload || {};

    if (action === 'shown') {
      var sk = payload.candKey;
      if (sk) {
        var s = L.snippets[sk] || { shown: 0, accepted: 0, lastUsedAt: 0, source: 'preset' };
        s.shown += 1;
        L.snippets[sk] = s;
      }
    } else if (action === 'accepted') {
      var ak = payload.candKey;
      if (ak) {
        var a = L.snippets[ak] || { shown: 0, accepted: 0, lastUsedAt: 0, source: 'preset' };
        a.accepted += 1;
        if (a.shown < a.accepted) a.shown = a.accepted; // 防御：采纳不该超过展示
        a.lastUsedAt = now;
        L.snippets[ak] = a;
        if (payload.prefixKey) {
          var pk = payload.prefixKey;
          var bm = L.bigrams[pk] || {};
          bm[ak] = (bm[ak] || 0) + 1;
          L.bigrams[pk] = bm;
        }
      }
    } else if (action === 'commit') {
      var lang = payload.lang === 'en' ? 'en' : 'zh';
      var lines = Array.isArray(payload.lines) ? payload.lines : [];
      lines.forEach(function (raw) {
        var text = String(raw == null ? '' : raw).trim();
        if (text.length < 4) return;           // 太短的行不学，避免噪声
        // 归一化后为空（整行纯标点 / 纯空白）不学：否则多条语义无关的行会
        // 落到同一个「空内容」key 上被错误合并计数、提炼成无意义候选。
        if (normalizeLearnText(text) === '') return;
        var rk = learnKey(lang, text);
        var r = L.rawCounts[rk] || { text: text, count: 0, lang: lang };
        r.count += 1;
        L.rawCounts[rk] = r;
        // 达阈值：提炼成 learned 片段（用同一 key，进候选池与预设平起平坐）
        if (r.count >= LEARN_PROMOTE_THRESHOLD && !L.snippets[rk]) {
          L.snippets[rk] = { shown: 0, accepted: 0, lastUsedAt: now, source: 'learned' };
        }
      });
    }
    return L;
  }

  // 判断光标（在 textBeforeCaret 末尾处）是否处于 Markdown 代码区，
  // 处于代码区时补全应关闭，避免拿自然语言片段去补代码。
  //   - 围栏 ```：数光标前出现的 ``` 次数，奇数说明当前在未闭合的围栏块内。
  //   - 行内 `：只看光标所在当前行，本行内未闭合的反引号也算代码区。
  function isInCodeContext(textBeforeCaret) {
    var t = String(textBeforeCaret == null ? '' : textBeforeCaret);
    var fences = t.match(/```/g);
    if (fences && fences.length % 2 === 1) return true;
    var lineStart = t.lastIndexOf('\n') + 1;
    var curLine = t.slice(lineStart);
    var ticks = curLine.match(/`/g);
    if (ticks && ticks.length % 2 === 1) return true;
    return false;
  }

  // 收集所有已提炼的 learned 片段文本（供 UI 合成候选池时取用）。
  function learnedSnippets(learning, lang) {
    var L = normalizeLearning(learning);
    var want = lang === 'en' ? 'en' : 'zh';
    var out = [];
    Object.keys(L.snippets).forEach(function (k) {
      if (L.snippets[k].source !== 'learned') return;
      var r = L.rawCounts[k];
      if (r && r.lang === want) out.push({ key: k, text: r.text, source: 'learned' });
    });
    return out;
  }

  // 读时片段池：遍历 rawCounts（按 lang 过滤）把每行 segmentText 切成片段，
  // 按片段归一化 key 聚合两个量后择优进池——存档里没有片段数据，换切分策略
  // 只是改代码 + 下次读取重算，零迁移。返回 [{ key, text, source:'learned', lines, count }]。
  //   lines：该片段出现在多少「不同的行」里（行内去重，跨句复用信号）；
  //   count：加权频次 = 含该片段的各行 count 之和（单行高频保底）。
  // 进池：lines >= minLines 或 count >= minCount；片段字符数 < minLen 丢弃；
  // blocked（P3 拉黑名单，此前缺失即空）里的 key 不进池。
  function learnedFragments(learning, lang, opts) {
    opts = opts || {};
    var L = normalizeLearning(learning);
    var want = lang === 'en' ? 'en' : 'zh';
    var minLen = numOr(opts.minLen, LEARN_FRAG_MIN_LEN);
    var minLines = numOr(opts.minLines, LEARN_FRAG_MIN_LINES);
    var minCount = numOr(opts.minCount, LEARN_PROMOTE_THRESHOLD);
    var blocked = (L.blocked && typeof L.blocked === 'object') ? L.blocked : {};

    var agg = {}; // fragKey -> { key, text, lines, count }
    Object.keys(L.rawCounts).forEach(function (rk) {
      var r = L.rawCounts[rk];
      if (!r || r.lang !== want) return;
      var lineCount = numOr(r.count, 0);
      var frags = segmentText(r.text, opts);
      var seenInLine = {};
      frags.forEach(function (frag) {
        if (frag.length < minLen) return;
        if (normalizeLearnText(frag) === '') return; // 归一化后为空（纯标点等）不进池
        var fk = learnKey(want, frag);
        if (blocked[fk]) return;
        var a = agg[fk] || (agg[fk] = { key: fk, text: frag, lines: 0, count: 0 });
        a.count += lineCount;                        // 加权频次：累加所在行的 count
        if (!seenInLine[fk]) { seenInLine[fk] = true; a.lines += 1; } // 行内去重后计不同行数
      });
    });

    var out = [];
    Object.keys(agg).forEach(function (fk) {
      var a = agg[fk];
      if (a.lines >= minLines || a.count >= minCount) {
        out.push({ key: a.key, text: a.text, source: 'learned', lines: a.lines, count: a.count });
      }
    });
    return out;
  }

  // 收集所有已提炼的 learned 片段 + 统计信息（供设置面板「自学习」列表展示/管理）。
  // 不区分语言，按最近使用时间降序，供用户查看/逐条删除。
  function learnedSnippetsForManage(learning) {
    var L = normalizeLearning(learning);
    var out = [];
    Object.keys(L.snippets).forEach(function (k) {
      var s = L.snippets[k];
      if (s.source !== 'learned') return;
      var r = L.rawCounts[k];
      if (!r) return;
      out.push({
        key: k, text: r.text, lang: r.lang,
        shown: s.shown, accepted: s.accepted, lastUsedAt: s.lastUsedAt
      });
    });
    out.sort(function (a, b) { return b.lastUsedAt - a.lastUsedAt; });
    return out;
  }

  // 删除单条 learned 片段：级联清掉 snippets 记录、rawCounts 原始计数、
  // bigrams 中以它为候选词的项——否则残留的 rawCounts 计数会在下次达阈值时被重新提炼。
  function removeLearnedSnippet(learning, key) {
    var L = normalizeLearning(learning);
    delete L.snippets[key];
    delete L.rawCounts[key];
    Object.keys(L.bigrams).forEach(function (pk) {
      var m = L.bigrams[pk];
      if (m && m[key] !== undefined) {
        delete m[key];
        if (Object.keys(m).length === 0) delete L.bigrams[pk];
      }
    });
    return L;
  }

  // 清空全部自学习数据，回到初始状态。
  function clearLearning() {
    return defaultLearning();
  }

  /* ============================================================
   * 2.0.2 自学习数据的独立导入 / 导出（与配置导入导出完全分离）
   * ------------------------------------------------------------
   * 导出：只含 learned 片段（snippets 中 source==='learned' 的）及其
   * rawCounts 原始文本/计数，不含 bigrams（上下文关联对迁移无意义、
   * 且体积会随词表膨胀）。导入：同 key（语言+文本）直接把计数相加，
   * lastUsedAt 取较大值；复用 normalizeLearning 兜底脏值。
   * ============================================================ */
  var LEARNING_EXPORT_KIND = 'composer-learning';

  function buildLearningExportBundle(learning) {
    var L = normalizeLearning(learning);
    var snippets = {};
    var rawCounts = {};
    Object.keys(L.snippets).forEach(function (k) {
      var s = L.snippets[k];
      if (s.source !== 'learned') return;
      var r = L.rawCounts[k];
      if (!r) return;
      snippets[k] = s;
      rawCounts[k] = r;
    });
    return { kind: LEARNING_EXPORT_KIND, version: LEARN_VERSION, exportedAt: new Date().toISOString(), snippets: snippets, rawCounts: rawCounts };
  }

  // 校验导入文件是否是合法的自学习数据导出文件。
  // 接受 v1 / v2 导出文件（导入时按新 key 重算合并，见 mergeLearningImport）；
  // version 高于当前的判为「来自更新版本」，拒绝。
  function validateLearningImportBundle(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, code: 'not-object' };
    if (raw.kind !== LEARNING_EXPORT_KIND) return { ok: false, code: 'not-learning' };
    var v = raw.version;
    if (typeof v !== 'number' || v < 1) return { ok: false, code: 'bad-schema' };
    if (v > LEARN_VERSION) return { ok: false, code: 'too-new' };
    return { ok: true };
  }

  // 合并导入的自学习数据到当前 learning：**按 learnKey 重算 key**（不信任 bundle 里的
  // 旧 key，这样 v1 导出文件里的条目也能和本地 v2 数据、以及导入文件内彼此归一化合并），
  // 同 key 计数相加、lastUsedAt 取较大值。
  function mergeLearningImport(learning, bundle) {
    var L = normalizeLearning(learning);
    var incomingSnippets = (bundle && bundle.snippets && typeof bundle.snippets === 'object') ? bundle.snippets : {};
    var incomingRaw = (bundle && bundle.rawCounts && typeof bundle.rawCounts === 'object') ? bundle.rawCounts : {};
    var importedCount = 0;
    Object.keys(incomingRaw).forEach(function (k) {
      var ir = incomingRaw[k];
      if (!ir || typeof ir.text !== 'string') return;
      var lang = ir.lang === 'en' ? 'en' : 'zh';
      var nk = learnKey(lang, ir.text);      // 重算，落到与本地一致的归一化 key

      var existingR = L.rawCounts[nk];
      L.rawCounts[nk] = {
        text: existingR ? existingR.text : ir.text,   // 保留本地已有原文，否则用导入原文
        count: (existingR ? existingR.count : 0) + numOr(ir.count, 0),
        lang: lang
      };

      var is = incomingSnippets[k] || { shown: 0, accepted: 0, lastUsedAt: 0, source: 'learned' };
      var existingS = L.snippets[nk];
      L.snippets[nk] = {
        shown: (existingS ? existingS.shown : 0) + numOr(is.shown, 0),
        accepted: (existingS ? existingS.accepted : 0) + numOr(is.accepted, 0),
        lastUsedAt: Math.max(existingS ? existingS.lastUsedAt : 0, numOr(is.lastUsedAt, 0)),
        source: 'learned'
      };
      importedCount++;
    });
    return { learning: L, importedCount: importedCount };
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
    s.settings = { toggleShortcut: 'Ctrl+Alt+C', pasteDelayMs: 60, translation: defaultTranslateSettings(), onboarding: defaultOnboarding(), completion: defaultCompletionSettings() };
    if (raw.settings && typeof raw.settings === 'object') {
      if (typeof raw.settings.toggleShortcut === 'string' && raw.settings.toggleShortcut.trim() !== '') {
        s.settings.toggleShortcut = raw.settings.toggleShortcut;
      }
      var delay = raw.settings.pasteDelayMs;
      if (typeof delay === 'number' && isFinite(delay)) {
        s.settings.pasteDelayMs = Math.min(500, Math.max(30, Math.round(delay)));
      }
      s.settings.translation = normalizeTranslateSettings(raw.settings.translation);
      // 新手引导标记：白名单式拷贝，未识别字段一律丢弃，脏值回退默认
      var ob = raw.settings.onboarding;
      if (ob && typeof ob === 'object') {
        s.settings.onboarding.tourDone = ob.tourDone === true;
        if (ob.hintsSeen && typeof ob.hintsSeen === 'object') {
          ONBOARDING_HINT_KEYS.forEach(function (k) {
            if (ob.hintsSeen[k] === true) s.settings.onboarding.hintsSeen[k] = true;
          });
        }
      }
      // 行内补全总开关：脏值一律回退默认开
      var cp = raw.settings.completion;
      if (cp && typeof cp === 'object') {
        s.settings.completion.enabled = cp.enabled !== false;
        // 读时切分粒度：仅 'word' opt-in，其余（含缺失）回退默认 'clause'
        s.settings.completion.segMode = cp.segMode === 'word' ? 'word' : 'clause';
      }
    }

    s.learning = normalizeLearning(raw.learning);   // v0.2：行内补全自学习数据兜底/迁移

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
   * 2.2 翻译设置校验（纯函数）
   * ------------------------------------------------------------
   * 任何脏值都回退到默认。protocol 只接受 'gemini' / 'openai'；
   * 未知预设 id 归到 'custom'。key/baseUrl/model 取字符串，缺失留空。
   * ============================================================ */
  function normalizeTranslateSettings(raw) {
    var d = defaultTranslateSettings();
    if (!raw || typeof raw !== 'object') return d;
    var out = {
      provider: (typeof raw.provider === 'string' && TRANSLATE_PROVIDER_BY_ID[raw.provider]) ? raw.provider : 'custom',
      protocol: (raw.protocol === 'gemini' || raw.protocol === 'openai') ? raw.protocol : d.protocol,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      overwrite: raw.overwrite !== false
    };
    // provider 为已知预设、但 protocol 缺失时，用预设的 protocol 兜底
    if (TRANSLATE_PROVIDER_BY_ID[out.provider] && (raw.protocol !== 'gemini' && raw.protocol !== 'openai')) {
      out.protocol = TRANSLATE_PROVIDER_BY_ID[out.provider].protocol;
    }
    return out;
  }

  /* ============================================================
   * 2.3 翻译：代码/行内代码“遮罩 + 还原”（可选增强）
   * ------------------------------------------------------------
   * 翻前把代码块（```…```）与行内代码（`code`）替换成不易被模型改动的
   * 记号 〖0〗〖1〗…，翻后再还原。系统指令里也会要求模型保留记号原样、
   * 不翻译不重排；遮罩是双保险，进一步降低代码被改动的概率。
   *
   * maskCode(text) -> { masked, tokens }
   * unmaskCode(masked, tokens) -> text
   * 记号用全角括号包住序号，正文里几乎不会自然出现，冲突概率极低。
   * ============================================================ */
  function maskCode(text) {
    text = text == null ? '' : String(text);
    var tokens = [];
    function makeToken(chunk) {
      var t = '〖' + tokens.length + '〗';
      tokens.push(chunk);
      return t;
    }
    // 先遮罩围栏代码块（含跨行），再遮罩行内代码，避免行内规则吃掉围栏内的反引号
    var masked = text.replace(/```[\s\S]*?```/g, function (m) { return makeToken(m); });
    masked = masked.replace(/`[^`\n]+`/g, function (m) { return makeToken(m); });
    return { masked: masked, tokens: tokens };
  }

  function unmaskCode(masked, tokens) {
    if (!tokens || tokens.length === 0) return masked == null ? '' : String(masked);
    return String(masked).replace(/〖(\d+)〗/g, function (m, i) {
      var idx = +i;
      return (idx >= 0 && idx < tokens.length) ? tokens[idx] : m;
    });
  }

  /* ============================================================
   * 2.4 翻译：请求体构造 + 响应解析（纯函数，不发请求）
   * ------------------------------------------------------------
   * buildTranslatePayload：给定源/目标语言名与文本数组，产出
   *   { url, headers, body } —— 由 UI 层交给 Tauri http fetch 发出。
   * parseTranslateResponse：从两种协议的响应里提取 translations 数组。
   * 强制结构化输出：Gemini 用 responseMimeType='application/json'；
   * OpenAI 兼容用 response_format:{type:'json_object'}，故返回体统一用
   *   对象 {"translations":[...]} 而非裸数组，跨提供商都兼容。
   * ============================================================ */
  function translateSystemPrompt(srcName, tgtName) {
    return '你是专业翻译。把用户给出的 JSON 里 texts 数组中的每个字符串从「' + srcName + '」翻译成「' + tgtName + '」。' +
      '规则：只翻译自然语言文字；不要翻译或改动代码块、行内代码、URL、路径、命令、标识符/变量名/函数名；' +
      '保留 Markdown 格式、换行、列表符号与编号、标题标记、粗斜体标记、链接语法等结构，只翻其中的自然语言文字，不改结构；' +
      '如遇形如〖0〗〖1〗的记号，请原样保留、不翻译不重排；不要输出任何解释。' +
      '只返回 JSON 对象 {"translations": [...]}，其中数组与输入 texts 等长、顺序一致。';
  }

  function buildTranslatePayload(cfg, srcName, tgtName, texts) {
    var sys = translateSystemPrompt(srcName, tgtName);
    var userObj = { texts: texts };
    if (cfg.protocol === 'gemini') {
      var base = (cfg.baseUrl || '').replace(/\/+$/, '');
      var url = base + '/models/' + encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);
      var body = {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(userObj) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      };
      return { url: url, headers: { 'Content-Type': 'application/json' }, body: body };
    }
    // openai 兼容
    var baseU = (cfg.baseUrl || '').replace(/\/+$/, '');
    var urlO = baseU + '/chat/completions';
    var bodyO = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(userObj) }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    };
    return {
      url: urlO,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: bodyO
    };
  }

  // 从响应 JSON 里取出模型返回的文本，再解析成 { translations: [...] }。
  // 两种协议的“外层信封”不同：Gemini 在 candidates[0].content.parts[0].text，
  // OpenAI 兼容在 choices[0].message.content。内层都是我们要求的 JSON 字符串。
  function extractModelText(protocol, resp) {
    if (!resp || typeof resp !== 'object') return null;
    if (protocol === 'gemini') {
      var cand = resp.candidates && resp.candidates[0];
      var parts = cand && cand.content && cand.content.parts;
      if (Array.isArray(parts)) {
        return parts.map(function (p) { return (p && typeof p.text === 'string') ? p.text : ''; }).join('');
      }
      return null;
    }
    var choice = resp.choices && resp.choices[0];
    var content = choice && choice.message && choice.message.content;
    return typeof content === 'string' ? content : null;
  }

  function parseTranslateResponse(protocol, resp) {
    var text = extractModelText(protocol, resp);
    if (typeof text !== 'string' || text.trim() === '') return null;
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      // 有些模型会包一层 ```json …```，兜底剥掉围栏再试一次
      var m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { obj = JSON.parse(m[0]); } catch (e2) { return null; }
    }
    if (obj && Array.isArray(obj.translations)) return obj.translations;
    if (Array.isArray(obj)) return obj; // 极少数模型直接返回裸数组，也接住
    return null;
  }

  /* ============================================================
   * 3. token 估算
   * ============================================================ */
  function estimateTokens(text) {
    if (!text) return 0;
    var cjk = 0, other = 0;
    // for...of 按「码点」迭代（不是 UTF-16 码元），非 BMP 字符（CJK 扩展 B、
    // emoji 等由代理对表示）才不会被数两次。
    for (var ch of String(text)) {
      var code = ch.codePointAt(0);
      var isCjk = (code >= 0x3000 && code <= 0x303f) || (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x20000 && code <= 0x2ffff) || (code >= 0x30000 && code <= 0x3ffff); // CJK 扩展 B~
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
    'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'folder': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'eraser': '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'moon': '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'rotate-ccw': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'github': '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
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
   * 7. 配置导入导出（纯逻辑，无 DOM / 无 Tauri / 无 localStorage）
   * ------------------------------------------------------------
   * 打包 / 校验 / 合并 / 预览摘要 都是纯函数：输入 state + 选项，
   * 输出普通对象，副作用值（theme / appVersion / now）由 UI 层注入。
   * 编排（读写文件、弹窗、广播）在 backup.js。
   *
   * 导出文件信封结构（schemaVersion=1）：
   *   { app:'composer', type:'composer-config', schemaVersion, appVersion,
   *     exportedAt, includes:[section...], containsApiKey, payload:{...} }
   * payload 按 section 组织：
   *   materials    —— 素材库（7 字段，见 MATERIAL_FIELDS）
   *   preferences  —— 偏好（toggleShortcut / pasteDelayMs / translation / theme）
   *   content      —— 正文双语草稿（{ lang, content:{zh,en} }）
   * ============================================================ */
  var EXPORT_SCHEMA_VERSION = 1;
  var EXPORT_APP_ID = 'composer';
  var EXPORT_FILE_TYPE = 'composer-config';
  var EXPORT_SECTIONS = ['materials', 'preferences', 'content'];
  // 素材库对应的 state 字段（抽取 / 覆盖 / 合并共用这份白名单）
  var MATERIAL_FIELDS = [
    'customSnippets', 'builtinPatches', 'snippetOrder',
    'customModules', 'modulePatches', 'moduleOrder', 'quickGroups'
  ];

  // 深拷贝：state 全部可 JSON 序列化（与 persistState 一致），用最稳的方式。
  function deepClone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  /* ---------- 7.1 导出：从 state 打包成信封对象 ----------
   * buildExportBundle(state, { sections, appVersion, exportedAt, theme })
   * - sections：要导出的段数组（materials / preferences / content 的子集）
   * - appVersion / exportedAt / theme 由 UI 层注入，core 不读环境
   * - API Key 从不导出：preferences.translation.apiKey 一律置空串
   */
  function buildExportBundle(state, opts) {
    opts = opts || {};
    var sections = Array.isArray(opts.sections)
      ? EXPORT_SECTIONS.filter(function (s) { return opts.sections.indexOf(s) !== -1; })
      : ['materials', 'preferences'];
    var payload = {};

    if (sections.indexOf('materials') !== -1) {
      var mat = {};
      MATERIAL_FIELDS.forEach(function (f) { mat[f] = deepClone(state[f]); });
      payload.materials = mat;
    }

    if (sections.indexOf('preferences') !== -1) {
      var s = state.settings || {};
      var tr = deepClone(s.translation) || {};
      tr.apiKey = ''; // 铁律：API Key 永不导出
      payload.preferences = {
        toggleShortcut: s.toggleShortcut,
        pasteDelayMs: s.pasteDelayMs,
        translation: tr,
        theme: (typeof opts.theme === 'string') ? opts.theme : null
      };
    }

    if (sections.indexOf('content') !== -1) {
      payload.content = { lang: state.lang, content: deepClone(state.content) };
    }

    return {
      app: EXPORT_APP_ID,
      type: EXPORT_FILE_TYPE,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      appVersion: (typeof opts.appVersion === 'string' && opts.appVersion) ? opts.appVersion : 'unknown',
      exportedAt: (typeof opts.exportedAt === 'string' && opts.exportedAt) ? opts.exportedAt : new Date().toISOString(),
      includes: sections,
      containsApiKey: false, // 恒 false —— Key 不进文件
      payload: payload
    };
  }

  /* ---------- 7.2 导入：校验信封 ----------
   * validateImportBundle(raw) -> { ok, code?, bundle? }
   * code（UI 据此出中文文案）：
   *   'not-object'  非对象 / null
   *   'not-composer' 缺 app/type/payload 或 app 不匹配（不是本 app 文件）
   *   'bad-schema'  schemaVersion 非正整数
   *   'too-new'     schemaVersion 高于当前（更新版本导出，拒绝）
   *   'no-sections' payload 里没有任何可导入的段（空文件）
   * ok 时 bundle 为（必要时迁移后的）信封。
   */
  function validateImportBundle(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'not-object' };
    if (raw.app !== EXPORT_APP_ID || raw.type !== EXPORT_FILE_TYPE ||
        !raw.payload || typeof raw.payload !== 'object') {
      return { ok: false, code: 'not-composer' };
    }
    var v = raw.schemaVersion;
    if (typeof v !== 'number' || !isFinite(v) || v < 1 || Math.floor(v) !== v) {
      return { ok: false, code: 'bad-schema' };
    }
    if (v > EXPORT_SCHEMA_VERSION) return { ok: false, code: 'too-new' };

    var bundle = (v < EXPORT_SCHEMA_VERSION) ? migrateBundle(raw) : raw;
    // 收敛出真正存在的段（payload 里有、且是已知 section）
    var present = EXPORT_SECTIONS.filter(function (sec) {
      return bundle.payload[sec] && typeof bundle.payload[sec] === 'object';
    });
    if (present.length === 0) return { ok: false, code: 'no-sections' };
    bundle.includes = present;
    return { ok: true, bundle: bundle };
  }

  // 低版本信封 → 当前版本的迁移。当前只有 v1，占位恒等；
  // 将来引入 v2 时在这里按 bundle.schemaVersion 加迁移分支。
  function migrateBundle(bundle) { return bundle; }

  /* ---------- 7.3 判重与改名辅助 ----------
   * 自定义素材的“同名”判定：模块 / 快速段落分组看 label（zh|en），
   * 常用句看 tag。id 是本机时间戳生成、跨机不撞，不能用来判重。
   */
  function moduleKey(m) {
    var l = (m && m.label) || {};
    return (l.zh || '') + ' ' + (l.en || '');
  }
  function snippetKey(sn) { return (sn && sn.tag) || ''; }
  function groupKey(g) {
    var l = (g && g.label) || {};
    return (l.zh || '') + ' ' + (l.en || '');
  }

  /* ---------- 7.4 合并 ----------
   * mergeState(state, bundle, { mode, conflict, sections }) -> 新 state（未 normalize）
   * - mode：'merge'（默认，并入）| 'replace'（整段替换）
   * - conflict：'rename'（默认，保留两份）| 'skip'（保留本机）| 'overwrite'（用导入的）
   * - sections：只应用这些段（默认取 bundle.includes ∩ 用户勾选）
   * 调用方拿到结果后必须再走 normalizeState 收尾（order 补齐 / 去脏值）。
   */
  function mergeState(state, bundle, options) {
    options = options || {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';
    var conflict = (options.conflict === 'skip' || options.conflict === 'overwrite') ? options.conflict : 'rename';
    var payload = (bundle && bundle.payload) || {};
    var avail = Array.isArray(bundle && bundle.includes) ? bundle.includes : EXPORT_SECTIONS;
    var sections = Array.isArray(options.sections)
      ? avail.filter(function (s) { return options.sections.indexOf(s) !== -1; })
      : avail;

    var next = deepClone(state);

    if (sections.indexOf('materials') !== -1 && payload.materials) {
      if (mode === 'replace') {
        MATERIAL_FIELDS.forEach(function (f) {
          if (payload.materials[f] !== undefined) next[f] = deepClone(payload.materials[f]);
        });
      } else {
        mergeMaterials(next, payload.materials, conflict);
      }
    }

    if (sections.indexOf('preferences') !== -1 && payload.preferences) {
      mergePreferences(next, payload.preferences, mode);
    }

    if (sections.indexOf('content') !== -1 && payload.content) {
      // 合并模式默认保留本机正文（不覆盖当次草稿）；覆盖模式才采用导入正文。
      if (mode === 'replace') {
        var c = payload.content;
        if (c.content && typeof c.content === 'object') next.content = deepClone(c.content);
        if (c.lang === 'en' || c.lang === 'zh') next.lang = c.lang;
      }
    }

    return next;
  }

  // 素材库合并：自定义项按名称判重走三策略，patches 按内置 id 合并。
  //
  // 判重键 vs 显示名分离：常用句判重键就是 tag（改名即改 tag）；模块 / 分组的
  // 判重键是 zh+en 复合，但改名只动 zh（更自然），故每类各传一套“取键 / 取基名 /
  // 写名”回调，避免在通用函数里塞 label 特判。
  function mergeMaterials(next, mat, conflict) {
    // --- 自定义常用句（按 tag 判重，改名改 tag）---
    if (Array.isArray(mat.customSnippets)) {
      next.customSnippets = mergeCustomList(
        Array.isArray(next.customSnippets) ? next.customSnippets : [],
        mat.customSnippets, conflict, newSnippetId, next.snippetOrder,
        {
          key: snippetKey,
          baseName: function (it) { return it.tag || ''; },
          setName: function (it, name) { it.tag = name; }
        }
      );
    }
    // --- 自定义模块（按 label 判重，改名只改 label.zh）---
    if (Array.isArray(mat.customModules)) {
      next.customModules = mergeCustomList(
        Array.isArray(next.customModules) ? next.customModules : [],
        mat.customModules, conflict, newModuleId, next.moduleOrder,
        {
          key: moduleKey,
          baseName: function (it) { return (it.label && (it.label.zh || it.label.en)) || ''; },
          setName: function (it, name) { it.label = { zh: name, en: (it.label && it.label.en) || '' }; }
        }
      );
    }
    // --- 快速段落分组（一级按 label 判重，同名整组走策略，新组内 items 全新 id）---
    if (Array.isArray(mat.quickGroups)) {
      next.quickGroups = mergeQuickGroups(
        Array.isArray(next.quickGroups) ? next.quickGroups : [],
        mat.quickGroups, conflict
      );
    }
    // --- 内置 patch（按固定 id 合并；合并模式下同名保留本机，仅补本机没有的）---
    if (mat.builtinPatches && typeof mat.builtinPatches === 'object') {
      next.builtinPatches = mergePatches(next.builtinPatches, mat.builtinPatches);
    }
    if (mat.modulePatches && typeof mat.modulePatches === 'object') {
      next.modulePatches = mergePatches(next.modulePatches, mat.modulePatches);
    }
    // order 交给 normalizeState 收尾补齐 / 去重，这里不手动重排。
  }

  // 通用：把 incoming 自定义项按名称判重并入 existing。
  // conflict：skip / overwrite / rename；genId：新 id 生成器；order：对应 order 数组
  //（追加新 id 到末尾，overwrite 保留旧 id 不动 order）。
  // ops：{ key(取判重键) / baseName(取用于改名的基名) / setName(写回改名) }。
  function mergeCustomList(existing, incoming, conflict, genId, order, ops) {
    var out = existing.map(function (x) { return deepClone(x); });
    var keySet = {};   // 判重键集合
    var byKey = {};    // 判重键 -> out 里的项（overwrite 用）
    out.forEach(function (x) { var k = ops.key(x); keySet[k] = true; byKey[k] = x; });
    if (!Array.isArray(order)) order = null;

    incoming.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var item = deepClone(raw);
      var exists = keySet[ops.key(item)];

      if (exists && conflict === 'skip') return;

      if (exists && conflict === 'overwrite') {
        // 覆盖：保留本机旧 id（避免 order / patch 引用断裂），只替换内容字段
        var target = byKey[ops.key(item)];
        var keepId = target.id;
        Object.keys(item).forEach(function (f) { if (f !== 'id') target[f] = item[f]; });
        target.id = keepId;
        return;
      }

      // rename 且冲突：在基名上找不冲突的新名写回
      if (exists && conflict === 'rename') {
        ops.setName(item, dedupeUniqueName(ops.baseName(item), item, ops.key, keySet));
      }
      // 无冲突 或 已改名：新 id 并入
      item.id = genId();
      item.builtin = false;
      out.push(item);
      var nk = ops.key(item);
      keySet[nk] = true; byKey[nk] = item;
      if (order) order.push(item.id);
    });

    return out;
  }

  // 在 base 名上寻找一个改名后判重键不冲突的名字（先 '原名 (导入)'，再递增）。
  // 通过临时改名 probe 项、复算其 key 来判冲突，兼容常用句 / 模块 / 分组三种 key 形态。
  function dedupeUniqueName(base, probeItem, getKey, keySet) {
    base = base == null ? '' : String(base);
    var candidates = [base, base + ' (导入)'];
    for (var i = 2; i < 1000; i++) candidates.push(base + ' (导入 ' + i + ')');
    var probe = deepClone(probeItem);
    for (var j = 0; j < candidates.length; j++) {
      // 用与 setName 一致的方式写入候选名再取 key
      if (probe.label) probe.label = { zh: candidates[j], en: (probeItem.label && probeItem.label.en) || '' };
      else probe.tag = candidates[j];
      if (!keySet[getKey(probe)]) return candidates[j];
    }
    return base + ' (导入 ' + Date.now() + ')';
  }

  // 快速段落分组合并（一级按 label 判重）。同名分组：skip 保留本机；
  // overwrite 用导入组替换（内容全新 id）；rename 改组名后并存。新组内 items 全部重新生成 id。
  function mergeQuickGroups(existing, incoming, conflict) {
    var out = existing.map(function (g) { return deepClone(g); });
    var nameSet = {};
    var byName = {};
    out.forEach(function (g) { var k = groupKey(g); nameSet[k] = true; byName[k] = g; });

    function freshGroup(raw, labelOverride) {
      var g = deepClone(raw);
      g.id = newQuickGroupId();
      g.hidden = g.hidden === true;
      if (labelOverride) g.label = labelOverride;
      g.items = (Array.isArray(g.items) ? g.items : []).map(function (it) {
        var item = deepClone(it);
        item.id = newQuickItemId();
        return item;
      });
      return g;
    }

    incoming.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var key = groupKey(raw);
      var exists = nameSet[key];
      if (exists && conflict === 'skip') return;
      if (exists && conflict === 'overwrite') {
        var idx = out.indexOf(byName[key]);
        var keepId = byName[key].id;
        var replaced = freshGroup(raw);
        replaced.id = keepId; // 保留本机组 id
        out[idx] = replaced;
        byName[key] = replaced;
        return;
      }
      if (exists && conflict === 'rename') {
        var baseZh = (raw.label && (raw.label.zh || raw.label.en)) || '';
        var newZh = dedupeUniqueName(baseZh, { label: { zh: baseZh, en: (raw.label && raw.label.en) || '' } }, groupKey, nameSet);
        var g = freshGroup(raw, { zh: newZh, en: (raw.label && raw.label.en) || '' });
        out.push(g);
        var nk = groupKey(g); nameSet[nk] = true; byName[nk] = g;
        return;
      }
      // 无冲突：直接并入
      var ng = freshGroup(raw);
      out.push(ng);
      var k2 = groupKey(ng); nameSet[k2] = true; byName[k2] = ng;
    });

    return out;
  }

  // 内置 patch 合并：以本机为准，仅补入本机没有的 id（同名保留本机个性化）。
  function mergePatches(local, incoming) {
    var out = (local && typeof local === 'object') ? deepClone(local) : {};
    Object.keys(incoming).forEach(function (id) {
      if (out[id] === undefined && incoming[id] && typeof incoming[id] === 'object') {
        out[id] = deepClone(incoming[id]);
      }
    });
    return out;
  }

  // 偏好合并：标量字段导入值存在则采用；apiKey 永远保留本机（导入文件本就无 Key）。
  function mergePreferences(next, prefs, mode) {
    var s = next.settings || (next.settings = {});
    if (typeof prefs.toggleShortcut === 'string' && prefs.toggleShortcut.trim() !== '') {
      s.toggleShortcut = prefs.toggleShortcut;
    }
    if (typeof prefs.pasteDelayMs === 'number' && isFinite(prefs.pasteDelayMs)) {
      s.pasteDelayMs = prefs.pasteDelayMs;
    }
    if (prefs.translation && typeof prefs.translation === 'object') {
      var localKey = (s.translation && s.translation.apiKey) || '';
      var tr = deepClone(prefs.translation);
      tr.apiKey = localKey; // 铁律：导入不改本机 Key
      s.translation = tr;
    }
    // theme 不在 state（localStorage），由 UI 层从 payload 单独应用。
    // onboarding / lang 合并模式保留本机；lang 覆盖模式由 content 段处理，这里不动。
    if (mode === 'replace') { /* 覆盖模式偏好即上面整替，无额外差异 */ }
  }

  /* ---------- 7.5 导入预览摘要 ----------
   * summarizeImport(state, bundle, { mode, conflict, sections }) -> 计数与冲突
   * 只统计不改 state，供预览弹窗渲染中文清单。
   */
  function summarizeImport(state, bundle, options) {
    options = options || {};
    var payload = (bundle && bundle.payload) || {};
    var avail = Array.isArray(bundle && bundle.includes) ? bundle.includes : EXPORT_SECTIONS;
    var sections = Array.isArray(options.sections)
      ? avail.filter(function (s) { return options.sections.indexOf(s) !== -1; })
      : avail;

    var out = { sections: sections, materials: null, preferences: null, content: null };

    if (sections.indexOf('materials') !== -1 && payload.materials) {
      var mat = payload.materials;
      out.materials = {
        modules: countIncoming(mat.customModules, state.customModules, moduleKey),
        snippets: countIncoming(mat.customSnippets, state.customSnippets, snippetKey),
        quickGroups: countIncoming(mat.quickGroups, state.quickGroups, groupKey)
      };
    }
    if (sections.indexOf('preferences') !== -1 && payload.preferences) {
      out.preferences = { includesApiKey: false, keptLocalApiKey: true };
    }
    if (sections.indexOf('content') !== -1 && payload.content) {
      var c = payload.content.content || {};
      out.content = { zh: (c.zh || '').length, en: (c.en || '').length };
    }
    return out;
  }

  // 统计一段自定义列表里 incoming 的条数与其中同名冲突数。
  function countIncoming(incoming, existing, getKey) {
    var inc = Array.isArray(incoming) ? incoming : [];
    var have = {};
    (Array.isArray(existing) ? existing : []).forEach(function (x) { have[getKey(x)] = true; });
    var conflicts = 0;
    inc.forEach(function (x) { if (x && have[getKey(x)]) conflicts++; });
    return { incoming: inc.length, conflicts: conflicts };
  }

  /* ============================================================
   * 导出（ES module）
   * ============================================================ */
  export {
    INSERT_MODULES,
    MODULE_BY_ID,
    BUILTIN_SNIPPETS,
    BUILTIN_BY_ID,
    // v0.2 行内补全：自学习引擎（纯逻辑）
    defaultLearning,
    normalizeLearning,
    normalizeLearnText,
    learnKey,
    // 读时切分（片段补全）
    segmentClause,
    segmentText,
    clauseTailParts,
    learnedFragments,
    getCandidates,
    scoreCandidate,
    rankCandidates,
    learn,
    learnedSnippets,
    learnedSnippetsForManage,
    removeLearnedSnippet,
    clearLearning,
    buildLearningExportBundle,
    validateLearningImportBundle,
    mergeLearningImport,
    isInCodeContext,
    defaultCompletionSettings,
    TRANSLATE_PROVIDERS,
    TRANSLATE_PROVIDER_BY_ID,
    defaultTranslateSettings,
    normalizeTranslateSettings,
    defaultOnboarding,
    ONBOARDING_HINT_KEYS,
    maskCode,
    unmaskCode,
    translateSystemPrompt,
    buildTranslatePayload,
    extractModelText,
    parseTranslateResponse,
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
    // 配置导入导出（纯逻辑）
    EXPORT_SCHEMA_VERSION,
    EXPORT_APP_ID,
    EXPORT_FILE_TYPE,
    EXPORT_SECTIONS,
    MATERIAL_FIELDS,
    buildExportBundle,
    validateImportBundle,
    mergeState,
    summarizeImport,
  };
