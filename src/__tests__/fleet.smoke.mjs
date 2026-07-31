/* Agent tab 冒烟：用 playwright 在**真浏览器**里打开 float.html，验证两件
 * jsdom 测不到的事：
 *
 *   1. tab 骨架真的渲染出来了（CSS 显隐、面板切换在真实布局引擎下成立）；
 *   2. **非 Tauri 环境下 Agent tab 不报错**，而是显示降级文案。
 *
 * 第 2 条是这个脚本存在的主要理由。jsdom 里我们是手工注入假 Tauri 或干脆不注入，
 * 与"真浏览器里 window.__TAURI__ 压根不存在、ESM 模块图正常加载"不是一回事——
 * float.js 顶层就 import 了 fleetView.js，任何一处对 Tauri 的无保护访问都会让
 * 整个模块挂掉，连编写区都一起白屏。而那正是用户在浏览器预览时会遇到的场景。
 *
 * ⚠️ **必须走 http 而不是 file://**。`file://` 下 Chrome 的 CORS 会直接拦掉
 * `<script type="module">`，float.js 压根不会执行——那样这个脚本就只是在测静态
 * HTML，tab 点了没反应、面板永远空白，看起来像功能坏了，实际是测试写错了。
 * （我第一版就是这么写的，白排查了一轮。float-theme.smoke.mjs 能用 file:// 是
 * 因为它只测 head 里的内联脚本和 CSS 变量，不依赖模块图。）
 *
 * 运行：node src/__tests__/fleet.smoke.mjs
 * 路径约定见 reference-verify-frontend-playwright。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

// playwright 不在本项目 node_modules，用 npx 缓存里的
const PW = process.env.PW_MODULE ||
  (process.env.HOME || process.env.USERPROFILE) +
  '/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const pw = await import(pathToFileURL(path.resolve(PW)).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const CHROME = process.env.PW_CHROME ||
  (process.env.LOCALAPPDATA + '/ms-playwright/chromium-1223/chrome-win64/chrome.exe');

const ROOT = path.resolve('src');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/float.html';
  // favicon 回 204 而非 404：404 会往 console 打 error，污染"无错误"那项断言
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const FLOAT = `http://127.0.0.1:${server.address().port}/float.html`;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failed += 1; }
  else console.log('  ok:', msg);
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();

// 收集页面级错误。file:// 下 ESM 能正常加载，所以这里**不该**有 import 失败；
// 但 Tauri API 缺失导致的错误如果没被防御掉，会在这里现形。
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(FLOAT);
// 等模块图执行完 + fleetView 首次渲染（它构造时会立即尝试抓一次）
await page.waitForTimeout(600);

console.log('非 Tauri 环境下打开 float.html：');

// ---- tab 骨架 ----
const tabCount = await page.locator('.fw-tabs button').count();
assert(tabCount === 2, `tab 栏有 2 个按钮（实际 ${tabCount}）`);

const composeVisible = await page.locator('#fwPanelCompose').isVisible();
const fleetPanelExists = (await page.locator('#fwPanelFleet').count()) === 1;
assert(fleetPanelExists, '#fwPanelFleet 存在');

// ---- 编写区必须完好：这是"新功能不能破坏旧功能"的底线 ----
const textareaExists = (await page.locator('#fwTextarea').count()) === 1;
assert(textareaExists, '编写区 textarea 仍在');
assert(composeVisible || (await page.locator('#fwTextarea').isVisible()),
  '默认停在编写 tab（或至少编写区可见）');

// ---- 切到 Agent tab，验降级文案 ----
const fleetTab = page.locator('.fw-tabs button').nth(1);
await fleetTab.click();
await page.waitForTimeout(300);

assert(await page.locator('#fwPanelFleet').isVisible(), '点击后 Agent 面板可见');
const fleetText = (await page.locator('#fwPanelFleet').innerText()).trim();
console.log('  Agent 面板文案:', JSON.stringify(fleetText.slice(0, 60)));
assert(fleetText.length > 0, 'Agent 面板有内容（不是空白）');
assert(/桌面端|Tauri|不支持|需要/.test(fleetText),
  '显示的是"需要桌面端"一类的降级文案');

// ---- 切回编写 tab，内容还在 ----
await page.locator('.fw-tabs button').nth(0).click();
await page.waitForTimeout(200);
assert(await page.locator('#fwTextarea').isVisible(), '切回后编写区仍可见');

/* ---- E2：小球状态点 ----
 * 两件 jsdom 验不了的事，都只有真实布局引擎能回答：
 *   1. 点会不会溢出小球圆外（窗口背景是透明的，溢出部分会悬空在桌面上）；
 *   2. 点会不会把小球的点击吃掉——小球的展开/拖动是手动 mousedown 判定的，
 *      多一个能接指针事件的子元素就会让"单击展开"失效，而这种坏法在
 *      截图里完全看不出来。
 * 把 viewport 调成真实的 52×52（float.js 的 MINI 尺寸）才量得准：默认
 * viewport 下 .fw-card 会撑满整页，小球变成一个巨大的椭圆，而点用的是固定
 * px 偏移，算出来的比例毫无意义。
 * 非 Tauri 环境下 fleetView 不会点亮这个点，所以手动摆出"等你回话"的状态。 */
