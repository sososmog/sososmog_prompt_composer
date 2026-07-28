/* ============================================================
 * main.js —— 应用唯一入口
 * ------------------------------------------------------------
 * 职责单一：等 events.js 连同它 import 的 store / render / quick /
 * guide / backup 等整张模块图装配完成之后，调用 bootstrap() 触发一次
 * 真实启动——挂上事件监听（bindEvents）、恢复存档、按需弹新手引导、
 * 3 秒后查更新。
 *
 * 单独拆出这一步，是为了让 events.js 本身可以被安全 import——
 * import 只是装配模块图，既不接线也不启动，测试因此可以只取其中
 * 一部分行为来验证。
 * index.html 现在加载的是本文件而非 events.js：CSP 配了
 * script-src 'self'，不允许内联 <script> 调用 bootstrap()，
 * 必须是这样一个外置文件。
 * ============================================================ */
import { bootstrap } from './events.js';

bootstrap();
