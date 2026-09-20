/**
 * 触屏输入接线（**只在渲染器页面**用，见 `player.html` 的「触屏游玩模式」开关）。
 *
 * 职责边界：
 *  - 这里只做「浏览器事件 -> 输入缓冲」的搬运与「事件时间戳 -> 谱面时间」的换算；
 *    判定规则全在 `src/core/state.js` 的 `advancePlayJudging`，缓冲结构在 `src/core/input.js`。
 *  - 触屏游玩**仅限触屏设备**：`isTouchDevice()` 判定，桌面端面板里的开关会被禁用。
 *
 * 移动端的系统级操作要一并挡掉（否则点/长按/滑动会打断游玩）：
 *  - `touchstart/move/end/cancel` 里 `preventDefault()`（配 CSS `touch-action: none`）→ 不滚动、不双击缩放；
 *  - `contextmenu`（长按菜单）、`gesturestart/gesturechange`（iOS 捏合）、`dblclick`（双击缩放）→ `preventDefault()`；
 *  - `selectstart` → 不进入文字选择（CSS 里还有 `user-select: none` / `-webkit-touch-callout: none` 兜底）。
 */
import { JUDGE } from '../core/units.js';

/** 这台设备能不能玩：有触摸点（或存在 ontouchstart）即视为触屏设备 */
export function isTouchDevice(win = globalThis) {
  if (!win) return false;
  const points = win.navigator?.maxTouchPoints ?? win.navigator?.msMaxTouchPoints ?? 0;
  if (points > 0) return true;
  return 'ontouchstart' in win;
}

/** 触摸点的标识（多指判定按它区分手指） */
const idOf = (touch, index) => (touch?.identifier !== undefined ? touch.identifier : `i${index}`);

/**
 * 绑定触摸输入。
 *
 * @param {EventTarget} target 判定表面（`#stage-wrap`）
 * @param {object} input `createInput()` 的输入缓冲
 * @param {{
 *   getChartTime: () => number,   // 当前谱面时间（秒）
 *   getRate?: () => number,       // 倍速（用于把事件时间戳折算回谱面时间）
 *   isActive?: () => boolean,     // 是否在游玩中（暂停/未开始时不接受输入）
 *   now?: () => number,           // 时钟（毫秒），测试可注入
 * }} ctx
 * @returns {() => void} 解绑函数
 */
export function bindTouchInput(target, input, ctx = {}) {
  if (!target?.addEventListener || !input) return () => {};
  const now = ctx.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const active = ctx.isActive ?? (() => true);
  /** 触摸点 → 画布 CSS 像素（判定带要用画布坐标；投影的 width/height 就是画布 CSS 尺寸） */
  const rectOf = ctx.getRect ?? (() => target.getBoundingClientRect?.() ?? { left: 0, top: 0 });
  const toCanvas = (touch) => {
    const r = rectOf() ?? { left: 0, top: 0 };
    return { x: Number(touch?.clientX) - (r.left ?? 0), y: Number(touch?.clientY) - (r.top ?? 0) };
  };
  /** 手指起始位置与时刻：判断「滑动」用 */
  const starts = new Map();
  const listeners = [];

  const on = (type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push([type, fn, options]);
  };

  /**
   * 事件时间戳 -> 谱面时间。
   * 触摸事件的 `timeStamp` 与帧读取的时钟是同一时间轴，所以「这一帧的谱面时间 − 事件延迟 × 倍速」
   * 就是手指落下那一刻的谱面时间（最多往回 80ms，避免时间戳异常时把判定拉到很久以前）。
   */
  function chartTimeOf(ev) {
    const t = ctx.getChartTime?.() ?? 0;
    const rate = ctx.getRate?.() ?? 1;
    const stamp = Number(ev?.timeStamp);
    if (!Number.isFinite(stamp)) return t;
    const delay = Math.min(Math.max(0, now() - stamp), 80) / 1000;
    return t - delay * rate;
  }

  /**
   * 事件是否落在**界面控件**上（暂停页 / 左上角暂停键 / HUD 上的按钮）。
   * 这类目标既不参与判定、也**不能 preventDefault**：iOS 上 touchstart 被 preventDefault
   * 之后就不会再派发合成 click，按钮会「点不动」。touch 事件的 target 是手指按下时那个元素。
   */
  const isUiTarget = (ev) => {
    const t = ev?.target;
    if (!t?.closest) return false;
    return !!t.closest('#btn-pause, .screen, .action, .chip, .file, .check, input, button, label');
  };

  on(
    'touchstart',
    (ev) => {
      if (isUiTarget(ev)) return; // 交给浏览器：按钮/输入框照常工作
      ev.preventDefault?.();
      if (!active()) return;
      const touches = ev.changedTouches ?? [];
      const at = chartTimeOf(ev);
      for (let i = 0; i < touches.length; i++) {
        const id = idOf(touches[i], i);
        const touch = touches[i];
        const p = toCanvas(touch);
        input.down(id, p.x, p.y);
        input.tap(at, p.x, p.y, id); // 一根手指 = 一次「按下」输入（多指判定 / Hold 保持靠它）
        if (Number.isFinite(touch?.clientX)) starts.set(id, { x: p.x, y: p.y, at: now(), moved: false });
      }
    },
    { passive: false },
  );

  on(
    'touchmove',
    (ev) => {
      if (isUiTarget(ev)) return;
      ev.preventDefault?.();
      if (!active()) return;
      const touches = ev.changedTouches ?? [];
      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i];
        const id = idOf(touch, i);
        const start = starts.get(id);
        if (!start || !Number.isFinite(touch?.clientX)) continue;
        const p = toCanvas(touch);
        input.move(id, p.x, p.y); // 手指实时位置：Drag 要判「这一刻有没有手指在判定带里」
        if (start.moved) continue;
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (Math.hypot(dx, dy) < JUDGE.SWIPE_MIN_PX) continue;
        start.moved = true; // 一根手指只报一次滑动
        // 起点 + 当前点都带上：Flick 判定要的是「滑动是否经过音符的判定带」
        if (now() - start.at <= JUDGE.SWIPE_MAX_MS) input.swipe(chartTimeOf(ev), p.x, p.y, start.x, start.y);
      }
    },
    { passive: false },
  );

  const release = (ev) => {
    if (isUiTarget(ev)) return;
    ev.preventDefault?.();
    const touches = ev.changedTouches ?? [];
    for (let i = 0; i < touches.length; i++) {
      const id = idOf(touches[i], i);
      input.up(id);
      starts.delete(id);
    }
  };
  on('touchend', release, { passive: false });
  on('touchcancel', release, { passive: false });

  // ── 系统级手势：长按菜单 / iOS 捏合 / 双击缩放 / 文字选择 ──
  const block = (ev) => ev.preventDefault?.();
  on('contextmenu', block);
  on('gesturestart', block);
  on('gesturechange', block);
  on('gestureend', block);
  on('dblclick', block);
  on('selectstart', block);

  return () => {
    for (const [type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    listeners.length = 0;
    starts.clear();
  };
}
