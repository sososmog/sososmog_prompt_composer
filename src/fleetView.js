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
  TONE_PRIORITY,
  ORB_DOT_MIN_PRIORITY,
  groupSessions,
  lastActivityMs,
  countNeedsInput,
  reduceFleetTone,
  formatAgo,
  formatTokens,
  formatCpu,
  validateReport,
  buildSubagentTree,
  deriveSubagentStatus,
} from './fleet.js';

/** 可见 && 非小球 && 停在 Agent tab：全量轮询间隔。 */
const FAST_MS = 2000;
/** 可见 && (小球 || 停在编写 tab)：精简轮询间隔，也是"不可见"时的低频复检间隔。 */
const SLOW_MS = 8000;
/** 连续失败退避阶梯，2s→4s→8s→16s→30s 封顶。 */
const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 30000];
/** 子 agent 树渲染深度上限。380px 宽的卡片到第 4 层缩进已经没地方放文字了，
 * 更深的节点折叠成一行「更深层 N 个」而不是硬挤出来看不清。 */
const MAX_SUBAGENT_DEPTH = 3;

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
  // 后台会话可能一条 transcript 都没有，但它有 intent（起这个任务时的原始
  // prompt）——那回答的正是标题该回答的问题："这是在干什么"。
  if (session.job && session.job.intent) return session.job.intent;
  return '（无标题）';
}

/**
 * 子 agent 的展示文案：description 是官方现成的"在干什么"，最有信息量；
 * 缺失时退一步用 agentType（至少知道是什么角色的 agent）；两者都没有
 * 才落到 agentId 前 8 位（本来就是给人看的兜底，不追求可读）。
 * @param {import('./fleet.js').SubagentDigest} sub
 * @returns {string}
 */
function subagentLabel(sub) {
  if (sub.description) return sub.description;
  if (sub.agentType) return sub.agentType;
  return sub.agentId.slice(0, 8);
}

/**
 * 文件夹图标（feather 风格，与 float.html 里那几个内联 SVG 同一套笔画参数）。
 * 用 createElementNS 而不是 innerHTML 拼字符串：这个文件其余部分全是
 * createElement 建节点，没必要为一个图标开 innerHTML 的头。
 * @returns {SVGElement}
 */
function folderIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  svg.appendChild(path);
  return svg;
}

/**
 * 数一棵子树里"更深层"折叠起来的节点总数（不只是直接子节点，是全部
 * 后代）——用户想知道的是"这一支底下到底还有多少东西"，不是"这一层
 * 有几个直接孩子"。
 * @param {import('./fleet.js').SubagentTreeNode} node
 * @returns {number}
 */
function countSubagentDescendants(node) {
  let n = 0;
  for (const child of node.children) {
    n += 1 + countSubagentDescendants(child);
  }
  return n;
}

/**
 * @param {import('./fleet.js').SubagentTreeNode} node
 * @param {number} scannedAt
 * @param {boolean} isOrphanRoot  是否要挂「（父级缺失）」标记——只标在
 *        orphans 数组里那个节点本身，它下面正常挂着的子节点不重复标。
 * @returns {HTMLElement}
 */
function buildSubagentRow(node, scannedAt, isOrphanRoot) {
  const status = deriveSubagentStatus(node, scannedAt);
  const row = document.createElement('div');
  row.className = 'fw-fleet-sub-row';
  row.style.paddingLeft = (node.depth - 1) * 12 + 'px';

  const glyph = document.createElement('span');
  glyph.className = 'fw-fleet-sub-glyph tone-' + status.tone + (status.animated ? ' is-animated' : '');
  glyph.textContent = status.glyph;
  row.appendChild(glyph);

  const label = document.createElement('span');
  label.className = 'fw-fleet-sub-label';
  const text = subagentLabel(node);
  label.textContent = text;
  label.title = text;
  row.appendChild(label);

  if (isOrphanRoot) {
    const flag = document.createElement('span');
    flag.className = 'fw-fleet-sub-orphan';
    flag.textContent = '（父级缺失）';
    row.appendChild(flag);
  }

  const meta = document.createElement('span');
  meta.className = 'fw-fleet-sub-row-meta';
  // mtimeMs / lastMsgTsMs 都缺失时不能把 NaN 传给 formatAgo——它只对
  // "已经算出的毫秒差"负责，不负责判断输入合不合法。
  const base = node.mtimeMs ?? node.lastMsgTsMs;
  const ago = base == null ? '—' : formatAgo(scannedAt - base);
  meta.textContent = formatTokens(node.contextTokens) + ' · ' + ago;
  row.appendChild(meta);

  return row;
}

