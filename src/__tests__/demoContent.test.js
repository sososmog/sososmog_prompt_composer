import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { demoContent, parseBlocks, defaultState } = loadComposer();

describe('demoContent（引导型演示数据）', () => {
  it('中英文都存在且非空', () => {
    const d = demoContent();
    expect(typeof d.zh).toBe('string');
    expect(typeof d.en).toBe('string');
    expect(d.zh.trim().length).toBeGreaterThan(0);
    expect(d.en.trim().length).toBeGreaterThan(0);
  });

  it('中文首张卡片是引导语（以 ## 👋 开头）', () => {
    const zhBlocks = parseBlocks(demoContent().zh);
    expect(zhBlocks[0].startsWith('## 👋')).toBe(true);
  });

  it('中文引导语提到左侧「插入模块」的用法', () => {
    expect(demoContent().zh).toContain('插入模块');
  });

  it('中文是一份多卡片的完整成品', () => {
    const zhBlocks = parseBlocks(demoContent().zh);
    // 首卡引导 + 角色/场景/需求效果/约束/输出格式 = 6 张
    expect(zhBlocks.length).toBe(6);
  });

  it('英文是一份简版模板（角色/场景/需求效果/解决方案/输出格式 = 5 张，无引导语）', () => {
    const enBlocks = parseBlocks(demoContent().en);
    expect(enBlocks.length).toBe(5);
    expect(demoContent().en.startsWith('## Role')).toBe(true);
  });

  it('中文成品无 …… 占位符（已填得像样，非半成品）', () => {
    expect(demoContent().zh).not.toContain('……');
  });

  it('defaultState().content 即演示数据（首次使用载入）', () => {
    expect(defaultState().content).toEqual(demoContent());
  });
});
