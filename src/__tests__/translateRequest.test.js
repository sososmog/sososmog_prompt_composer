/* ============================================================
 * translateRequest.test.js —— 翻译编排层（translate.js）的请求路径
 * ------------------------------------------------------------
 * 纯逻辑（配置校验、译文回填、遮罩、请求体构造、响应解析）在
 * translate.test.js 里覆盖；这份测试管 translate.js 自己那段：选哪个
 * fetch、超时怎么中断、失败重试几次、拿到脏响应时会不会把用户正文写坏。
 *
 * 这些分支全是"不测就不知道对不对"的防御代码——正常联网时一次都走不到，
 * 所以最容易一直是错的而没人发现。这里用 mock fetch 把每条都走一遍，
 * 重点断言一条不变量：**任何失败路径都不能改动已有正文**。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

var here = path.dirname(fileURLToPath(import.meta.url));
var rawIndexHtml = readFileSync(path.resolve(here, '../index.html'), 'utf-8');
function extractBodyHtml(html) {
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error('index.html 里找不到 <body>');
  return m[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}
var BODY_HTML = extractBodyHtml(rawIndexHtml);

// OpenAI 协议的成功响应信封：translations 数组塞在 message.content 的 JSON 串里
function openaiResp(translations) {
  return {
    ok: true,
    status: 200,
    json: function () {
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ translations: translations }) } }]
      });
    },
    text: function () { return Promise.resolve(''); }
  };
}

function errorResp(status, body) {
  return {
    ok: false,
    status: status,
    json: function () { return Promise.reject(new Error('不该走到这')); },
    text: function () { return Promise.resolve(body || ''); }
  };
}

var events, store, translate;

beforeEach(async function () {
  vi.resetModules();
  document.body.innerHTML = BODY_HTML;

  events = await import('../events.js');
  store = await import('../store.js');
  translate = await import('../translate.js');
  events.renderAll();

  // 配好一份可用的翻译设置，否则一律短路在配置校验上
  store.state.settings.translation.apiKey = 'sk-test';
  store.state.settings.translation.baseUrl = 'https://api.example.com/v1/chat/completions';
  store.state.settings.translation.model = 'test-model';
  store.state.settings.translation.protocol = 'openai';

  store.state.lang = 'zh';
  store.state.content.zh = '## 角色\n你是一个助手。\n\n## 任务\n帮我写文案。';
  store.state.content.en = '原有英文内容，失败时必须保持不变。';
  // 必须重渲染：translateCurrentContent 会先 collectText() 把 DOM 里的块收回
  // state，不同步的话上面这份 content.zh 会被 renderAll 留下的演示正文覆盖掉。
  events.renderAll();
});

afterEach(function () {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.__TAURI__;
});

describe('配置不全时短路，不发请求', function () {
  it('缺 Key 时 reason 为 need-key，fetch 一次都没调', async function () {
    var fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    store.state.settings.translation.apiKey = '';

    var r = await translate.translateCurrentContent();
    expect(r).toEqual({ ok: false, reason: 'need-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('缺 baseUrl 时返回提示文案，不发请求', async function () {
    var fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    store.state.settings.translation.baseUrl = '';

    var r = await translate.translateCurrentContent();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/baseURL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('正文为空时返回 empty，不发请求', async function () {
    var fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    store.state.content.zh = '   \n\n  ';
    events.renderAll();

    var r = await translate.translateCurrentContent();
    expect(r).toEqual({ ok: false, reason: 'empty' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('成功路径', function () {
  it('译文按序写进目标语言槽位，源语言不动', async function () {
    var fetchSpy = vi.fn(function () {
      return Promise.resolve(openaiResp(['## Role\nYou are an assistant.', '## Task\nWrite copy for me.']));
    });
    vi.stubGlobal('fetch', fetchSpy);
    var srcBefore = store.state.content.zh;

    var r = await translate.translateCurrentContent();

    expect(r.ok).toBe(true);
    expect(r.target).toBe('en');
    expect(r.count).toBe(2);
    expect(r.partial).toBe(false);
    expect(store.state.content.en).toBe('## Role\nYou are an assistant.\n\n## Task\nWrite copy for me.');
    expect(store.state.content.zh).toBe(srcBefore);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('请求走 POST，带上 headers 与 JSON body', async function () {
    var seen = null;
    vi.stubGlobal('fetch', vi.fn(function (url, opts) {
      seen = { url: url, opts: opts };
      return Promise.resolve(openaiResp(['A', 'B']));
    }));

    await translate.translateCurrentContent();

    expect(seen.url).toContain('api.example.com');
    expect(seen.opts.method).toBe('POST');
    expect(seen.opts.headers).toBeTruthy();
    expect(function () { JSON.parse(seen.opts.body); }).not.toThrow();
  });

  it('从 en 翻到 zh 时方向反过来（目标槽位是 zh）', async function () {
    store.state.lang = 'en';
    store.state.content.en = '## Role\nYou are an assistant.';
    events.renderAll();
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve(openaiResp(['## 角色\n你是一个助手。']));
    }));

    var r = await translate.translateCurrentContent();
    expect(r.target).toBe('zh');
    expect(store.state.content.zh).toBe('## 角色\n你是一个助手。');
  });

  it('优先用 Tauri 的 http.fetch（有它时不碰 window.fetch）', async function () {
    var winFetch = vi.fn();
    var tauriFetch = vi.fn(function () { return Promise.resolve(openaiResp(['A', 'B'])); });
    vi.stubGlobal('fetch', winFetch);
    window.__TAURI__ = { http: { fetch: tauriFetch } };

    var r = await translate.translateCurrentContent();

    expect(r.ok).toBe(true);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(winFetch).not.toHaveBeenCalled();
  });
});

describe('失败路径：正文一律不许被改动', function () {
  it('HTTP 500：重试一次后仍失败，抛出带状态码的错误，目标语言不变', async function () {
    var fetchSpy = vi.fn(function () { return Promise.resolve(errorResp(500, 'upstream boom')); });
    vi.stubGlobal('fetch', fetchSpy);
    var before = store.state.content.en;

    await expect(translate.translateCurrentContent()).rejects.toThrow(/HTTP 500/);
    // 首次 + 重试 1 次 = 2 次
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(store.state.content.en).toBe(before);
  });

  it('HTTP 错误体过长时截断进错误消息（不把整篇上游日志塞进 toast）', async function () {
    var long = 'x'.repeat(500);
    vi.stubGlobal('fetch', vi.fn(function () { return Promise.resolve(errorResp(400, long)); }));

    await translate.translateCurrentContent().then(
      function () { throw new Error('本该失败'); },
      function (err) {
        expect(err.message).toMatch(/HTTP 400/);
        expect(err.message.length).toBeLessThan(300);
      }
    );
  });

  it('resp.text() 自己也炸时，退化成只报状态码', async function () {
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve({
        ok: false,
        status: 502,
        text: function () { return Promise.reject(new Error('body 读不出来')); },
        json: function () { return Promise.reject(new Error('n/a')); }
      });
    }));

    await expect(translate.translateCurrentContent()).rejects.toThrow(/HTTP 502/);
  });

  it('网络层直接 reject：重试一次，两次都挂则抛原始错误', async function () {
    var fetchSpy = vi.fn(function () { return Promise.reject(new Error('ECONNREFUSED')); });
    vi.stubGlobal('fetch', fetchSpy);
    var before = store.state.content.en;

    await expect(translate.translateCurrentContent()).rejects.toThrow('ECONNREFUSED');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(store.state.content.en).toBe(before);
  });

  it('第一次失败、重试成功：结果照常写回（重试不是白设的）', async function () {
    var n = 0;
    vi.stubGlobal('fetch', vi.fn(function () {
      n++;
      if (n === 1) return Promise.reject(new Error('一次抖动'));
      return Promise.resolve(openaiResp(['## Role\nOne', '## Task\nTwo']));
    }));

    var r = await translate.translateCurrentContent();
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(store.state.content.en).toContain('One');
  });

  it('重试时抛的是首次那个错误（首错通常更能说明原因）', async function () {
    var n = 0;
    vi.stubGlobal('fetch', vi.fn(function () {
      n++;
      return Promise.reject(new Error(n === 1 ? '首次错误' : '重试错误'));
    }));

    await expect(translate.translateCurrentContent()).rejects.toThrow('首次错误');
  });

  it('返回体不是预期 JSON 结构：抛错，目标语言保持原样', async function () {
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ choices: [{ message: { content: '这不是 JSON' } }] }); },
        text: function () { return Promise.resolve(''); }
      });
    }));
    var before = store.state.content.en;

    await expect(translate.translateCurrentContent()).rejects.toThrow(/JSON/);
    expect(store.state.content.en).toBe(before);
  });

  it('响应信封整体畸形（没有 choices）：抛错且不写回', async function () {
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ unexpected: true }); },
        text: function () { return Promise.resolve(''); }
      });
    }));
    var before = store.state.content.en;

    await expect(translate.translateCurrentContent()).rejects.toThrow();
    expect(store.state.content.en).toBe(before);
  });

  it('环境里既没有 Tauri 也没有 fetch：明确报不支持，且重试后仍不写回', async function () {
    var before = store.state.content.en;
    vi.stubGlobal('fetch', undefined);

    await expect(translate.translateCurrentContent()).rejects.toThrow(/不支持网络请求/);
    expect(store.state.content.en).toBe(before);
  });
});

describe('部分对不齐时的写回策略', function () {
  it('模型少返回一块：缺的那块回填源文，标记 partial，块数不减', async function () {
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve(openaiResp(['## Role\nYou are an assistant.']));
    }));

    var r = await translate.translateCurrentContent();

    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.count).toBe(2);
    // 第二块没翻出来，写回的是中文源块，而不是被吞掉
    expect(store.state.content.en.split('\n\n')).toHaveLength(2);
    expect(store.state.content.en).toContain('帮我写文案。');
  });

  it('某块返回空串：那块回填源文并标记 partial', async function () {
    vi.stubGlobal('fetch', vi.fn(function () {
      return Promise.resolve(openaiResp(['## Role\nYou are an assistant.', '']));
    }));

    var r = await translate.translateCurrentContent();
    expect(r.partial).toBe(true);
    expect(store.state.content.en).toContain('帮我写文案。');
  });

  it('代码围栏在译文里被完整还原（遮罩没漏）', async function () {
    store.state.content.zh = '## 示例\n看这段 `foo()` 和\n```js\nlet a = 1;\n```\n结束';
    events.renderAll();
    var sentBody = null;
    vi.stubGlobal('fetch', vi.fn(function (url, opts) {
      sentBody = JSON.parse(opts.body);
      // 把模型行为模拟成"原样返回收到的遮罩文本"，只有遮罩正确才能还原
      var content = sentBody.messages
        ? JSON.parse(sentBody.messages[sentBody.messages.length - 1].content).texts
        : null;
      return Promise.resolve(openaiResp(content));
    }));

    var r = await translate.translateCurrentContent();
    expect(r.ok).toBe(true);
    expect(store.state.content.en).toContain('`foo()`');
    expect(store.state.content.en).toContain('let a = 1;');
  });
});

describe('超时', function () {
  it('超过 30 秒未响应则中断请求（AbortController 被触发）', async function () {
    vi.useFakeTimers();
    var aborted = false;
    vi.stubGlobal('fetch', vi.fn(function (url, opts) {
      return new Promise(function (resolve, reject) {
        if (opts.signal) {
          opts.signal.addEventListener('abort', function () {
            aborted = true;
            reject(new Error('The operation was aborted'));
          });
        }
        // 永不 resolve，模拟服务端挂住
      });
    }));

    var p = translate.translateCurrentContent();
    var assertion = expect(p).rejects.toThrow(/aborted/);
    // 推进到超时点：首次请求超时 → 重试 → 重试也超时
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('正常返回后超时定时器被清掉，不会事后误中断', async function () {
    vi.useFakeTimers();
    var signals = [];
    vi.stubGlobal('fetch', vi.fn(function (url, opts) {
      signals.push(opts.signal);
      return Promise.resolve(openaiResp(['A', 'B']));
    }));

    var r = await translate.translateCurrentContent();
    expect(r.ok).toBe(true);
    expect(signals[0].aborted).toBe(false);

    // 越过超时点：若 clearTimeout 漏了，这里会把已完成请求的 controller
    // 也 abort 掉（本身无害，但说明每次翻译都留了个 30 秒的悬挂定时器）
    await vi.advanceTimersByTimeAsync(31000);
    expect(signals[0].aborted).toBe(false);
  });
});
