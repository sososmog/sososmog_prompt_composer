import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { parseBlocks } = loadComposer();

describe('parseBlocks', () => {
  it('空文本返回空数组', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks(undefined)).toEqual([]);
    expect(parseBlocks('   \n  \n')).toEqual([]);
  });

  it('无 ## 标题的纯文本作为单个前言块', () => {
    expect(parseBlocks('普通一段话\n第二行')).toEqual(['普通一段话\n第二行']);
  });

  it('首个 ## 之前的内容作为无标题前言块（块内空行归属前一块末尾）', () => {
    const text = '前言内容\n\n## 角色\n你是……';
    expect(parseBlocks(text)).toEqual(['前言内容\n', '## 角色\n你是……']);
  });

  it('按多个 ## 标题切分为多个块，块间空行归属前一块末尾', () => {
    const text = '## 角色\n你是……\n\n## 场景\n使用场景：……\n\n## 规则\n- 始终……';
    expect(parseBlocks(text)).toEqual([
      '## 角色\n你是……\n',
      '## 场景\n使用场景：……\n',
      '## 规则\n- 始终……'
    ]);
  });

  it('只过滤整块都是空白的块，块内尾随空行本身不裁剪', () => {
    const text = '## A\n内容A\n\n\n\n## B\n内容B';
    expect(parseBlocks(text)).toEqual(['## A\n内容A\n\n\n', '## B\n内容B']);
  });

  it('孤立的 "##"（无空格无内容）也被识别为新块起点', () => {
    const text = '##\n无标题内容\n\n## 标题\n正文';
    expect(parseBlocks(text)).toEqual(['##\n无标题内容\n', '## 标题\n正文']);
  });

  it('三级及以上标题（###）不会被当成块分隔符', () => {
    const text = '## 角色\n### 子标题\n正文';
    expect(parseBlocks(text)).toEqual(['## 角色\n### 子标题\n正文']);
  });
});
