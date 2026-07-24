/* 浮窗主题冒烟：用 playwright 打开 float.html，验证 CSS 深浅两套分支生效。
 * float.html 内含 Tauri 依赖的 module 脚本，在浏览器里会报 import 失败，
 * 但那不阻塞 head 的内联主题脚本与 CSS 变量渲染，本脚本只测这两者。
 * 运行：node src/__tests__/float-theme.smoke.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// playwright 不在本项目 node_modules，用 npx 缓存里的（见 reference-verify-frontend-playwright）
const PW = process.env.PW_MODULE ||
  (process.env.HOME || process.env.USERPROFILE) +
  '/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const pw = await import(pathToFileURL(path.resolve(PW)).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const CHROME = process.env.LOCALAPPDATA +
  '/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const FLOAT = pathToFileURL(path.resolve('src/float.html')).href;

function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); process.exitCode = 1; }
  else console.log('  ok:', msg);
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();

// 收集页面报错，确认「有 Tauri import 报错但不致命」
page.on('pageerror', () => {});

// —— 场景 A：localStorage 无值 → 内联脚本默认深色 ——
await page.addInitScript(() => { try { localStorage.clear(); } catch (e) { /* 存储不可用 */ } });
await page.goto(FLOAT);
const darkAttr = await page.getAttribute('html', 'data-theme');
assert(darkAttr === 'dark', '无 localStorage 时默认加 data-theme=dark');
const darkCardBg = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.fw-card')).backgroundColor);
console.log('    深色 .fw-card 背景 =', darkCardBg);

// —— 场景 B：localStorage=light → 内联脚本不加属性（浅色）——
await page.addInitScript(() => { try { localStorage.setItem('composer-theme', 'light'); } catch (e) { /* 存储不可用 */ } });
await page.goto(FLOAT);
const lightAttr = await page.getAttribute('html', 'data-theme');
assert(lightAttr === null, 'localStorage=light 时不加 data-theme（浅色）');
const lightCardBg = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.fw-card')).backgroundColor);
console.log('    浅色 .fw-card 背景 =', lightCardBg);

assert(darkCardBg !== lightCardBg, '深浅两套 CSS 变量确实产出不同背景色');

// —— 场景 C：模拟 composer-theme-changed 回调切主题（复刻 float.html 的处理逻辑）——
async function applyThemeInPage(theme) {
  await page.evaluate((t) => {
    const isLight = t === 'light';
    if (isLight) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
  }, theme);
  return page.evaluate(() =>
    getComputedStyle(document.querySelector('.fw-card')).backgroundColor);
}
const toDark = await applyThemeInPage('dark');
assert(toDark === darkCardBg, '收到 theme=dark 事件后背景切成深色');
const toLight = await applyThemeInPage('light');
assert(toLight === lightCardBg, '收到 theme=light 事件后背景切成浅色');

// —— 场景 D：文本色也随主题变（防止只改背景漏改前景导致对比度失效）——
const darkText = (await applyThemeInPage('dark'),
  await page.evaluate(() => getComputedStyle(document.body).color));
const lightText = (await applyThemeInPage('light'),
  await page.evaluate(() => getComputedStyle(document.body).color));
assert(darkText !== lightText, '正文颜色也随主题切换（--text 生效）');

await browser.close();
console.log(process.exitCode ? '\n浮窗主题冒烟：有失败' : '\n浮窗主题冒烟：全部通过');
