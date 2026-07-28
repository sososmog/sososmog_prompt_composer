/* ============================================================
 * sync.js —— state 持久化 + 双窗口广播 + 回声过滤（工厂函数，依赖注入）
 * ------------------------------------------------------------
 * 主窗口 store.js 与浮窗各自维护过一份几乎相同的这套逻辑：防抖写盘、
 * emit/listen 'composer-state-changed' 广播、recentBroadcasts 回声
 * 过滤、正在编辑时暂存远端更新（pendingRemoteState）。两处实现完全
 * 独立维护，容易漂移（且确实漂移过，见 pool.js 头部注释）。
 *
 * 用工厂函数 + 依赖注入（而非直接 import Tauri API/DOM）：
 *   - fs / baseDir / eventApi：真实环境传 Tauri 句柄，单测传假对象；
 *   - getState / setState：读写调用方持有的 state 变量（本模块不持有
 *     业务 state，只知道怎么问它要、怎么替换它）；
 *   - onApply：state 已被 setState 替换后，通知调用方重渲染；
 *   - isEditing()：调用方判断"此刻是否正在编辑"（DOM 相关，注入而非
 *     本模块直接读 document.activeElement，保持这里可测）；
 *   - onError(err)：写盘失败时调用，由调用方决定怎么提示——主窗口要
 *     emitSaveStatus('error') + toast 防刷屏，浮窗只 console.warn；
 *   - onStatus(status)：'saving' | 'saved' 时调用，供调用方转发给自己
 *     的保存状态订阅者（如设置面板的"保存中…/已保存"）。原描述里没
 *     列这个参数，但主窗口的 emitSaveStatus('saving'|'saved') 与
 *     lastPersistFailed 复位（在 onStatus('saved') 里做）都要保留，
 *     拆成 onStatus/onError 两个回调职责更清楚：onStatus 管状态广播，
 *     onError 管失败的错误详情与提示。
 *
 * 已确认的时序 bug 与修法：
 *   旧代码里，recentBroadcasts 记录的回声指纹是写盘前算的 payload
 *   字符串，但 eventApi.emit(event, state) 发的是 write().then() 回调
 *   触发那一刻的**当前 state 对象**——写盘的 Promise resolve 之前，
 *   用户可能又敲了字，state 已经变了。于是"发出去的内容"和"记下的
 *   指纹"不一致：对端收到后指纹对不上，回声过滤形同虚设；更糟的是
 *   本窗口自己也会在 listen 回调里把自己刚发的（更新后的）payload
 *   误判成"别人发来的新 state"去 apply，触发一次无谓的全量 renderAll
 *   （丢焦点/滚动位置）。
 *   修法：emit 时发送 JSON.parse(payload)——即把落盘用的 payload 字符
 *   串反解回对象再发送，保证"发出去的"与"指纹记的"是完全同一份快照，
 *   不再受 emit 时刻 state 是否已被继续编辑影响。（另一种可选修法是
 *   把 payload 对应的对象在算出 payload 字符串时一并缓存下来发它；
 *   这里选 JSON.parse(payload) 是因为 payload 本身已经是权威快照，
 *   反解一次的开销可忽略，且不需要额外多存一份引用。）
 *
 * 铁律：模块加载时不碰 document——focusout 监听与 eventApi.listen
 * 只在 start() 被调用时才注册，保证本模块能在 vitest 里直接 import
 * 并用假依赖单测（不调用 start() 的用例完全不涉及 DOM）。
 * ============================================================ */
import { writeStateAtomic } from './statefile.js';

