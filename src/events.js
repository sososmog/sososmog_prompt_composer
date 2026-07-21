/* ============================================================
 * events.js —— 语言/视图切换、输出、设置面板、浮窗开关、快捷键、
 *              检查更新、汇总渲染 renderAll，以及启动引导
 * ------------------------------------------------------------
 * 主窗口最上层：装配各按钮/全局事件，import 其余模块的能力。
 * 文件末尾执行启动逻辑（restoreState + 延迟检查更新）。
 * ============================================================ */
import { icon, TRANSLATE_PROVIDERS, TRANSLATE_PROVIDER_BY_ID, normalizeTranslateSettings } from './core.js';
import { translateCurrentContent } from './translate.js';
import {
  state,
  view,
  setViewValue,
  scheduleSave,
  showToast,
  collectText,
  restoreState,
  history,
  captureHistory,
  applyContentSnapshot,
  fsApi,
  dialogApi,
  clipboardApi,
  updaterApi,
  processApi,
  webviewWindowApi,
  eventApi,
  coreApi,
  $langSegmented,
  $viewSeg,
  $blocks,
  $preview,
  $btnCopy,
  $btnDownload,
  $btnClearAll,
} from './store.js';
import {
  renderBlocks,
  renderPreview,
  renderInsertGrid,
  renderSnippets,
  renderEditor,
} from './render.js';
import {
  renderQuick,
  openSnippetManager,
  openModuleManager,
  openQuickManager,
  renderSnippetManager,
  renderQuickManager,
  $smOverlay,
  $qmOverlay,
} from './quick.js';

  /* ============================================================
   * 9. 语言 / 视图切换
   * ============================================================ */
  function setLang(lang) {
    if (state.lang === lang) return;
    // 切换前把当前编辑内容存回（仅编辑模式下 DOM 才是最新）
    if (view !== 'preview') collectText();
    state.lang = lang;
    // 语言切换：清空撤销/重做两栈。快照只存单语言 content 字符串，
    // 既不含 lang 也无法跨语言写回，跨语言复用会导致内容串味；清空是
    // 最简单且绝不串味的选择。代价：切语言无法撤回、切换前后各自的
    // 历史都不保留——撤销/重做严格限定在“当前语言的本次编辑会话”内。
    history.reset();
    renderAll();
    scheduleSave();
  }
  function toggleLang() { setLang(state.lang === 'zh' ? 'en' : 'zh'); }

  function renderLangSeg() {
    $langSegmented.querySelectorAll('button[data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === state.lang ? 'true' : 'false');
    });
    updateTranslateDir();
  }
  $langSegmented.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-lang]');
    if (b) setLang(b.dataset.lang);
  });

  /* ============================================================
   * 9.1 一键翻译（⇄）：把当前语言正文翻译到另一种语言
   * ------------------------------------------------------------
   * 方向 = 源语言 state.lang → 目标语言（另一种）。悬停提示当前方向；
   * 切换语言后方向随之翻转（renderLangSeg 里调 updateTranslateDir）。
   * 翻译中 ⇄ 进入加载/禁用态；完成后自动切到目标语言看结果，短暂提示。
   * ============================================================ */
  var $btnTranslate = document.getElementById('btnTranslate');
  var isTranslating = false;

  function langLabel(code) { return code === 'zh' ? '中文' : 'English'; }

  function updateTranslateDir() {
    if (!$btnTranslate) return;
    var src = state.lang;
    var tgt = src === 'zh' ? 'en' : 'zh';
    var dir = '翻译 ' + langLabel(src) + ' → ' + langLabel(tgt);
    $btnTranslate.title = isTranslating ? '翻译中…' : dir;
    $btnTranslate.setAttribute('aria-label', isTranslating ? '翻译中' : (dir + '（一键翻译）'));
  }

  function setTranslating(on) {
    isTranslating = on;
    if ($btnTranslate) {
      $btnTranslate.classList.toggle('loading', on);
      $btnTranslate.disabled = on;
    }
    updateTranslateDir();
  }

  function doTranslate() {
    if (isTranslating) return;
    var cfg = state.settings && state.settings.translation;

    // 未配置 key：友好提示并打开设置面板，不报错崩溃
    if (!cfg || !cfg.apiKey || !cfg.apiKey.trim()) {
      showToast('请先在设置里填写翻译 API Key', true);
      openSettingsPanel();
      return;
    }

    var src = state.lang;
    var target = src === 'zh' ? 'en' : 'zh';

    // 覆盖确认：目标已有内容且用户关闭了“覆盖已有译文”时，逐次征询
    if (view !== 'preview') collectText();
    var targetHasContent = (state.content[target] || '').trim() !== '';
    if (targetHasContent && cfg.overwrite === false) {
      var ok = window.confirm('目标语言（' + langLabel(target) + '）已有内容，是否覆盖为新的译文？');
      if (!ok) return;
    }

    setTranslating(true);
    showToast('翻译中…');

    translateCurrentContent().then(function (res) {
      setTranslating(false);
      if (!res || !res.ok) {
        var reason = res && res.reason;
        if (reason === 'need-key') { showToast('请先在设置里填写翻译 API Key', true); openSettingsPanel(); return; }
        if (reason === 'empty') { showToast('当前正文为空，没有可翻译的内容'); return; }
        showToast('翻译失败：' + (reason || '未知错误'), true);
        return;
      }
      // 成功：自动切到目标语言看结果
      setLang(res.target);
      if (res.partial) {
        showToast('已翻译到 ' + langLabel(res.target) + '（部分内容未对齐，请检查）', true);
      } else {
        showToast('已翻译到 ' + langLabel(res.target));
      }
    }).catch(function (err) {
      setTranslating(false);
      var msg = (err && err.message) ? err.message : String(err);
      showToast('翻译失败：' + msg, true);
    });
  }

  if ($btnTranslate) {
    $btnTranslate.addEventListener('click', doTranslate);
    updateTranslateDir();
  }

  function setView(v) {
    if (view === v) return;
    if (v === 'preview') collectText(); // 进预览前把块内容存回
    setViewValue(v);
    renderViewSeg();
    if (view === 'preview') {
      $blocks.hidden = true;
      $preview.hidden = false;
      renderPreview();
    } else {
      $preview.hidden = true;
      $blocks.hidden = false;
      renderBlocks();
    }
  }
  function toggleView() { setView(view === 'write' ? 'preview' : 'write'); }

  function renderViewSeg() {
    $viewSeg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === view ? 'true' : 'false');
    });
  }
  $viewSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  /* ============================================================
   * 10. 输出：复制 / 下载 / 示例 / 清空
   * ============================================================ */
  function doCopy() {
    if (view !== 'preview') collectText();
    var text = state.content[state.lang] || '';
    var langName = state.lang === 'zh' ? '中文' : 'English';
    if (clipboardApi && clipboardApi.writeText) {
      clipboardApi.writeText(text).then(function () { showToast('已复制' + langName + '提示词'); }).catch(function () { fallbackCopy(text, langName); });
    } else {
      fallbackCopy(text, langName);
    }
  }
  function fallbackCopy(text, langName) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('已复制' + langName + '提示词'); }).catch(function () { showToast('复制失败', true); });
    } else { showToast('复制失败：当前环境不支持', true); }
  }

  function doDownload() {
    if (view !== 'preview') collectText();
    var text = state.content[state.lang] || '';
    var defaultName = state.lang === 'zh' ? 'prompt-zh.md' : 'prompt-en.md';
    var langName = state.lang === 'zh' ? '中文' : 'English';
    if (dialogApi && dialogApi.save && fsApi && fsApi.writeTextFile) {
      dialogApi.save({ defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] })
        .then(function (filePath) {
          if (!filePath) return;
          return fsApi.writeTextFile(filePath, text).then(function () { showToast('已下载' + langName + '提示词'); });
        })
        .catch(function () { showToast('下载失败', true); });
    } else {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast('已下载' + langName + '提示词');
    }
  }

  $btnCopy.addEventListener('click', doCopy);
  $btnDownload.addEventListener('click', doDownload);

  var $btnManageSnippets = document.getElementById('btnManageSnippets');
  if ($btnManageSnippets) $btnManageSnippets.addEventListener('click', openSnippetManager);
  var $btnManageModules = document.getElementById('btnManageModules');
  if ($btnManageModules) $btnManageModules.addEventListener('click', openModuleManager);
  var $btnManageQuick = document.getElementById('btnManageQuick');
  if ($btnManageQuick) $btnManageQuick.addEventListener('click', openQuickManager);

  /* ============================================================
   * 12.0 设置面板：快捷键录制（项1） + 粘贴前等待 ms（项2）
   * ------------------------------------------------------------
   * 只有主窗口负责把 state.settings.toggleShortcut 应用到 Rust 侧
   * （invoke set_toggle_shortcut），浮窗不做这件事，避免两个窗口在
   * 启动时争相注册同一个全局热键。
   * ============================================================ */
  var $stOverlay = null, $stRecorderBox = null, $stDelayInput = null;
  var stKeyHandler = null;
  var isRecordingShortcut = false;

  // Rust 命令返回 Result<(), String> 时，invoke 失败会直接以该字符串 reject，
  // 不是一个带 .message 的 Error 对象；做个防御性兜底，避免显示 [object Object]。
  function formatInvokeError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return String(err); } catch (e) { return '未知错误'; }
  }

  // accelerator 主键映射：event.code -> Tauri accelerator 里的主键片段。
  // 纯修饰键（Control/Alt/Shift/Meta 本身）不算主键，需要过滤掉。
  var MODIFIER_CODES = {
    ControlLeft: true, ControlRight: true,
    AltLeft: true, AltRight: true,
    ShiftLeft: true, ShiftRight: true,
    MetaLeft: true, MetaRight: true, OSLeft: true, OSRight: true
  };
  var ARROW_CODE_MAP = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  function codeToMainKey(code) {
    if (!code || MODIFIER_CODES[code]) return null;
    if (ARROW_CODE_MAP[code]) return ARROW_CODE_MAP[code];
    if (code === 'Space') return 'Space';
    if (/^F([1-9]|1[0-2])$/.test(code)) return code; // F1..F12 原样
    var km = code.match(/^Key([A-Z])$/);
    if (km) return km[1];
    var dm = code.match(/^Digit([0-9])$/);
    if (dm) return dm[1];
    // 其余（Comma、Period、Minus 等）没有在规格里列出映射，兜底直接去掉前缀分类词，
    // 拿不准的场景宁可让用户重录，也不要生成一个 Tauri 不认识的 accelerator。
    return null;
  }

  function formatAccelerator(e) {
    var mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    var mainKey = codeToMainKey(e.code);
    if (mods.length === 0 || !mainKey) return null;
    return mods.concat([mainKey]).join('+');
  }

  function ensureSettingsPanel() {
    if ($stOverlay) return;
    $stOverlay = document.createElement('div');
    $stOverlay.className = 'sm-overlay';
    $stOverlay.setAttribute('role', 'dialog');
    $stOverlay.setAttribute('aria-modal', 'true');
    $stOverlay.setAttribute('aria-label', '设置');
    $stOverlay.innerHTML =
      '<div class="sm-panel st-panel">' +
        '<div class="sm-head">' +
          '<span class="sm-title">设置</span>' +
          '<button type="button" class="sm-close" aria-label="关闭">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="st-layout">' +
          '<nav class="st-nav" role="tablist" aria-label="设置分类">' +
            '<button type="button" class="st-nav-item is-active" role="tab" data-tab="general" aria-selected="true">通用</button>' +
            '<button type="button" class="st-nav-item" role="tab" data-tab="shortcut" aria-selected="false">快捷键</button>' +
            '<button type="button" class="st-nav-item" role="tab" data-tab="translate" aria-selected="false">翻译</button>' +
            '<button type="button" class="st-nav-item" role="tab" data-tab="about" aria-selected="false">关于</button>' +
          '</nav>' +
          '<div class="st-body">' +
            // ---- 通用 ----
            '<section class="st-tab-page is-active" data-tab="general" role="tabpanel">' +
              '<div class="st-field">' +
                '<span class="st-label">粘贴前等待</span>' +
                '<span class="st-desc">自动粘贴前等待焦点切换到目标窗口的时长，切换较慢的电脑可以调大一些。</span>' +
                '<div class="st-delay-row">' +
                  '<input type="number" class="st-delay-input" id="stDelayInput" min="30" max="500" step="10" />' +
                  '<span class="st-delay-unit">毫秒（30–500）</span>' +
                '</div>' +
              '</div>' +
            '</section>' +
            // ---- 快捷键 ----
            '<section class="st-tab-page" data-tab="shortcut" role="tabpanel">' +
              '<div class="st-field">' +
                '<span class="st-label">呼出浮窗快捷键</span>' +
                '<span class="st-desc">点击输入框后按下新的组合键（至少一个 Ctrl/Alt/Shift/Super + 一个主键），松开自动保存。</span>' +
                '<div class="st-recorder">' +
                  '<div class="st-recorder-box" id="stRecorderBox" tabindex="0" role="button" aria-label="点击录制快捷键"></div>' +
                  '<button type="button" class="st-recorder-clear" id="stRecorderReset" title="恢复默认（Ctrl+Alt+C）" aria-label="恢复默认快捷键">' + icon('rotate-ccw') + '</button>' +
                '</div>' +
              '</div>' +
            '</section>' +
            // ---- 翻译 ----
            '<section class="st-tab-page" data-tab="translate" role="tabpanel">' +
              '<div class="st-field st-translate">' +
                '<span class="st-label">翻译（LLM）</span>' +
                '<span class="st-desc">配置一键翻译（⇄）使用的大模型。API Key 保存在本地配置文件，不会硬编码进程序。默认 Google Gemini，免费层翻译质量好。</span>' +
                '<div class="st-tr-grid">' +
                  '<label class="st-tr-row"><span class="st-tr-k">提供商</span>' +
                    '<select class="st-tr-input" id="stTrProvider">' +
                      TRANSLATE_PROVIDERS.map(function (p) { return '<option value="' + p.id + '">' + p.label + '</option>'; }).join('') +
                    '</select>' +
                  '</label>' +
                  '<label class="st-tr-row"><span class="st-tr-k">API Key</span>' +
                    '<input type="password" class="st-tr-input" id="stTrKey" placeholder="粘贴你的 API Key" autocomplete="off" spellcheck="false" />' +
                  '</label>' +
                  '<label class="st-tr-row"><span class="st-tr-k">模型名</span>' +
                    '<input type="text" class="st-tr-input" id="stTrModel" placeholder="如 gemini-2.5-flash" spellcheck="false" />' +
                  '</label>' +
                  '<label class="st-tr-row"><span class="st-tr-k">baseURL</span>' +
                    '<input type="text" class="st-tr-input" id="stTrBase" placeholder="接口地址" spellcheck="false" />' +
                  '</label>' +
                  '<label class="st-tr-check"><input type="checkbox" id="stTrOverwrite" /><span>覆盖已有译文（关闭则目标已有内容时先询问）</span></label>' +
                '</div>' +
              '</div>' +
            '</section>' +
            // ---- 关于 ----
            '<section class="st-tab-page" data-tab="about" role="tabpanel">' +
              '<div class="st-about">' +
                '<div class="st-about-app">' +
                  '<span class="st-about-name">Composer</span>' +
                  '<span class="st-about-ver" id="stAboutVer">—</span>' +
                '</div>' +
                '<p class="st-about-desc">提示词构建工具。</p>' +
              '</div>' +
              '<div class="st-field">' +
                '<span class="st-label">检查更新</span>' +
                '<span class="st-desc">向服务器查询是否有新版本，有新版本时会提示下载并安装。</span>' +
                '<div class="st-update-row">' +
                  '<button type="button" class="st-update-btn" id="stCheckUpdate">' + icon('refresh-cw') + '<span>检查更新</span></button>' +
                '</div>' +
              '</div>' +
            '</section>' +
          '</div>' +
        '</div>' +
        '<div class="st-foot-hint">改动会立即保存并同步到浮窗。</div>' +
      '</div>';
    document.body.appendChild($stOverlay);
    $stRecorderBox = $stOverlay.querySelector('#stRecorderBox');
    $stDelayInput = $stOverlay.querySelector('#stDelayInput');
    bindTranslateSettings();
    bindSettingsTabs();
    loadAboutVersion();

    $stOverlay.addEventListener('mousedown', function (e) {
      if (e.target === $stOverlay) closeSettingsPanel();
    });
    $stOverlay.querySelector('.sm-close').addEventListener('click', closeSettingsPanel);

    $stRecorderBox.addEventListener('click', startRecordingShortcut);
    $stRecorderBox.addEventListener('keydown', function (e) {
      // 空格/回车 激活录制态；录制态本身的按键在 startRecordingShortcut 里单独监听
      if (!isRecordingShortcut && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        startRecordingShortcut();
      }
    });

    $stOverlay.querySelector('#stRecorderReset').addEventListener('click', function () {
      applyToggleShortcut('Ctrl+Alt+C');
    });

    $stDelayInput.addEventListener('change', function () {
      var v = parseInt($stDelayInput.value, 10);
      if (!isFinite(v)) v = 60;
      v = Math.min(500, Math.max(30, v));
      $stDelayInput.value = v;
      state.settings.pasteDelayMs = v;
      scheduleSave();
      showToast('粘贴等待时长已更新为 ' + v + ' 毫秒');
    });

    var $stCheckUpdate = $stOverlay.querySelector('#stCheckUpdate');
    if ($stCheckUpdate) {
      if (updaterApi) {
        $stCheckUpdate.addEventListener('click', function () { checkForUpdate(true); });
      } else {
        $stCheckUpdate.disabled = true;
        $stCheckUpdate.title = '当前环境不支持自动更新（仅桌面应用可用）';
      }
    }
  }

  /* ---------- 设置分类 tab 切换 ---------- */
  function bindSettingsTabs() {
    var navItems = $stOverlay.querySelectorAll('.st-nav-item');
    var pages = $stOverlay.querySelectorAll('.st-tab-page');
    navItems.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        navItems.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        pages.forEach(function (p) {
          p.classList.toggle('is-active', p.getAttribute('data-tab') === tab);
        });
      });
    });
  }

  /* ---------- 关于页版本号（Tauri 环境才能拿到，浏览器降级为占位） ---------- */
  function loadAboutVersion() {
    var el = $stOverlay && $stOverlay.querySelector('#stAboutVer');
    if (!el) return;
    var appApi = window.__TAURI__ && window.__TAURI__.app;
    if (!appApi || typeof appApi.getVersion !== 'function') {
      el.textContent = '开发预览';
      return;
    }
    appApi.getVersion().then(function (v) {
      el.textContent = 'v' + v;
    }).catch(function () {
      el.textContent = '—';
    });
  }

  function renderSettingsPanel() {
    if (!$stOverlay || isRecordingShortcut) return;
    $stRecorderBox.textContent = state.settings.toggleShortcut;
    $stDelayInput.value = state.settings.pasteDelayMs;
    renderTranslateSettings();
  }

  /* ---------- 翻译设置：绑定 + 渲染 + 保存 ---------- */
  var $trProvider = null, $trKey = null, $trModel = null, $trBase = null, $trOverwrite = null;

  function bindTranslateSettings() {
    $trProvider = $stOverlay.querySelector('#stTrProvider');
    $trKey = $stOverlay.querySelector('#stTrKey');
    $trModel = $stOverlay.querySelector('#stTrModel');
    $trBase = $stOverlay.querySelector('#stTrBase');
    $trOverwrite = $stOverlay.querySelector('#stTrOverwrite');

    // 选预设：自动填入该预设的 protocol / baseUrl / model（key 与 overwrite 保留用户已填）。
    // 选“自定义”时不覆盖用户已填的 baseUrl/model，只切 protocol 为 openai。
    $trProvider.addEventListener('change', function () {
      var id = $trProvider.value;
      var preset = TRANSLATE_PROVIDER_BY_ID[id];
      var tr = state.settings.translation;
      tr.provider = id;
      if (preset) {
        tr.protocol = preset.protocol;
        if (id !== 'custom') {
          tr.baseUrl = preset.baseUrl;
          tr.model = preset.model;
        }
      }
      saveTranslateSettings();
      renderTranslateSettings();
    });

    $trKey.addEventListener('change', function () {
      state.settings.translation.apiKey = $trKey.value.trim();
      saveTranslateSettings();
    });
    $trModel.addEventListener('change', function () {
      state.settings.translation.model = $trModel.value.trim();
      saveTranslateSettings();
    });
    $trBase.addEventListener('change', function () {
      state.settings.translation.baseUrl = $trBase.value.trim();
      saveTranslateSettings();
    });
    $trOverwrite.addEventListener('change', function () {
      state.settings.translation.overwrite = $trOverwrite.checked;
      saveTranslateSettings();
    });
  }

  function renderTranslateSettings() {
    if (!$trProvider) return;
    var tr = state.settings.translation || normalizeTranslateSettings(null);
    $trProvider.value = TRANSLATE_PROVIDER_BY_ID[tr.provider] ? tr.provider : 'custom';
    $trKey.value = tr.apiKey || '';
    $trModel.value = tr.model || '';
    $trBase.value = tr.baseUrl || '';
    $trOverwrite.checked = tr.overwrite !== false;
  }

  // 归一化后保存，防止脏值进持久化文件；不打断 UI（防抖保存 + 同步浮窗）。
  function saveTranslateSettings() {
    state.settings.translation = normalizeTranslateSettings(state.settings.translation);
    scheduleSave();
    updateTranslateDir();
  }

  function startRecordingShortcut() {
    if (isRecordingShortcut) return;
    isRecordingShortcut = true;
    var previous = state.settings.toggleShortcut;
    $stRecorderBox.classList.add('recording');
    $stRecorderBox.textContent = '请按下快捷键…';

    function finish(newAccelerator) {
      isRecordingShortcut = false;
      $stRecorderBox.classList.remove('recording');
      document.removeEventListener('keydown', onKeydown, true);
      if (newAccelerator) {
        applyToggleShortcut(newAccelerator);
      } else {
        $stRecorderBox.textContent = previous;
      }
    }

    function onKeydown(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { finish(null); return; }
      var accelerator = formatAccelerator(e);
      if (!accelerator) {
        // 无效组合（缺修饰键或缺主键）：提示但保持录制态，让用户重试
        $stRecorderBox.textContent = '无效组合，请至少按 1 个修饰键 + 1 个主键';
        return;
      }
      finish(accelerator);
    }

    document.addEventListener('keydown', onKeydown, true);
  }

  // 应用新快捷键：先本地更新 + 保存 + 广播（前端体验立即生效），
  // 再调用 Rust 命令真正切换全局注册；失败则把显示值回滚为旧值并提示原因。
  function applyToggleShortcut(accelerator) {
    var previous = state.settings.toggleShortcut;
    state.settings.toggleShortcut = accelerator;
    if ($stRecorderBox) $stRecorderBox.textContent = accelerator;
    scheduleSave();

    if (!coreApi || !coreApi.invoke) {
      showToast('当前环境不支持设置全局快捷键（仅桌面应用可用）', true);
      return;
    }
    coreApi.invoke('set_toggle_shortcut', { accelerator: accelerator }).then(function () {
      showToast('快捷键已更新为 ' + accelerator);
    }).catch(function (err) {
      var reason = formatInvokeError(err);
      showToast('快捷键设置失败：' + reason, true);
      // 回滚：注册失败时 Rust 侧会把旧热键重新注册回来（仍可用），
      // 这里只需把前端显示与持久化的值同步回旧值，保持一致。
      state.settings.toggleShortcut = previous;
      if ($stRecorderBox && !isRecordingShortcut) $stRecorderBox.textContent = previous;
      scheduleSave();
    });
  }

  // 启动时把持久化的自定义热键应用到 Rust 侧。只有主窗口做这件事。
  function applyStartupShortcut() {
    if (!coreApi || !coreApi.invoke) return;
    coreApi.invoke('set_toggle_shortcut', { accelerator: state.settings.toggleShortcut }).catch(function (err) {
      var reason = formatInvokeError(err);
      console.warn('启动时应用自定义快捷键失败：', reason);
    });
  }

  function openSettingsPanel() {
    ensureSettingsPanel();
    renderSettingsPanel();
    $stOverlay.classList.add('show');
    stKeyHandler = function (e) { if (e.key === 'Escape' && !isRecordingShortcut) closeSettingsPanel(); };
    document.addEventListener('keydown', stKeyHandler);
    $stRecorderBox.focus();
  }

  function closeSettingsPanel() {
    if (!$stOverlay) return;
    if (isRecordingShortcut) return; // 录制中先不关闭，避免误触丢失操作
    $stOverlay.classList.remove('show');
    if (stKeyHandler) { document.removeEventListener('keydown', stKeyHandler); stKeyHandler = null; }
  }

  var $btnEditorSettings = document.getElementById('btnEditorSettings');
  if ($btnEditorSettings) $btnEditorSettings.addEventListener('click', openSettingsPanel);

  /* ============================================================
   * 12.1 浮窗 toggle：显示/隐藏 label 为 'float' 的窗口
   * ------------------------------------------------------------
   * 按钮做成 toggle，视觉需与浮窗真实可见性保持一致。浮窗可被三处
   * 切换：本按钮、全局快捷键（Rust 侧 show/hide）、浮窗自身关闭键。
   * 因此不能只靠本按钮的乐观状态，需要在下列时机回查真实可见性：
   *   - 点击切换后
   *   - 主窗口重新获得焦点时（覆盖快捷键切换 / 浮窗自关后用户切回主窗）
   *   - 浮窗关闭键广播 'composer-float-visibility' 时（无需切焦点即时更新）
   * ============================================================ */
  var $btnFloatWindow = document.getElementById('btnFloatWindow');

  function setFloatActive(active) {
    if (!$btnFloatWindow) return;
    $btnFloatWindow.setAttribute('aria-pressed', active ? 'true' : 'false');
    var text = $btnFloatWindow.querySelector('.float-toggle-text');
    if (text) text.textContent = active ? '退出浮窗' : '浮窗';
    var label = active ? '退出浮窗，恢复主窗口' : '进入浮窗模式';
    $btnFloatWindow.setAttribute('title', label);
    $btnFloatWindow.setAttribute('aria-label', label);
  }

  function getFloatWindow() {
    if (!(webviewWindowApi && webviewWindowApi.WebviewWindow)) return Promise.resolve(null);
    var floatWin = webviewWindowApi.WebviewWindow.getByLabel
      ? webviewWindowApi.WebviewWindow.getByLabel('float')
      : null;
    return floatWin && typeof floatWin.then === 'function' ? floatWin : Promise.resolve(floatWin);
  }

  function syncFloatState() {
    getFloatWindow().then(function (win) {
      if (!win) return;
      win.isVisible().then(function (visible) { setFloatActive(!!visible); }).catch(function () {});
    }).catch(function () {});
  }

  if ($btnFloatWindow) {
    if (webviewWindowApi && webviewWindowApi.WebviewWindow) {
      $btnFloatWindow.addEventListener('click', function () {
        getFloatWindow().then(function (win) {
          if (!win) { showToast('未找到浮窗，请重启应用', true); return; }
          win.isVisible().then(function (visible) {
            if (visible) {
              win.hide().then(function () { setFloatActive(false); }).catch(function () {});
            } else {
              win.show().then(function () { win.setFocus(); setFloatActive(true); }).catch(function () {});
            }
          }).catch(function () { win.show().then(function () { setFloatActive(true); }).catch(function () {}); });
        }).catch(function () { showToast('浮窗不可用', true); });
      });

      // 主窗口重新获得焦点时回查（覆盖快捷键切换、浮窗自关后切回主窗）
      window.addEventListener('focus', syncFloatState);
      // 浮窗关闭键广播，即时收起激活态
      if (eventApi && eventApi.listen) {
        eventApi.listen('composer-float-visibility', function (evt) {
          if (evt && evt.payload && typeof evt.payload.visible === 'boolean') {
            setFloatActive(evt.payload.visible);
          } else {
            syncFloatState();
          }
        }).catch(function () {});
      }
      // 初始对齐一次
      syncFloatState();
    } else {
      // 非 Tauri 环境（浏览器预览）：无浮窗窗口可控制，禁用按钮
      $btnFloatWindow.disabled = true;
      $btnFloatWindow.setAttribute('title', '浮窗（仅桌面应用可用）');
      $btnFloatWindow.setAttribute('aria-label', '浮窗（仅桌面应用可用）');
    }
  }

  var $themeToggle = document.getElementById('themeToggle');
  $themeToggle.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    try { localStorage.setItem('composer-theme', dark ? 'light' : 'dark'); } catch (e) {}
  });

  $btnClearAll.addEventListener('click', function () {
    if (!(state.content[state.lang] || '').trim()) { showToast('当前语言正文已经是空的'); return; }
    captureHistory(); // 结构操作（清空正文）：改动前存旧快照
    state.content[state.lang] = '';
    if (view === 'preview') setView('write');
    renderAll();
    scheduleSave();
    showToast('已清空' + (state.lang === 'zh' ? '中文' : 'English') + '正文');
  });

  /* ============================================================
   * 10.1 结构级 Undo / Redo
   * ------------------------------------------------------------
   * 撤销：当前 content 推入 redo 栈，弹出上一个快照恢复；重做对称。
   * 恢复后走 renderAll 完整重渲染（含块视图 / 预览 / token 统计），
   * 不另写渲染路径。栈空时给一个轻 toast 提示，不阻断。
   * ============================================================ */
  function doUndo() {
    if (view !== 'preview') collectText(); // 恢复前把 DOM 里未收回的编辑并入当前 content
    var snapshot = history.undo(state.content[state.lang] || '');
    if (snapshot === null) { showToast('没有可撤销的操作'); return; }
    applyContentSnapshot(snapshot, renderAll);
  }
  function doRedo() {
    if (view !== 'preview') collectText();
    var snapshot = history.redo(state.content[state.lang] || '');
    if (snapshot === null) { showToast('没有可重做的操作'); return; }
    applyContentSnapshot(snapshot, renderAll);
  }

  /* ============================================================
   * 11. 快捷键
   * ============================================================ */
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var key = e.key.toLowerCase();
    // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z：结构级撤销/重做。
    // 边界（约束第 1、7 条）：焦点在块内 textarea 时，Ctrl+Z 交给浏览器
    // 做原生的块内逐字撤销，不被全局处理抢走。Ctrl+Y / Ctrl+Shift+Z（重做）
    // 浏览器对 textarea 也有原生行为，同样让位。判断依据：activeElement 是
    // 块内 .block-textarea。其它输入框（管理浮窗里的 INPUT/TEXTAREA）里同理
    // 让位原生撤销，不触发结构级历史。
    if (key === 'z' || key === 'y') {
      var ae = document.activeElement;
      var inEditable = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable === true);
      if (inEditable) return; // 让位浏览器原生撤销/重做（块内逐字编辑）
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); doRedo(); return; }
    }
    if (key === 'l') { e.preventDefault(); toggleLang(); }
    else if (key === 's') { e.preventDefault(); doDownload(); }
    else if (key === 'p') { e.preventDefault(); toggleView(); }
    else if (key === 'c') {
      var sel = window.getSelection && window.getSelection().toString();
      var tag = document.activeElement && document.activeElement.tagName;
      var inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if (!sel && !inField) { e.preventDefault(); doCopy(); }
    }
  });

  /* ============================================================
   * 12. 检查更新
   * ============================================================ */
  var checkingUpdate = false;
  function checkForUpdate(manual) {
    if (!updaterApi) { if (manual) showToast('当前环境不支持自动更新'); return; }
    if (checkingUpdate) return;
    checkingUpdate = true;
    updaterApi.check().then(function (update) {
      checkingUpdate = false;
      if (!update) { if (manual) showToast('已是最新版本'); return; }
      var ok = window.confirm('发现新版本 ' + update.version + '，是否立即下载并安装？\n\n' + (update.body || ''));
      if (!ok) return;
      showToast('正在下载更新…');
      update.downloadAndInstall().then(function () {
        showToast('更新完成，即将重启');
        if (processApi) processApi.relaunch();
      }).catch(function (err) {
        showToast('更新安装失败：' + (err && err.message ? err.message : err), true);
      });
    }).catch(function (err) {
      checkingUpdate = false;
      if (manual) showToast('检查更新失败：' + (err && err.message ? err.message : err), true);
    });
  }

  /* ============================================================
   * 13. 汇总渲染
   * ============================================================ */
  function renderAll() {
    renderLangSeg();
    renderViewSeg();
    renderInsertGrid();
    renderSnippets();
    renderQuick();
    renderEditor();
    if ($smOverlay && $smOverlay.classList.contains('show')) renderSnippetManager();
    if ($qmOverlay && $qmOverlay.classList.contains('show')) renderQuickManager();
    if ($stOverlay && $stOverlay.classList.contains('show')) renderSettingsPanel();
  }

  restoreState();
  setTimeout(function () { checkForUpdate(false); }, 3000);

  export {
    setLang, toggleLang, renderLangSeg,
    setView, toggleView, renderViewSeg,
    doCopy, fallbackCopy, doDownload,
    formatInvokeError, codeToMainKey, formatAccelerator,
    ensureSettingsPanel, renderSettingsPanel, startRecordingShortcut,
    applyToggleShortcut, applyStartupShortcut, openSettingsPanel, closeSettingsPanel,
    checkForUpdate, renderAll,
    doUndo, doRedo,
    $stOverlay,
  };
