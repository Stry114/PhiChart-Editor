/**
 * 触屏输入接线（**只在渲染器页面**用，见 `player.html` 的「触屏游玩模式」开关）。
 *
 * 职责边界：
 *  - 这里只做「浏览器事件 -> 输入缓冲」的搬运与「事件时间戳 -> 谱面时间」的换算；
 *    判定规则全在 `src/core/state.js` 的 `advancePlayJudging`，缓冲结构在 `src/core/input.js`。
 *  - 触屏游玩**仅限触屏设备**：`isTouchDevice()` 判定，桌面端面板里的开关会被禁用。
 *
 * **多指触控**（此前「偶尔只认两指」的根因都在这几处，见下）：
 *  - 每根手指各自记账（`fingers` Map，键是 `Touch.identifier`），不再共用「当前手指」这种单值状态；
 *  - `changedTouches` 只含**这次变化**的手指，`touches` 含**全部**按下的手指：两者都读，
 *    并用 `touches` 做一次对账（`syncFingers`）—— 少收到一个 touchend 也不会留下「幽灵手指」，
 *    多一根手指按下也一定立刻记账；
 *  - 界面判定**逐指**做（`touch.target`，不是整个事件的 `ev.target`）：一根手指按在暂停键上，
 *    不会把同一批事件里的其它手指一起丢掉；
 *  - 释放路径不再提前 return（以前若这批手指落在控件上，其余手指的 `up()` 会被一起跳过）。
 *
 * 移动端的系统级操作要一并挡掉（否则点/长按/滑动会打断游玩）：
 *  - `touchstart/move/end/cancel` 里 `preventDefault()`（配 CSS `touch-action: none`）→ 不滚动、不双击缩放；
 *  - `contextmenu`（长按菜单）、`gesturestart/gesturechange`（iOS 捏合）、`dblclick`（双击缩放）→ `preventDefault()`；
 *  - `selectstart` → 不进入文字选择（CSS 里还有 `user-select: none` / `-webkit-touch-callout: none` 兜底）。
 *    ⚠️ 只有「不是界面控件」的那些手指才 preventDefault：iOS 上 touchstart 被 preventDefault 之后
 *    不会再派发合成 click，按钮会点不动。
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

/** TouchList → 数组（新版浏览器可迭代，老的要按下标取；两者都兜住） */
function toArray(list) {
  if (!list) return [];
  const out = [];
  for (let i = 0; i < (list.length ?? 0); i++) out.push(list[i]);
  return out;
}

/**
 * 绑定触摸输入。
 *
 * @param {EventTarget} target 判定表面（`#stage`）
 * @param {object} input `createInput()` 的输入缓冲
 * @param {{
 *   getChartTime: () => number,   // 当前谱面时间（秒）
 *   getRate?: () => number,       // 倍速（用于把事件时间戳折算回谱面时间）
 *   isActive?: () => boolean,     // 是否在游玩中（暂停/未开始时不接受判定输入）
 *   trackAlways?: () => boolean,  // 即使不在游玩中也记账（「手指位置」调试标记要用）
 *   now?: () => number,           // 时钟（毫秒），测试可注入
 * }} ctx
 * @returns {() => void} 解绑函数
 */
