# Composer · 模块化提示词构建工具

一个用 **Tauri 2.x** 构建的跨平台桌面应用，用于「像搭积木一样」组装 AI 提示词。前端为原生 HTML/CSS/JS（无框架、无打包器，原生 ESM 分模块），纯逻辑抽离进 `core.js`，运行时按 store（状态）/ render（渲染）/ quick（浮窗）/ events（装配入口）分层，供主窗口与浮窗共用；Rust 侧除应用壳外，还实现了全局热键、窗口记忆、自动粘贴到外部窗口等桌面能力，可打包为 macOS / Windows / Linux 桌面程序，并支持应用内自动更新。

## 功能一览

### 主窗口

- 左栏模块库：点击标签往装配区追加模块（角色 / 场景 / 问题 / 规则 / 工作流程 / 输出格式 …）
- 中栏装配区：模块卡片可改名、编辑、启用/停用、上下排序、删除
- 变量系统：内容中写 `{{名称}}` 即创建变量；变量名中英共用、值按语言分别填写
- 右栏检视：变量填写、中英双语 Token 估算对比卡、编译预览（标题/正文/变量三处可直接点击内联编辑）
- 常用句：每个模块下方内置常用句，可一键插入光标处，支持自定义增删
- **行内自动补全**：在模块正文里打字时，编辑区会以灰字（ghost text）预览接续内容，`Tab` / `→` 采纳、`Esc` 取消；只在光标位于文本末尾、且不在代码块内时提示。候选来自内置常用句/段落，以及一套**本地自学习引擎**——每当你完整复制或导出一段文本，就会把其中的子句/片段学下来，越用越贴合你的写法（数据只存在本机，可在设置面板关闭；关闭仅停用，不清除已学数据）
- **自学习数据管理**：设置面板「自学习」页可查看、逐条删除或一键清空学到的片段，并支持把自学习数据单独导入/导出为文件（与配置备份相互独立）
- **快速段落**：独立功能区，支持自定义分组（两级结构：分组 → 段落），下拉展开后点击即可插入预设文本，可通过管理面板增删分组/段落、调整顺序
- **一键翻译**：把当前语言正文按块整体翻译到另一种语言并写回对应槽位。内置 Google Gemini / GLM 智谱 / Groq / OpenRouter 以及「自定义（OpenAI 兼容）」端点，可在设置面板选择服务商、填 API Key 与模型；请求经 Tauri `http` 插件直发（绕开浏览器 CORS，Key 只留在应用侧），代码块会被遮罩不参与翻译，失败时不改动任何已有内容
- **配置导入导出**：把素材库 / 变量 / 设置等打包为 `.json` 备份文件，导入时可预览摘要并按名称判重合并。**API Key 从不导出，导入也永不清空本机 Key**
- **新手引导**：首次启动的最短路径高亮遮罩引导（含一步真实交互），以及初次接近某功能时的锚定轻提示；是否看过的标记随状态落盘
- 复制到系统剪贴板、导出 `.md`（系统保存对话框）
- 本地持久化：所有状态存到应用数据目录，重开应用自动恢复
- 应用内更新：启动时静默检查 GitHub Release（可在设置里关掉），有新版本只提示不自动装，下载安装始终由你在「设置 → 关于」里点一下触发

### 浮窗模式

- 全局快捷键（默认 `Ctrl+Alt+C`，可在设置面板自定义）随时呼出/隐藏一个置顶小窗，无需切回主窗口即可复制常用句/模块内容
- 浮窗内的编辑同样支持上面的**行内自动补全**（灰字预览、`Tab`/`→` 采纳），与主窗口共用同一套候选池与自学习数据
- **一键缩小为悬浮小球**：点击浮窗右上角的收拢图标，可把整个浮窗缩成一个约 52×52 的置顶小圆球，暂时不用时不占屏幕；单击小球即原地恢复到缩小前的尺寸，按住小球可拖动挪位
- 窗口位置与尺寸会被记住，下次呼出恢复原位（不记忆可见性，默认仍是隐藏启动）
- **自动粘贴到外部窗口**（Windows 已在真机验证；macOS 为未编译验证的草稿实现）：开启开关后，点击浮窗内容会先复制到剪贴板，再自动切回你刚才操作的窗口并模拟粘贴，粘贴前等待时长可配置
- 粘贴失败会做一次重试，且不会因目标窗口已关闭而误操作到其它窗口

