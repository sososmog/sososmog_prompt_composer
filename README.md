# Composer · 模块化提示词构建工具

一个用 **Tauri 2.x** 构建的跨平台桌面应用，用于「像搭积木一样」组装 AI 提示词。前端为原生 HTML/CSS/JS（无框架、无打包器，原生 ESM 分模块），纯逻辑抽离进 `core.js`，运行时按 store（状态）/ render（渲染）/ quick（浮窗）/ events（装配入口）分层，供主窗口与浮窗共用；Rust 侧除应用壳外，还实现了全局热键、窗口记忆、自动粘贴到外部窗口等桌面能力，可打包为 macOS / Windows / Linux 桌面程序，并支持应用内自动更新。

## 功能一览

### 主窗口

- 左栏模块库：点击标签往装配区追加模块（角色 / 场景 / 问题 / 规则 / 工作流程 / 输出格式 …）
- 中栏装配区：模块卡片可改名、编辑、启用/停用、上下排序、删除
- 变量系统：内容中写 `{{名称}}` 即创建变量；变量名中英共用、值按语言分别填写
- 右栏检视：变量填写、中英双语 Token 估算对比卡、编译预览（标题/正文/变量三处可直接点击内联编辑）
- 常用句：每个模块下方内置常用句，可一键插入光标处，支持自定义增删
- **快速段落**：独立功能区，支持自定义分组（两级结构：分组 → 段落），下拉展开后点击即可插入预设文本，可通过管理面板增删分组/段落、调整顺序
- **一键翻译**：把当前语言正文按块整体翻译到另一种语言并写回对应槽位。内置 Google Gemini / GLM 智谱 / Groq / OpenRouter 以及「自定义（OpenAI 兼容）」端点，可在设置面板选择服务商、填 API Key 与模型；请求经 Tauri `http` 插件直发（绕开浏览器 CORS，Key 只留在应用侧），代码块会被遮罩不参与翻译，失败时不改动任何已有内容
- **配置导入导出**：把素材库 / 变量 / 设置等打包为 `.json` 备份文件，导入时可预览摘要并按名称判重合并。**API Key 从不导出，导入也永不清空本机 Key**
- **新手引导**：首次启动的最短路径高亮遮罩引导（含一步真实交互），以及初次接近某功能时的锚定轻提示；是否看过的标记随状态落盘
- 复制到系统剪贴板、导出 `.md`（系统保存对话框）
- 本地持久化：所有状态存到应用数据目录，重开应用自动恢复
- 应用内自动更新：启动时检查 GitHub Release，发现新版本可一键下载安装并重启

### 浮窗模式

- 全局快捷键（默认 `Ctrl+Alt+C`，可在设置面板自定义）随时呼出/隐藏一个置顶小窗，无需切回主窗口即可复制常用句/模块内容
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
- 前端为纯静态文件、原生 ESM 分模块：纯逻辑在 [src/core.js](src/core.js)，主窗口按 [src/store.js](src/store.js)（状态/持久化）→ [src/render.js](src/render.js)（渲染）→ [src/quick.js](src/quick.js)（浮窗/管理面板）→ [src/events.js](src/events.js)（装配入口）分层，另有 [src/backup.js](src/backup.js)（导入导出）、[src/translate.js](src/translate.js)（一键翻译）、[src/guide.js](src/guide.js)（新手引导）与 [src/styles.css](src/styles.css)；主窗口 UI 在 [src/index.html](src/index.html)，浮窗 UI 在 [src/float.html](src/float.html)。修改后刷新对应窗口即可看到变化。
- 按下 `Ctrl+Alt+C`（或在设置面板中自定义后的快捷键）可呼出/隐藏浮窗；浮窗默认不可见，不会随应用启动自动弹出。

> 也可以直接用浏览器打开 `src/index.html` 预览主窗口界面（此时无 Tauri 环境，持久化/系统剪贴板/保存对话框/浮窗热键/一键翻译等能力会自动降级为浏览器行为或空操作，UI 仍可正常操作）。

### 测试与静态检查

纯逻辑层用 [Vitest](https://vitest.dev/) 覆盖（jsdom 环境），用例位于 [src/__tests__/](src/__tests__/)：

```bash
npm test          # vitest run，跑一遍全部用例
npm run test:cov  # 附带 v8 覆盖率
npm run lint      # eslint 全量检查
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

### 应用内自动更新

`tauri.conf.json` 中 `plugins.updater.endpoints` 指向本仓库 GitHub Release 的 `latest.json`；应用启动时会检查该地址，若有新版本可提示用户下载并通过 `tauri-plugin-process` 重启完成安装。发布新版本前务必确保 tag 已推送、CI 已成功生成对应产物与 `latest.json`。

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
├── .github/
│   └── workflows/
│       └── release.yml       # 推送 v* tag 自动构建全平台产物 + 创建 Draft Release
├── src/
│   ├── core.js                # 纯逻辑层（无 DOM）：预设数据/持久化归一化/token 估算/翻译请求构造 等纯函数，主窗口与浮窗、测试共用
│   ├── store.js               # 运行时状态 + 持久化 + 双向同步 + 基础 DOM/工具（主窗口最底层）
│   ├── render.js              # 左栏模块库 / 右栏编辑器渲染 + 块拖拽
│   ├── quick.js               # 快速段落 + 通用管理浮窗（常用句/插入模块）+ 快速段落管理
│   ├── events.js              # 语言/视图切换、输出、设置面板、浮窗开关、快捷键、检查更新、汇总渲染 renderAll、启动引导（装配入口）
│   ├── backup.js              # 配置导入导出（打包/校验/合并的编排 + 弹窗 UI）
│   ├── translate.js           # 一键翻译编排层（收集待翻块 → http 请求 → 解析写回）
│   ├── guide.js               # 新手引导：首启动高亮遮罩引导 + 上下文轻提示
│   ├── styles.css             # 主窗口样式
│   ├── index.html             # 主窗口 UI：模块库/装配区/检视栏/快速段落/设置面板
│   ├── float.html             # 浮窗 UI：置顶小窗、常用句/快速段落一键复制、自动粘贴开关
│   └── __tests__/             # Vitest 用例（纯逻辑层）
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
