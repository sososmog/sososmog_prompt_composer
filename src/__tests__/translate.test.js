import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const {
  maskCode,
  unmaskCode,
  normalizeTranslateSettings,
  defaultTranslateSettings,
  buildTranslatePayload,
  parseTranslateResponse,
  extractModelText,
  validateTranslateConfig,
  assembleTranslatedBlocks,
  TRANSLATE_PROVIDER_BY_ID,
} = loadComposer();

describe('maskCode / unmaskCode 代码遮罩还原', () => {
  it('无代码时原样返回、tokens 为空', () => {
    const { masked, tokens } = maskCode('普通一段话');
    expect(masked).toBe('普通一段话');
    expect(tokens).toEqual([]);
    expect(unmaskCode(masked, tokens)).toBe('普通一段话');
  });

  it('行内代码被遮罩并可完整还原', () => {
    const src = '运行 `npm install` 安装依赖';
    const { masked, tokens } = maskCode(src);
    expect(masked).not.toContain('npm install');
    expect(masked).toContain('〖0〗');
    expect(tokens).toEqual(['`npm install`']);
    expect(unmaskCode(masked, tokens)).toBe(src);
  });

  it('围栏代码块（含跨行）整体遮罩并还原', () => {
    const src = '示例：\n```js\nconst a = 1;\nconsole.log(a);\n```\n结束';
    const { masked, tokens } = maskCode(src);
    expect(masked).not.toContain('console.log');
    expect(tokens.length).toBe(1);
    expect(unmaskCode(masked, tokens)).toBe(src);
  });

  it('围栏与行内并存：围栏优先，编号从 0 递增', () => {
    const src = '`inline` 与\n```\nblock\n```';
    const { masked, tokens } = maskCode(src);
    // 围栏先遮罩得 〖0〗，行内后遮罩得 〖1〗
    expect(tokens[0]).toBe('```\nblock\n```');
    expect(tokens[1]).toBe('`inline`');
    expect(unmaskCode(masked, tokens)).toBe(src);
  });

  it('unmaskCode 对越界记号保持原样', () => {
    expect(unmaskCode('保留〖9〗', ['x'])).toBe('保留〖9〗');
  });
});

describe('normalizeTranslateSettings 脏值回退', () => {
  it('undefined / 非对象 回退默认（Gemini）', () => {
    expect(normalizeTranslateSettings(undefined)).toEqual(defaultTranslateSettings());
    expect(normalizeTranslateSettings(null)).toEqual(defaultTranslateSettings());
    expect(normalizeTranslateSettings(42)).toEqual(defaultTranslateSettings());
  });

  it('未知 provider 归为 custom', () => {
    const out = normalizeTranslateSettings({ provider: 'unknown-x', protocol: 'openai' });
    expect(out.provider).toBe('custom');
  });

  it('非法 protocol 用已知预设的 protocol 兜底', () => {
    const out = normalizeTranslateSettings({ provider: 'glm', protocol: 'weird' });
    expect(out.protocol).toBe('openai'); // glm 预设是 openai
  });

  it('overwrite 默认 true，显式 false 才关闭', () => {
    expect(normalizeTranslateSettings({}).overwrite).toBe(true);
    expect(normalizeTranslateSettings({ overwrite: false }).overwrite).toBe(false);
    expect(normalizeTranslateSettings({ overwrite: 'no' }).overwrite).toBe(true);
  });

  it('字符串字段被 trim，缺失留空', () => {
    const out = normalizeTranslateSettings({ provider: 'custom', protocol: 'openai', baseUrl: '  http://x  ', model: ' m ', apiKey: 'k' });
    expect(out.baseUrl).toBe('http://x');
    expect(out.model).toBe('m');
    expect(out.apiKey).toBe('k');
  });
});

