import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { floatWindowHintBody } = loadComposer();

// guide.js 里「浮窗随叫随到」提示的文案生成逻辑已抽成纯函数放进 core.js（见
// core.js 的 floatWindowHintBody），因为 guide.js 本身没法在 vitest 里直接
// import：它 import 了 store.js，而 store.js 加载即执行 DOM/Tauri 副作用，
// 且顶层还 import 了 events.js（$langSegmented 为 null 时 addEventListener
// 会直接抛错）。这里只测抽出来的纯函数，覆盖 guide.js 的 HINTS.floatWindow.body
// 实际会读到的两种输入：用户自定义过快捷键 / 还没配置过（回退默认值）。
describe('floatWindowHintBody', () => {
  it('传入自定义快捷键时，文案里包含该快捷键', () => {
    var body = floatWindowHintBody('Ctrl+Shift+F');
    expect(body).toContain('Ctrl+Shift+F');
    expect(body).not.toContain('Ctrl+Alt+C');
  });

  it('传入 undefined 时回退到默认快捷键 Ctrl+Alt+C', () => {
    expect(floatWindowHintBody(undefined)).toContain('Ctrl+Alt+C');
  });

  it('传入空字符串（含只有空白）时同样回退到默认快捷键', () => {
    expect(floatWindowHintBody('')).toContain('Ctrl+Alt+C');
    expect(floatWindowHintBody('   ')).toContain('Ctrl+Alt+C');
  });
});
