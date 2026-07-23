import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { estimateTokens } = loadComposer();

describe('estimateTokens', () => {
  it('空值 / 空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it('纯 CJK 字符按 1.6 倍估算并四舍五入', () => {
    // 5 个汉字 * 1.6 = 8
    expect(estimateTokens('你好世界啊')).toBe(8);
  });

  it('纯英文字符按 1/4 估算并四舍五入', () => {
    // 8 个字符 / 4 = 2
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('混合中英文按各自权重求和', () => {
    // 2 个汉字 * 1.6 = 3.2, 4 个英文字符 / 4 = 1, 合计 4.2 -> round 4
    expect(estimateTokens('你好abcd')).toBe(4);
  });

  it('CJK 标点区间（0x3000-0x303f）计入 cjk', () => {
    // 、是 0x3001，属于该区间
    expect(estimateTokens('、')).toBe(2); // round(1 * 1.6) = 2
  });

  it('全角字符区间（0xff00-0xffef）计入 cjk', () => {
    // full-width Ａ 是 U+FF21
    expect(estimateTokens('Ａ')).toBe(2);
  });

  it('CJK 扩展区间边界值（0x9fff）计入 cjk', () => {
    expect(estimateTokens('鿿')).toBe(2);
  });

  it('非 BMP 字符按码点计数、不被数两次', () => {
    // 扩展 B 汉字 U+20000 应按 CJK（×1.6）算，且与基本汉字计数一致
    expect(estimateTokens('𠀀')).toBe(2);
    expect(estimateTokens('𠀀𠀀𠀀𠀀𠀀')).toBe(8); // 与 5 个基本汉字相同
    // emoji（代理对）算 1 个 other，而非 2 个：round(1/4) = 0
    expect(estimateTokens('😀')).toBe(0);
    // 混合：1 个扩展 B 汉字 + 4 英文 = round(1.6 + 1) = 3
    expect(estimateTokens('𠀀abcd')).toBe(3);
  });
});
