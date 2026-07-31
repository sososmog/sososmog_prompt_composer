/* 校验浮窗里「文字压在色块上」那几处的对比度是否达到 WCAG AA。
 *
 * 为什么需要它：Agent 面板的状态色（--fleet-attention / --fleet-danger）在**深色
 * 主题下本身是浅色**——它们的设计用途是"深底上的前景文字"。一旦被拿来当填充背景
 * 再配白字，对比度会掉到 2.5~3.0，连大字号 AA 的 3.0 都不到。
 *
 * 而这种缺陷**肉眼只觉得"有点发灰"，不会明显觉得坏**，靠人看几乎发现不了；
 * 真机验收、截图对比、单测都不会拦住它。只能算。
 *
 * 运行：node scripts/check-contrast.mjs
 *
 * ⚠️ 曾经踩过的坑：第一版核对脚本用 `css.indexOf('[data-theme="dark"]')` 定位深色
 * 变量块，结果命中了 float.css 顶部注释里出现的同一串文字，于是"深色块"实际抓到
 * 的是紧跟其后的 `:root`——等于拿浅色跟自己比，**无论有没有问题都会通过**。
 * 所以下面按行匹配"整行就是选择器且以 { 结尾"，并显式跳过注释行。
 */
import fs from 'node:fs';

const CSS_PATH = 'src/float.css';

/** 被检查的组合：文字变量压在背景变量上，用在哪个选择器上（仅用于报错时定位）。 */
const PAIRS = [
  { fg: 'fleet-on-attention', bg: 'fleet-attention', where: '.fw-tab-badge（tab 角标，9.5px 小字）' },
  { fg: 'fleet-on-danger', bg: 'fleet-danger', where: '.fw-fleet-error（错误横条，10.5px 小字）' },
];

/** 小字号 AA 要求 4.5:1。这里全是小字，所以不给大字号的 3.0 开后门。 */
const REQUIRED = 4.5;

const lines = fs.readFileSync(CSS_PATH, 'utf8').split('\n');

/** 取出「整行就是该选择器且以 { 结尾」的声明块内容。跳过注释行，见文件头注释。 */
function grabBlock(selectorRe) {
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
    if (selectorRe.test(t) && t.endsWith('{')) {
      const out = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '}') return out.join('\n');
        out.push(lines[j]);
      }
    }
  }
  return null;
}

/** 解析变量值，最多跟随 5 层 var() 间接引用；本主题查不到就回落到浅色块（CSS 的继承语义）。 */
function resolve(block, name, fallbackBlock) {
  const read = (b, n) => {
    const m = (b || '').match(new RegExp(`--${n}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  let v = read(block, name) ?? read(fallbackBlock, name);
  for (let i = 0; i < 5 && v && v.startsWith('var('); i += 1) {
    const inner = v.slice(4, -1).trim().replace(/^--/, '');
    v = read(block, inner) ?? read(fallbackBlock, inner);
  }
  return v;
}

function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = grabBlock(/^:root\s*\{$/);
const dark = grabBlock(/^\[data-theme="dark"\]\s*\{$/);

let failed = 0;
if (!light || !dark) {
  console.error(`✗ 在 ${CSS_PATH} 里找不到 :root 或 [data-theme="dark"] 变量块（选择器写法改了？）`);
  process.exit(1);
}

for (const { fg, bg, where } of PAIRS) {
  for (const [themeName, block] of [['浅色', light], ['深色', dark]]) {
    const fgVal = resolve(block, fg, light);
    const bgVal = resolve(block, bg, light);
    if (!fgVal?.startsWith('#') || !bgVal?.startsWith('#')) {
      console.error(`✗ ${themeName} --${fg} / --${bg} 解析不出 hex：${fgVal} / ${bgVal}`);
      failed += 1;
      continue;
    }
    const r = contrast(fgVal, bgVal);
    const ok = r >= REQUIRED;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${themeName} ${where}\n     ${fgVal} on ${bgVal} = ${r.toFixed(2)}:1（要求 ≥ ${REQUIRED}）`
    );
  }
}

if (failed) {
  console.error(`\n${failed} 项不达标。别靠调整观感解决——重算，或换用更深/更浅的底色。`);
  process.exit(1);
}
console.log('\n全部达标');
