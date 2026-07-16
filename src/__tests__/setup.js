// core.js 现在是 ES module，直接 import 即可。保留 loadComposer() 接口以免
// 改动各测试文件：它返回一个包含 core.js 全部导出的命名空间对象，
// 与旧的 window.Composer 形状一致。
import * as Composer from '../core.js';

export function loadComposer() {
  return Composer;
}