/**
 * @param {import('./fleet.js').SubagentTreeNode} node  折叠点本身（depth 已达上限的那个节点）
 * @param {number} count
 * @returns {HTMLElement}
 */
function buildSubagentMoreRow(node, count) {
  const row = document.createElement('div');
  row.className = 'fw-fleet-sub-row fw-fleet-sub-more';
  row.style.paddingLeft = node.depth * 12 + 'px';
  row.textContent = '更深层 ' + count + ' 个';
  return row;
}

/**
 * 递归把一棵子树铺成一串 DOM 行，超过深度上限的部分折叠成一行摘要。
 * @param {HTMLElement} container
 * @param {import('./fleet.js').SubagentTreeNode} node
 * @param {number} scannedAt
 * @param {boolean} isOrphanRoot
 */
function appendSubagentNode(container, node, scannedAt, isOrphanRoot) {
  container.appendChild(buildSubagentRow(node, scannedAt, isOrphanRoot));
  if (node.depth >= MAX_SUBAGENT_DEPTH) {
    if (node.children.length > 0) {
      container.appendChild(buildSubagentMoreRow(node, countSubagentDescendants(node)));
    }
    return;
  }
  for (const child of node.children) {
    appendSubagentNode(container, child, scannedAt, false);
  }
}

/**
 * 有几个子 agent 正在 working——给 §3.5 的独立指示用。主会话状态该是
 * 什么就是什么（比如 needs-input），这里只是补一条"顺带告诉你后台还有
 * 东西在动"的事实，不参与状态判定本身。
 * @param {import('./fleet.js').SubagentDigest[]} subagents
 * @param {number} scannedAt
 * @returns {number}
 */
function countWorkingSubagents(subagents, scannedAt) {
  let n = 0;
  for (const sub of subagents) {
    if (deriveSubagentStatus(sub, scannedAt).code === 'working') n += 1;
  }
  return n;
}

/**
 * 装配浮窗的 Agent tab：渲染 + 轮询。
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.root        面板容器（#fwPanelFleet），本模块独占其内容
 * @param {HTMLElement} [opts.tabButton] Agent tab 按钮，用于回填角标数量的 title 提示
 * @param {HTMLElement} [opts.badge]     tab 按钮里的角标元素，数量为 0 时隐藏
 * @param {HTMLElement} [opts.orbDot]    悬浮小球上的状态点（#fwMiniOrbDot），缩成
 *        小球后唯一还能表达"有事发生"的元素。缺省则整个特性静默跳过
 * @param {(cmd: string, args?: object) => Promise<unknown>} [opts.invoke]
 *        Tauri 的 core.invoke。非 Tauri 环境传 null/undefined，本模块会渲染降级文案
 *        并且完全不启动轮询——playwright 冒烟跑在浏览器里，这一步不能报错。
 * @param {() => boolean} opts.getVisibility  当前浮窗是否可见（由调用方综合
 *        document.visibilityState 判断；本模块只在每次 tick 时读一下这个值）
 * @param {(path: string) => (Promise<unknown>|void)} [opts.openPath]  在系统文件管理器
 *        里打开一个目录（Tauri opener 插件的 openPath）。**这是本模块唯一一个对外
 *        副作用**，此前整个 Agent 面板都是只读的。不传 / 非 Tauri 环境则整个按钮
 *        不渲染，而不是渲染成禁用态——一个永远点不动的按钮只是在占位置。
 *        失败反馈（toast）由注入方负责，本模块只负责调用。
 * @param {(err: unknown) => void} [opts.onError]  每次抓取失败时的旁路通知（比如
 *        float.js 想 console.warn 一下），与面板里显示的错误横条互不影响
 * @param {boolean} [opts.enabled]  settings.fleet.enabled 的初始值，默认 true。
 *        关闭时与"不可见"走同一条早退路径——完全不发 invoke，只留低频自检
 *        定时器，之后由 setEnabled() 实时更新（见返回值说明）。
 * @returns {{ refreshSchedule: () => void, setEnabled: (v: boolean) => void, stop: () => void }}
 */
