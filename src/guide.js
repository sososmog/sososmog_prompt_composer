/* ============================================================
 * guide.js —— 新手引导（首启动最短路径引导 + 上下文轻提示）
 * ------------------------------------------------------------
 * 纯原生实现，无外部库。两套东西：
 *   1. startTour()          —— 5 步高亮遮罩引导，其中第 2 步为真实交互步
 *                              （必须真的插入一次素材才前进）。
 *   2. maybeShowHint(key)   —— 第一次接近某功能时浮现的锚定小气泡。
 * 「是否已完成 / 是否已看过」标记存 state.settings.onboarding，
 * 随 state 落盘并自动同步（core.js 的 normalizeState 做白名单归一化）。
 *
 * DOM 全部运行时 createElement 注入 body（照抄 .sm-overlay 惯例），
 * 用 .gd-* 前缀的 class（样式见 styles.css）。引导层 z-index 1100，
 * 高于设置面板遮罩（1000）与 toast（999）。
 * ============================================================ */
import { state, scheduleSave } from './store.js';

/* ------------------------------------------------------------
 * 读写 onboarding 标记
 * ---------------------------------------------------------- */
function ob() {
  // 防御：正常 normalizeState 后一定存在，这里兜底避免早期调用报错
  if (!state.settings) state.settings = {};
  if (!state.settings.onboarding) state.settings.onboarding = { tourDone: false, hintsSeen: {} };
  if (!state.settings.onboarding.hintsSeen) state.settings.onboarding.hintsSeen = {};
  return state.settings.onboarding;
}
function markTourDone() { ob().tourDone = true; scheduleSave(); }
function isTourDone() { return ob().tourDone === true; }
function hintSeen(key) { return ob().hintsSeen[key] === true; }
function markHintSeen(key) { ob().hintsSeen[key] = true; scheduleSave(); }

/* ------------------------------------------------------------
 * 第一层：最短路径引导（5 步）
 * ---------------------------------------------------------- */
// 每步：target 高亮锚点 selector（null=居中卡片）、title/body 文案、
// interactive 表示交互步（不显示“下一步”，由真实操作推进）。
var TOUR_STEPS = [
  {
    target: '.rail',
    title: '这是你的素材库',
    body: '左边有三区：插入模块、常用句、快速段落。点一下，内容就进右边的正文。',
    interactive: false
  },
  {
    target: '#insertGrid',
    title: '试着插入一块',
    body: '现在点上面任意一个「+ 模块」，把它加进右侧正文 —— 试一下，我等你。',
    interactive: true
  },
  {
    target: '#blocks',
    title: '正文是一张张卡片',
    body: '正文按 ## 标题切成卡片，每张都能单独改。拖左侧手柄排序，或按 Alt+↑ / Alt+↓。',
    interactive: false
  },
  {
    target: '#btnCopy',
    title: '一键带走',
    body: '改好后，点这里复制，或点旁边下载 .md。一次「插入 → 编辑 → 输出」就跑通了。',
    interactive: false
  },
  {
    target: null,
    title: '就这么简单 🎉',
    body: '更多功能你用到时会有小提示。想重看这段引导，随时到「设置 → 引导」里点开。',
    interactive: false
  }
];

var tour = null; // { root, mask*, bubble, stepIdx, ... } 运行中才非 null

function q(sel) { try { return sel ? document.querySelector(sel) : null; } catch (_e) { return null; } }

