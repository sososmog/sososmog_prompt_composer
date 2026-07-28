/* ============================================================
 * frontend.smoke.mjs —— 主窗口 + 浮窗的端到端冒烟（真浏览器）
 * ------------------------------------------------------------
 * 为什么需要它：vitest 里跑的是 jsdom，验不了「真的能启动、样式真的生效、
 * 交互真的连得上」。这轮重构动了很大的面（抽出 materials/pool/sync 三个共享
 * 模块、浮窗从 float.html 内联脚本拆成 float.js + float.css、入口从 events.js
 * 换成 main.js、主题 bootstrap 外置、字体本地化），这些都属于「单测全绿但应用
 * 可能起不来」的改动类型，必须有一层真浏览器验证兜住。
 *
 * 做法：起一个静态 http server 伺服 src/，用 Chromium 打开两份 HTML。此时
 * window.__TAURI__ 不存在，前端会走各处的降级分支（fs/dialog/clipboard 全部
 * 不可用），正好不碰真实磁盘。
 *
 * 两种模式：
 *   node src/__tests__/frontend.smoke.mjs          交互冒烟
 *   node src/__tests__/frontend.smoke.mjs --csp    额外把 tauri.conf.json 里的
 *                                                 CSP 用 <meta> 注入再跑一遍，
 *                                                 检查我们自己的代码有没有违规
 * ⚠ --csp 模式验不到 Tauri 运行时自身的需求（ipc: / tauri: 协议、它注入的
 *   初始化脚本要的 nonce），那部分只能真机 npm run dev 验，见 docs/csp.md。
 *
 * playwright 不在本项目 node_modules 里，走 npx 缓存；两个路径都能用环境变量
 * 覆盖（PW_MODULE / PW_CHROME），换机器时不用改代码。
 * ============================================================ */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const PW = process.env.PW_MODULE ||
  (process.env.HOME || process.env.USERPROFILE) +
  '/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const pw = await import(pathToFileURL(path.resolve(PW)).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
const CHROME = process.env.PW_CHROME ||
  (process.env.LOCALAPPDATA + '/ms-playwright/chromium-1223/chrome-win64/chrome.exe');

