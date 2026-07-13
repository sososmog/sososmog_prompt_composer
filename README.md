# Composer · 模块化提示词构建工具

一个用 **Tauri 2.x** 构建的跨平台桌面应用，用于「像搭积木一样」组装 AI 提示词。前端为纯原生 HTML/CSS/JS 单文件（无框架、无打包器），Rust 侧只做壳，可打包为 macOS / Windows / Linux 桌面程序。

## 功能一览

- 左栏模块库：点击标签往装配区追加模块（角色 / 场景 / 问题 / 规则 / 工作流程 / 输出格式 …）
- 中栏装配区：模块卡片可改名、编辑、启用/停用、上下排序、删除
- 变量系统：内容中写 `{{名称}}` 即创建变量；变量名中英共用、值按语言分别填写
- 右栏检视：变量填写、中英双语 Token 估算对比卡、编译预览（标题/正文/变量三处可直接点击内联编辑）
- 常用句：每个模块下方内置 10 条常用句，可一键插入光标处，支持自定义增删
- 复制到系统剪贴板、导出 `.md`（系统保存对话框）
- 本地持久化：所有状态存到应用数据目录，重开应用自动恢复

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

> 交叉架构：Apple Silicon 上可通过 `rustup target add x86_64-apple-darwin` 增加 Intel 目标，用 `--target` 分别打包，或用 `universal-apple-darwin` 出通用包。
</details>

<details>
<summary><b>🪟 Windows</b></summary>

1. **Microsoft C++ Build Tools**（MSVC 工具链）：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」工作负载。
2. **WebView2 Runtime**：Windows 11 通常已内置；Windows 10 若缺失，从微软官网安装 [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
3. 打包 `.msi` 需要 WiX（Tauri CLI 会在首次构建时自动下载），打包 `.exe`（NSIS）同理自动获取。

> 本仓库当前开发环境即为 Windows 11。
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
</details>

---

## 二、安装依赖

在项目根目录执行一次（安装 Tauri CLI 与前端 JS 依赖包）：

```bash
npm install
```

Rust 侧依赖（`tauri`、`tauri-plugin-fs`、`tauri-plugin-dialog`、`tauri-plugin-clipboard-manager`）会在首次 `dev` / `build` 时由 Cargo 自动拉取，无需手动安装。

---

## 三、开发运行

```bash
npm run tauri dev
```

- 启动桌面窗口（标题 Composer，默认 1200×800，最小 900×600）。
- 前端为纯静态文件，修改 [src/index.html](src/index.html) 后刷新窗口即可看到变化。

> 也可以直接用浏览器打开 `src/index.html` 预览界面（此时无 Tauri 环境，持久化/系统剪贴板/保存对话框会自动降级为浏览器行为或空操作，UI 仍可正常操作）。

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

> **跨平台限制**：Tauri 一般只能在目标平台上打对应平台的包（例如 Windows 包需在 Windows 上构建）。跨平台分发建议用各平台的 CI（如 GitHub Actions matrix）分别构建。

### 打包前替换应用图标（重要）

当前 `src-tauri/icons/` 是占位纯色 PNG。正式发布前，用一张 ≥ 1024×1024 的源图生成全平台图标（会自动产出 macOS `.icns`、Windows `.ico` 等）：

```bash
npm run tauri icon path/to/your-icon.png
```

---

## 五、项目结构

```
.
├── package.json              # 脚本与前端/CLI 依赖
├── src/
│   └── index.html            # 全部前端：内联 style + script，纯原生 JS
└── src-tauri/
    ├── Cargo.toml            # Rust 依赖（tauri + fs/dialog/clipboard 插件）
    ├── build.rs
    ├── tauri.conf.json       # 窗口、打包、frontendDist 等配置
    ├── capabilities/
    │   └── default.json      # 插件权限声明（fs / dialog / clipboard）
    ├── icons/                # 应用图标（占位，发布前替换）
    └── src/
        ├── lib.rs            # 注册三个插件并启动
        └── main.rs           # 入口，调用 lib 的 run()
```

数据持久化文件位于系统的应用数据目录下 `composer-state.json`：

- macOS：`~/Library/Application Support/com.composer.app/`
- Windows：`%APPDATA%\com.composer.app\`
- Linux：`~/.config/com.composer.app/`

---

## 常见问题

- **`npm run tauri dev` 报缺少系统库 / 链接错误** → 回到「各平台系统依赖」小节补装对应库（Linux 最常见）。
- **Windows 编译报找不到 MSVC / link.exe** → 未安装 C++ Build Tools，见上文。
- **窗口白屏 / WebView 报错**（Windows 10）→ 安装 WebView2 Runtime。
- **导出 `.md` 保存失败** → 该功能依赖 `dialog` + `fs` 插件，权限在 `src-tauri/capabilities/default.json` 中声明，保存位置需在用户目录（Home/Desktop/Documents/Downloads）范围内。