describe('buildTranslatePayload 请求体构造', () => {
  const gemini = { protocol: 'gemini', baseUrl: 'https://gen.example/v1beta', model: 'gemini-2.5-flash', apiKey: 'KEY123' };
  const openai = { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'glm-4-flash', apiKey: 'KEY456' };

  it('gemini：URL 带 ?key=，强制 JSON responseMimeType', () => {
    const p = buildTranslatePayload(gemini, '中文', 'English', ['你好']);
    expect(p.url).toBe('https://gen.example/v1beta/models/gemini-2.5-flash:generateContent?key=KEY123');
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.headers.Authorization).toBeUndefined();
    expect(p.body.generationConfig.responseMimeType).toBe('application/json');
    // 用户消息里带 texts 数组
    const userText = p.body.contents[0].parts[0].text;
    expect(JSON.parse(userText)).toEqual({ texts: ['你好'] });
  });

  it('openai：/chat/completions + Bearer + json_object', () => {
    const p = buildTranslatePayload(openai, '中文', 'English', ['你好', '世界']);
    expect(p.url).toBe('https://api.example/v1/chat/completions');
    expect(p.headers.Authorization).toBe('Bearer KEY456');
    expect(p.body.response_format).toEqual({ type: 'json_object' });
    expect(p.body.model).toBe('glm-4-flash');
    expect(JSON.parse(p.body.messages[1].content)).toEqual({ texts: ['你好', '世界'] });
  });

  it('baseUrl 末尾斜杠被规整', () => {
    const p = buildTranslatePayload({ ...openai, baseUrl: 'https://api.example/v1/' }, '中文', 'English', ['x']);
    expect(p.url).toBe('https://api.example/v1/chat/completions');
  });
});

describe('parseTranslateResponse 响应解析', () => {
  it('gemini：从 candidates parts 取出 translations', () => {
    const resp = { candidates: [{ content: { parts: [{ text: '{"translations":["Hello","World"]}' }] } }] };
    expect(parseTranslateResponse('gemini', resp)).toEqual(['Hello', 'World']);
  });

  it('openai：从 choices message.content 取出 translations', () => {
    const resp = { choices: [{ message: { content: '{"translations":["Hello"]}' } }] };
    expect(parseTranslateResponse('openai', resp)).toEqual(['Hello']);
  });

  it('模型包了 ```json 围栏也能剥离解析', () => {
    const resp = { choices: [{ message: { content: '```json\n{"translations":["Hi"]}\n```' } }] };
    expect(parseTranslateResponse('openai', resp)).toEqual(['Hi']);
  });

  it('裸数组也接住', () => {
    const resp = { choices: [{ message: { content: '["A","B"]' } }] };
    expect(parseTranslateResponse('openai', resp)).toEqual(['A', 'B']);
  });

  it('空/非 JSON/结构缺失 返回 null', () => {
    expect(parseTranslateResponse('openai', { choices: [{ message: { content: '' } }] })).toBeNull();
    expect(parseTranslateResponse('openai', { choices: [{ message: { content: '不是json' } }] })).toBeNull();
    expect(parseTranslateResponse('gemini', {})).toBeNull();
    expect(parseTranslateResponse('gemini', null)).toBeNull();
  });

  it('extractModelText 对两种协议正确取信封', () => {
    expect(extractModelText('gemini', { candidates: [{ content: { parts: [{ text: 'ab' }, { text: 'cd' }] } }] })).toBe('abcd');
    expect(extractModelText('openai', { choices: [{ message: { content: 'x' } }] })).toBe('x');
  });
});

describe('预设完整性', () => {
  it('每个预设都有 protocol / baseUrl / model 字段', () => {
    Object.values(TRANSLATE_PROVIDER_BY_ID).forEach((p) => {
      expect(['gemini', 'openai']).toContain(p.protocol);
      expect(typeof p.baseUrl).toBe('string');
      expect(typeof p.model).toBe('string');
    });
  });
});

describe('validateTranslateConfig 配置校验', () => {
  const ok = { apiKey: 'sk-x', baseUrl: 'https://api.example.com', model: 'gpt-x' };

  it('三项齐全时返回 null', () => {
    expect(validateTranslateConfig(ok)).toBe(null);
  });

  it('配置对象缺失时给出提示', () => {
    expect(validateTranslateConfig(null)).toBe('翻译未配置');
    expect(validateTranslateConfig(undefined)).toBe('翻译未配置');
  });

  it('缺 Key 返回特殊标识 need-key（UI 据此引导去填，而非弹这句话）', () => {
    expect(validateTranslateConfig({ ...ok, apiKey: '' })).toBe('need-key');
    expect(validateTranslateConfig({ ...ok, apiKey: undefined })).toBe('need-key');
  });

  it('Key 只有空白也算没填', () => {
    expect(validateTranslateConfig({ ...ok, apiKey: '   ' })).toBe('need-key');
  });

  it('缺 baseUrl / model 各自给出对应提示', () => {
    expect(validateTranslateConfig({ ...ok, baseUrl: '' })).toMatch(/baseURL/);
    expect(validateTranslateConfig({ ...ok, baseUrl: '  ' })).toMatch(/baseURL/);
    expect(validateTranslateConfig({ ...ok, model: '' })).toMatch(/模型名/);
    expect(validateTranslateConfig({ ...ok, model: '\t' })).toMatch(/模型名/);
  });

  it('校验顺序：Key 优先于 baseUrl（同时缺时先引导填 Key）', () => {
    expect(validateTranslateConfig({ apiKey: '', baseUrl: '', model: '' })).toBe('need-key');
  });
});

