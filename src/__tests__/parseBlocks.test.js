import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { parseBlocks, isFenceLine, isBlockHeadingLine } = loadComposer();

// collectText 的回写方式：逐块去尾随空白后用 \n\n 拼接。
// 用它来断言"解析 → 回写"不会篡改用户内容。
function roundTrip(text) {
  return parseBlocks(text).map((b) => b.replace(/\s+$/, '')).join('\n\n');
}

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

/* ============================================================
 * 代码围栏感知
 * ------------------------------------------------------------
 * 回归：提示词正文里经常带 Markdown 示例。以前 parseBlocks 逐行匹配 ##、
 * 不认围栏，会把一段代码块拦腰切成两张卡片（删掉其中一张即静默截断代码），
 * 而回写按 \n\n 拼接，还会往围栏里插进一个空行——直接篡改了用户内容。
 * ============================================================ */
describe('parseBlocks - 代码围栏', () => {
  it('围栏内的 ## 不作为块边界，整段保持一块', () => {
    const text = '## 示例\n下面是代码：\n```md\n## 这是示例里的标题\n正文\n```\n结束';
    expect(parseBlocks(text)).toEqual([text]);
  });

  it('回归：解析 → 回写不再往围栏里插空行', () => {
    const text = '## 示例\n下面是代码：\n```md\n## 这是示例里的标题\n正文\n```\n结束';
    expect(roundTrip(text)).toBe(text);
  });

  it('围栏之后的 ## 恢复为块边界', () => {
    const text = '## A\n```\n## 假标题\n```\n\n## B\n正文B';
    expect(parseBlocks(text)).toEqual(['## A\n```\n## 假标题\n```\n', '## B\n正文B']);
  });

  it('带语言标记的围栏（```js）同样识别', () => {
    const text = '## A\n```js\n// ## not a heading\n```\n## B';
    expect(parseBlocks(text)).toEqual(['## A\n```js\n// ## not a heading\n```', '## B']);
  });

  it('缩进的围栏也算围栏（与 highlightMarkdown 同一判定）', () => {
    const text = '## A\n  ```\n  ## 缩进代码里的井号\n  ```\n## B';
    expect(parseBlocks(text)).toEqual(['## A\n  ```\n  ## 缩进代码里的井号\n  ```', '## B']);
  });

  it('未闭合的围栏：其后内容全部归入当前块（等同未终止的代码块）', () => {
    const text = '## A\n```\n## 还在代码里\n## 也还在';
    expect(parseBlocks(text)).toEqual([text]);
  });

  it('多段围栏交替时边界判断正确', () => {
    const text = '## A\n```\n## x\n```\n中间\n```\n## y\n```\n## B';
    expect(parseBlocks(text)).toEqual(['## A\n```\n## x\n```\n中间\n```\n## y\n```', '## B']);
  });

  it('围栏内的正常标题不受影响：常见提示词整篇 round-trip 稳定', () => {
    const text = [
      '## 角色',
      '你是一名工程师。',
      '',
      '## 输出格式',
      '按下面的模板输出：',
      '```markdown',
      '## 结论',
      '（一句话）',
      '',
      '## 理由',
      '- 第一点',
      '```',
      '',
      '## 约束',
      '不要编造。',
    ].join('\n');
    const blocks = parseBlocks(text);
    expect(blocks.length).toBe(3); // 角色 / 输出格式（含整段代码）/ 约束
    expect(blocks[1]).toContain('## 结论');
    expect(blocks[1]).toContain('## 理由');
    expect(roundTrip(text)).toBe(text.replace(/\n+(?=## 输出格式|## 约束)/g, '\n\n'));
  });
});

describe('isFenceLine / isBlockHeadingLine', () => {
  it('isFenceLine 识别 ``` 与前置空白', () => {
    ['```', '```js', '   ```', '\t```md'].forEach((l) => expect(isFenceLine(l)).toBe(true));
    ['`` `', 'a```', '`code`', ''].forEach((l) => expect(isFenceLine(l)).toBe(false));
  });
  it('isBlockHeadingLine 只认行首的 "## " 与裸 "##"', () => {
    ['## 标题', '##', '## '].forEach((l) => expect(isBlockHeadingLine(l)).toBe(true));
    ['###', '### 三级', ' ## 缩进', '正文 ## 中间', '#单级'].forEach((l) => expect(isBlockHeadingLine(l)).toBe(false));
  });
});
