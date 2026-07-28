/* 主题 bootstrap —— 必须在 CSS 生效前同步执行，避免首屏主题闪烁。
 * 原来这段逻辑分别内联在 index.html 与 float.html 的 <head> 里（两份完全相同的
 * 代码）；开启 CSP 后想让 script-src 收紧到不含 'unsafe-inline'，同源的外置 .js
 * 文件天然只需要 'self'，不用再为内联脚本单独开口子，所以把它提出来共用一份。
 *
 * 外置成普通（非 module、非 async/defer）脚本仍然是同步阻塞执行的：浏览器解析
 * 到 <script src="theme-boot.js"> 时会暂停 HTML 解析、下载并立即执行完这段代码，
 * 才会继续往下解析到 <link rel="stylesheet">，效果和原来内联等价——只要这个
 * <script> 标签放在两份 HTML 里所有样式表 <link> 之前即可。本地文件走 Tauri 的
 * tauri:// / http://tauri.localhost 协议读取本机资源，取文件几乎零延迟，不会引入
 * 可感知的白屏时间。
 *
 * 与 localStorage 的 composer-theme 键保持一致：默认深色，仅当显式为 'light' 时
 * 才不加 data-theme（浮窗与主窗口共享同一个 localStorage 键，二者读到的值相同）。
 */
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('composer-theme') || 'dark'; } catch { /* 存储不可用，按默认深色处理 */ }
  if (t !== 'light') document.documentElement.setAttribute('data-theme', 'dark');
})();
