import js from '@eslint/js';
import globals from 'globals';

/* 全局清单一律取自 globals 包，不再手工维护白名单——手写的那份漏一个
 * （performance / KeyboardEvent / structuredClone …）就会以 no-undef 报错，
 * 而它跟代码正确性毫无关系。 */
export default [
  // Rust 构建产物（被 git 忽略），不参与前端 lint。
  //
  // .claude/worktrees/** 是并行开发时的 git worktree 落地目录，里面是整个仓库的
  // 副本。不排除的话 `eslint .` 会把每个 worktree 的源码重复扫一遍——实测三个
  // worktree 同时存在时报出 2109 个"错误"，全是同一份代码被数了四遍，而且因为
  // worktree 里没有各自的 node_modules，连 import 解析都是错的。
  // 这些假错误极具误导性：清理 worktree 之前跑一次 lint 会让人以为自己写崩了。
  { ignores: ['src-tauri/target/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  {
    // 纯逻辑层：不碰 DOM，只用 ES 内置对象，故不给任何浏览器全局——
    // 这条约束本身就是"core.js 必须保持纯"的机器化守卫。
    files: ['src/core.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // 浏览器端模块：<script type="module"> 加载，ESM，可用浏览器全局。
    files: [
      'src/store.js', 'src/render.js', 'src/quick.js', 'src/events.js',
      'src/translate.js', 'src/guide.js', 'src/backup.js',
      'src/completion.js', 'src/statefile.js', 'src/edit.js',
      'src/materials.js', 'src/pool.js', 'src/sync.js', 'src/float.js',
      'src/main.js',
    ],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn'],
    },
  },
  {
    // 单元测试：vitest 环境是 jsdom，浏览器全局可用；setup.js 还用到 node 的 global。
    files: ['src/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // theme-boot.js 是**普通脚本**而非 ESM 模块：它必须在样式表之前同步阻塞执行
    // 才能避免首屏主题闪烁，所以两份 HTML 用的是 <script src> 而非
    // <script type="module">（module 隐含 defer，会等到解析完才跑）。
    // sourceType 因此得是 'script'，不能跟着上面那批模块一起配。
    files: ['src/theme-boot.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: globals.browser,
    },
  },
  {
    // scripts/ 下的构建期脚本：纯 node 环境（抓字体、同步版本号等），不进打包产物。
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // __tests__ 下的 .mjs 冒烟脚本：node 里驱动 playwright，
    // page.evaluate 内联的浏览器全局静态可见但运行在浏览器。
    files: ['src/__tests__/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn'],
    },
  },
];
