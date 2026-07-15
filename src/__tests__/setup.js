// core.js 是无 import/export 的 IIFE，靠 window.Composer 挂载 + module.exports
// 兼容导出（见 src/core.js 末尾）。createRequire 走 Node 原生 CJS loader，
// 不共享 Vitest jsdom 环境注入的全局 window，因此这里显式挂上 global.window
// 再 require，core.js 顶层的 `window.Composer = window.Composer || {}` 才能跑通。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadComposer() {
  if (typeof global.window === 'undefined') {
    global.window = global;
  }
  delete require.cache[require.resolve('../core.js')];
  require('../core.js');
  return global.window.Composer;
}
