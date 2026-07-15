import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { highlightMarkdown } = loadComposer();

describe('highlightMarkdown', () => {
  it('标题行整体包裹 hl-h', () => {
    expect(highlightMarkdown('## 角色')).toBe('<span class="hl-h">## 角色</span>');
    expect(highlightMarkdown('# 一级标题')).toBe('<span class="hl-h"># 一级标题</span>');
  });

  it('引用行前缀包裹 hl-quote，正文走行内高亮', () => {
    const out = highlightMarkdown('> 引用内容');
    expect(out).toBe('<span class="hl-quote">&gt; </span>引用内容');
  });

  it('列表行的标记符号包裹 hl-list', () => {
    expect(highlightMarkdown('- 条目一')).toBe('<span class="hl-list">-</span> 条目一');
    expect(highlightMarkdown('1. 有序条目')).toBe('<span class="hl-list">1.</span> 有序条目');
  });

  it('代码围栏内的内容整体标记为 hl-fence，不做行内高亮', () => {
    const out = highlightMarkdown('```\n**not bold**\n```');
    const lines = out.split('\n');
    expect(lines[0]).toBe('<span class="hl-fence">```</span>');
    expect(lines[1]).toBe('<span class="hl-fence">**not bold**</span>');
    expect(lines[2]).toBe('<span class="hl-fence">```</span>');
  });

  it('粗体 / 斜体 / 行内代码 / 链接 分别高亮', () => {
    expect(highlightMarkdown('**粗体**')).toContain('<span class="hl-bold">**粗体**</span>');
    expect(highlightMarkdown('*斜体*')).toContain('<span class="hl-italic">*斜体*</span>');
    expect(highlightMarkdown('`code`')).toContain('<span class="hl-code">`code`</span>');
    const linkOut = highlightMarkdown('[文本](https://x.com)');
    expect(linkOut).toContain('<span class="hl-link-text">[文本]</span>');
    expect(linkOut).toContain('<span class="hl-link-url">(https://x.com)</span>');
  });

  it('相邻的两段斜体都能被识别（lookbehind/lookahead 边界）', () => {
    const out = highlightMarkdown('*a* *b*');
    expect(out).toBe('<span class="hl-italic">*a*</span> <span class="hl-italic">*b*</span>');
  });

  it('HTML 特殊字符被转义，防止注入', () => {
    const out = highlightMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('行内代码内容中的特殊字符也被转义且不被粗体规则二次处理', () => {
    const out = highlightMarkdown('`**not-bold**`');
    expect(out).toBe('<span class="hl-code">`**not-bold**`</span>');
  });

  it('多行文本按行独立处理并用换行符拼接', () => {
    const out = highlightMarkdown('## 标题\n普通段落');
    expect(out).toBe('<span class="hl-h">## 标题</span>\n普通段落');
  });
});
