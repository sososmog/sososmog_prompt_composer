import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 以前只统计 core.js —— 那时 UI 层根本 import 不了（events.js 顶层直接跑启动
      // 逻辑），统计它只会得到一片 0%。现在启动动作已收进 bootstrap()，UI 层可以在
      // jsdom 里装配起来测，覆盖率该把整个 src 都算进去，否则新加的 DOM 层测试
      // 完全不体现、也看不出还有哪些地方没测到。
      include: ['src/**/*.js'],
      exclude: [
        'src/__tests__/**',
        // main.js / theme-boot.js 是两行胶水（一个调 bootstrap、一个读 localStorage
        // 设 data-theme），由 frontend.smoke.mjs 在真浏览器里覆盖，jsdom 里统计它们
        // 只会制造噪声。
        'src/main.js',
        'src/theme-boot.js'
      ]
    }
  }
});