await page.setViewportSize({ width: 52, height: 52 });
await page.evaluate(() => {
  document.getElementById('fwCard').classList.add('is-mini');
  const dot = document.getElementById('fwMiniOrbDot');
  dot.hidden = false;
  dot.className = 'fw-mini-orb-dot tone-attention';
});
await page.waitForTimeout(100);

assert(await page.locator('#fwMiniOrb').isVisible(), 'is-mini 时小球可见');

const geo = await page.evaluate(() => {
  const orb = document.getElementById('fwMiniOrb').getBoundingClientRect();
  const dot = document.getElementById('fwMiniOrbDot').getBoundingClientRect();
  const cx = orb.left + orb.width / 2;
  const cy = orb.top + orb.height / 2;
  const dx = dot.left + dot.width / 2 - cx;
  const dy = dot.top + dot.height / 2 - cy;
  // 命中测试打在点的正中心：这里返回什么，就是用户点下去时事件真正落到谁身上
  const hit = document.elementFromPoint(dot.left + dot.width / 2, dot.top + dot.height / 2);
  return {
    orbRadius: Math.min(orb.width, orb.height) / 2,
    dotRadius: Math.min(dot.width, dot.height) / 2,
    centerDist: Math.hypot(dx, dy),
    size: dot.width,
    hitId: hit ? hit.id : null,
  };
});

assert(geo.size > 0, `状态点有实际尺寸（${geo.size}px）`);
// 点也是圆的，所以最远点在"圆心连线"方向，不是外接矩形的角。
// box-shadow 描边（1.5px）不计入 boundingRect，算上它仍在圆内（约 24.5 < 26）。
assert(
  geo.centerDist + geo.dotRadius <= geo.orbRadius,
  `状态点完全落在小球圆内（离圆心 ${geo.centerDist.toFixed(1)} + 半径 ${geo.dotRadius} ≤ ${geo.orbRadius}）`
);
assert(
  geo.hitId === 'fwMiniOrb',
  `点在状态点上，事件仍落到小球本身（实际命中 ${JSON.stringify(geo.hitId)}；若是 fwMiniOrbDot 说明漏了 pointer-events:none）`
);

// ---- 最关键的一条：没有未捕获的页面错误 ----
if (pageErrors.length) {
  console.error('  页面错误:', pageErrors.slice(0, 3));
}
assert(pageErrors.length === 0,
  `非 Tauri 环境下无未捕获错误（实际 ${pageErrors.length} 条）`);

await browser.close();
server.close();

if (failed) {
  console.error(`\n${failed} 条断言失败`);
  process.exit(1);
}
console.log('\nAgent tab 冒烟通过');
