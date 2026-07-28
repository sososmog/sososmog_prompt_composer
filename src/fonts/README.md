# 本地字体文件

这个目录放界面用到的自托管 `.woff2` 字体。**这些文件是二进制、无法在 diff 里
审查**，所以不要手动往这里丢文件——统一用仓库里的脚本抓取：

```
npm run fonts        # 等价于 node scripts/fetch-fonts.mjs
```

该脚本会清空本目录的 woff2 后重新抓取，并**整份重新生成 `src/fonts.css`**。
因此 `src/fonts.css` 也不要手改，改了会被下次抓取覆盖；要调整字族/字重请改
`scripts/fetch-fonts.mjs` 里的 `FAMILIES` 表。

## 为什么要自托管

改动前 `src/index.html` 有三行 `<link>` 指向 `fonts.googleapis.com` /
`fonts.gstatic.com`，问题有三个：

1. 一个纯本地离线工具每次启动都往 Google 发请求 —— 隐私，且断网/被墙时首屏
   字体退化不可控；
2. `float.css` 里 `--font-sans:'Inter', ...` / `--font-mono:'IBM Plex Mono', ...`
   引用的字族，浮窗文档 `float.html` **从来没有加载过**那个 `<link>`
   （`@font-face` 是按文档生效的，主窗口加载不会让浮窗拿到），所以浮窗一直在用
   `Segoe UI` 兜底 —— 主窗口与浮窗字体长期不一致；
3. 开了 CSP 之后（见 `docs/csp.md`），为外部字体域名放开 `font-src` 会削弱策略。

现在 `index.html` 和 `float.html` 都 `<link>` 同一份 `fonts.css`，两个窗口
字体来源统一，且运行期零外部请求（已用 Playwright 实测确认）。

## 当前文件清单

| 文件 | 字族 | font-weight | 子集 |
| --- | --- | --- | --- |
| `fraunces-var.woff2` | Fraunces | 500–700（可变） | latin |
| `fraunces-var-ext.woff2` | Fraunces | 500–700（可变） | latin-ext |
| `inter-var.woff2` | Inter | 400–600（可变） | latin |
| `inter-var-ext.woff2` | Inter | 400–600（可变） | latin-ext |
| `ibm-plex-mono-400.woff2` / `-500` / `-600` | IBM Plex Mono | 400 / 500 / 600 | latin |
| `ibm-plex-mono-400-ext.woff2` / `-500-ext` / `-600-ext` | IBM Plex Mono | 400 / 500 / 600 | latin-ext |

合计 10 个文件、约 338 KB。三点说明：

- **Fraunces 与 Inter 是可变字体**：Google 对多个字重返回的是同一个文件，由浏览器
  按 `wght` 轴合成字重。所以这里一个字族只存一个文件、`@font-face` 用
  `font-weight: 400 600` 这样的区间声明。早先按字重拆成 `inter-400/450/500/600`
  四条规则指向同一份数据是错的用法（会让浏览器重复下载）。这也顺带解决了
  `--font-sans` 用到的非标准字重 `450`：可变字体能直接插值出来，不需要单独文件。
- **只取 latin / latin-ext**：这三套字体本身都不含中文字形，界面中文由
  `font-family` 链里的 `PingFang SC` / `Microsoft YaHei` 等系统字体承担，抓
  cyrillic / greek / vietnamese 只会白白增大安装包。
- **`unicode-range` 按需加载**：`-ext` 那几份只有页面真的出现拉丁扩展字符时才会
  下载。实测主窗口只下 3 个文件、浮窗只下 2 个（浮窗不用 Fraunces）。

## 来源与许可证

三套字体均为 **SIL Open Font License 1.1**，允许自托管并随应用分发（要求是保留
版权声明、不得把字体文件本身当独立产品出售）：

- **Fraunces** — https://github.com/undercasetype/Fraunces （Undercase Type）
- **Inter** — https://github.com/rsms/inter （Rasmus Andersson）
- **IBM Plex Mono** — https://github.com/IBM/plex （IBM）

文件经 Google Fonts 的 `css2` 接口取得（即 `fonts.gstatic.com` 上的官方切片），
抓取逻辑与子集选择见 `scripts/fetch-fonts.mjs`。

## 设计上的保底：文件缺失也完全能用

`@font-face` 的 `src` 指向的文件不存在时，浏览器只会加载失败并**静默**回退到
`font-family` 里的下一个候选（系统字体），不报错、不阻塞渲染、不白屏。所以
clone 之后没跑 `npm run fonts` 也能正常开发，只是界面用系统字体 —— 字体是锦上
添花，不是功能依赖。
