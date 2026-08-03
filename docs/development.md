# 开发指南

本文档面向参与 Composer 开发的贡献者，涵盖环境搭建、项目结构、测试、打包发布等内容。

用户使用说明请看 [README.md](../README.md)。

---

## 开发环境准备

无论哪个平台，都需要以下两样基础工具：

| 工具 | 说明 | 安装 |
| --- | --- | --- |
| **Node.js** | >= 18 LTS，提供 `npm` 用于安装前端依赖与 Tauri CLI | <https://nodejs.org> |
| **Rust** | 稳定版工具链（含 `cargo`），Tauri 后端编译需要 | `rustup`：<https://rustup.rs> |

安装完成后校验：

```bash
node -v      # v18+
cargo -V     # cargo 1.77+
```

### 各平台系统依赖

Tauri 使用系统原生 WebView，不同平台需要不同的系统库/构建工具。**这一步是能否成功编译的关键。**

<details open>
<summary><b>macOS</b></summary>

1. 安装 Xcode Command Line Tools：
   ```bash
   xcode-select --install
   ```
2. WebView 使用系统自带的 WKWebView，无需额外安装。
3. 签名与公证需要 Apple 开发者账号（本地开发可跳过）。
4. 「自动粘贴到外部窗口」需在「系统设置 → 隐私与安全性 → 辅助功能」中授权。该平台的粘贴实现（`src-tauri/src/lib.rs` 中的 `macos` 模块）目前仅按 API 文档编写，尚未在真机编译验证。

> 交叉架构：Apple Silicon 上可通过 `rustup target add x86_64-apple-darwin` 增加 Intel 目标，用 `--target` 分别打包，或用 `universal-apple-darwin` 出通用包。
</details>

<details>
<summary><b>Windows</b></summary>

