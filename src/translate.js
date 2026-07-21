/* ============================================================
 * translate.js —— 一键翻译编排层
 * ------------------------------------------------------------
 * 把“当前语言正文”翻译到另一种语言并写回对应槽位。真相源是
 * state.content[lang] 大文本；按块（parseBlocks）拆成有序字符串
 * 数组，一次请求批量翻完，模型返回等长同序的 JSON，再拼回写入
 * state.content[target]。
 *
 * 纯逻辑（遮罩/还原、请求体构造、响应解析）在 core.js；此文件负责：
 *   - 收集待翻字符串 + 遮罩代码
 *   - 通过 Tauri http 插件发请求（绕 CORS，key 留应用侧）
 *   - 超时 + 重试 1 次 + 全程 try/catch
 *   - 解析结果、还原遮罩、写回 state、触发防抖保存
 * 全程不阻塞 UI；失败时不改动任何已有内容。
 * ============================================================ */
import {
  parseBlocks,
  maskCode,
  unmaskCode,
  buildTranslatePayload,
  parseTranslateResponse,
} from './core.js';
import {
  state,
  scheduleSave,
  collectText,
} from './store.js';

var TRANSLATE_TIMEOUT_MS = 30000;

function langName(code) { return code === 'zh' ? '中文' : 'English'; }

// Tauri http 插件的 fetch：window.__TAURI__.http.fetch。降级到 window.fetch
// 仅用于非 Tauri 预览环境（会受 CORS 限制，正式使用走 Tauri）。
function httpFetch() {
  var TAURI = window.__TAURI__ || null;
  if (TAURI && TAURI.http && typeof TAURI.http.fetch === 'function') return TAURI.http.fetch;
  if (typeof window.fetch === 'function') return window.fetch.bind(window);
  return null;
}

// 单次请求（带超时）。返回解析后的响应 JSON；任何异常向上抛。
function requestOnce(payload) {
  var fetchFn = httpFetch();
  if (!fetchFn) return Promise.reject(new Error('当前环境不支持网络请求'));

  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, TRANSLATE_TIMEOUT_MS);

  var opts = {
    method: 'POST',
    headers: payload.headers,
    body: JSON.stringify(payload.body)
  };
  if (controller) opts.signal = controller.signal;

  return fetchFn(payload.url, opts).then(function (resp) {
    clearTimeout(timer);
    if (!resp || !resp.ok) {
      var status = resp ? resp.status : '?';
      return resp.text().then(function (t) {
        throw new Error('HTTP ' + status + (t ? ('：' + t.slice(0, 200)) : ''));
      }, function () { throw new Error('HTTP ' + status); });
    }
    return resp.json();
  }).catch(function (err) {
    clearTimeout(timer);
    throw err;
  });
}

// 请求 + 失败自动重试 1 次。
function requestWithRetry(payload) {
  return requestOnce(payload).catch(function (err) {
    return requestOnce(payload).catch(function () { throw err; });
  });
}

// 校验配置是否可用。返回 null 表示 OK，否则返回错误提示字符串。
function validateConfig(cfg) {
  if (!cfg) return '翻译未配置';
  if (!cfg.apiKey || !cfg.apiKey.trim()) return 'need-key';
  if (!cfg.baseUrl || !cfg.baseUrl.trim()) return '请先在设置里填写 baseURL';
  if (!cfg.model || !cfg.model.trim()) return '请先在设置里填写模型名';
  return null;
}

/* ------------------------------------------------------------
 * 主流程：把当前语言正文翻译到另一种语言。
 * 返回 Promise，resolve 一个结果对象供 UI 决定 toast 文案：
 *   { ok:true, target, count, partial }  —— 成功（partial 表示部分对不齐）
 *   { ok:false, reason:'need-key' | 'empty' | 'no-config' | msg }
 * onProgress 可选：进行中回调（此实现单/少量请求，未细分进度）。
 * ------------------------------------------------------------ */
function translateCurrentContent() {
  var cfg = state.settings && state.settings.translation;
  var cfgErr = validateConfig(cfg);
  if (cfgErr === 'need-key') return Promise.resolve({ ok: false, reason: 'need-key' });
  if (cfgErr) return Promise.resolve({ ok: false, reason: cfgErr });

  var src = state.lang;
  var target = src === 'zh' ? 'en' : 'zh';

  // 把 DOM 里未收回的编辑并入当前 content（编辑模式下）
  try { collectText(); } catch (_e) { /* 预览模式或无 DOM，忽略 */ }

  var srcText = state.content[src] || '';
  var blocks = parseBlocks(srcText);
  // 源为空的项跳过：整篇为空则直接提示
  if (blocks.length === 0 || !srcText.trim()) {
    return Promise.resolve({ ok: false, reason: 'empty' });
  }

  // 逐块遮罩代码，收集待翻文本与各自的还原 tokens（保持顺序一致）
  var maskedList = [];
  var tokensList = [];
  blocks.forEach(function (b) {
    var m = maskCode(b);
    maskedList.push(m.masked);
    tokensList.push(m.tokens);
  });

  var payload = buildTranslatePayload(cfg, langName(src), langName(target), maskedList);

  return requestWithRetry(payload).then(function (resp) {
    var translations = parseTranslateResponse(cfg.protocol, resp);
    if (!Array.isArray(translations)) {
      throw new Error('返回内容不是预期的 JSON 结构');
    }

    // 按顺序还原遮罩并拼回。长度对不齐时，对不齐的块保持“原文块”不变，
    // 并标记 partial 由 UI 提示部分失败（约束：不改动对不齐项的目标值——
    // 这里目标是新生成的整篇，对不齐项以源块原文回填，等价于该块未翻译）。
    var partial = translations.length !== blocks.length;
    var outBlocks = blocks.map(function (srcBlock, i) {
      var t = translations[i];
      var block = (typeof t !== 'string' || t.trim() === '') ? srcBlock : unmaskCode(t, tokensList[i]);
      return block.replace(/\s+$/, ''); // 去块尾空白，避免以 \n\n 拼接后累积空行
    });

    state.content[target] = outBlocks.join('\n\n');
    scheduleSave();
    return { ok: true, target: target, count: blocks.length, partial: partial };
  });
}

export {
  translateCurrentContent,
  validateConfig,
  langName,
  TRANSLATE_TIMEOUT_MS,
};
