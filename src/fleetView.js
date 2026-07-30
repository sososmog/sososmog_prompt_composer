/* ============================================================
 * fleetView.js —— 浮窗 Agent tab 的 DOM 层 + 轮询调度
 * ------------------------------------------------------------
 * 判定逻辑一行都不在这里写，全部来自 fleet.js（groupSessions /
 * lastActivityMs / countNeedsInput / formatAgo / formatTokens /
 * formatCpu / validateReport / STATUS_DEFS）。这个文件只管三件事：
 *   1. 把 FleetReport 画成分组+卡片（渲染）
 *   2. 决定多久问 Rust 一次、问的时候带不带 cpu（轮询调度）
 *   3. 失败了怎么办、用户正在交互时怎么不打断（容错 + 守卫）
 *
 * 依赖全部从 createFleetView() 的参数注入（invoke / getVisibility /
 * onError），没有一行摸 window.__TAURI__ 或 document.visibilityState——
 * 这样 jsdom 测试直接传假函数就行，不需要 stub 任何全局对象（对应
 * reference-vitest-global-stub-leak 那个坑：整体替换全局极容易在某个
 * 用例中途崩掉后连坏后面几十个用例）。
 *
 * isActiveTab / isMini 这两个"我现在该用哪档轮询间隔"的信号，反过来
 * 走的是 DOM 读取（root 自己的 .is-active、以及 root 所在 .fw-card 的
 * .is-mini），不是额外的注入参数——这两个 class 已经是 float.js 切
 * tab / 缩放小球时**必须**维护的真实视觉状态（截图会说谎的东西不会通过
 * class 说谎），复用它俩比另开一套"通知 fleetView 当前档位"的状态
 * 同步机制更不容易长歪。float.js 只需要在这些 class 变化的时刻调一次
 * 返回的 refreshSchedule()，让定时器立刻按新档位重排；即使某处忘了调，
 * 下一次自然 tick 也会读到最新的 class 自愈，不会永久卡在错误档位。
 * ============================================================ */
import {
  STATUS_DEFS,
  groupSessions,
  lastActivityMs,
  countNeedsInput,
  formatAgo,
  formatTokens,
  formatCpu,
  validateReport,
} from './fleet.js';

/** 可见 && 非小球 && 停在 Agent tab：全量轮询间隔。 */
const FAST_MS = 2000;
/** 可见 && (小球 || 停在编写 tab)：精简轮询间隔，也是"不可见"时的低频复检间隔。 */
const SLOW_MS = 8000;
/** 连续失败退避阶梯，2s→4s→8s→16s→30s 封顶。 */
const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 30000];

const TAB_ACTIVE_CLASS = 'is-active';
const CARD_MINI_CLASS = 'is-mini';
const COMMAND = 'list_agent_sessions';

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && err.message) return String(err.message);
  try {
    return String(err);
  } catch (e) {
    return '未知错误';
  }
}

/**
 * @param {import('./fleet.js').AgentSession} session
 * @returns {string}
 */
function cardTitle(session) {
  const t = session.transcript;
  if (t && t.aiTitle) return t.aiTitle;
  if (t && t.lastPrompt) return t.lastPrompt;
  return '（无标题）';
}

/**
 * 装配浮窗的 Agent tab：渲染 + 轮询。
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.root        面板容器（#fwPanelFleet），本模块独占其内容
 * @param {HTMLElement} [opts.tabButton] Agent tab 按钮，用于回填角标数量的 title 提示
 * @param {HTMLElement} [opts.badge]     tab 按钮里的角标元素，数量为 0 时隐藏
 * @param {(cmd: string, args?: object) => Promise<unknown>} [opts.invoke]
 *        Tauri 的 core.invoke。非 Tauri 环境传 null/undefined，本模块会渲染降级文案
 *        并且完全不启动轮询——playwright 冒烟跑在浏览器里，这一步不能报错。
 * @param {() => boolean} opts.getVisibility  当前浮窗是否可见（由调用方综合
 *        document.visibilityState 判断；本模块只在每次 tick 时读一下这个值）
 * @param {(err: unknown) => void} [opts.onError]  每次抓取失败时的旁路通知（比如
 *        float.js 想 console.warn 一下），与面板里显示的错误横条互不影响
 * @returns {{ refreshSchedule: () => void, stop: () => void }}
 */