// 四块遮罩（上/下/左/右）围出中间高亮镂空区，镂空区可正常点击穿透。
function buildTour() {
  var root = document.createElement('div');
  root.className = 'gd-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '新手引导');

  var maskTop = document.createElement('div'); maskTop.className = 'gd-mask';
  var maskBottom = document.createElement('div'); maskBottom.className = 'gd-mask';
  var maskLeft = document.createElement('div'); maskLeft.className = 'gd-mask';
  var maskRight = document.createElement('div'); maskRight.className = 'gd-mask';
  var ring = document.createElement('div'); ring.className = 'gd-ring';

  var bubble = document.createElement('div');
  bubble.className = 'gd-bubble';
  bubble.innerHTML =
    '<div class="gd-arrow"></div>' +
    '<div class="gd-step"></div>' +
    '<div class="gd-title"></div>' +
    '<div class="gd-body"></div>' +
    '<div class="gd-actions">' +
      '<button type="button" class="gd-skip">跳过</button>' +
      '<div class="gd-nav">' +
        '<button type="button" class="gd-prev">上一步</button>' +
        '<button type="button" class="gd-next">下一步</button>' +
      '</div>' +
    '</div>';

  root.appendChild(maskTop);
  root.appendChild(maskBottom);
  root.appendChild(maskLeft);
  root.appendChild(maskRight);
  root.appendChild(ring);
  root.appendChild(bubble);
  document.body.appendChild(root);

  tour = {
    root: root, masks: [maskTop, maskBottom, maskLeft, maskRight], ring: ring,
    bubble: bubble,
    elStep: bubble.querySelector('.gd-step'),
    elTitle: bubble.querySelector('.gd-title'),
    elBody: bubble.querySelector('.gd-body'),
    elArrow: bubble.querySelector('.gd-arrow'),
    btnSkip: bubble.querySelector('.gd-skip'),
    btnPrev: bubble.querySelector('.gd-prev'),
    btnNext: bubble.querySelector('.gd-next'),
    stepIdx: 0,
    onKey: null, onResize: null, onInsert: null
  };

  tour.btnSkip.addEventListener('click', endTour);
  tour.btnPrev.addEventListener('click', function () { gotoStep(tour.stepIdx - 1); });
  tour.btnNext.addEventListener('click', function () { advance(); });

  tour.onKey = function (e) {
    if (e.key === 'Escape') { e.preventDefault(); endTour(); }
  };
  document.addEventListener('keydown', tour.onKey, true);

  tour.onResize = function () { layoutStep(); };
  window.addEventListener('resize', tour.onResize);

  return tour;
}

// 交互步：在三大素材区上挂捕获阶段 click 监听，点任意 pill 都算过关。
// 用捕获阶段确保先于（或同时）触发插入逻辑，捕获到后自动前进。
function armInsertListener() {
  disarmInsertListener();
  tour.onInsert = function () {
    // 让实际插入逻辑先执行完，再前进（下一步要指向 #blocks 里新出现的卡片）
    setTimeout(function () { if (tour) advance(); }, 60);
  };
  ['#insertGrid', '#snippetWrap', '#quickWrap'].forEach(function (sel) {
    var el = q(sel);
    if (el) el.addEventListener('click', tour.onInsert, true);
  });
}
function disarmInsertListener() {
  if (!tour || !tour.onInsert) return;
  ['#insertGrid', '#snippetWrap', '#quickWrap'].forEach(function (sel) {
    var el = q(sel);
    if (el) el.removeEventListener('click', tour.onInsert, true);
  });
  tour.onInsert = null;
}

function advance() {
  if (tour.stepIdx >= TOUR_STEPS.length - 1) { finishTour(); return; }
  gotoStep(tour.stepIdx + 1);
}

function gotoStep(idx) {
  if (!tour) return;
  disarmInsertListener();
  if (idx < 0) idx = 0;
  if (idx > TOUR_STEPS.length - 1) idx = TOUR_STEPS.length - 1;
  tour.stepIdx = idx;
  var step = TOUR_STEPS[idx];

  tour.elStep.textContent = (idx + 1) + ' / ' + TOUR_STEPS.length;
  tour.elTitle.textContent = step.title;
  tour.elBody.textContent = step.body;

  // 按钮显隐：交互步只留“跳过”；首步无“上一步”；末步“下一步”变“开始使用”
  var isFirst = idx === 0;
  var isLast = idx === TOUR_STEPS.length - 1;
  tour.btnPrev.style.display = isFirst ? 'none' : '';
  tour.btnNext.style.display = step.interactive ? 'none' : '';
  tour.btnNext.textContent = isLast ? '开始使用' : '下一步';

  if (step.interactive) armInsertListener();

  layoutStep();
}

// 依据当前步的高亮目标，摆放四块遮罩、高亮环与气泡。
function layoutStep() {
  if (!tour) return;
  var step = TOUR_STEPS[tour.stepIdx];
  var vw = window.innerWidth, vh = window.innerHeight;
  var target = step.target ? q(step.target) : null;
  var rect = target ? target.getBoundingClientRect() : null;

  if (rect && rect.width > 0 && rect.height > 0) {
    var pad = 6;
    var x = Math.max(0, rect.left - pad);
    var y = Math.max(0, rect.top - pad);
    var w = Math.min(vw, rect.right + pad) - x;
    var h = Math.min(vh, rect.bottom + pad) - y;

    tour.ring.style.display = 'block';
    tour.ring.style.left = x + 'px';
    tour.ring.style.top = y + 'px';
    tour.ring.style.width = w + 'px';
    tour.ring.style.height = h + 'px';

    // 四块遮罩围住镂空区（镂空区不盖，可点击）
    setMask(tour.masks[0], 0, 0, vw, y);                       // top
    setMask(tour.masks[1], 0, y + h, vw, vh - (y + h));        // bottom
    setMask(tour.masks[2], 0, y, x, h);                        // left
    setMask(tour.masks[3], x + w, y, vw - (x + w), h);         // right

    placeBubble(x, y, w, h);
  } else {
    // 无锚点（末步或找不到目标）：整屏半透明遮罩 + 居中气泡
    tour.ring.style.display = 'none';
    setMask(tour.masks[0], 0, 0, vw, vh);
    setMask(tour.masks[1], 0, 0, 0, 0);
    setMask(tour.masks[2], 0, 0, 0, 0);
    setMask(tour.masks[3], 0, 0, 0, 0);
    centerBubble();
  }
}

