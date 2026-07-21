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