export function createFleetView({ root, tabButton, badge, orbDot, invoke, openPath, getVisibility, onError, enabled }) {
  let errorBannerEl = null;
  let contentEl = null;
  let warningsOpen = false; // 警告折叠区展开状态，重渲染后要保持（同 openQuickGroupId 的做法）
  let openSubagentSessionId = null; // 当前展开子 agent 树的会话 id，同一时刻只有一个（同 openQuickGroupId 范式）
  let lastReport = null; // 最近一次成功渲染的报告，供子 agent 折叠区点击后立即重渲染用

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
    hideOrbDot(); // 版本对不上 = 数据不可信，小球上继续亮着一个旧状态点是在撒谎
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
    // 后台会话常常没有 transcript，也就没有 model 可显示。那个位置改标"后台"
    // 比留空有用：这类会话的 CPU 是 "—"、没有进程，看到标记才知道那是它本来
    // 的样子，而不是采集失败了。
    model.textContent = modelText || (session.kind === 'background' ? '后台' : '');
    head.appendChild(model);

    const openBtn = buildOpenCwdButton(session);
    if (openBtn) head.appendChild(openBtn);

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

    // 后台会话的核心价值：官方已经算好的一句人话摘要（实测样本"要我顺手提交
    // 这条 fix 吗?"）。它比我们从 transcript 推的任何东西都准，也是"这个任务
    // 到底卡在哪"的直接答案。
    //
    // 这是唯一一处会让卡片变高的追加内容——阶段 3 刻意没给失败卡片单独起行，
    // 就是因为一屏内高度参差难扫视。这里破例，理由是后台会话本来就少，而没有
    // 这一行的话它整张卡片几乎是空的（没有 CPU、常常也没有 transcript）。
    const jobDetail = session.job && session.job.detail;
    if (jobDetail) {
      const detailLine = document.createElement('div');
      detailLine.className = 'fw-fleet-job-detail';
      detailLine.textContent = jobDetail;
      detailLine.title = jobDetail;
      card.appendChild(detailLine);
    }

    const meta = document.createElement('div');
    meta.className = 'fw-fleet-meta';
    const ago = formatAgo(scannedAt - lastActivityMs(session));
    const cpu = formatCpu(session.proc ? session.proc.cpuPercent : null);
    const tokens = formatTokens(session.transcript ? session.transcript.contextTokens : null);
    let metaText = def.label + ' · ' + ago + ' · CPU ' + cpu + ' · ' + tokens + ' tokens';
    // §3.5：主会话状态（def.label）保持它本来该是什么样——哪怕它是
    // "等你回话"、subagent 还在后台跑，也不塌缩成一个状态，只在这里
    // 追加一条独立事实。
    const workingSubs = countWorkingSubagents(session.subagents, scannedAt);
    if (workingSubs > 0) {
      metaText += ' · ' + workingSubs + ' 个子 agent 在跑';
    }
    // 失败会话追加错误码：塞进 meta 行末尾，不单独起一行——失败卡片一旦
    // 比其它卡片高，一屏内高度参差就很难扫视（上一轮实现砍掉它就是为了
    // 这个原因）。apiErrorStatus/apiErrorCode 都可能缺失，两个都没有时
    // （hasApiError 为真但两个字段都是 null）什么都不追加，避免留一个
    // 空的" · "分隔符。
    const t = session.transcript;
    if (t && t.hasApiError) {
      const errParts = [];
      if (t.apiErrorStatus) errParts.push(t.apiErrorStatus);
      if (t.apiErrorCode) errParts.push(t.apiErrorCode);
      if (errParts.length > 0) {
        const errText = errParts.join(' ');
        metaText += ' · ' + errText;
        meta.title = errText; // 错误码可能很长，靠 title 看全文
      }
    }
    meta.textContent = metaText;
    card.appendChild(meta);

    const subSection = buildSubagentSection(session, scannedAt);
    if (subSection) card.appendChild(subSection);

    return card;
  }

  /**
   * E3：卡片头部右侧的"打开工作目录"按钮。
   *
   * 刻意做成一个独立小按钮，而不是让整张卡片可点：打开文件管理器是个对外
   * 副作用，而卡片本身是拿来扫读状态的，误触很烦。
   *
   * @param {import('./fleet.js').AgentSession} session
   * @returns {HTMLElement|null}
   */
  function buildOpenCwdButton(session) {
    if (!openPath || !session.cwd) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fw-fleet-open-cwd';
    btn.title = '在文件管理器中打开 ' + session.cwd;
    btn.setAttribute('aria-label', '打开工作目录');
    btn.appendChild(folderIcon());
    btn.addEventListener('click', function () {
      // ⚠️ 点完必须 blur。按钮留着焦点会让 applyReport 的焦点守卫一直判定
      // "用户正在交互"，于是**每一轮轮询都跳过内容重建**——面板从此静悄悄
      // 地停止刷新，界面上没有任何迹象说明为什么。子 agent 折叠区不需要这
      // 一步，是因为它点完立刻重建 DOM，按钮连同焦点一起消失了；这个按钮
      // 不重建 DOM，得自己把焦点交出去。
      btn.blur();
      try {
        const r = openPath(session.cwd);
        // 注入方自己也会 catch（float.js 要弹 toast），这里再兜一层只是不想
        // 让某个没 catch 的实现变成 unhandled rejection。
        if (r && typeof r.catch === 'function') r.catch(function () {});
      } catch (e) {
        /* 同步抛错也不该波及卡片上的其它交互 */
      }
    });
    return btn;
  }

  /**
   * C9：卡片底部的"子 agent N ▾"折叠区。大多数会话没有 subagent，数量
   * 为 0 时整行不渲染——380px 宽里留个空行占位没意义。
   * @param {import('./fleet.js').AgentSession} session
   * @param {number} scannedAt
   * @returns {HTMLElement|null}
   */
  function buildSubagentSection(session, scannedAt) {
    const subagents = session.subagents;
    if (!subagents || subagents.length === 0) return null;

    const isOpen = openSubagentSessionId === session.sessionId;
    const wrap = document.createElement('div');
    wrap.className = 'fw-fleet-sub';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'fw-fleet-sub-head' + (isOpen ? ' open' : '');
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    const headText = document.createElement('span');
    headText.className = 'fw-fleet-sub-head-text';
    headText.textContent = '子 agent';
    const headCount = document.createElement('span');
    headCount.className = 'fw-fleet-sub-head-count';
    headCount.textContent = String(subagents.length);
    const headCaret = document.createElement('span');
    headCaret.className = 'fw-fleet-sub-caret';
    headCaret.textContent = '▾';
    head.appendChild(headText);
    head.appendChild(headCount);
    head.appendChild(headCaret);
    head.addEventListener('click', function () {
      // 同一时刻只展开一个：点开自己就置为自己，点开的是自己就收起。
      // 直接置换 id 就自动实现了"展开 B 时 A 跟着收起"——不需要另外
      // 遍历"关掉其它展开项"，因为渲染时每张卡片都只认这一个 id。
      openSubagentSessionId = isOpen ? null : session.sessionId;
      // 用 renderContent 而不是 applyReport：这是用户主动点出来的重渲染，
      // 不该被 C4 附的焦点守卫拦下（那条守卫防的是轮询自动重建打断
      // 正在输入，不是这种一次性点击操作）。
      if (lastReport) renderContent(lastReport);
    });
    wrap.appendChild(head);

    if (isOpen) {
      const tree = document.createElement('div');
      tree.className = 'fw-fleet-sub-tree';
      const { roots, orphans } = buildSubagentTree(subagents);
      for (const node of roots) appendSubagentNode(tree, node, scannedAt, false);
      // orphans 排在 roots 之后——它们是父 id 指向不存在的 agent、或成环
      // 被摘出来的节点，正常不该出现，但丢掉就等于用户看不到那个 agent。
      for (const node of orphans) appendSubagentNode(tree, node, scannedAt, true);
      wrap.appendChild(tree);
    }

    return wrap;
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

  const ORB_DOT_BASE_CLASS = 'fw-mini-orb-dot';

  function hideOrbDot() {
    if (!orbDot) return;
    orbDot.hidden = true;
    orbDot.className = ORB_DOT_BASE_CLASS; // 顺手清掉 tone-*/is-animated，不留上一轮的残迹
  }

  /**
   * E2：把全部会话归约成一个状态，点亮/熄灭小球上的点。
   *
   * 与 updateBadge 一样跑在 applyReport 的焦点守卫**之前**——守卫防的是
   * "正在输入时别重建面板 DOM"，而这个点和角标都不在面板里，跳过它们没
   * 有任何好处，只会让缩成小球时的状态停在旧值上。
   *
   * @param {import('./fleet.js').AgentSession[]} sessions
   * @param {number} scannedAt
   */
  function updateOrbDot(sessions, scannedAt) {
    if (!orbDot) return;
    const reduced = reduceFleetTone(sessions, scannedAt);
    if (TONE_PRIORITY[reduced.code] < ORB_DOT_MIN_PRIORITY) {
      hideOrbDot();
      return;
    }
    const def = STATUS_DEFS[reduced.code];
    orbDot.className = ORB_DOT_BASE_CLASS + ' tone-' + reduced.tone + (def.animated ? ' is-animated' : '');
    orbDot.hidden = false;
  }

  /**
   * 把报告画成分组+卡片，真正动手改 DOM 的地方。从 applyReport 拆出来，
   * 是因为子 agent 折叠区的点击也需要立即重渲染一次（见 buildSubagentSection），
   * 而那次重渲染不该经过 applyReport 里的焦点守卫。
   * @param {import('./fleet.js').FleetReport} report
   */
  function renderContent(report) {
    // 展开的会话如果这一轮报告里已经不存在了（会话退出/关闭），收起——
    // 同 float.js 里 openQuickGroupId 的防御性检查。
    if (
      openSubagentSessionId &&
      !report.sessions.some(function (s) {
        return s.sessionId === openSubagentSessionId;
      })
    ) {
      openSubagentSessionId = null;
    }

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

  /** @param {import('./fleet.js').FleetReport} report */
  function applyReport(report) {
    lastReport = report;
    updateBadge(report.sessions, report.scannedAt);
    updateOrbDot(report.sessions, report.scannedAt);
    hideErrorBanner();

    // C4 附：交互中不打断——面板里有焦点元素时，本次跳过内容重建，
    // 数据已经拿到了，下一 tick 自然会再画一次。
    if (root.contains(document.activeElement)) return;

    renderContent(report);
  }

  ensureSkeleton();

  // 非 Tauri 环境（浏览器预览 / playwright）：只显示降级文案，完全不建定时器。
  // 这是 C6 的硬要求——冒烟测试跑在真浏览器里，这里绝不能因为拿不到
  // invoke 而抛错，否则整个 float.html 都起不来。
  if (!invoke) {
    renderDegraded();
    hideOrbDot();
    return { refreshSchedule: function () {}, setEnabled: function () {}, stop: function () {} };
  }

  renderInitialLoading();

  let timer = null;
  let inFlight = false;
  let failCount = 0;
  let stopped = false;
  // 总开关：只接受布尔值，其余（含缺失）落回默认开，跟 core.js 里
  // `fl.enabled !== false` 那套"false 才是唯一合法关闭值"的写法保持一致。
  let isEnabled = enabled !== false;

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
  /** 精简档不传 cpu/subagents 的默认值：跳过 sysinfo 刷新和 subagent 目录扫描，
   * 只喂角标需要的字段——subagent 现在是真实成本（每个子 agent 要读一次 jsonl
   * 尾部），精简档没有树要画，没理由让 Rust 侧白扫。 */
  function currentOpts() {
    return fastTier() ? undefined : { cpu: false, includeSubagents: false };
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

    if (!isEnabled || !getVisibility()) {
      // 总开关关闭 或 不可见：暂停抓取，但仍要留一个低频的自检时钟，否则
      // 开关重新打开/浮窗重新可见时没有任何东西会把轮询叫醒。这里的
      // "暂停"指的是不发 invoke，不是真的清空所有定时器。
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
    /**
     * float.js 在 settings.fleet.enabled 变化时调用（面板打开时的回填、
     * 或主窗口改设置广播过来之后，都汇聚到 renderAll() 这一条路径，见
     * float.js 的 applyFleetEnabled()）。关闭时立即让下一次 tick 落进
     * "总开关关闭"的早退分支（不发 invoke）；重新开启时立即触发一次
     * 抓取，不必等到下一个自然 tick，避免用户刚打开开关却要空等 8 秒。
     */
    setEnabled: function (v) {
      var next = v !== false;
      if (next === isEnabled) return; // 状态没变，不折腾定时器
      isEnabled = next;
      // 关掉总开关必须立刻熄灭小球状态点。角标不需要这一步是因为 tab 按钮
      // 整个被 float.js 隐藏了，而小球在任何时候都可见——留一个再也不会
      // 更新的点在上面，比不显示更糟。
      if (!next) hideOrbDot();
      if (stopped || inFlight) return; // 已终态 / 请求飞行中：下一轮自然生效，不用现在插手
      scheduleNext(0);
    },
    /** 停止轮询（目前只用于测试收尾，避免 fake timer 泄漏到下一个用例）。 */
    stop: function () {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
