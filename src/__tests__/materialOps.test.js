/* 素材管理（常用句 / 插入模块 / 快速段落）的数据变换。
 *
 * 这批操作的失效方式是「静默损坏」：不抛异常、界面照样渲染，只是用户下次
 * 打开发现顺序变了或少了一条。所以这里重点钉三类不变量：
 *   1. 相邻交换只动两个位置，其余元素与长度不变；
 *   2. 越界不动、不误伤；
 *   3. 删除自定义素材时「对象数组」与「id 顺序数组」必须同步，
 *      order 里不能留下找不到对象的孤儿 id。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadComposer } from './setup.js';

const {
  moveById, moveId, removeById, removeCustomMaterial,
  setFieldById, setLangFieldById,
  addCustomSnippet, addCustomModule, addQuickGroup, addQuickItem,
  defaultState,
} = loadComposer();

const ids = (arr) => arr.map((x) => x.id);

describe('moveById（对象数组相邻交换）', () => {
  let arr;
  beforeEach(() => {
    arr = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  });

  it('上移中间项：与前一项交换，返回 true', () => {
    expect(moveById(arr, 'b', -1)).toBe(true);
    expect(ids(arr)).toEqual(['b', 'a', 'c']);
  });

  it('下移中间项：与后一项交换', () => {
    expect(moveById(arr, 'b', 1)).toBe(true);
    expect(ids(arr)).toEqual(['a', 'c', 'b']);
  });

  it('首项上移越界：数组不变，返回 false（调用方据此跳过保存）', () => {
    expect(moveById(arr, 'a', -1)).toBe(false);
    expect(ids(arr)).toEqual(['a', 'b', 'c']);
  });

  it('末项下移越界：数组不变，返回 false', () => {
    expect(moveById(arr, 'c', 1)).toBe(false);
    expect(ids(arr)).toEqual(['a', 'b', 'c']);
  });

  it('id 不存在：不动任何元素', () => {
    expect(moveById(arr, 'zzz', -1)).toBe(false);
    expect(ids(arr)).toEqual(['a', 'b', 'c']);
  });

  it('单元素数组：两个方向都不动', () => {
    const one = [{ id: 'only' }];
    expect(moveById(one, 'only', -1)).toBe(false);
    expect(moveById(one, 'only', 1)).toBe(false);
    expect(ids(one)).toEqual(['only']);
  });

  it('空数组 / 非数组：不抛异常，返回 false', () => {
    expect(moveById([], 'a', 1)).toBe(false);
    expect(moveById(null, 'a', 1)).toBe(false);
    expect(moveById(undefined, 'a', 1)).toBe(false);
  });

  it('交换保持元素身份（是移动而非复制），长度不变', () => {
    const objA = arr[0], objB = arr[1];
    moveById(arr, 'b', -1);
    expect(arr[0]).toBe(objB);
    expect(arr[1]).toBe(objA);
    expect(arr).toHaveLength(3);
  });

  it('一路上移到顶后再上移，序列稳定不乱', () => {
    moveById(arr, 'c', -1); // a c b
    moveById(arr, 'c', -1); // c a b
    moveById(arr, 'c', -1); // 越界，不动
    expect(ids(arr)).toEqual(['c', 'a', 'b']);
  });

  it('元素含 null 时跳过、不因取 .id 抛异常', () => {
    const holey = [null, { id: 'x' }];
    expect(moveById(holey, 'x', -1)).toBe(true);
    expect(holey[0]).toEqual({ id: 'x' });
    expect(holey[1]).toBe(null);
  });
});

describe('moveId（id 字符串数组相邻交换）', () => {
  let order;
  beforeEach(() => {
    order = ['s1', 's2', 's3'];
  });

  it('上移 / 下移中间项', () => {
    expect(moveId(order, 's2', -1)).toBe(true);
    expect(order).toEqual(['s2', 's1', 's3']);
    expect(moveId(order, 's2', 1)).toBe(true);
    expect(order).toEqual(['s1', 's2', 's3']);
  });

  it('两端越界不动', () => {
    expect(moveId(order, 's1', -1)).toBe(false);
    expect(moveId(order, 's3', 1)).toBe(false);
    expect(order).toEqual(['s1', 's2', 's3']);
  });

  it('id 不在 order 里：不动', () => {
    expect(moveId(order, 'ghost', 1)).toBe(false);
    expect(order).toEqual(['s1', 's2', 's3']);
  });

  it('非数组不抛异常', () => {
    expect(moveId(null, 's1', 1)).toBe(false);
  });

  it('交换不改变集合内容，只改变顺序', () => {
    moveId(order, 's3', -1);
    expect([...order].sort()).toEqual(['s1', 's2', 's3']);
    expect(order).toHaveLength(3);
  });
});

describe('removeById', () => {
  it('删中间项，其余顺序不变', () => {
    const arr = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(removeById(arr, 'b')).toBe(true);
    expect(ids(arr)).toEqual(['a', 'c']);
  });

  it('id 不存在：数组不变，返回 false', () => {
    const arr = [{ id: 'a' }];
    expect(removeById(arr, 'b')).toBe(false);
    expect(ids(arr)).toEqual(['a']);
  });

  it('只删第一个命中，不会连带删掉后面的', () => {
    const arr = [{ id: 'dup', n: 1 }, { id: 'dup', n: 2 }];
    removeById(arr, 'dup');
    expect(arr).toHaveLength(1);
    expect(arr[0].n).toBe(2);
  });

  it('空数组 / 非数组不抛异常', () => {
    expect(removeById([], 'a')).toBe(false);
    expect(removeById(null, 'a')).toBe(false);
  });
});

describe('removeCustomMaterial（对象数组 + order 数组必须同步）', () => {
  let list, order;
  beforeEach(() => {
    list = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    order = ['c1', 'c2', 'c3'];
  });

  it('两处一起剔除，order 里不留孤儿 id', () => {
    expect(removeCustomMaterial(list, order, 'c2')).toBe(true);
    expect(ids(list)).toEqual(['c1', 'c3']);
    expect(order).toEqual(['c1', 'c3']);
  });

  it('删除后 order 与对象集合仍一一对应（这是上移/下移不错位的前提）', () => {
    removeCustomMaterial(list, order, 'c1');
    expect(order.every((id) => list.some((x) => x.id === id))).toBe(true);
    expect(list.every((x) => order.includes(x.id))).toBe(true);
  });

  it('order 里混有内置 id 时，只剔掉目标那一个', () => {
    const mixed = ['builtin_x', 'c1', 'builtin_y', 'c2'];
    removeCustomMaterial(list, mixed, 'c1');
    expect(mixed).toEqual(['builtin_x', 'builtin_y', 'c2']);
  });

  it('对象已丢但 order 仍有残留时，能把残留 id 清掉（自愈）', () => {
    const onlyOrder = ['c1', 'orphan'];
    expect(removeCustomMaterial(list, onlyOrder, 'orphan')).toBe(true);
    expect(onlyOrder).toEqual(['c1']);
  });

  it('两处都没有：返回 false，什么都不动', () => {
    expect(removeCustomMaterial(list, order, 'nope')).toBe(false);
    expect(ids(list)).toEqual(['c1', 'c2', 'c3']);
    expect(order).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('setFieldById / setLangFieldById', () => {
  it('setFieldById 命中时写入字段', () => {
    const list = [{ id: 'a', tag: '旧' }];
    expect(setFieldById(list, 'a', 'tag', '新')).toBe(true);
    expect(list[0].tag).toBe('新');
  });

  it('setFieldById 可写布尔（hidden 走的就是这条）', () => {
    const list = [{ id: 'a', hidden: false }];
    setFieldById(list, 'a', 'hidden', true);
    expect(list[0].hidden).toBe(true);
  });

  it('setFieldById 未命中不误改其他条目', () => {
    const list = [{ id: 'a', tag: '甲' }, { id: 'b', tag: '乙' }];
    expect(setFieldById(list, 'zzz', 'tag', 'X')).toBe(false);
    expect(list.map((x) => x.tag)).toEqual(['甲', '乙']);
  });

  it('setLangFieldById 写入 label/text 的指定语言，不影响另一语言', () => {
    const list = [{ id: 'm', label: { zh: '中', en: 'EN' }, text: { zh: '正文', en: 'body' } }];
    expect(setLangFieldById(list, 'm', 'label', 'zh', '改了')).toBe(true);
    expect(list[0].label).toEqual({ zh: '改了', en: 'EN' });
    setLangFieldById(list, 'm', 'text', 'en', 'changed');
    expect(list[0].text).toEqual({ zh: '正文', en: 'changed' });
  });

  it('多语结构缺失时补出来再写，不静默丢掉这次编辑', () => {
    const list = [{ id: 'm' }];
    expect(setLangFieldById(list, 'm', 'label', 'zh', '补出来')).toBe(true);
    expect(list[0].label).toEqual({ zh: '补出来' });
  });

  it('非数组不抛异常', () => {
    expect(setFieldById(null, 'a', 'tag', 'x')).toBe(false);
    expect(setLangFieldById(null, 'a', 'label', 'zh', 'x')).toBe(false);
  });
});

describe('新增素材：对象与 order 同时追加', () => {
  let state;
  beforeEach(() => {
    state = defaultState();
  });

  it('addCustomSnippet 追加到 customSnippets 与 snippetOrder 末尾', () => {
    const before = state.snippetOrder.length;
    const c = addCustomSnippet(state);
    expect(state.customSnippets[state.customSnippets.length - 1]).toBe(c);
    expect(state.snippetOrder).toHaveLength(before + 1);
    expect(state.snippetOrder[state.snippetOrder.length - 1]).toBe(c.id);
    expect(c.builtin).toBe(false);
  });

  it('addCustomModule 同理，且带 zh/en 双语骨架', () => {
    const before = state.moduleOrder.length;
    const m = addCustomModule(state);
    expect(state.customModules).toContain(m);
    expect(state.moduleOrder).toHaveLength(before + 1);
    expect(state.moduleOrder[state.moduleOrder.length - 1]).toBe(m.id);
    expect(m.label).toHaveProperty('zh');
    expect(m.label).toHaveProperty('en');
    expect(m.text).toEqual({ zh: '', en: '' });
  });

  it('连续新增的 id 互不相同（否则删一条会连带删错）', () => {
    const a = addCustomSnippet(state);
    const b = addCustomSnippet(state);
    expect(a.id).not.toBe(b.id);
    const m1 = addCustomModule(state);
    const m2 = addCustomModule(state);
    expect(m1.id).not.toBe(m2.id);
  });

  it('新增后删除，能回到新增前的 order 状态', () => {
    const snapshot = [...state.snippetOrder];
    const c = addCustomSnippet(state);
    removeCustomMaterial(state.customSnippets, state.snippetOrder, c.id);
    expect(state.snippetOrder).toEqual(snapshot);
  });

  it('addQuickGroup 追加空分组（items 是空数组，不是 undefined）', () => {
    const g = addQuickGroup(state);
    expect(state.quickGroups[state.quickGroups.length - 1]).toBe(g);
    expect(g.items).toEqual([]);
    expect(g.hidden).toBe(false);
  });

  it('addQuickItem 往指定分组追加，不影响其他分组', () => {
    const g1 = addQuickGroup(state);
    const g2 = addQuickGroup(state);
    const it = addQuickItem(g1);
    expect(g1.items).toEqual([it]);
    expect(g2.items).toEqual([]);
  });

  it('addQuickItem 在 items 缺失的脏存档上先补数组再追加', () => {
    const g = { id: 'g', label: { zh: '', en: '' } };
    const it = addQuickItem(g);
    expect(Array.isArray(g.items)).toBe(true);
    expect(g.items).toEqual([it]);
  });

  it('addQuickItem 传空分组时返回 null 而不是抛异常', () => {
    expect(addQuickItem(null)).toBe(null);
    expect(addQuickItem(undefined)).toBe(null);
  });

  it('分组内段落的 id 互不相同', () => {
    const g = addQuickGroup(state);
    const a = addQuickItem(g);
    const b = addQuickItem(g);
    expect(a.id).not.toBe(b.id);
  });
});

describe('组合场景：增删移之后不变量仍成立', () => {
  let state;
  beforeEach(() => {
    state = defaultState();
  });

  it('新增三条 → 移动 → 删中间一条：order 与对象集合始终一致', () => {
    const a = addCustomSnippet(state);
    const b = addCustomSnippet(state);
    const c = addCustomSnippet(state);
    moveId(state.snippetOrder, c.id, -1);
    removeCustomMaterial(state.customSnippets, state.snippetOrder, b.id);

    // defaultState() 自带演示常用句，只看本次新增的三条
    const mine = [a.id, b.id, c.id];
    const left = state.customSnippets.map((x) => x.id).filter((id) => mine.includes(id));
    expect(left).toEqual([a.id, c.id]);
    // 留下的每条都还在 order 里，被删的那条两处都没了
    left.forEach((id) => expect(state.snippetOrder).toContain(id));
    expect(state.snippetOrder).not.toContain(b.id);
  });

  it('分组重排后各分组的段落仍挂在自己身上（不会串组）', () => {
    const g1 = addQuickGroup(state);
    const g2 = addQuickGroup(state);
    const i1 = addQuickItem(g1);
    const i2 = addQuickItem(g2);
    moveById(state.quickGroups, g2.id, -1);

    const found1 = state.quickGroups.find((g) => g.id === g1.id);
    const found2 = state.quickGroups.find((g) => g.id === g2.id);
    expect(ids(found1.items)).toEqual([i1.id]);
    expect(ids(found2.items)).toEqual([i2.id]);
  });

  it('删掉分组不影响其余分组的段落内容', () => {
    const g1 = addQuickGroup(state);
    const g2 = addQuickGroup(state);
    const keep = addQuickItem(g2);
    addQuickItem(g1);
    removeById(state.quickGroups, g1.id);

    expect(state.quickGroups.some((g) => g.id === g1.id)).toBe(false);
    const survived = state.quickGroups.find((g) => g.id === g2.id);
    expect(ids(survived.items)).toEqual([keep.id]);
  });

  it('段落删到空之后分组仍可用（能继续新增）', () => {
    const g = addQuickGroup(state);
    const it = addQuickItem(g);
    removeById(g.items, it.id);
    expect(g.items).toEqual([]);
    const again = addQuickItem(g);
    expect(ids(g.items)).toEqual([again.id]);
  });
});