---

## 一、开发环境准备

无论哪个平台，都需要以下两样基础工具：

| 工具 | 说明 | 安装 |
| --- | --- | --- |
| **Node.js** | ≥ 18 LTS，提供 `npm` 用于安装前端依赖与 Tauri CLI | <https://nodejs.org> |
| **Rust** | 稳定版工具链（含 `cargo`），Tauri 后端编译需要 | `rustup`：<https://rustup.rs> |

安装完成后校验：

```bash
node -v      # v18+ 
cargo -V     # cargo 1.77+
```

### 各平台还需额外配置的系统依赖

Tauri 使用系统原生 WebView，因此不同平台要装不同的系统库/构建工具。**这一步是能否成功编译打包的关键。**

<details open>
<summary><b>🍎 macOS</b></summary>

1. 安装 Xcode Command Line Tools（提供 Clang、系统 SDK）：
   ```bash
   xcode-select --install
   ```
2. WebView 使用系统自带的 **WKWebView**，无需额外安装。
3. 若要给 `.app` / `.dmg` 签名与公证，需 Apple 开发者账号（本地自用可跳过）。
4. 若要使用「自动粘贴到外部窗口」功能，需在「系统设置 → 隐私与安全性 → 辅助功能」中为本 App 授权，否则模拟按键会被系统静默拒绝。该平台的粘贴实现（`src-tauri/src/lib.rs` 中的 `macos` 模块）目前仅按 API 文档编写，尚未在真机编译验证。

> 交叉架构：Apple Silicon 上可通过 `rustup target add x86_64-apple-darwin` 增加 Intel 目标，用 `--target` 分别打包，或用 `universal-apple-darwin` 出通用包。
</details>

<details>
<summary><b>🪟 Windows</b></summary>

