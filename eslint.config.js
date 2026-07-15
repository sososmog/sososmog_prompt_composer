import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/core.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        module: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    // 浏览器端主窗口脚本：普通 <script> 加载（非 module），可用浏览器全局。
    // app.js 及其后续拆分文件（state/render/events/quick）共享此配置。
    files: ['src/app.js', 'src/state.js', 'src/render.js', 'src/events.js', 'src/quick.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
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
