import { describe, it, expect } from 'vitest';
import { loadComposer } from './setup.js';

const { createHistory } = loadComposer();

describe('createHistory', () => {
  it('初始状态两栈皆空', () => {
    const h = createHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo('now')).toBe(null);
    expect(h.redo('now')).toBe(null);
  });

  it('push 后可撤销；undo 把当前值移入 redo 并弹出旧快照', () => {
    const h = createHistory();
    h.push('v0');           // 结构操作前存旧快照 v0，当前已变成 v1
    expect(h.canUndo()).toBe(true);
    expect(h.undo('v1')).toBe('v0'); // 恢复到 v0，当前 v1 进 redo
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    expect(h.redo('v0')).toBe('v1'); // 重做回 v1，当前 v0 进 undo
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it('push 清空 redo 栈（撤销后做新操作，被撤销分支不可重做）', () => {
    const h = createHistory();
    h.push('a');
    h.undo('b');            // redo 里现在有 'b'
    expect(h.canRedo()).toBe(true);
    h.push('a');            // 新的结构操作 → redo 应被清空
    expect(h.canRedo()).toBe(false);
    expect(h.redo('x')).toBe(null);
  });

  it('连续三次结构操作可连续三次撤销退回', () => {
    const h = createHistory();
    h.push('s0'); // 当前 s1
    h.push('s1'); // 当前 s2
    h.push('s2'); // 当前 s3
    expect(h.undo('s3')).toBe('s2');
    expect(h.undo('s2')).toBe('s1');
    expect(h.undo('s1')).toBe('s0');
    expect(h.undo('s0')).toBe(null);
  });

  it('栈深超过上限时丢弃最旧的', () => {
    const h = createHistory(3);
    h.push('a'); h.push('b'); h.push('c'); h.push('d'); // 'a' 被挤出
    expect(h.undo('cur')).toBe('d');
    expect(h.undo('d')).toBe('c');
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe(null); // 'a' 已丢弃
  });

  it('reset 清空两栈（如切换语言）', () => {
    const h = createHistory();
    h.push('a');
    h.undo('b'); // undo 空、redo 有 b
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo('x')).toBe(null);
    expect(h.redo('x')).toBe(null);
  });
});