function createStateSync(opts) {
  opts = opts || {};
  var fs = opts.fs;
  var baseDir = opts.baseDir;
  var eventApi = opts.eventApi;
  var getState = opts.getState;
  var setState = opts.setState;
  var onApply = opts.onApply;
  var isEditing = opts.isEditing;
  var onError = opts.onError;
  var onStatus = opts.onStatus;

  var saveTimer = null;
  var suppressBroadcast = false; // 应用远端更新期间置真，避免 A→B→A 回声
  // 用队列而非单值：回声到达时机不定，两次连续保存会让单值被后者覆盖、漏过滤。
  var recentBroadcasts = [];
  var RECENT_BROADCAST_MAX = 6;
  var pendingRemoteState = null;
  var appDataEnsured = false;

  function tauriAvailable() { return !!(fs && baseDir != null); }

  function ensureAppDataDir() {
    if (appDataEnsured || !fs.mkdir) return Promise.resolve();
    return fs.mkdir('.', { baseDir: baseDir, recursive: true })
      .then(function () { appDataEnsured = true; })
      .catch(function () { appDataEnsured = true; });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    if (onStatus) onStatus('saving');
    saveTimer = setTimeout(persistNow, 300);
  }

  function persistNow() {
    // 非 Tauri（浏览器预览）无盘可写，直接视作"已保存"，避免状态字卡在"保存中…"
    if (!tauriAvailable()) {
      if (onStatus) onStatus('saved');
      return Promise.resolve();
    }
    var payload = JSON.stringify(getState(), null, 2);
    return ensureAppDataDir().then(function () {
      // 原子写：先写 .tmp 再 rename 覆盖正档，避免写盘中途崩溃留下截断的 JSON
      return writeStateAtomic(fs, baseDir, payload);
    }).then(function () {
      if (eventApi && eventApi.emit && !suppressBroadcast) {
        recentBroadcasts.push(payload);
        if (recentBroadcasts.length > RECENT_BROADCAST_MAX) recentBroadcasts.shift();
        // 见文件头"时序 bug"注释：emit 的必须是与指纹 payload 完全同一份快照，
        // 而不是此刻再读 getState()。
        eventApi.emit('composer-state-changed', JSON.parse(payload)).catch(function () {});
      }
      if (onStatus) onStatus('saved');
    }).catch(function (err) {
      if (onError) onError(err);
    });
  }

  function applyRemoteState(payload) {
    suppressBroadcast = true;
    setState(payload);
    if (onApply) onApply();
    suppressBroadcast = false;
  }

  function discardPending() { pendingRemoteState = null; }

  function flushPending() {
    if (pendingRemoteState && !isEditing()) {
      var payload = pendingRemoteState;
      pendingRemoteState = null;
      applyRemoteState(payload);
    }
  }

  function start() {
    if (!(eventApi && eventApi.listen)) return;
    eventApi.listen('composer-state-changed', function (evt) {
      var payload = evt && evt.payload;
      if (!payload || typeof payload !== 'object') return;
      // 过滤自我回声：命中本窗口近期广播过的任一指纹即忽略（是自己发的，本地
      // state 已经是它，无需再 apply，更不能在编辑中暂存后打断后续操作）。
      var fp = JSON.stringify(payload, null, 2);
      var hitIdx = recentBroadcasts.indexOf(fp);
      if (hitIdx !== -1) {
        recentBroadcasts.splice(hitIdx, 1); // 消费掉，避免误吃后续同内容的真实更新
        return;
      }
      if (isEditing()) {
        // 正在编辑：暂存最新一份，待失焦后应用（后到的覆盖先到的，只保留最新）
        pendingRemoteState = payload;
        return;
      }
      applyRemoteState(payload);
    }).catch(function () {});
    // 失焦后把暂存的远端 state flush 掉；focusout 触发时 activeElement 可能尚未
    // 切换，延到下一微/宏任务再判断。
    document.addEventListener('focusout', function () {
      setTimeout(flushPending, 0);
    });
  }

  return {
    scheduleSave: scheduleSave,
    persistNow: persistNow,
    discardPending: discardPending,
    flushPending: flushPending,
    start: start,
    // 未在原设计草图里列出，但 store.js 需要保留可独立调用的 applyRemoteState
    // 导出名（历史 API 面），且 suppressBroadcast 是本模块私有闭包变量，只能
    // 由本模块自己驱动这套"设置+渲染"的组合，故一并导出。
    applyRemoteState: applyRemoteState,
  };
}

export { createStateSync };