1. **Microsoft C++ Build Tools**（MSVC 工具链）：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」工作负载。
2. **WebView2 Runtime**：Windows 11 通常已内置；Windows 10 若缺失，从微软官网安装 [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
3. 打包 `.msi` 需要 WiX（Tauri CLI 会在首次构建时自动下载），打包 `.exe`（NSIS）同理自动获取。

> 本仓库当前开发环境即为 Windows 11，「自动粘贴到外部窗口」「全局热键呼出浮窗」等功能均已在此平台真机验证。
</details>

<details>
<summary><b>🐧 Linux</b></summary>

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

## 二、安装依赖

在项目根目录执行一次（安装 Tauri CLI 与前端 JS 依赖包）：

```bash
npm install
```

前端 JS 依赖：`@tauri-apps/api`、`plugin-fs`、`plugin-dialog`、`plugin-clipboard-manager`、`plugin-updater`、`plugin-process`、`plugin-opener`；开发依赖含 `@tauri-apps/cli`、`vitest`（+ `@vitest/coverage-v8` / `jsdom`）与 `eslint`。

Rust 侧依赖（`tauri`、文件系统/对话框/剪贴板/更新器/进程/全局热键/窗口状态记忆/`http` 等插件，以及 Windows 下的 `windows-sys`、macOS 下的 `objc2` 系列、跨平台的按键模拟库 `enigo`）会在首次 `dev` / `build` 时由 Cargo 自动拉取，无需手动安装。其中「一键翻译」的网络请求走 `tauri-plugin-http`，前端通过 `window.__TAURI__.http.fetch` 调用，无对应 JS 包依赖。

---

## 三、开发运行

```bash
npm run tauri dev
```

- 启动主窗口（标题 Composer，默认 1200×800，最小 900×600）。
- 前端为纯静态文件、原生 ESM 分模块：纯逻辑在 [src/core.js](src/core.js)，主窗口按 [src/store.js](src/store.js)（状态/持久化）→ [src/render.js](src/render.js)（渲染）→ [src/quick.js](src/quick.js)（浮窗/管理面板）→ [src/events.js](src/events.js)（装配入口）分层，浮窗逻辑在 [src/float.js](src/float.js)；主窗口与浮窗共用一套模块以避免实现漂移：[src/materials.js](src/materials.js)（素材解析）、[src/pool.js](src/pool.js)（补全候选池）、[src/sync.js](src/sync.js)（持久化+双窗口广播）、[src/statefile.js](src/statefile.js)（原子写）、[src/edit.js](src/edit.js)（保撤销栈的文本插入）；另有 [src/backup.js](src/backup.js)（导入导出）、[src/translate.js](src/translate.js)（一键翻译）、[src/guide.js](src/guide.js)（新手引导）、[src/completion.js](src/completion.js)（行内自动补全交互层）与 [src/styles.css](src/styles.css) / [src/float.css](src/float.css)；主窗口 UI 在 [src/index.html](src/index.html)，浮窗 UI 在 [src/float.html](src/float.html)。修改后刷新对应窗口即可看到变化。
- 按下 `Ctrl+Alt+C`（或在设置面板中自定义后的快捷键）可呼出/隐藏浮窗；浮窗默认不可见，不会随应用启动自动弹出。

> 也可以直接用浏览器打开 `src/index.html` 预览主窗口界面（此时无 Tauri 环境，持久化/系统剪贴板/保存对话框/浮窗热键/一键翻译等能力会自动降级为浏览器行为或空操作，UI 仍可正常操作）。

### 测试与静态检查

用 [Vitest](https://vitest.dev/) 覆盖（jsdom 环境），用例位于 [src/__tests__/](src/__tests__/)。
除纯逻辑层（core.js 等）外，主窗口 UI 层也有测试：做法是把真实 `index.html` 的
`<body>` 灌进 jsdom 再动态 `import`，因此测的是真实页面结构而不是手写的假 DOM。

```bash
npm test          # vitest run，跑一遍全部用例
npm run test:cov  # 附带 v8 覆盖率（统计整个 src/）
npm run lint      # eslint 全量检查
```

另有两个**真浏览器**端到端冒烟脚本（需要本机有 playwright 的 chromium 缓存，
因此不在 CI 里跑；路径可用 `PW_MODULE` / `PW_CHROME` 环境变量覆盖）：

```bash
npm run smoke       # 起静态 server + Chromium 打开两份 HTML，跑 30 项交互断言
npm run smoke:csp   # 额外把 tauri.conf.json 的 CSP 用 <meta> 注入，检查有无违规
```

`npm run smoke` 覆盖的是「单测全绿但应用可能起不来」那一类问题：启动、样式生效、
素材渲染、插入、Markdown 高亮、中英切换、预览分栏、设置面板各 tab、主题切换、
以及两个窗口的行内补全。

`package.json` 与 `src-tauri/tauri.conf.json` 里各有一份 `version` 字段，靠人手
保持一致容易漂移，用 [scripts/sync-version.mjs](scripts/sync-version.mjs) 校验/同步：

```bash
npm run version:check       # 校验模式：两处 version 不一致就报错退出（非 0）
npm run version:set 0.2.1   # 写入模式：把两处 version 都改成 0.2.1
```

`--set` 只接受纯 `数字.数字.数字` 格式，不接受 `-Beta` 之类后缀——MSI 打包要求
`version` 字段是纯数字，后缀只能放 git tag / GitHub Release 名字里。

界面字体是自托管的（不再运行时请求 Google Fonts）。字体是二进制、没法在 diff 里
审查，所以用脚本抓取、并由它整份重新生成 `src/fonts.css`：

```bash
npm run fonts   # 重新抓取 src/fonts/*.woff2 并重新生成 src/fonts.css
```

---

## 四、打包发布

```bash
npm run tauri build
```

各平台产物（位于 `src-tauri/target/release/bundle/`）：

| 平台 | 产物格式 |
| --- | --- |
| macOS | `.app`、`.dmg` |
| Windows | `.msi`（WiX）、`.exe`（NSIS 安装器） |
| Linux | `.deb`、`.rpm`、`.AppImage` |

> **跨平台限制**：Tauri 一般只能在目标平台上打对应平台的包（例如 Windows 包需在 Windows 上构建）。

### CI 自动发布

仓库内置 [.github/workflows/release.yml](.github/workflows/release.yml)：推送 `v*` 格式的 tag（或手动 `workflow_dispatch` 指定 tag）会触发 GitHub Actions（`windows-latest`），自动安装依赖、用 `tauri-apps/tauri-action` 构建并创建 Draft Release，同时生成供 `tauri-plugin-updater` 消费的 `latest.json` 更新清单。签名密钥通过仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）注入，公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 中。

### 应用内更新

`tauri.conf.json` 中 `plugins.updater.endpoints` 指向本仓库 GitHub Release 的 `latest.json`。应用启动 3 秒后会静默检查一次该地址（受设置项 `settings.update.autoCheck` 控制，默认开，可在「设置 → 通用」关闭）；发布新版本前务必确保 tag 已推送、CI 已成功生成对应产物与 `latest.json`。

**检查与安装是分开的两步，永远不会自动升级**：查到新版本只会在侧栏「设置」按钮上点一个小红点、并在「设置 → 关于」里显示版本号、更新说明和一个「下载并安装」按钮，只有点这个按钮才会下载并通过 `tauri-plugin-process` 重启完成安装。早先的实现是查到后直接弹原生 `window.confirm`，而那个对话框默认焦点就在「确定」上，用户启动后正在打字，一个回车就把升级确认掉了，观感上等于应用自己偷偷升级重启——这条回归由 [src/\_\_tests\_\_/updateCheck.test.js](src/__tests__/updateCheck.test.js) 钉住。

### 打包前替换应用图标（重要）

正式发布前，用一张 ≥ 1024×1024 的源图生成全平台图标（会自动产出 macOS `.icns`、Windows `.ico` 等，覆盖 `src-tauri/icons/` 下现有文件）：

```bash
npm run tauri icon path/to/your-icon.png
```

---

## 五、项目结构

```
.
├── package.json              # 脚本与前端/CLI 依赖
├── docs/
│   └── csp.md                 # CSP 最终字符串 + 每条指令的理由 + 真机验证清单
├── scripts/
│   └── sync-version.mjs       # package.json / tauri.conf.json 的 version 字段校验与同步
├── .github/
│   └── workflows/
│       └── release.yml       # 推送 v* tag 自动构建全平台产物 + 创建 Draft Release
├── src/
│   ├── core.js                # 纯逻辑层（无 DOM）：预设数据/持久化归一化/token 估算/翻译请求构造/补全候选筛选打分与自学习 等纯函数，主窗口与浮窗、测试共用
│   ├── store.js               # 运行时状态 + 持久化 + 双向同步 + 基础 DOM/工具（主窗口最底层）
│   ├── render.js              # 左栏模块库 / 右栏编辑器渲染 + 块拖拽
│   ├── quick.js               # 快速段落 + 通用管理浮窗（常用句/插入模块）+ 快速段落管理
│   ├── events.js              # 语言/视图切换、输出、设置面板、浮窗开关、快捷键、检查更新、汇总渲染 renderAll、启动引导（装配入口）
│   ├── backup.js              # 配置导入导出（打包/校验/合并的编排 + 弹窗 UI）
│   ├── translate.js           # 一键翻译编排层（收集待翻块 → http 请求 → 解析写回）
│   ├── guide.js               # 新手引导：首启动高亮遮罩引导 + 上下文轻提示
│   ├── completion.js          # 行内自动补全交互层（ghost text 展示/键盘接管，纯逻辑在 core.js），主窗口与浮窗共用
│   ├── materials.js           # 素材解析纯函数（按 id 合成模块/常用句，内置 patch 合并），主窗口与浮窗共用，避免两处实现漂移
│   ├── pool.js                # 行内补全候选池合成 + 学习数据读写入口（纯逻辑），统一主窗口与浮窗的候选 key 算法
│   ├── sync.js                # state 持久化 + 双窗口广播 + 回声过滤（工厂函数 + 依赖注入，可用假 fs/事件对象单测）
│   ├── statefile.js           # composer-state.json 的原子写 / 容错读，主窗口与浮窗共用同一份实现
│   ├── edit.js                # textarea 文本插入（用 execCommand('insertText') 保住浏览器原生撤销栈）
│   ├── float.js               # 浮窗交互逻辑（从 float.html 内联 script 搬出，便于 eslint/单测覆盖）
│   ├── theme-boot.js          # 主题 bootstrap（同步阻塞的普通脚本，避免首屏闪烁），index.html 与 float.html 共用
│   ├── fonts.css              # 本地字体 @font-face 声明（取代运行时请求 Google Fonts），详见 src/fonts/README.md
│   ├── fonts/                 # 本地自托管字体 woff2（由 npm run fonts 生成，约 338KB；缺失时静默回退系统字体）
│   ├── styles.css             # 主窗口样式
│   ├── float.css              # 浮窗样式（从 float.html 内联 style 搬出）
│   ├── index.html             # 主窗口 UI：模块库/装配区/检视栏/快速段落/设置面板
│   ├── float.html             # 浮窗 UI：置顶小窗、常用句/快速段落一键复制、行内自动补全、自动粘贴开关、一键缩小为悬浮小球
│   ├── main.js                # 唯一入口：模块图装配完成后调用 events.js 的 bootstrap()
│   └── __tests__/             # Vitest 用例 + 两个真浏览器冒烟脚本（*.smoke.mjs）
└── src-tauri/
    ├── Cargo.toml             # Rust 依赖（tauri + fs/dialog/clipboard/updater/process/global-shortcut/window-state/http 插件 + enigo 等）
    ├── build.rs
    ├── tauri.conf.json        # 主窗口 + 浮窗定义、打包、updater 端点与公钥等配置
    ├── capabilities/
    │   └── default.json       # 插件权限声明（fs / dialog / clipboard / updater / process / opener / http，作用于 main + float 两个窗口）
    ├── icons/                 # 应用图标（发布前用 `tauri icon` 替换）
    └── src/
        ├── lib.rs             # 注册插件、全局热键、窗口状态记忆；实现 paste_to_active_window / set_toggle_shortcut 两个自定义命令
        └── main.rs            # 入口，调用 lib 的 run()
```

数据持久化文件位于系统的应用数据目录下 `composer-state.json`：

- macOS：`~/Library/Application Support/com.composer.app/`
- Windows：`%APPDATA%\com.composer.app\`
- Linux：`~/.config/com.composer.app/`

浮窗的「自动粘贴开关」状态只存在浏览器 `localStorage`，不写入 `composer-state.json`。

---

## 常见问题

- **`npm run tauri dev` 报缺少系统库 / 链接错误** → 回到「各平台系统依赖」小节补装对应库（Linux 最常见）。
- **Windows 编译报找不到 MSVC / link.exe** → 未安装 C++ Build Tools，见上文。
- **窗口白屏 / WebView 报错**（Windows 10）→ 安装 WebView2 Runtime。
- **导出 `.md` 保存失败** → 该功能依赖 `dialog` + `fs` 插件，权限在 `src-tauri/capabilities/default.json` 中声明，保存位置需在用户目录（Home/Desktop/Documents/Downloads）范围内。
- **`Ctrl+Alt+C` 呼不出浮窗** → 该快捷键可能已被其他程序全局占用；可在设置面板改绑其他组合，注册失败会自动回滚到上一个可用热键并提示原因。
- **浮窗自动粘贴不生效 / 报错「没有可粘贴的目标窗口」「目标窗口已关闭」** → 需先切到目标软件再呼出浮窗完成一次前台切换采样；macOS 还需额外在辅助功能中授权，且该平台实现尚未真机验证。
- **应用内检测不到新版本** → 确认对应 tag 已推送并且 CI 已成功跑完（会生成 `latest.json` 并附加到 Release），本地网络能访问 GitHub。
- **一键翻译报错 / 无响应** → 先在设置面板选好服务商并填写有效 API Key 与模型；请求走 `http` 插件，需能访问对应端点域名（见 `capabilities/default.json` 的 `http` 白名单）；失败会自动重试一次，仍失败则不改动已有内容。
- **导入配置后 API Key 丢了 / 想同步 Key** → 属预期：导出永不包含 API Key、导入也永不清空本机 Key，Key 需在目标机器上手动重填。
- **开启 CSP 后某功能白屏 / DevTools Console 报 `Refused to ... Content Security Policy`** → 见 [docs/csp.md](docs/csp.md)：里面有最终 CSP 字符串、每条指令的理由，以及一份**尚未真机验证过**的检查清单；排查时优先确认是不是漏放了某个同源资源或 Tauri 自身需要的来源，不要直接删掉整条 CSP 或改成 `'unsafe-inline'` 了事。
- **字体看起来是系统默认字体（不是 Fraunces / Inter / IBM Plex Mono）** → 说明 `src/fonts/` 下的 `.woff2` 缺失或损坏（正常情况下仓库自带 10 个文件，约 338KB）。`@font-face` 加载失败会静默回退到系统字体，不影响任何功能；跑一次 `npm run fonts` 重新抓取即可（它会清空该目录并整份重新生成 [src/fonts.css](src/fonts.css)，详见 [src/fonts/README.md](src/fonts/README.md)）。
- **两个版本号文件不一致 / 想改版本号** → 用 `npm run version:check` 校验、`npm run version:set X.Y.Z` 同步（详见「测试与静态检查」小节）；不要手改其中一个文件后忘了改另一个。
