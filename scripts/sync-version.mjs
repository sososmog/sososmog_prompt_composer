/*
 * scripts/sync-version.mjs
 *
 * package.json 的 version 和 src-tauri/tauri.conf.json 的 version 曾经靠人手同步，
 * 容易漂移。这个脚本提供两种用法：
 *
 *   node scripts/sync-version.mjs             —— 校验模式（默认）：
 *       读两个文件的 version，不一致就打印差异并以非 0 退出；一致则打印 OK 退出 0。
 *
 *   node scripts/sync-version.mjs --set X.Y.Z —— 写入模式：
 *       把两个文件的 version 都改写成 X.Y.Z。
 *
 * 两个踩过的坑，这里都要处理对：
 *   1. MSI 打包要求 version 字段必须是纯 `数字.数字.数字`，不接受 `-Beta` 之类
 *      后缀（后缀只能进 git tag / GitHub Release 名字，不能进 version 字段）。
 *      所以 --set 模式强制校验格式，格式不对给出明确的中文报错说明原因。
 *   2. 两个目标文件都是人工维护的 JSON，缩进风格（2 空格）、键顺序（尤其
 *      tauri.conf.json 开头的 $schema）必须原样保留——所以这里用「正则替换
 *      version 那一行的值」而不是 JSON.parse 再 JSON.stringify，避免把整个
 *      文件的键序打乱、格式压扁。写文件用不带 BOM 的 UTF-8（Node 的
 *      fs.writeFileSync 配 'utf8' 编码本身就不会加 BOM）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CONF_PATH = path.join(ROOT, 'src-tauri', 'tauri.conf.json');

// 只匹配顶层的 "version": "x.y.z" 这一行；两个目标文件里 version 字段都只出现一次。
const VERSION_RE = /("version"\s*:\s*")([^"]*)(")/;
const PURE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

function readVersion(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const m = text.match(VERSION_RE);
  if (!m) {
    console.error(`没在 ${filePath} 里找到 "version" 字段，脚本假设的格式可能不对。`);
    process.exit(1);
  }
  return { text, version: m[2] };
}

function writeVersion(filePath, text, newVersion) {
  const next = text.replace(VERSION_RE, (_whole, pre, _old, post) => pre + newVersion + post);
  // 显式 'utf8' 编码写入，不带 BOM；只替换 version 这一行的值，其余内容
  // （缩进、键顺序、$schema 等）原样保留。
  writeFileSync(filePath, next, 'utf8');
}

function check() {
  const pkg = readVersion(PKG_PATH);
  const conf = readVersion(CONF_PATH);
  if (pkg.version !== conf.version) {
    console.error('版本号不一致：');
    console.error(`  package.json              = ${pkg.version}`);
    console.error(`  src-tauri/tauri.conf.json  = ${conf.version}`);
    console.error('请用 `node scripts/sync-version.mjs --set X.Y.Z` 同步（或 `npm run version:set -- X.Y.Z`）。');
    process.exit(1);
  }
  console.log(`OK：两处 version 一致（${pkg.version}）`);
  process.exit(0);
}

function set(newVersion) {
  if (!PURE_SEMVER_RE.test(newVersion)) {
    console.error(`版本号格式不对："${newVersion}"`);
    console.error('必须是纯 `数字.数字.数字`（例如 0.2.1），不能带 -Beta 等后缀 ——');
    console.error('MSI 打包不接受 version 字段里出现后缀；后缀只能放进 git tag / GitHub Release 名字。');
    process.exit(1);
  }
  const pkg = readVersion(PKG_PATH);
  const conf = readVersion(CONF_PATH);
  writeVersion(PKG_PATH, pkg.text, newVersion);
  writeVersion(CONF_PATH, conf.text, newVersion);
  console.log(`OK：已把 package.json 和 src-tauri/tauri.conf.json 的 version 都写成 ${newVersion}`);
  process.exit(0);
}

const args = process.argv.slice(2);
const setIdx = args.indexOf('--set');
if (setIdx !== -1) {
  const value = args[setIdx + 1];
  if (!value) {
    console.error('用法：node scripts/sync-version.mjs --set X.Y.Z');
    process.exit(1);
  }
  set(value);
} else {
  check();
}
