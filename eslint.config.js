import js from '@eslint/js';

export default [
  // Rust 构建产物（被 git 忽略），不参与前端 lint
  { ignores: ['src-tauri/target/**'] },
  js.configs.recommended,
  {
    files: ['src/core.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    // 浏览器端主窗口模块：<script type="module"> 加载，ESM，可用浏览器全局。
    // store/render/quick/events 四个拆分文件共享此配置。
    files: ['src/store.js', 'src/render.js', 'src/quick.js', 'src/events.js', 'src/translate.js', 'src/guide.js', 'src/backup.js', 'src/completion.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        Promise: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        Event: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-empty': ['warn'],
    },
  },
  {
    files: ['src/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        global: 'readonly',
      },
    },
  },
];