function setMask(el, x, y, w, h) {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = Math.max(0, w) + 'px';
  el.style.height = Math.max(0, h) + 'px';
}

// 把气泡放在高亮区下方（放不下则放上方），水平方向对齐并夹在视口内。
function placeBubble(x, y, w, h) {
  var b = tour.bubble;
  b.style.visibility = 'hidden';
  b.style.left = '0px'; b.style.top = '0px';
  var bw = b.offsetWidth, bh = b.offsetHeight;
  var vw = window.innerWidth, vh = window.innerHeight;
  var gap = 12, margin = 12;

  var below = y + h + gap;
  var placeBelow = (below + bh <= vh - margin);
  var top = placeBelow ? below : (y - gap - bh);
  if (top < margin) top = margin;

  var left = x + w / 2 - bw / 2;
  if (left < margin) left = margin;
  if (left + bw > vw - margin) left = vw - margin - bw;

  b.style.left = left + 'px';
  b.style.top = top + 'px';

  // 箭头指回高亮区中心
  var arrowX = (x + w / 2) - left;
  arrowX = Math.max(16, Math.min(bw - 16, arrowX));
  tour.elArrow.style.left = arrowX + 'px';
  tour.elArrow.classList.toggle('gd-arrow-up', placeBelow);
  tour.elArrow.classList.toggle('gd-arrow-down', !placeBelow);
  tour.elArrow.style.display = 'block';

  b.style.visibility = 'visible';
}

function centerBubble() {
  var b = tour.bubble;
  b.style.visibility = 'hidden';
  var bw = b.offsetWidth, bh = b.offsetHeight;
  b.style.left = Math.round((window.innerWidth - bw) / 2) + 'px';
  b.style.top = Math.round((window.innerHeight - bh) / 2) + 'px';
  tour.elArrow.style.display = 'none';
  b.style.visibility = 'visible';
}

function teardownTour() {
  if (!tour) return;
  disarmInsertListener();
  document.removeEventListener('keydown', tour.onKey, true);
  window.removeEventListener('resize', tour.onResize);
  if (tour.root && tour.root.parentNode) tour.root.parentNode.removeChild(tour.root);
  tour = null;
}

// 跳过 / Esc：结束并标记（不再自动弹）
function endTour() { markTourDone(); teardownTour(); }
// 走完最后一步：同样标记完成
function finishTour() { markTourDone(); teardownTour(); }

// 启动引导（供首启动与“重新观看”共用）。已在运行则忽略。
function startTour() {
  if (tour) return;
  buildTour();
  gotoStep(0);
}

// 启动时按标记决定是否自动弹。DOM 需已渲染（在 renderAll 之后调用）。
function maybeStartTourOnBoot() {
  if (isTourDone()) return;
  // 等一帧，确保演示数据卡片等 DOM 已布局，getBoundingClientRect 才准
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { startTour(); });
  });
}

/* ------------------------------------------------------------
 * 第二层：上下文轻提示（锚定小气泡，无遮罩，只出现一次）
 * ---------------------------------------------------------- */
var HINTS = {
  langBilingual: {
    target: '#langSegmented',
    title: '中英文各存一份',
    body: '中英文是两份独立的正文，各自保存、互不覆盖。切回来内容还在，放心切。'
  },
  floatWindow: {
    target: '#btnFloatWindow',
    title: '浮窗随叫随到',
    body: '浮窗会始终置顶。按 Ctrl+Alt+C 可随时全局呼出/收起；开启「点击即粘贴」后，点一下素材就能直接粘到别的程序里。'
  },
  translateKey: {
    target: '#btnTranslate',
    title: '翻译要先配 Key',
    body: '一键翻译会把当前正文译成另一种语言，需要先在「设置 → 翻译」里填一个 API Key（Gemini / GLM / Groq 等，有免费额度）。'
  }
};