export function createFleetView({ root, tabButton, badge, invoke, getVisibility, onError }) {
  let errorBannerEl = null;
  let contentEl = null;
  let warningsOpen = false; // 警告折叠区展开状态，重渲染后要保持（同 openQuickGroupId 的做法）

  function ensureSkeleton() {
    if (contentEl && errorBannerEl) return;
    root.innerHTML = '';
    errorBannerEl = document.createElement('div');
    errorBannerEl.className = 'fw-fleet-error';
    errorBannerEl.hidden = true;
    contentEl = document.createElement('div');
    contentEl.className = 'fw-fleet-content';
    root.appendChild(errorBannerEl);
    root.appendChild(contentEl);
  }

  function showErrorBanner(message) {
    errorBannerEl.hidden = false;
    errorBannerEl.textContent = message;
  }
  function hideErrorBanner() {
    errorBannerEl.hidden = true;
    errorBannerEl.textContent = '';
  }

  function renderDegraded() {
    ensureSkeleton();
    contentEl.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'fw-fleet-empty';
    el.textContent = '此功能需要桌面端';
    contentEl.appendChild(el);
  }

  function renderInitialLoading() {
    contentEl.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'fw-fleet-empty';
    el.textContent = '扫描中…';
    contentEl.appendChild(el);
  }

  function renderSchemaError(detail) {
    hideErrorBanner(); // 已经是终态提示，不需要瞬时错误条一起挂着
    contentEl.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'fw-fleet-empty fw-fleet-schema-error';
    el.textContent = '版本不一致，请重启应用';
    el.title = detail;
    contentEl.appendChild(el);
  }

  /** @param {import('./fleet.js').AgentSession} session @param {object} def @param {number} scannedAt */
  function buildCard(session, def, scannedAt) {
    const card = document.createElement('div');
    card.className = 'fw-fleet-card tone-' + def.tone;
    card.dataset.sessionId = session.sessionId;

    const head = document.createElement('div');
    head.className = 'fw-fleet-card-head';

    const glyph = document.createElement('span');
    glyph.className = 'fw-fleet-glyph' + (def.animated ? ' is-animated' : '');
    glyph.textContent = def.glyph;
    head.appendChild(glyph);

    const name = document.createElement('span');
    name.className = 'fw-fleet-name';
    name.textContent = session.name;
    name.title = session.name;
    head.appendChild(name);

    const model = document.createElement('span');
    model.className = 'fw-fleet-model';
    const modelText = (session.transcript && session.transcript.model) || '';
    model.textContent = modelText;
    head.appendChild(model);

    card.appendChild(head);

    const titleLine = document.createElement('div');
    titleLine.className = 'fw-fleet-title-line';
    const titleText = cardTitle(session);
    titleLine.textContent = titleText;
    titleLine.title = titleText;
    card.appendChild(titleLine);

    const branch = session.transcript && session.transcript.gitBranch;
    if (branch) {
      const branchLine = document.createElement('div');
      branchLine.className = 'fw-fleet-branch';
      branchLine.textContent = '⎇ ' + branch;
      branchLine.title = branch;
      card.appendChild(branchLine);
    }

    const meta = document.createElement('div');
    meta.className = 'fw-fleet-meta';
    const ago = formatAgo(scannedAt - lastActivityMs(session));
    const cpu = formatCpu(session.proc ? session.proc.cpuPercent : null);
    const tokens = formatTokens(session.transcript ? session.transcript.contextTokens : null);
    meta.textContent = def.label + ' · ' + ago + ' · CPU ' + cpu + ' · ' + tokens + ' tokens';
    card.appendChild(meta);

    return card;
  }

  /** @param {import('./fleet.js').FleetWarning[]} warnings */
  function buildWarnings(warnings) {
    const details = document.createElement('details');
    details.className = 'fw-fleet-warnings';
    if (warningsOpen) details.open = true;
    details.addEventListener('toggle', function () {
      warningsOpen = details.open;
    });
    const summary = document.createElement('summary');
    summary.textContent = '警告（' + warnings.length + '）';
    details.appendChild(summary);
    const list = document.createElement('ul');
    list.className = 'fw-fleet-warnings-list';
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = w.detail;
      li.title = w.code + '：' + w.detail;
      list.appendChild(li);
    }
    details.appendChild(list);
    return details;
  }

  function updateBadge(sessions, scannedAt) {
    const n = countNeedsInput(sessions, scannedAt);
    if (badge) {
      if (n > 0) {
        badge.textContent = String(n);
        badge.hidden = false;
      } else {
        badge.textContent = '';
        badge.hidden = true;
      }
    }
    if (tabButton) {
      tabButton.title = n > 0 ? n + ' 个会话等你回话' : 'Agent';
    }
  }

  /** @param {import('./fleet.js').FleetReport} report */
  function applyReport(report) {
    updateBadge(report.sessions, report.scannedAt);
    hideErrorBanner();

    // C4 附：交互中不打断——面板里有焦点元素时，本次跳过内容重建，
    // 数据已经拿到了，下一 tick 自然会再画一次。
    if (root.contains(document.activeElement)) return;

    const prevList = contentEl.querySelector('.fw-fleet-list');
    const savedScrollTop = prevList ? prevList.scrollTop : 0;

    contentEl.innerHTML = '';
    const groups = groupSessions(report.sessions, report.scannedAt);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fw-fleet-empty';
      empty.textContent = '没有正在运行的 agent';
      contentEl.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'fw-fleet-list';
      for (const group of groups) {
        const def = STATUS_DEFS[group.key];
        const h = document.createElement('div');
        h.className = 'fw-fleet-group-title';
        const label = document.createElement('span');
        label.textContent = group.label;
        const count = document.createElement('span');
        count.className = 'fw-fleet-group-count';
        count.textContent = String(group.items.length);
        h.appendChild(label);
        h.appendChild(count);
        list.appendChild(h);
        for (const session of group.items) {
          list.appendChild(buildCard(session, def, report.scannedAt));
        }
      }
      contentEl.appendChild(list);
      list.scrollTop = savedScrollTop;
    }

    if (report.warnings && report.warnings.length > 0) {
      contentEl.appendChild(buildWarnings(report.warnings));
    }
  }

  ensureSkeleton();

  // 非 Tauri 环境（浏览器预览 / playwright）：只显示降级文案，完全不建定时器。
  // 这是 C6 的硬要求——冒烟测试跑在真浏览器里，这里绝不能因为拿不到
  // invoke 而抛错，否则整个 float.html 都起不来。
  if (!invoke) {
    renderDegraded();
    return { refreshSchedule: function () {}, stop: function () {} };
  }

  renderInitialLoading();

  let timer = null;
  let inFlight = false;
  let failCount = 0;
  let stopped = false;

  function isActiveTab() {
    return root.classList.contains(TAB_ACTIVE_CLASS);
  }
  function isMini() {
    const card = root.closest('.fw-card');
    return !!(card && card.classList.contains(CARD_MINI_CLASS));
  }
  function fastTier() {
    return isActiveTab() && !isMini();
  }
  function currentTierMs() {
    return fastTier() ? FAST_MS : SLOW_MS;
  }
  /** 精简档不传 cpu:true 的默认值，让 Rust 侧跳过 sysinfo 刷新，只喂角标需要的字段。 */
  function currentOpts() {
    return fastTier() ? undefined : { cpu: false };
  }

  function scheduleNext(delayMs) {
    clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  }

  function backoffDelay() {
    const idx = Math.min(failCount - 1, BACKOFF_STEPS_MS.length - 1);
    return BACKOFF_STEPS_MS[idx];
  }

  function handleFailure(err) {
    failCount += 1;
    if (onError) {
      try {
        onError(err);
      } catch (e) {
        /* 旁路通知本身出错不能拖垮轮询 */
      }
    }
    showErrorBanner('获取 agent 列表失败，' + Math.round(backoffDelay() / 1000) + ' 秒后重试（' + describeError(err) + '）');
    scheduleNext(backoffDelay());
  }

  function tick() {
    if (stopped) return;

    if (!getVisibility()) {
      // 不可见：暂停抓取，但仍要留一个低频的自检时钟，否则浮窗重新可见时
      // 没有任何东西会把轮询叫醒。这里的"暂停"指的是不发 invoke，不是
      // 真的清空所有定时器。
      scheduleNext(SLOW_MS);
      return;
    }

    if (inFlight) {
      // 单飞：上一次还没回来，这次直接跳过，按当前档位再等一轮。
      scheduleNext(currentTierMs());
      return;
    }

    inFlight = true;
    // 先把下一次检查排上——请求本身耗时不确定，若超过一个间隔，下一次
    // tick 会自己在 inFlight 分支里跳过，不会导致重复发请求（这就是
    // "自链 setTimeout + 单飞标记"合起来才成立的地方：这里只管排期，
    // 真正防重复发请求靠上面的 inFlight 判断）。
    scheduleNext(currentTierMs());

    const opts = currentOpts();
    const p = opts === undefined ? invoke(COMMAND) : invoke(COMMAND, { opts: opts });

    p.then(function (raw) {
      inFlight = false;
      const result = validateReport(raw);
      if (!result.ok) {
        if (result.reason === 'schema-mismatch') {
          stopped = true;
          clearTimeout(timer);
          renderSchemaError(result.detail);
          return;
        }
        handleFailure(new Error(result.detail));
        return;
      }
      failCount = 0;
      applyReport(result.report);
    }).catch(function (err) {
      inFlight = false;
      handleFailure(err);
    });
  }

  scheduleNext(0); // 立即做第一次抓取，不必等满一个间隔才有数据

  return {
    /**
     * float.js 在任何可能影响轮询档位的状态变化后调用（tab 切换 / 缩成
     * 小球 / 恢复），让定时器立刻按新档位重排，而不是等旧间隔走完才生效。
     * 请求进行中或已停止时什么都不做——前者怕打断单飞判断，后者是终态。
     */
    refreshSchedule: function () {
      if (stopped || inFlight) return;
      scheduleNext(currentTierMs());
    },
    /** 停止轮询（目前只用于测试收尾，避免 fake timer 泄漏到下一个用例）。 */
    stop: function () {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
