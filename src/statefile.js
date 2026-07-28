/* ============================================================
 * statefile.js —— composer-state.json 的原子写 / 容错读
 * ------------------------------------------------------------
 * 主窗口（store.js）与浮窗（float.js）共用同一份实现，避免两处
 * 各写一遍再漂移。所有 Tauri fs 依赖由调用方以 `fs` 对象注入
 * （{ writeTextFile, readTextFile, exists, rename }），因此本模块
 * 可以用假 fs 单测，不需要真实 Tauri 环境。
 *
 * 为什么要原子写：writeTextFile 是「截断 + 写入」，写到一半崩溃/断电
 * 就留下一个被截断的 JSON —— 而这一个文件装着用户的全部数据（素材库、
 * 翻译配置、自学习语料）。改成「先写 .tmp 再 rename 覆盖正档」，
 * rename 在 Windows/Unix 上都是单次原子替换，正档永远是完整的旧值或
 * 完整的新值，不存在中间态。
 *
 * 为什么要备份而不是静默重置：读不动/解析失败时若直接回退 defaultState()，
 * 用户下一次编辑就会把默认值写回正档，原数据彻底消失且毫无提示。现在改为
 * ①先把坏档改名成 composer-state.corrupt-<时间戳>.json 留证；
 * ②尝试用 .tmp 恢复（崩在 write→rename 之间时 .tmp 恰好是完好的新值）；
 * ③把结果状态回报给 UI 层，由它给出明确提示。
 * ============================================================ */

var STATE_FILE = 'composer-state.json';
var STATE_TMP_FILE = 'composer-state.json.tmp';

// 坏档备份文件名：composer-state.corrupt-20260728-114233.json
// 用本地时间而非 ISO，方便用户在文件管理器里对上"什么时候坏的"。
function corruptFileName(now) {
  var d = (now instanceof Date) ? now : new Date(now == null ? Date.now() : now);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return 'composer-state.corrupt-' +
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
}

/* ------------------------------------------------------------
 * 原子写：先写 .tmp，再 rename 覆盖正档。
 * fs.rename 不可用时（旧版插件 / 全局 bundle 未导出）降级为直接写正档，
 * 行为与改动前一致——宁可退回非原子，也不能让保存整体失效。
 * ---------------------------------------------------------- */
function writeStateAtomic(fs, baseDir, payload) {
  var opts = { baseDir: baseDir };
  if (typeof fs.rename !== 'function') {
    return fs.writeTextFile(STATE_FILE, payload, opts);
  }
  return fs.writeTextFile(STATE_TMP_FILE, payload, opts).then(function () {
    return fs.rename(STATE_TMP_FILE, STATE_FILE, {
      oldPathBaseDir: baseDir,
      newPathBaseDir: baseDir
    });
  });
}

/* ------------------------------------------------------------
 * 容错读。resolve 一个结果对象，永不 reject：
 *   { status:'empty' }                     —— 没有存档（首次运行）
 *   { status:'ok', data }                  —— 正档读取成功
 *   { status:'recovered', data, backup }   —— 正档坏，用 .tmp 恢复成功
 *   { status:'corrupt', backup }           —— 正档坏且无可用 .tmp，已备份坏档
 * backup 为坏档备份后的文件名（备份本身失败时为 null）。
 * ---------------------------------------------------------- */
function readState(fs, baseDir, now) {
  var opts = { baseDir: baseDir };

  function parseFile(name) {
    return fs.readTextFile(name, opts).then(function (text) {
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('state-not-object');
      }
      return parsed;
    });
  }

  // 把坏掉的正档改名留证；rename 不可用或失败时返回 null（不阻断后续流程）。
  function backupCorrupt() {
    if (typeof fs.rename !== 'function') return Promise.resolve(null);
    var name = corruptFileName(now);
    return fs.rename(STATE_FILE, name, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir })
      .then(function () { return name; })
      .catch(function () { return null; });
  }

  // 正档坏了：先备份坏档，再看 .tmp 能不能救回来。
  function recover() {
    return backupCorrupt().then(function (backup) {
      return Promise.resolve(fs.exists(STATE_TMP_FILE, opts))
        .catch(function () { return false; })
        .then(function (hasTmp) {
          if (!hasTmp) return { status: 'corrupt', backup: backup };
          return parseFile(STATE_TMP_FILE).then(
            function (data) { return { status: 'recovered', data: data, backup: backup }; },
            function () { return { status: 'corrupt', backup: backup }; }
          );
        });
    });
  }

  return Promise.resolve(fs.exists(STATE_FILE, opts))
    .then(function (exists) {
      if (!exists) return { status: 'empty' };
      return parseFile(STATE_FILE).then(
        function (data) { return { status: 'ok', data: data }; },
        recover
      );
    })
    .catch(function () {
      // exists 本身都失败（目录不可读等）：当作没有存档，不做破坏性动作。
      return { status: 'empty' };
    });
}

export {
  STATE_FILE,
  STATE_TMP_FILE,
  corruptFileName,
  writeStateAtomic,
  readState,
};
