/* ============================================================
 * fetch-fonts.mjs —— 把界面用到的三套 Web 字体抓成本地自托管文件
 * ------------------------------------------------------------
 * 为什么要自托管：改动前 index.html 直接从 fonts.googleapis.com 加载字体，
 * 一个纯本地离线工具每次启动都往 Google 发一次请求（隐私 + 断网/墙内首屏
 * 降级），而且开了 CSP 之后 font-src 还得为此放开外部域名。更关键的是浮窗
 * 文档从来没有引过那个 <link>，@font-face 是按文档生效的，所以浮窗一直在用
 * 系统字体、和主窗口不一致。
 *
 * 为什么把这个脚本留在仓库里：字体文件是二进制、无法在 diff 里审查，留一个
 * 可复现的抓取脚本才说得清「这些 woff2 是从哪来的、怎么再生成一遍」。
 *
 * 用法：node scripts/fetch-fonts.mjs
 * 产出：src/fonts/*.woff2 + src/fonts.css（整份重新生成，不要手改 fonts.css）
 *
 * 只取 latin / latin-ext 两个子集：这三套字体本身都不含中文字形，界面中文由
 * font-family 链里的 PingFang SC / 微软雅黑 等系统字体承担，抓 cyrillic /
 * greek / vietnamese 只会白白增大安装包。
 *
 * 许可证：Fraunces、Inter、IBM Plex Mono 均为 SIL Open Font License 1.1，
 * 允许自托管与随应用分发（见 src/fonts/README.md）。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUT_DIR = 'src/fonts';
const CSS_OUT = 'src/fonts.css';

// query：给 Google css2 的 family 参数；weights：CSS 里实际用到的字重
const FAMILIES = [
  { name: 'Fraunces', slug: 'fraunces', query: 'Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700', weights: [500, 600, 700] },
  { name: 'Inter', slug: 'inter', query: 'Inter:wght@400;450;500;600', weights: [400, 450, 500, 600] },
  { name: 'IBM Plex Mono', slug: 'ibm-plex-mono', query: 'IBM+Plex+Mono:wght@400;500;600', weights: [400, 500, 600] },
];

async function get(url, asBuffer) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// 把 Google 返回的 css 拆成 { subset, weight, url, unicodeRange } 列表，只留 latin/latin-ext
function parseFaces(css) {
  const out = [];
  for (const raw of css.split(/\/\*\s*/).slice(1)) {
    const subset = raw.slice(0, raw.indexOf(' *')).trim();
    if (subset !== 'latin' && subset !== 'latin-ext') continue;
    const w = raw.match(/font-weight:\s*(\d+)/);
    const u = raw.match(/url\((https:[^)]+\.woff2)\)/);
    const r = raw.match(/unicode-range:\s*([^;]+);/);
    if (w && u && r) out.push({ subset, weight: +w[1], url: u[1], unicodeRange: r[1].trim() });
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.woff2')) fs.unlinkSync(path.join(OUT_DIR, f)); // 整份重抓，先清旧文件避免残留
}

let cssParts = [`/* ============================================================
 * fonts.css —— 本地自托管字体声明（由 scripts/fetch-fonts.mjs 生成，请勿手改）
 * ------------------------------------------------------------
 * 设计上刻意做到「文件缺失也不影响可用性」：@font-face 的 url 取不到时浏览器
 * 会静默回退到 font-family 链里的下一项（见 styles.css 的 --font-sans /
 * --font-mono / --font-display，链尾都有系统字体），所以即便有人 clone 之后
 * 没跑 fetch-fonts.mjs，应用照常工作、只是用系统字体。
 *
 * Fraunces 与 Inter 是可变字体：Google 对多个字重返回的是同一个文件，由浏览器
 * 按 wght 轴合成字重。因此这里用「一条 @font-face + font-weight 区间」声明，
 * 而不是按字重拆成多条指向同一文件的规则（那样会让浏览器重复下载同一份数据）。
 * IBM Plex Mono 是静态字体，每个字重各一个文件。
 *
 * unicode-range 照搬 Google 的拆分：只有页面真的出现 latin-ext 字符时才会去下载
 * 那一份，平时只付 latin 子集的体积。
 * ============================================================ */
`];

for (const fam of FAMILIES) {
  const faces = parseFaces(await get(`https://fonts.googleapis.com/css2?family=${fam.query}&display=swap`, false));
  // 按 (subset, url) 归组：可变字体同一 subset 下多个字重共享 url，归成一条
  const groups = new Map();
  for (const face of faces) {
    if (!fam.weights.includes(face.weight)) continue;
    const k = face.subset + '|' + face.url;
    if (!groups.has(k)) groups.set(k, { ...face, weights: [] });
    groups.get(k).weights.push(face.weight);
  }
  for (const g of groups.values()) {
    const variable = g.weights.length > 1;
    const lo = Math.min(...g.weights), hi = Math.max(...g.weights);
    const file = `${fam.slug}${variable ? '-var' : '-' + g.weights[0]}${g.subset === 'latin-ext' ? '-ext' : ''}.woff2`;
    fs.writeFileSync(path.join(OUT_DIR, file), await get(g.url, true));
    cssParts.push(`@font-face {
  font-family: '${fam.name}';
  font-style: normal;
  font-weight: ${variable ? lo + ' ' + hi : lo};
  font-display: swap;
  src: url('fonts/${file}') format('woff2');
  unicode-range: ${g.unicodeRange};
}`);
    console.log(String(fs.statSync(path.join(OUT_DIR, file)).size).padStart(7), 'B ', file, variable ? `(可变字体 ${lo}-${hi})` : `(${lo})`);
  }
}

fs.writeFileSync(CSS_OUT, cssParts.join('\n\n') + '\n', 'utf8');
const total = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.woff2'))
  .reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`\n共 ${fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.woff2')).length} 个文件，合计 ${(total / 1024).toFixed(0)} KB`);
console.log('已重新生成 ' + CSS_OUT);
