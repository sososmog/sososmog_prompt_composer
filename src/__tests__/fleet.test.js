/* ============================================================
 * fleet.js 纯判定层单测
 * ------------------------------------------------------------
 * 这一层没有 DOM、没有 Tauri，是整个 Agent Fleet 功能里逻辑最绕的部分
 * （状态推断七八个分支、树重建要处理环和孤儿），所以测试投入集中在这里。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SCHEMA_VERSION,
  IDLE_MS,
  STATUS_DEFS,
  GROUP_ORDER,
  TONE_PRIORITY,
  validateReport,
} from '../fleet.js';

describe('契约常量', () => {
  it('SCHEMA_VERSION 与 Rust 侧保持一致', () => {
    // 这条测试是把 "改契约必须同时改两侧" 从口头约定变成机器强制。
    // 两边版本悄悄漂移不会有任何编译/运行错误，只会让前端在真机上收到
    // 一个自己不认识的结构然后渲染出一片 undefined —— 正是最难查的那类 bug。
    const rust = readFileSync('src-tauri/src/fleet/types.rs', 'utf8');
    const m = rust.match(/pub const SCHEMA_VERSION:\s*u32\s*=\s*(\d+)/);
    expect(m, 'Rust 侧找不到 SCHEMA_VERSION 定义（改名了？）').toBeTruthy();
    expect(Number(m[1])).toBe(SCHEMA_VERSION);
  });

  it('STATUS_DEFS 与 GROUP_ORDER 覆盖同一批状态码', () => {
    // GROUP_ORDER 显式列出而非依赖对象键序，所以要防两边漏掉对方
    expect([...GROUP_ORDER].sort()).toEqual(Object.keys(STATUS_DEFS).sort());
  });

  it('每个状态码都有优先级，否则归约时会得到 undefined', () => {
    for (const code of GROUP_ORDER) {
      expect(TONE_PRIORITY[code], `${code} 缺优先级`).toBeTypeOf('number');
    }
  });

  it('needs-input 的优先级高于 working', () => {
    // 这是整个功能最核心的产品判断：需要你回话的会话必须排在正在干活的前面，
    // 否则角标和小球的意义就没了
    expect(TONE_PRIORITY['needs-input']).toBeGreaterThan(TONE_PRIORITY.working);
  });

  it('分组顺序把 needs-input 排在最前、working 紧随其后', () => {
    expect(GROUP_ORDER[0]).toBe('needs-input');
    expect(GROUP_ORDER[1]).toBe('working');
  });

  it('每个状态定义都齐备 label/glyph/tone/animated', () => {
    for (const [code, def] of Object.entries(STATUS_DEFS)) {
      expect(def.label, `${code}.label`).toBeTypeOf('string');
      expect(def.label.length, `${code}.label 不能为空`).toBeGreaterThan(0);
      expect(def.glyph, `${code}.glyph`).toBeTypeOf('string');
      expect(def.tone, `${code}.tone`).toBeTypeOf('string');
      expect(def.animated, `${code}.animated`).toBeTypeOf('boolean');
    }
  });

  it('只有 working 需要动画', () => {
    // 静止状态挂脉冲动画会让人误以为它还在跑
    const animated = Object.entries(STATUS_DEFS)
      .filter(([, d]) => d.animated)
      .map(([c]) => c);
    expect(animated).toEqual(['working']);
  });

  it('IDLE_MS 是 5 分钟', () => {
    expect(IDLE_MS).toBe(300000);
  });
});

describe('validateReport', () => {
  const good = { schemaVersion: SCHEMA_VERSION, scannedAt: 1, configDir: '', sessions: [], warnings: [] };

  it('放行版本正确的报告', () => {
    const res = validateReport(good);
    expect(res.ok).toBe(true);
    expect(res.report).toBe(good);
  });

  it('挡住版本不一致的报告', () => {
    // 真实触发场景：tauri dev 下前端热重载了但 Rust 二进制还是旧的
    const res = validateReport({ ...good, schemaVersion: 99 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('schema-mismatch');
    expect(res.detail).toContain('99');
  });

  it('schemaVersion 缺失时也算版本不一致，而不是当成正常', () => {
    const res = validateReport({ scannedAt: 1, sessions: [] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('schema-mismatch');
  });

  it('版本比对是严格相等，字符串 "1" 不等于数字 1', () => {
    // 松散比较会让"采集层返回了字符串"这种真实的序列化事故溜过去
    const res = validateReport({ ...good, schemaVersion: '1' });
    expect(res.ok).toBe(false);
  });

  for (const [desc, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'oops'],
    ['数字', 42],
  ]) {
    it(`拒绝非对象输入：${desc}`, () => {
      const res = validateReport(bad);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('not-an-object');
    });
  }
});
