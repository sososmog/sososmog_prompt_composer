import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

describe('smoke: core.js 加载', () => {
  it('能拿到 window.Composer 并暴露所有目标函数', () => {
    const Composer = loadComposer();
    expect(typeof Composer.parseBlocks).toBe('function');
    expect(typeof Composer.estimateTokens).toBe('function');
    expect(typeof Composer.normalizeState).toBe('function');
    expect(typeof Composer.highlightMarkdown).toBe('function');
    expect(typeof Composer.patchBuiltinSnippet).toBe('function');
    expect(typeof Composer.patchBuiltinModule).toBe('function');
  });
});
