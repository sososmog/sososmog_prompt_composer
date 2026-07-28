import js from '@eslint/js';
import globals from 'globals';

/* 全局清单一律取自 globals 包，不再手工维护白名单——手写的那份漏一个
 * （performance / KeyboardEvent / structuredClone …）就会以 no-undef 报错，
 * 而它跟代码正确性毫无关系。 */
export default [
  // Rust 构建产物（被 git 忽略），不参与前端 lint
  { ignores: ['src-tauri/target/**'] },
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
