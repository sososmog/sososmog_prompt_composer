import { describe, it, expect } from 'vitest';
import {
  STATE_FILE,
  STATE_TMP_FILE,
  corruptFileName,
  writeStateAtomic,
  readState,
} from '../statefile.js';

/* 假 fs：用一个普通对象当磁盘，记录调用顺序，用来断言"原子写"的真实行为。
 * files 里的 key 就是文件名，value 是文本内容。 */
function fakeFs(initial, opts) {
  opts = opts || {};
  var files = Object.assign({}, initial);
  var calls = [];
  var fs = {
    files: files,
    calls: calls,
    writeTextFile: function (name, text) {
      calls.push('write:' + name);
      if (opts.failWrite) return Promise.reject(new Error('disk full'));
      files[name] = text;
      return Promise.resolve();
    },
    readTextFile: function (name) {
      calls.push('read:' + name);
      if (!(name in files)) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(files[name]);
    },
    exists: function (name) {
      calls.push('exists:' + name);
      if (opts.failExists) return Promise.reject(new Error('EACCES'));
      return Promise.resolve(name in files);
    },
  };
  if (!opts.noRename) {
    fs.rename = function (from, to) {
      calls.push('rename:' + from + '->' + to);
      if (opts.failRename) return Promise.reject(new Error('EPERM'));
      if (!(from in files)) return Promise.reject(new Error('ENOENT'));
      files[to] = files[from];
      delete files[from];
      return Promise.resolve();
    };
  }
  return fs;
}

describe('corruptFileName', () => {
  it('用本地时间生成可读的备份名', () => {
    const name = corruptFileName(new Date(2026, 6, 28, 9, 5, 3));
    expect(name).toBe('composer-state.corrupt-20260728-090503.json');
  });
  it('缺省参数时也能生成合法名字', () => {
    expect(corruptFileName()).toMatch(/^composer-state\.corrupt-\d{8}-\d{6}\.json$/);
  });
});

describe('writeStateAtomic', () => {
  it('先写 .tmp 再 rename 覆盖正档（顺序必须如此，否则不是原子的）', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'old' });
    await writeStateAtomic(fs, 'AppData', 'new');
    expect(fs.calls).toEqual(['write:' + STATE_TMP_FILE, 'rename:' + STATE_TMP_FILE + '->' + STATE_FILE]);
    expect(fs.files[STATE_FILE]).toBe('new');
    expect(STATE_TMP_FILE in fs.files).toBe(false);
  });

  it('写 .tmp 失败时正档保持旧值不被破坏', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'old' }, { failWrite: true });
    await expect(writeStateAtomic(fs, 'AppData', 'new')).rejects.toThrow('disk full');
    expect(fs.files[STATE_FILE]).toBe('old');
  });

  it('rename 不可用时降级为直接写正档（不能让保存整体失效）', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'old' }, { noRename: true });
    await writeStateAtomic(fs, 'AppData', 'new');
    expect(fs.calls).toEqual(['write:' + STATE_FILE]);
    expect(fs.files[STATE_FILE]).toBe('new');
  });
});

describe('readState', () => {
  it('没有存档 → empty（首次运行，不做任何破坏性动作）', async () => {
    const fs = fakeFs({});
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('empty');
    expect(fs.calls.some((c) => c.startsWith('rename'))).toBe(false);
  });

  it('正档完好 → ok，返回解析后的对象', async () => {
    const fs = fakeFs({ [STATE_FILE]: '{"lang":"en"}' });
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ lang: 'en' });
  });

  it('正档是截断的 JSON 且有完好 .tmp → recovered，并备份坏档', async () => {
    const fs = fakeFs({
      [STATE_FILE]: '{"lang":"zh","content"',   // 写盘中途崩溃留下的截断内容
      [STATE_TMP_FILE]: '{"lang":"zh","ok":true}',
    });
    const res = await readState(fs, 'AppData', new Date(2026, 6, 28, 1, 2, 3));
    expect(res.status).toBe('recovered');
    expect(res.data).toEqual({ lang: 'zh', ok: true });
    expect(res.backup).toBe('composer-state.corrupt-20260728-010203.json');
    // 坏档已改名留证，不是被删掉
    expect(fs.files['composer-state.corrupt-20260728-010203.json']).toBe('{"lang":"zh","content"');
    expect(STATE_FILE in fs.files).toBe(false);
  });

  it('正档损坏且无 .tmp → corrupt，坏档已备份（绝不静默丢数据）', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'not json at all' });
    const res = await readState(fs, 'AppData', new Date(2026, 0, 2, 3, 4, 5));
    expect(res.status).toBe('corrupt');
    expect(res.backup).toBe('composer-state.corrupt-20260102-030405.json');
    expect(fs.files['composer-state.corrupt-20260102-030405.json']).toBe('not json at all');
    expect(res.data).toBeUndefined();
  });

  it('正档损坏且 .tmp 也损坏 → corrupt', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'bad', [STATE_TMP_FILE]: 'also bad' });
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('corrupt');
    expect(res.backup).toMatch(/^composer-state\.corrupt-/);
  });

  it('存档是合法 JSON 但不是对象（如 "null" / 数组）→ 视为损坏', async () => {
    for (const bad of ['null', '[1,2]', '"str"', '42']) {
      const fs = fakeFs({ [STATE_FILE]: bad });
      const res = await readState(fs, 'AppData');
      expect(res.status).toBe('corrupt');
    }
  });

  it('rename 不可用时仍报 corrupt，但 backup 为 null（不阻断启动）', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'bad' }, { noRename: true });
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('corrupt');
    expect(res.backup).toBeNull();
    expect(fs.files[STATE_FILE]).toBe('bad'); // 备份不了就原地留着，别删
  });

  it('备份 rename 失败也不抛，仍能继续启动', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'bad' }, { failRename: true });
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('corrupt');
    expect(res.backup).toBeNull();
  });

  it('exists 本身失败（目录不可读）→ empty，不做破坏性动作', async () => {
    const fs = fakeFs({ [STATE_FILE]: '{"lang":"zh"}' }, { failExists: true });
    const res = await readState(fs, 'AppData');
    expect(res.status).toBe('empty');
    expect(fs.files[STATE_FILE]).toBe('{"lang":"zh"}');
  });

  it('readState 永不 reject（UI 层可以不写 catch）', async () => {
    const fs = fakeFs({ [STATE_FILE]: 'bad' }, { failRename: true, failWrite: true });
    await expect(readState(fs, 'AppData')).resolves.toBeTruthy();
  });
});