export function bindTouchInput(target, input, ctx = {}) {
  if (!target?.addEventListener || !input) return () => {};
  const now = ctx.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const active = ctx.isActive ?? (() => true);
  const trackAlways = ctx.trackAlways ?? (() => false);
  /** 触摸点 → 画布 CSS 像素（判定带要用画布坐标；投影的 width/height 就是画布 CSS 尺寸） */
  const rectOf = ctx.getRect ?? (() => target.getBoundingClientRect?.() ?? { left: 0, top: 0 });
  const toCanvas = (touch) => {
    const r = rectOf() ?? { left: 0, top: 0 };
    return { x: Number(touch?.clientX) - (r.left ?? 0), y: Number(touch?.clientY) - (r.top ?? 0) };
  };
  /**
   * 每根手指的状态：`{ x0, y0, at, lastAt }`
   *  - `x0/y0` = **上一次上报滑动时**的位置（也是滑动线段的起点）
   *  - `at` = 按下时刻（毫秒），`lastAt` = 上次上报时刻（毫秒）
   */
  const fingers = new Map();
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
   * 这根手指是否落在**界面控件**上（暂停页 / 左上角暂停键 / HUD 上的按钮）。
   * 逐指判断：用 `touch.target`（手指按下时那个元素），拿不到才退回事件的 target。
   */
  const isUiTouch = (touch, ev) => {
    const t = touch?.target ?? ev?.target;
    if (!t?.closest) return false;
    return !!t.closest('#btn-pause, .screen, .action, .chip, .file, .check, input, button, label');
  };

  /** 按下：记账 + （游玩中才）产生判定输入 */
  function beginTouch(touch, ev, index) {
    const id = idOf(touch, index);
    const p = toCanvas(touch);
    input.down(id, p.x, p.y);
    fingers.set(id, { x0: p.x, y0: p.y, at: now(), lastAt: now() });
    if (active()) input.tap(chartTimeOf(ev), p.x, p.y, id);
  }

  function releaseTouch(id) {
    input.up(id);
    fingers.delete(id);
  }

  /**
   * 用 `ev.touches`（当前**全部**按下的手指）对账：我们记着、但浏览器已经不认的手指一律释放。
   * 只在这一批触摸点都带 `identifier` 时才做 —— 否则（老浏览器/合成事件）索引会错位，反而误删。
   */
  function syncFingers(list) {
    const all = toArray(list);
    if (!all.length || !all.every((t) => t?.identifier !== undefined)) return;
    const present = new Set(all.map((t) => t.identifier));
    for (const id of [...fingers.keys()]) if (!present.has(id)) releaseTouch(id);
  }

  on(
    'touchstart',
    (ev) => {
      const changed = toArray(ev.changedTouches);
      let prevented = false;
      for (let i = 0; i < changed.length; i++) {
        if (isUiTouch(changed[i], ev)) continue; // 交给浏览器：按钮/输入框照常工作
        if (!prevented) {
          ev.preventDefault?.();
          prevented = true;
        }
        if (!active() && !trackAlways()) continue;
        beginTouch(changed[i], ev, i);
      }
      syncFingers(ev.touches);
    },
    { passive: false },
  );

  on(
    'touchmove',
    (ev) => {
      const changed = toArray(ev.changedTouches);
      let prevented = false;
      const at = chartTimeOf(ev);
      for (let i = 0; i < changed.length; i++) {
        const touch = changed[i];
        if (isUiTouch(touch, ev)) continue;
        if (!prevented) {
          ev.preventDefault?.();
          prevented = true;
        }
        const id = idOf(touch, i);
        const st = fingers.get(id);
        if (!st || !Number.isFinite(touch?.clientX)) continue;
        const p = toCanvas(touch);
        input.move(id, p.x, p.y); // 手指实时位置：Drag / Flick 判「这一刻有没有手指在判定范围里」
        const dx = p.x - st.x0;
        const dy = p.y - st.y0;
        if (Math.hypot(dx, dy) < JUDGE.SWIPE_MIN_PX) continue;
        const fast = now() - st.lastAt <= JUDGE.SWIPE_MAX_MS;
        // 每移动够一个阈值就上报一段滑动（一段手指可以连续划很多次；以前一根手指只报一次，
        // 长按后再划、或连续划几个 Flick 都会漏）
        if (fast && active()) input.swipe(at, p.x, p.y, st.x0, st.y0);
        st.x0 = p.x;
        st.y0 = p.y;
        st.lastAt = now();
      }
      syncFingers(ev.touches);
    },
    { passive: false },
  );

  const release = (ev) => {
    const changed = toArray(ev.changedTouches);
    let prevented = false;
    for (let i = 0; i < changed.length; i++) {
      const touch = changed[i];
      // 释放路径**不跳过**：即使这批手指落在控件上也要把账记平（否则会留下幽灵手指）
      if (!isUiTouch(touch, ev) && !prevented) {
        ev.preventDefault?.();
        prevented = true;
      }
      releaseTouch(idOf(touch, i));
    }
    syncFingers(ev.touches);
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
    for (const id of [...fingers.keys()]) input.up(id);
    fingers.clear();
  };
}
