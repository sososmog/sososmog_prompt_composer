# CSP（内容安全策略）说明

`src-tauri/tauri.conf.json` 的 `app.security.csp` 之前是 `null`——完全没有 CSP。
应用大量使用 `innerHTML`（审查过一遍，目前所有用户数据都正确转义，没找到注入点），
但没有 CSP 意味着一旦哪处漏了转义，注入的脚本就能拿到全套 Tauri API（读写
`$HOME` 下任意文件、发 HTTP 到任意主机）。这份文档记录最终选定的 CSP 字符串、
每条指令为什么这么写，以及**尚未真机验证**这件事。

## 最终 CSP 字符串

```
default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'none'; worker-src 'none'
```

（写在 `src-tauri/tauri.conf.json` 里的一整条字符串；JSON 不支持注释，所以理由写在这里。）

## 逐条指令的理由

| 指令 | 取值 | 为什么 |
| --- | --- | --- |
| `default-src` | `'self'` | 兜底：任何没有单独列出的 fetch 指令都退回同源，不给任何外部来源留口子。 |
| `script-src` | `'self'` | 全部脚本都是同源的 `.js` 模块（`events.js` / `float.js`，`type="module"`）加同源的普通脚本（`theme-boot.js`）。**没有任何内联 `<script>`**——主题 bootstrap 已经从两份 HTML 里各自内联的一段代码，外置成共用的 `src/theme-boot.js`（非 module、放在样式表 `<link>` 之前，仍是同步阻塞执行，效果和内联等价，不会闪一下默认主题），所以 `script-src` 不需要 `'unsafe-inline'` 或 nonce。Tauri 编译时会给它自己注入的初始化脚本自动加 nonce/hash，那部分不需要我们手动开口子——但也不能假定它会替我们的代码放开一切，所以这里明确写成 `'self'` 而非更宽松的值。项目里没有用到 WebAssembly，故不需要 `'wasm-unsafe-eval'`。 |
| `style-src` | `'self'` | 只有同源的 `.css` 文件（`fonts.css` / `styles.css` / `float.css`），本次改动后已经不再有 Google Fonts 的外部样式表；代码里也没有 `<style>` 标签或 JS `createElement('style')`。**不需要** `'unsafe-inline'`。 |
| `style-src-attr` | `'unsafe-inline'` | `style` **属性**由 `style-src-attr` 单独管，不受 `style-src` 约束。项目里有真实用到：`float.html` 的 `<div style="position:relative;">`、`render.js` 的 `add.innerHTML = '...<span style="...">...'`、以及 `guide.js` / `backup.js` 里大量 `el.style.left/top/width/...= ...px` 的 JS 动态定位/显隐（新手引导遮罩跟手定位、导入导出冲突项的显隐等）。这些文件都不在本次改动范围内（`core.js`/`render.js`/`guide.js`/`backup.js` 等由其他并行任务负责），无法把它们改写成纯 class 切换，所以这里必须放开 `style-src-attr`，否则新手引导和一些动态定位功能会直接失效。 |
| `img-src` | `'self' data:` | 项目里用到的图形都是内联 SVG（直接写在 HTML/`innerHTML` 里的 `<svg>` 元素），不是 `<img>` 标签，理论上根本不受 `img-src` 约束；`data:` 是保底（万一以后哪里用 data URI 贴图）。没有任何外部图片域名。 |
| `font-src` | `'self'` | 任务 1 把字体本地化之后，字体文件（如果放了的话）都在同源的 `src/fonts/` 目录下，不再需要 `fonts.gstatic.com`。 |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Tauri v2 的 IPC 桥在 Windows 上通过 `http://ipc.localhost` 发起（webview 内部机制），其他平台走 `ipc:` 自定义协议；这条来自 Tauri 官方 CSP 文档给出的示例（`"connect-src": "ipc: http://ipc.localhost"`），必须保留，否则前端调用不了任何 Tauri 命令，直接白屏/功能全挂。**翻译请求不需要放行任何 LLM 域名**：`translate.js` 的正常路径是通过 Rust 侧的 `tauri-plugin-http` 发起（`window.__TAURI__.http.fetch`），这个请求完全在 Rust 进程里完成，不经过 webview 的网络层，不受 CSP 约束（真正需要放行的域名清单在 `src-tauri/capabilities/default.json` 的 `http:default` 权限里，那是另一套机制）。`translate.js` 里确实有一个用 `window.fetch` 的降级分支，但那只在**非 Tauri 的浏览器预览**环境下才会被走到（`httpFetch()` 优先取 `window.__TAURI__.http.fetch`，只有它不存在时才退到 `window.fetch`）；在真正的 Tauri 应用里这个分支不会被触发，CSP 挡掉它是可接受的。`'self'` 是保留余量，理论上目前没有任何同源 `fetch`/`XHR` 调用。 |
| `object-src` | `'none'` | 没有用到 `<object>`/`<embed>`/插件，直接锁死。 |
| `base-uri` | `'self'` | 防止注入 `<base>` 标签劫持相对路径解析。 |
| `form-action` | `'none'` | 项目里没有 `<form>` 元素（所有交互都是按钮 + JS），锁死。 |
| `worker-src` | `'none'` | 没有用到 `Worker`/`SharedWorker`，锁死。 |