1. **Microsoft C++ Build Tools**（MSVC 工具链）：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」工作负载。
2. **WebView2 Runtime**：Windows 11 通常已内置；Windows 10 若缺失，从微软官网安装 [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
3. 打包 `.msi` 需要 WiX（Tauri CLI 会在首次构建时自动下载），打包 `.exe`（NSIS）同理自动获取。

> 本仓库当前开发环境即为 Windows 11，「自动粘贴到外部窗口」「全局热键呼出浮窗」等功能均已在此平台真机验证。
</details>

<details>
<summary><b>Linux</b></summary>

需要 WebKitGTK 及相关开发库。以 Debian / Ubuntu 为例：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential curl wget file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

- Fedora：`sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel` + `sudo dnf group install "C Development Tools and Libraries"`
- Arch：`sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg`

不同发行版包名可能略有差异，以 [Tauri 官方 Linux 前置条件](https://v2.tauri.app/start/prerequisites/) 为准。

> 浮窗的「自动粘贴到外部窗口」功能目前只实现了 Windows / macOS 两个平台，Linux 上调用会直接返回「当前平台暂不支持自动粘贴」，其余功能不受影响。
</details>

---

## 安装依赖

```bash
npm install
```

前端 JS 依赖：`@tauri-apps/api`、`plugin-fs`、`plugin-dialog`、`plugin-clipboard-manager`、`plugin-updater`、`plugin-process`、`plugin-opener`；开发依赖含 `@tauri-apps/cli`、`vitest`（+ `@vitest/coverage-v8` / `jsdom`）与 `eslint`。

Rust 侧依赖会在首次 `dev` / `build` 时由 Cargo 自动拉取，无需手动安装。

---

## 开发运行

```bash
npm run tauri dev
```

- 启动主窗口（标题 Composer，默认 1200x800，最小 900x600）。
- 前端为纯静态文件、原生 ESM 分模块，修改后刷新对应窗口即可看到变化。
- 按下 `Ctrl+Alt+C`（或在设置面板中自定义后的快捷键）可呼出/隐藏浮窗。

> 也可以直接用浏览器打开 `src/index.html` 预览主窗口界面（此时无 Tauri 环境，持久化/系统剪贴板/保存对话框/浮窗热键/一键翻译等能力会自动降级为浏览器行为或空操作，UI 仍可正常操作）。

---

## 测试与静态检查

用 [Vitest](https://vitest.dev/) 覆盖（jsdom 环境），用例位于 `src/__tests__/`。
除纯逻辑层外，主窗口 UI 层也有测试：做法是把真实 `index.html` 的 `<body>` 灌进 jsdom 再动态 `import`，测的是真实页面结构而不是手写的假 DOM。

```bash
npm test          # vitest run，跑一遍全部用例
npm run test:cov  # 附带 v8 覆盖率（统计整个 src/）
npm run lint      # eslint 全量检查
```

另有几个**真浏览器**端到端冒烟脚本（需要本机有 playwright 的 chromium 缓存，因此不在 CI 里跑；路径可用 `PW_MODULE` / `PW_CHROME` 环境变量覆盖）：

```bash
npm run smoke        # 起静态 server + Chromium 打开两份 HTML，跑 30 项交互断言
npm run smoke:csp    # 额外把 tauri.conf.json 的 CSP 用 <meta> 注入，检查有无违规
npm run smoke:fleet  # 浮窗 Agent 面板：tab 切换 + 非 Tauri 环境的降级路径
```

> `smoke:fleet` 的理由是 jsdom 测不到"真浏览器里 `window.__TAURI__` 压根不存在且 ESM 模块图正常加载"这个组合——`float.js` 顶层就 import 了 Agent 面板的模块，任何一处对 Tauri 的无保护访问都会让整个模块挂掉。这类脚本**必须走 http 而不是 `file://`**，后者会被 Chrome 的 CORS 拦掉 `<script type="module">`。

`npm run smoke` 覆盖的是「单测全绿但应用可能起不来」那一类问题：启动、样式生效、素材渲染、插入、Markdown 高亮、中英切换、预览分栏、设置面板各 tab、主题切换、以及两个窗口的行内补全。

### 版本号同步

`package.json` 与 `src-tauri/tauri.conf.json` 里各有一份 `version` 字段，用 `scripts/sync-version.mjs` 校验/同步：

```bash
npm run version:check       # 校验模式：两处 version 不一致就报错退出
npm run version:set 0.2.1   # 写入模式：把两处 version 都改成 0.2.1
```

只接受纯 `数字.数字.数字` 格式——MSI 打包要求 `version` 字段是纯数字，`-Beta` 之类后缀只能放 git tag / GitHub Release 名字里。

### 字体

界面字体是自托管的（不运行时请求 Google Fonts）。用脚本抓取并重新生成 `src/fonts.css`：

```bash
npm run fonts   # 重新抓取 src/fonts/*.woff2 并重新生成 src/fonts.css
```

---

## 打包发布

```bash
npm run tauri build
```

各平台产物（位于 `src-tauri/target/release/bundle/`）：

| 平台 | 产物格式 |
| --- | --- |
| macOS | `.app`、`.dmg` |
| Windows | `.msi`（WiX）、`.exe`（NSIS 安装器） |
| Linux | `.deb`、`.rpm`、`.AppImage` |

> Tauri 一般只能在目标平台上打对应平台的包。

### 打包前替换应用图标

正式发布前，用一张 >= 1024x1024 的源图生成全平台图标：

```bash
npm run tauri icon path/to/your-icon.png
```

### CI 自动发布

仓库内置 `.github/workflows/release.yml`：推送 `v*` 格式的 tag（或手动 `workflow_dispatch` 指定 tag）会触发 GitHub Actions（`windows-latest`），自动构建并创建 Draft Release，同时生成 `latest.json` 更新清单。

签名密钥通过仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）注入，公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 中。

### 应用内更新机制

`tauri.conf.json` 中 `plugins.updater.endpoints` 指向本仓库 GitHub Release 的 `latest.json`。应用启动 3 秒后静默检查一次（可在设置里关掉）。

检查与安装是分开的两步，永远不会自动升级：查到新版本只会在设置页提示并显示「下载并安装」按钮。

---

## 项目结构

```
.
├── package.json
├── docs/
│   ├── development.md         # 本文件
│   ├── csp.md                 # CSP 策略说明
│   └── agent-fleet.md         # Agent 面板方案文档
├── scripts/
│   └── sync-version.mjs       # 版本号校验与同步
├── .github/workflows/
│   └── release.yml            # CI 自动构建与发布
├── src/
│   ├── index.html             # 主窗口 UI
│   ├── float.html             # 浮窗 UI
│   ├── main.js                # 入口：装配模块图后调用 bootstrap()
│   ├── core.js                # 纯逻辑层（无 DOM）：预设数据/token 估算/补全打分/自学习
│   ├── store.js               # 运行时状态 + 持久化 + 双向同步
│   ├── render.js              # 左栏模块库 / 右栏编辑器渲染 + 块拖拽
│   ├── quick.js               # 快速段落 + 管理面板
│   ├── events.js              # 装配入口：语言/视图切换、输出、设置、浮窗开关、快捷键等
│   ├── backup.js              # 配置导入导出
│   ├── translate.js           # 一键翻译
│   ├── guide.js               # 新手引导
│   ├── completion.js          # 行内自动补全交互层
│   ├── fleet.js               # Agent 面板纯判定层（状态推断/subagent 树/分组排序）
│   ├── fleetView.js           # Agent 面板 DOM 层 + 轮询调度
│   ├── materials.js           # 素材解析（主窗口与浮窗共用）
│   ├── pool.js                # 补全候选池 + 学习数据读写入口
│   ├── sync.js                # state 持久化 + 双窗口广播
│   ├── statefile.js           # 原子写 / 容错读
│   ├── edit.js                # textarea 文本插入（保撤销栈）
│   ├── float.js               # 浮窗交互逻辑
│   ├── theme-boot.js          # 主题 bootstrap（避免首屏闪烁）
│   ├── styles.css             # 主窗口样式
│   ├── float.css              # 浮窗样式
│   ├── fonts.css              # 本地字体声明
│   ├── fonts/                 # 自托管字体 woff2
│   └── __tests__/             # Vitest 用例 + 冒烟脚本 + fixtures
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json        # 窗口定义、打包配置、updater 端点与公钥
    ├── capabilities/
    │   └── default.json       # 插件权限声明
    ├── icons/                 # 应用图标
    └── src/
        ├── lib.rs             # 插件注册、全局热键、自定义命令
        └── main.rs            # 入口
```

### 前端分层

前端无框架、无打包器，原生 ESM 分模块。主窗口按以下顺序分层：

`core.js`（纯逻辑）→ `store.js`（状态）→ `render.js`（渲染）→ `quick.js`（浮窗/面板）→ `events.js`（装配入口）

主窗口与浮窗共用 `materials.js`、`pool.js`、`sync.js`、`statefile.js`、`edit.js`、`completion.js` 以避免实现漂移。

### 数据持久化

数据文件 `composer-state.json` 位于系统应用数据目录：

- macOS：`~/Library/Application Support/com.composer.app/`
- Windows：`%APPDATA%\com.composer.app\`
- Linux：`~/.config/com.composer.app/`

浮窗的「自动粘贴开关」状态只存在浏览器 `localStorage`，不写入 `composer-state.json`。

---

## 常见开发问题

- **`npm run tauri dev` 报缺少系统库 / 链接错误** → 回到「各平台系统依赖」小节补装对应库（Linux 最常见）。
- **Windows 编译报找不到 MSVC / link.exe** → 未安装 C++ Build Tools。
- **开启 CSP 后某功能白屏 / DevTools Console 报 `Refused to ... Content Security Policy`** → 见 [csp.md](csp.md)，优先确认是不是漏放了同源资源或 Tauri 需要的来源，不要直接删掉 CSP 或改成 `'unsafe-inline'`。
- **字体显示为系统默认** → `src/fonts/` 下的 `.woff2` 缺失，跑一次 `npm run fonts` 重新抓取。
- **两个版本号文件不一致** → 用 `npm run version:check` 校验、`npm run version:set X.Y.Z` 同步。

### Agent 面板诊断

Agent 面板读取的是各家 agent 写在本地的会话文件，属于未公开的内部实现，上游改格式就可能读不出来。诊断命令：

```bash
cd src-tauri
cargo test --test fleet_real_machine -- --ignored --nocapture
```

它会打印采集层在你机器上认出的全部内容。**输出含真实的会话标题、分支和工作目录，贴到 issue 之前先看一眼。**

设计取舍、数据来源和踩过的坑记在 [agent-fleet.md](agent-fleet.md)。