const WITH_CSP = process.argv.includes('--csp');
const ROOT = path.resolve('src');
const CSP = WITH_CSP
  ? JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  : null;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/markdown',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  // 浏览器会自动请求 /favicon.ico，应用没有也不需要（Tauri 里没有浏览器 chrome）。
  // 回 204 而不是 404：404 会让浏览器往 console 打一条 error，污染「无 JS 错误」这项断言。
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (CSP && path.extname(file) === '.html') {
    body = Buffer.from(body.toString('utf8').replace('<head>',
      `<head>\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`), 'utf8');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
function check(name, ok, extra) { results.push([!!ok, name, extra == null ? '' : String(extra)]); }

const browser = await chromium.launch({ executablePath: CHROME });

for (const pageName of ['index.html', 'float.html']) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errors = [];
  const cspViolations = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t);
    else if (m.type() === 'error' && !/favicon/i.test(t)) errors.push('console.error: ' + t);
  });

  await pg.goto(`${base}/${pageName}`, { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(600);

  check(`${pageName} 无 JS 错误`, errors.length === 0, errors.slice(0, 3).join(' | '));
  // 主题 bootstrap 外置成非 module 脚本后仍必须同步执行完（否则首屏会闪主题）
  check(`${pageName} 主题 bootstrap 生效`,
    (await pg.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');

  if (pageName === 'index.html') {
    // 首次运行会自动弹新手引导（这本身就说明启动链路跑通了），它会拦截点击
    if (await pg.locator('.gd-root').count() > 0) {
      check('新手引导自动弹出', true);
      await pg.locator('.gd-skip').click({ force: true });
      await pg.waitForTimeout(250);
      check('引导可跳过', await pg.locator('.gd-root').count() === 0);
    }

    check('左栏插入模块渲染', await pg.locator('#insertGrid .insert-pill').count() === 10);
    check('左栏常用句渲染', await pg.locator('#snippetWrap .snippet-pill').count() > 10);
    check('左栏快速段落分组渲染', await pg.locator('#quickWrap .quick-block').count() === 4);
    check('演示数据渲染出块卡片', await pg.locator('#blocks .block').count() > 0);
    check('token 统计已计算', /~\d+/.test(await pg.locator('#editorStat').innerText()));
    // 字体本地化：三套字体都应从同源加载成功
    const fontsOk = await pg.evaluate(() => ({
      inter: document.fonts.check('16px Inter'),
      mono: document.fonts.check("16px 'IBM Plex Mono'"),
      display: document.fonts.check('21px Fraunces'),
    }));
    check('本地字体生效（Inter / IBM Plex Mono / Fraunces）',
      fontsOk.inter && fontsOk.mono && fontsOk.display, JSON.stringify(fontsOk));

    const before = await pg.locator('#blocks .block').count();
    await pg.locator('#insertGrid .insert-pill').first().click();
    await pg.waitForTimeout(250);
    check('点插入模块新增了块', await pg.locator('#blocks .block').count() === before + 1);

    const area = pg.locator('#blocks .block-textarea').last();
    await area.click();
    await area.pressSequentially('## 冒烟 **粗体**', { delay: 10 });
    await pg.waitForTimeout(200);
    check('高亮 overlay 渲染了粗体 span',
      (await pg.locator('#blocks .block').last().locator('.hl-overlay').innerHTML()).includes('hl-bold'));

    await pg.locator('#langSegmented button[data-lang="en"]').click();
    await pg.waitForTimeout(250);
    check('切到英文正文', /english/i.test(await pg.locator('#etLabel').innerText()));
    await pg.locator('#langSegmented button[data-lang="zh"]').click();
    await pg.waitForTimeout(200);

    await pg.locator('#viewSeg button[data-view="preview"]').click();
    await pg.waitForTimeout(250);
    check('预览态出现分栏', await pg.locator('.editor-surface.is-split').count() === 1);
    await pg.locator('#viewSeg button[data-view="write"]').click();
    await pg.waitForTimeout(150);

    await pg.locator('#btnEditorSettings').click();
    await pg.waitForTimeout(250);
    check('设置面板打开', await pg.locator('.sm-overlay.show .st-panel').count() === 1);
    await pg.locator('.st-nav-item[data-tab="learning"]').click();
    await pg.waitForTimeout(150);
    check('自学习 tab 可渲染', await pg.locator('#stLearningHost').count() === 1);
    await pg.locator('.st-nav-item[data-tab="snippets"]').click();
    await pg.waitForTimeout(200);
    check('常用句管理内嵌渲染', await pg.locator('#stSnippetsHost .sm-row').count() > 10);
    await pg.locator('.st-nav-item[data-tab="quick"]').click();
    await pg.waitForTimeout(200);
    check('快速段落管理内嵌渲染', await pg.locator('#stQuickHost .qm-group').count() === 4);
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(150);

    await pg.locator('#themeToggle').click();
    await pg.waitForTimeout(200);
    check('主题切到浅色', (await pg.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null);
    await pg.locator('#themeToggle').click();
    await pg.waitForTimeout(150);

    await pg.locator('#quickWrap .qb-head').first().click();
    await pg.waitForTimeout(200);
    check('快速段落分组可展开', await pg.locator('#quickWrap .quick-block.open .qb-item').count() > 0);

    // 行内补全：打一条内置常用句的前缀，应出现灰字 ghost
    const first = pg.locator('#blocks .block-textarea').first();
    await first.click();
    await pg.keyboard.press('Control+End');
    await first.pressSequentially('\n一步步', { delay: 20 });
    await pg.waitForTimeout(350);
    check('行内补全 ghost 出现', await pg.locator('.cmp-ghost').count() > 0);
  } else {
    check('浮窗卡片渲染', await pg.locator('.fw-card').count() === 1);
    check('浮窗插入模块列表渲染', await pg.locator('#fwModuleWrap .fw-pill').count() === 10);
    check('浮窗常用句列表渲染', await pg.locator('#fwSnippetWrap .fw-pill').count() > 10);
    check('浮窗快速段落渲染', await pg.locator('#fwQuickWrap .fw-quick-block').count() === 4);
    // float.css 已从 float.html 的 <style> 拆成外部文件，必须确认它真的被加载
    check('外置 float.css 生效',
      (await pg.locator('.fw-card').evaluate((el) => getComputedStyle(el).borderRadius)) !== '0px');
    await pg.locator('#fwQuickWrap .fw-qb-head').first().click();
    await pg.waitForTimeout(200);
    check('浮窗分组可展开', await pg.locator('#fwQuickWrap .fw-quick-block.open .fw-qb-item').count() > 0);

    const ta = pg.locator('#fwTextarea');
    await ta.click();
    await pg.keyboard.press('Control+End');
    await ta.pressSequentially('\n一步步', { delay: 20 });
    await pg.waitForTimeout(350);
    check('浮窗行内补全 ghost 出现', await pg.locator('.cmp-ghost').count() > 0);
  }

  if (WITH_CSP) {
    check(`${pageName} 无 CSP 违规`, cspViolations.length === 0, cspViolations.slice(0, 3).join(' | '));
  }
  await ctx.close();
}

await browser.close();
server.close();

let failed = 0;
for (const [ok, name, extra] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failed++;
}
console.log(failed === 0
  ? `\n全部 ${results.length} 项通过${WITH_CSP ? '（含 CSP 注入模式）' : ''}`
  : `\n${failed}/${results.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