var activeHint = null; // 同时只显示一个 hint

// 返回 true 表示本次真的展示了提示（首次触碰）；false 表示此前已看过或被抑制。
// 调用方可据此决定是否短路自身的后续打扰（如翻译未配 key 的 toast+弹窗）。
function maybeShowHint(key) {
  var def = HINTS[key];
  if (!def) return false;
  if (tour) return false;           // 引导进行中不打扰
  if (hintSeen(key)) return false;  // 只出现一次
  markHintSeen(key);                // 无论用户看不看，都算“接近过一次”，避免反复弹
  showHint(def);
  return true;
}

function closeHint() {
  if (!activeHint) return;
  document.removeEventListener('keydown', activeHint.onKey, true);
  window.removeEventListener('resize', activeHint.onLayout);
  window.removeEventListener('scroll', activeHint.onLayout, true);
  if (activeHint.timer) clearTimeout(activeHint.timer);
  if (activeHint.el && activeHint.el.parentNode) activeHint.el.parentNode.removeChild(activeHint.el);
  activeHint = null;
}

function showHint(def) {
  closeHint();
  var el = document.createElement('div');
  el.className = 'gd-hint';
  el.setAttribute('role', 'status');
  el.innerHTML =
    '<div class="gd-arrow gd-arrow-up"></div>' +
    '<button type="button" class="gd-hint-close" aria-label="关闭提示">×</button>' +
    '<div class="gd-hint-title"></div>' +
    '<div class="gd-hint-body"></div>';
  el.querySelector('.gd-hint-title').textContent = def.title;
  el.querySelector('.gd-hint-body').textContent = def.body;
  document.body.appendChild(el);

  activeHint = {
    el: el, target: def.target,
    onKey: function (e) { if (e.key === 'Escape') closeHint(); },
    onLayout: function () { layoutHint(); },
    timer: null
  };
  el.querySelector('.gd-hint-close').addEventListener('click', closeHint);
  document.addEventListener('keydown', activeHint.onKey, true);
  window.addEventListener('resize', activeHint.onLayout);
  window.addEventListener('scroll', activeHint.onLayout, true);

  layoutHint();
  // 一段时间后自动淡出，避免长期挡视线
  activeHint.timer = setTimeout(closeHint, 9000);
}

function layoutHint() {
  if (!activeHint) return;
  var el = activeHint.el;
  var target = q(activeHint.target);
  var arrow = el.querySelector('.gd-arrow');
  var vw = window.innerWidth, vh = window.innerHeight;
  var margin = 12, gap = 10;

  el.style.visibility = 'hidden';
  var bw = el.offsetWidth, bh = el.offsetHeight;

  var rect = target ? target.getBoundingClientRect() : null;
  if (rect && rect.width > 0) {
    var below = rect.bottom + gap;
    var placeBelow = (below + bh <= vh - margin);
    var top = placeBelow ? below : (rect.top - gap - bh);
    if (top < margin) top = margin;

    var left = rect.left + rect.width / 2 - bw / 2;
    if (left < margin) left = margin;
    if (left + bw > vw - margin) left = vw - margin - bw;

    el.style.left = left + 'px';
    el.style.top = top + 'px';

    var arrowX = (rect.left + rect.width / 2) - left;
    arrowX = Math.max(16, Math.min(bw - 16, arrowX));
    arrow.style.left = arrowX + 'px';
    arrow.classList.toggle('gd-arrow-up', placeBelow);
    arrow.classList.toggle('gd-arrow-down', !placeBelow);
    arrow.style.display = 'block';
  } else {
    // 找不到锚点：贴右上角
    el.style.left = (vw - margin - bw) + 'px';
    el.style.top = margin + 'px';
    arrow.style.display = 'none';
  }
  el.style.visibility = 'visible';
}

/* ------------------------------------------------------------
 * 重放 / 重置（供设置页“引导”tab 使用）
 * ---------------------------------------------------------- */
// 重看引导：清完成标记并立即启动（设置页应先关闭自己再调用）
function replayTour() {
  ob().tourDone = false;
  scheduleSave();
  startTour();
}
// 重置所有上下文提示，让它们能再次出现
function resetHints() {
  ob().hintsSeen = {};
  scheduleSave();
}

export {
  startTour,
  maybeStartTourOnBoot,
  maybeShowHint,
  replayTour,
  resetHints,
  HINTS,
};
