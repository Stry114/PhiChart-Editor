/**
 * 真实游玩（触屏）的**输入缓冲**：DOM 无关，只有「这一帧收到了什么」。
 *
 * 为什么单独一层：判定逻辑（`state.js` 的 `advancePlayJudging`）要能在 Node 里直接测，
 * 不能依赖浏览器事件；触摸事件的绑定与「事件时间戳 → 谱面时间」的换算放在
 * `src/app/touch-input.js`，那边只负责往这份缓冲里塞数据。
 *
 * 一帧的生命周期（由 app 的帧循环驱动）：
 *   touch 事件随时到达 → tap()/swipe()/down()/up() 写入
 *   → 帧循环用当前谱面时间判定（消费 taps/swipes）
 *   → endFrame() 清空「一次性」的 taps/swipes（手指按下状态 fingers 保留）
 */

/**
 * @returns {object} 输入缓冲
 *  - `taps`：本帧新增的「按下」事件 `[{ at, x, y, id }]`，`at` 是换算后的谱面时间（秒），
 *    `x / y` 是**画布 CSS 像素坐标**（判定范围要用它），`id` 是手指标识（Hold 要跟踪它）
 *  - `swipes`：本帧新增的「滑动」事件 `[{ at, x, y, x0, y0 }]`，起点 + 当前点用于「是否经过判定带」
 *  - `fingers`：当前按下的手指 id 集合（多指判定 / Hold 保持用）
 *  - `positions`：当前按下手指的**实时位置** `Map<id, {x, y}>`（Drag 要判「判定时刻有没有手指在带里」）
 */
export function createInput() {
  const taps = [];
  const swipes = [];
  const fingers = new Set();
  const positions = new Map();
  const pt = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
  return {
    taps,
    swipes,
    fingers,
    positions,
    get fingerCount() {
      return fingers.size;
    },
    /** 一根手指按下（触摸瞬间）。at = 谱面时间（秒），x/y = 画布坐标，id = 手指标识 */
    tap(at, x, y, id) {
      taps.push({ at: Number.isFinite(at) ? at : 0, ...(pt(x, y) ?? {}), ...(id === undefined || id === null ? {} : { id }) });
    },
    /** 一次滑动（手指位移超过阈值且够快）。x0/y0 = 起点，x/y = 触发滑动时的位置 */
    swipe(at, x, y, x0, y0) {
      swipes.push({ at: Number.isFinite(at) ? at : 0, ...(pt(x, y) ?? {}), ...(pt(x0, y0) ? { x0, y0 } : {}) });
    },
    down(id, x, y) {
      fingers.add(id);
      const p = pt(x, y);
      if (p) positions.set(id, p);
    },
    /** 手指移动：更新实时位置（Drag 的判定带检查用） */
    move(id, x, y) {
      const p = pt(x, y);
      if (p && fingers.has(id)) positions.set(id, p);
    },
    up(id) {
      fingers.delete(id);
      positions.delete(id);
    },
    /** 帧末：清掉一次性输入（按下状态与位置保留，跨帧有效） */
    endFrame() {
      taps.length = 0;
      swipes.length = 0;
    },
    /** 全部清空（暂停 / 退出游玩 / 换谱面时用） */
    clear() {
      taps.length = 0;
      swipes.length = 0;
      fingers.clear();
      positions.clear();
    },
  };
}