describe('assembleTranslatedBlocks 译文回填', () => {
  it('数量对齐且都非空：逐块替换，partial 为假', () => {
    const out = assembleTranslatedBlocks(['## A\n中文一', '## B\n中文二'], ['## A\nOne', '## B\nTwo'], [[], []]);
    expect(out.text).toBe('## A\nOne\n\n## B\nTwo');
    expect(out.partial).toBe(false);
    expect(out.count).toBe(2);
  });

  it('模型少返回一项：缺的位置回填源块原文，块数不减（不能吞掉正文）', () => {
    const src = ['块一', '块二', '块三'];
    const out = assembleTranslatedBlocks(src, ['One', 'Two'], [[], [], []]);
    expect(out.text.split('\n\n')).toEqual(['One', 'Two', '块三']);
    expect(out.partial).toBe(true);
    expect(out.count).toBe(3);
  });

  it('模型多返回项：多出来的丢弃，块数仍等于源块数', () => {
    const out = assembleTranslatedBlocks(['块一'], ['One', 'Extra', 'More'], [[]]);
    expect(out.text).toBe('One');
    expect(out.count).toBe(1);
    expect(out.partial).toBe(true);
  });

  it('某项是空串 / 纯空白：该块回填原文，并标记 partial', () => {
    const out = assembleTranslatedBlocks(['块一', '块二'], ['One', '   '], [[], []]);
    expect(out.text.split('\n\n')).toEqual(['One', '块二']);
    // 长度对得上但有一块其实没翻，不能报成完全成功
    expect(out.partial).toBe(true);
  });

  it('某项不是字符串（null / 数字 / 对象）也回退到源块，不把 null 写进正文', () => {
    const out = assembleTranslatedBlocks(['a', 'b', 'c'], [null, 42, { x: 1 }], [[], [], []]);
    expect(out.text.split('\n\n')).toEqual(['a', 'b', 'c']);
    expect(out.partial).toBe(true);
  });

  it('去掉每块尾部空白，拼接后不累积空行', () => {
    const out = assembleTranslatedBlocks(['a', 'b'], ['One\n\n\n', 'Two   \n'], [[], []]);
    expect(out.text).toBe('One\n\nTwo');
  });

  it('还原遮罩：译文里的占位符换回原始代码', () => {
    const { masked, tokens } = maskCode('看这段 `code()` 代码');
    const out = assembleTranslatedBlocks(['看这段 `code()` 代码'], [masked], [tokens]);
    expect(out.text).toContain('`code()`');
  });

  it('translations 不是数组：整篇回填源文，全部标记 partial', () => {
    const out = assembleTranslatedBlocks(['a', 'b'], null, [[], []]);
    expect(out.text).toBe('a\n\nb');
    expect(out.partial).toBe(true);
  });

  it('源块为空数组：产出空串、count 为 0，不抛异常', () => {
    const out = assembleTranslatedBlocks([], [], []);
    expect(out.text).toBe('');
    expect(out.count).toBe(0);
    expect(out.partial).toBe(false);
  });

  it('tokensList 缺失时不抛异常（按无遮罩处理）', () => {
    const out = assembleTranslatedBlocks(['a'], ['One'], undefined);
    expect(out.text).toBe('One');
  });

  it('源块本身带尾部空白时，回填的原文也被裁掉尾部空白', () => {
    const out = assembleTranslatedBlocks(['块一   \n\n'], [''], [[]]);
    expect(out.text).toBe('块一');
  });
});
