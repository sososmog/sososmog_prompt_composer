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

/** 卡片上可能有用户的选区，标题上没有——搬动量打平时优先牺牲标题。 */
export const CARD_WEIGHT = 100;
export const TITLE_WEIGHT = 1;

/**
 * 挑出"可以原地不动"的那批节点：在保持相对顺序的前提下，让留下来的总权重
 * 最大（加权最长上升子序列）。返回的是 oldIndex 数组里的下标。
 *
 * 为什么需要它：DOM 重排时"谁不动"是可选的，而**被移动 = 被重新挂载 =
 * 落在它上面的用户选区当场消失**。所以这不是性能优化，是 E6 的正确性核心。
 * 早先用的是一趟贪心 cursor（cursor 不等于当前节点就 insertBefore），它在
 * "挡路的节点是活的、只是该往后排"时会去搬后面那张无辜的卡片——换组、组内
 * 重排、整组消失这三件日常事都能触发。
 *
 * 权重而非长度：长度打平时普通 LIS 会随实现细节挑中搬卡片那一支。最简的
 * 打平形态是相邻两项交换且后者是卡片（oldIndex 形如 [0,1,2,4,3]）。
 *
 * O(n²) DP。n 是屏幕上的行数（会话数量级），换 O(n log n) 要额外处理权重，
 * 不值得。
 *
 * @param {number[]} oldIndex 每个目标节点在旧 DOM 里的下标，新节点为 -1
 * @param {number[]} weights  同长度的权重数组
 * @returns {number[]} 可以原地不动的下标，升序
 */