## Tauri 的自动增强 —— 能信多少

Tauri v2 文档（`v2.tauri.app/security/csp/`）说明：编译时它会解析前端资源，
把「自己需要的」脚本/样式来源自动补进 CSP（本地脚本用 hash、外部脚本/样式用
nonce），目的是不需要开发者额外为 Tauri 自身注入的初始化代码开口子。**但这条
增强只覆盖 Tauri 自己生成/注入的内容，不会也不应该假定它替应用自身写的代码放
开一切**——这也是这次把两段主题 bootstrap 从内联改成外置文件的直接原因：不想
把「Tauri 会不会自动放行我的内联脚本」这件事当成賭注，外置成同源 `.js` 文件后，
`script-src: 'self'` 在任何 Tauri 版本行为下都必然成立，不依赖对方内部实现细节。

## 尚未真机验证

**这条 CSP 字符串没有在真实的 Tauri 应用里跑过**——本次改动是在一个可能没有网络、
且没有安装完整 Rust/Cargo 工具链的环境里做的，无法执行 `cargo build` / `tauri dev`
把应用真正跑起来看是否白屏。CSP 配置错一个指令就可能导致某个功能（甚至整个应用）
白屏，所以在合并前**必须**有人在真机上跑一遍下面这份清单。

### 真机验证清单

- [ ] 主窗口能正常渲染（不白屏，左栏/编辑区/按钮都出现）
- [ ] 打开 DevTools（右键 → 检查，或看 `webview.open_devtools()` 是否已启用）的
      Console，确认**没有** `Refused to ...because it violates the following
      Content Security Policy directive` 之类的 CSP 违规报错
- [ ] 主题切换按钮（深色/浅色）能正常生效，且刷新/重启后记住上次主题
      （验证 `theme-boot.js` 外置后仍然同步生效、不闪屏）
- [ ] 呼出/隐藏浮窗（默认快捷键 `Ctrl+Alt+C`）正常，浮窗内容渲染正常
- [ ] 浮窗字体看起来与主窗口一致（验证任务 1 的 `fonts.css` 共享生效；如果
      `src/fonts/` 目录是空的，两边应该都退化成同一套系统字体，而不是浮窗单独
      是 Segoe UI、主窗口是别的字体）
- [ ] 新手引导高亮遮罩能正常跟手定位（验证 `style-src-attr 'unsafe-inline'`
      放开了 `guide.js` 的动态内联样式）
- [ ] 一键翻译功能正常发起请求并写回结果（验证 Rust 侧 `http` 插件请求不受
      webview CSP 影响；如果报错，检查是不是走到了 `translate.js` 里 `window.fetch`
      的降级分支——那条分支在真实 Tauri 环境里不应该被触发）
- [ ] 配置导入导出（`backup.js`）弹窗、冲突项高亮/隐藏正常
      （同样依赖 `style-src-attr`）
- [ ] 复制到剪贴板、下载 `.md`（保存对话框）正常
- [ ] 应用内检查更新流程正常（不确定 updater 是否有自己的网络/脚本需求，
      建议留意这一步是否报 CSP 相关错误）

宁可这份清单跑完之前保守一点：如果发现某个功能因为 CSP 报错而失效，优先考虑
是不是漏列了某个同源资源或者 Tauri 需要的来源，而不是直接放宽成 `'unsafe-inline'`
或删掉整条 CSP。