export function pickStayPut(oldIndex, weights) {
  const n = oldIndex.length;
  const best = new Array(n).fill(0);
  const prev = new Array(n).fill(-1);
  let bestEnd = -1;
  for (let i = 0; i < n; i += 1) {
    if (oldIndex[i] < 0) continue; // 新建的节点必然要插入，不参与
    best[i] = weights[i];
    for (let j = 0; j < i; j += 1) {
      if (oldIndex[j] >= 0 && oldIndex[j] < oldIndex[i] && best[j] + weights[i] > best[i]) {
        best[i] = best[j] + weights[i];
        prev[i] = j;
      }
    }
    if (bestEnd < 0 || best[i] > best[bestEnd]) bestEnd = i;
  }
  const out = [];
  for (let i = bestEnd; i >= 0; i = prev[i]) {
    out.push(i);
    if (prev[i] < 0) break;
  }
  return out.reverse();
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

  /**
   * 卡片上每个会随轮询变化的字段，算成纯字符串/布尔。
   *
   * E6 的地基：把"这一轮该显示什么"与"怎么落到 DOM 上"分开，updateCard
   * 才能逐字段比对、只动真变了的那个节点。所有分支逻辑都收在这里，建和
   * 更新两条路径吃的是同一份结果——否则两边各写一遍必然漂移，而漂移出来
   * 的 bug 只在"某字段变化时"才现形，最难抓。
   *
   * @param {import('./fleet.js').AgentSession} session
   * @param {object} def
   * @param {number} scannedAt
   */
  function cardFields(session, def, scannedAt) {
    const t = session.transcript;
    const modelText = (t && t.model) || '';

    const ago = formatAgo(scannedAt - lastActivityMs(session));
    const cpu = formatCpu(session.proc ? session.proc.cpuPercent : null);
    const tokens = formatTokens(t ? t.contextTokens : null);
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
    let metaTitle = '';
    if (t && t.hasApiError) {
      const errParts = [];
      if (t.apiErrorStatus) errParts.push(t.apiErrorStatus);
      if (t.apiErrorCode) errParts.push(t.apiErrorCode);
      if (errParts.length > 0) {
        const errText = errParts.join(' ');
        metaText += ' · ' + errText;
        metaTitle = errText; // 错误码可能很长，靠 title 看全文
      }
    }

    return {
      cardClass: 'fw-fleet-card tone-' + def.tone,
      glyphClass: 'fw-fleet-glyph' + (def.animated ? ' is-animated' : ''),
      glyph: def.glyph,
      name: session.name,
      // 后台会话常常没有 transcript，也就没有 model 可显示。那个位置改标"后台"
      // 比留空有用：这类会话的 CPU 是 "—"、没有进程，看到标记才知道那是它本来
      // 的样子，而不是采集失败了。
      model: modelText || (session.kind === 'background' ? '后台' : ''),
      title: cardTitle(session),
      branch: (t && t.gitBranch) || '',
      // 后台会话的核心价值：官方已经算好的一句人话摘要（实测样本"要我顺手提交
      // 这条 fix 吗?"）。它比我们从 transcript 推的任何东西都准，也是"这个任务
      // 到底卡在哪"的直接答案。
      //
      // 这是唯一一处会让卡片变高的追加内容——阶段 3 刻意没给失败卡片单独起行，
      // 就是因为一屏内高度参差难扫视。这里破例，理由是后台会话本来就少，而没有
      // 这一行的话它整张卡片几乎是空的（没有 CPU、常常也没有 transcript）。
      jobDetail: (session.job && session.job.detail) || '',
      metaText: metaText,
      metaTitle: metaTitle,
    };
  }

  /**
   * 只在文本真变了时才写 textContent。
   *
   * 这是 E6 的核心动作，不是省一次赋值那么简单：给 textContent 赋值——
   * **哪怕赋的是同一个字符串**——也会把原来的文本节点整个换掉，落在它上面
   * 的用户选区随之塌成空串。所以这个判断必须留着。
   *
   * @param {HTMLElement} el
   * @param {string} text
   */
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  /** 同 setText 的理由，只是 title 不影响选区，纯粹避免无谓的属性写入。 */
  function setTitle(el, text) {
    if (text) {
      if (el.title !== text) el.title = text;
    } else if (el.hasAttribute('title')) {
      el.removeAttribute('title');
    }
  }

  /**
   * 可选的单行文本（分支行 / 后台摘要）：有内容就确保存在并更新，没内容
   * 就摘掉。返回当前节点，供调用方存回 refs。
   *
   * @param {HTMLElement} card
   * @param {HTMLElement|null} el 上一轮的节点，没有则为 null
   * @param {string} text
   * @param {string} className
   * @param {string} prefix 显示用前缀（分支行的 "⎇ "），不进 title
   * @param {HTMLElement} before 插入位置的锚点
   * @returns {HTMLElement|null}
   */
  function syncOptionalLine(card, el, text, className, prefix, before) {
    if (!text) {
      if (el) el.remove();
      return null;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = className;
      card.insertBefore(el, before);
    }
    setText(el, prefix + text);
    setTitle(el, text);
    return el;
  }

  /** @param {import('./fleet.js').AgentSession} session @param {object} def @param {number} scannedAt */
  function buildCard(session, def, scannedAt) {
    const f = cardFields(session, def, scannedAt);

    const card = document.createElement('div');
    card.className = f.cardClass;
    card.dataset.sessionId = session.sessionId;

    const head = document.createElement('div');
    head.className = 'fw-fleet-card-head';

    const glyph = document.createElement('span');
    glyph.className = f.glyphClass;
    glyph.textContent = f.glyph;
    head.appendChild(glyph);

    const name = document.createElement('span');
    name.className = 'fw-fleet-name';
    name.textContent = f.name;
    name.title = f.name;
    head.appendChild(name);

    const model = document.createElement('span');
    model.className = 'fw-fleet-model';
    model.textContent = f.model;
    head.appendChild(model);

    const openBtn = buildOpenCwdButton(session);
    if (openBtn) head.appendChild(openBtn);

    card.appendChild(head);

    const titleLine = document.createElement('div');
    titleLine.className = 'fw-fleet-title-line';
    titleLine.textContent = f.title;
    titleLine.title = f.title;
    card.appendChild(titleLine);

    const meta = document.createElement('div');
    meta.className = 'fw-fleet-meta';

    // branch / jobDetail 是可选行，插在 titleLine 与 meta 之间。先把 meta
    // 挂上去当锚点，syncOptionalLine 才有 before 可用（建和更新走同一条
    // 插入路径，顺序不会两边写歪）。
    card.appendChild(meta);
    const branchLine = syncOptionalLine(card, null, f.branch, 'fw-fleet-branch', '⎇ ', meta);
    const jobDetailLine = syncOptionalLine(card, null, f.jobDetail, 'fw-fleet-job-detail', '', meta);

    meta.textContent = f.metaText;
    if (f.metaTitle) meta.title = f.metaTitle;

    const subSection = buildSubagentSection(session, scannedAt);
    if (subSection) card.appendChild(subSection);

    // 逐字段更新要能找回每个节点。挂在 DOM 元素上而不是另存一张外部
    // Map：卡片被移除时这些引用跟着一起走，不需要额外的清理逻辑，也就
    // 不会漏清理成内存泄漏。
    card._fleetRefs = {
      glyph: glyph,
      name: name,
      model: model,
      titleLine: titleLine,
      branchLine: branchLine,
      jobDetailLine: jobDetailLine,
      meta: meta,
      subSection: subSection || null,
    };
    card._fleetFields = f;
    return card;
  }

  /**
   * 拿已有的卡片节点就地更新到新数据。与 buildCard 一一对应——那边加一个
   * 字段，这边就要跟一个，靠 cardFields 是唯一事实源来保证不漏。
   *
   * @param {HTMLElement} card
   * @param {import('./fleet.js').AgentSession} session
   * @param {object} def
   * @param {number} scannedAt
   */
  function updateCard(card, session, def, scannedAt) {
    const f = cardFields(session, def, scannedAt);
    const r = card._fleetRefs;
    // 理论上不会发生（卡片都出自 buildCard）。真发生了就退回重建，
    // 让面板显示得对，而不是抛异常把整轮渲染带崩。
    if (!r) return buildCard(session, def, scannedAt);

    if (card.className !== f.cardClass) card.className = f.cardClass;
    if (r.glyph.className !== f.glyphClass) r.glyph.className = f.glyphClass;
    setText(r.glyph, f.glyph);
    setText(r.name, f.name);
    setTitle(r.name, f.name);
    setText(r.model, f.model);
    setText(r.titleLine, f.title);
    setTitle(r.titleLine, f.title);

    // 顺序必须是 branch → jobDetail → meta，与 buildCard 一致。branch 行迟到
    // 时（后台会话先没 gitBranch、下一轮才读到）要插在 jobDetail **之前**，
    // 所以锚点取"当前排在它后面的第一个节点"而不是一律用 meta——否则同屏两
    // 张卡片会一张 branch 在上、一张 branch 在下。
    r.branchLine = syncOptionalLine(card, r.branchLine, f.branch, 'fw-fleet-branch', '⎇ ', r.jobDetailLine || r.meta);
    r.jobDetailLine = syncOptionalLine(card, r.jobDetailLine, f.jobDetail, 'fw-fleet-job-detail', '', r.meta);

    setText(r.meta, f.metaText);
    setTitle(r.meta, f.metaTitle);

    // 打开目录的按钮：cwd 或注入能力变化时增删。它带闭包（捕获了 session），
    // cwd 变了就得换一个，否则点开的是旧目录。
    const head = r.glyph.parentNode;
    const oldBtn = head.querySelector('.fw-fleet-open-cwd');
    if (oldBtn) oldBtn.remove();
    const newBtn = buildOpenCwdButton(session);
    if (newBtn) head.appendChild(newBtn);

    // 子 agent 区整块重建。这里刻意不做 keyed 更新：它默认是收起的，
    // 展开时才有内容，而展开态下用户的注意力在树上、不在选文字上；
    // 真要在树里选文字再说（E6 的症状是卡片主体，不是这里）。
    if (r.subSection) r.subSection.remove();
    const subSection = buildSubagentSection(session, scannedAt);
    if (subSection) card.appendChild(subSection);
    r.subSection = subSection || null;

    card._fleetFields = f;
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

    const groups = groupSessions(report.sessions, report.scannedAt);

    if (groups.length === 0) {
      // 空态/降级态走全量替换：没有卡片就没有可保的选区，也没有复用价值。
      contentEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'fw-fleet-empty';
      empty.textContent = '没有正在运行的 agent';
      contentEl.appendChild(empty);
      syncWarnings(report.warnings);
      return;
    }

    // E6：keyed 原地更新。以前这里是 contentEl.innerHTML = '' 然后整树重建，
    // 每 2s 把所有文本节点换一遍——落在卡片上的用户选区随之消失（拖蓝一段
    // 会话标题想复制，两秒后就没了）。焦点守卫拦不住这个场景，因为拖选不
    // 产生焦点：activeElement 停在 body，root.contains() 为 false。
    //
    // 现在按 sessionId 复用节点：活下来的卡片连同它承载的选区一起留在原地，
    // 只有真变了的字段会被写。顺带把每轮的 DOM 操作量从"N 张卡全建"降到
    // "改几个字符串"。
    let list = contentEl.querySelector('.fw-fleet-list');
    if (!list) {
      // 从空态/加载态/错误态切过来：contentEl 里是别的东西，清掉重来一次。
      contentEl.innerHTML = '';
      list = document.createElement('div');
      list.className = 'fw-fleet-list';
      contentEl.appendChild(list);
    }

    // 现存卡片建索引。注意要在动 DOM 之前收集完——边遍历边移动节点会漏。
    /** @type {Map<string, HTMLElement>} */
    const existing = new Map();
    for (const el of list.querySelectorAll('.fw-fleet-card')) {
      existing.set(el.dataset.sessionId, el);
    }

    // ---- 第一趟：把这一轮该有的节点按目标顺序攒出来（先不动 DOM）----
    //
    // 早先这里是一趟贪心 cursor：cursor 不等于当前节点就 insertBefore。
    // 它有个隐蔽的失败模式——挡在 cursor 上的不一定是"要被删的"节点，也
    // 可能是"活着但该排到后面去"的节点。贪心遇到这种情况会去搬**后面那张
    // 无辜的卡片**，而搬动等于重新挂载，选区当场没。触发它的是最日常的三
    // 件事：某个会话状态变了换组、组内按活动时间重排、某一整组消失。所以
    // 改成两趟，用 LIS 挑出"最多能有多少节点原地不动"。
    const target = [];
    let groupIndex = 0;
    for (const group of groups) {
      const def = STATUS_DEFS[group.key];

      // 分组标题按序号复用（组的身份就是它在列表里的第几个），只更新文字。
      // 用 key 复用没有意义：标题里没有值得保护的选区，而组会随状态增删。
      let h = list.querySelector('.fw-fleet-group-title[data-group-index="' + groupIndex + '"]');
      if (!h) {
        h = document.createElement('div');
        h.className = 'fw-fleet-group-title';
        h.dataset.groupIndex = String(groupIndex);
        const label = document.createElement('span');
        const count = document.createElement('span');
        count.className = 'fw-fleet-group-count';
        h.appendChild(label);
        h.appendChild(count);
      }
      setText(h.firstChild, group.label);
      setText(h.lastChild, String(group.items.length));
      target.push(h);
      groupIndex += 1;

      for (const session of group.items) {
        const old = existing.get(session.sessionId);
        const card = old
          ? updateCard(old, session, def, report.scannedAt)
          : buildCard(session, def, report.scannedAt);
        target.push(card);
      }
    }

    // ---- 第二趟：只搬必须搬的 ----
    const domOrder = new Map();
    Array.prototype.forEach.call(list.children, function (el, i) {
      domOrder.set(el, i);
    });
    /** @type {number[]} 每个 target 元素在旧 DOM 里的下标，新节点为 -1 */
    const oldIndex = target.map(function (el) {
      const at = domOrder.get(el);
      return at === undefined ? -1 : at;
    });
    const weights = target.map(function (el) {
      return el.classList.contains('fw-fleet-card') ? CARD_WEIGHT : TITLE_WEIGHT;
    });
    const keepIdx = pickStayPut(oldIndex, weights);
    const keep = new Set();
    for (const i of keepIdx) keep.add(target[i]);

    // 从后往前插：后面的节点已经就位，anchor 才是稳定的。
    let anchor = null;
    for (let i = target.length - 1; i >= 0; i -= 1) {
      const node = target[i];
      if (!keep.has(node)) list.insertBefore(node, anchor);
      anchor = node;
    }

    /** 这一轮摆放过的全部节点（标题+卡片），收尾时据此清理残留。 */
    const placed = new Set(target);

    // 清掉这一轮没被用到的旧节点：退出的会话、以及组变少后多出来的标题。
    // 判据是"这一轮有没有摆过它"而不是"它是什么类型"——按类型判会给将来
    // 往 list 里加第三种子节点留个静默失效的口子（Number(undefined) >= n 恒
    // 为 false，那种节点会既不被清理也不参与摆放，永久滞留在列表里）。
    for (const el of Array.prototype.slice.call(list.children)) {
      if (!placed.has(el)) el.remove();
    }

    syncWarnings(report.warnings);
  }

  /**
   * 警告折叠区跟着报告增删。整块重建（而不是 keyed 更新）是刻意的：它
   * 默认收起，展开态由 warningsOpen 单独记着，重建不影响；而警告文本
   * 变化时整块换掉最省事。
   * @param {import('./fleet.js').FleetWarning[]|undefined} warnings
   */
  function syncWarnings(warnings) {
    const old = contentEl.querySelector('.fw-fleet-warnings');
    if (old) old.remove();
    if (warnings && warnings.length > 0) {
      contentEl.appendChild(buildWarnings(warnings));
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
