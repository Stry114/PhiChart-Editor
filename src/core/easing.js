/**
 * 缓动：RPE 的 29 种预设 + 自定义三次贝塞尔 + 缓动裁剪（easingLeft/easingRight）。
 * 官方格式不支持缓动（恒为线性），内部统一用本模块的函数表示。
 * 编号对照依据 docs/02 §5（Phira `RPE_TWEEN_MAP` + Phira Documents）。
 * 公式与 easings.net / Phira 的 rpe_easing 一致。
 */

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

const n1 = 7.5625;
const d1 = 2.75;

const outBounce = (t) => {
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/**
 * 索引 1..29 对应 RPE 的 easingType。
 * 索引 0 不是合法编号：RPE/Phira 会把越界值钳制到合法范围（<1 → 1），因此这里也放线性实现。
 */
export const EASING_PRESETS = [
  (t) => t, // 0（钳制到 1）
  (t) => t, // 1 Linear
  (t) => Math.sin((t * Math.PI) / 2), // 2 Out Sine
  (t) => 1 - Math.cos((t * Math.PI) / 2), // 3 In Sine
  (t) => 1 - (1 - t) ** 2, // 4 Out Quad
  (t) => t ** 2, // 5 In Quad
  (t) => -(Math.cos(Math.PI * t) - 1) / 2, // 6 In Out Sine
  (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2), // 7 In Out Quad
  (t) => 1 - (1 - t) ** 3, // 8 Out Cubic
  (t) => t ** 3, // 9 In Cubic
  (t) => 1 - (1 - t) ** 4, // 10 Out Quart
  (t) => t ** 4, // 11 In Quart
  (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2), // 12 In Out Cubic
  (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2), // 13 In Out Quart
  (t) => 1 - (1 - t) ** 5, // 14 Out Quint
  (t) => t ** 5, // 15 In Quint
  (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)), // 16 Out Expo
  (t) => (t <= 0 ? 0 : 2 ** (10 * (t - 1))), // 17 In Expo
  (t) => Math.sqrt(1 - (t - 1) ** 2), // 18 Out Circ
  (t) => 1 - Math.sqrt(1 - t ** 2), // 19 In Circ
  (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2, // 20 Out Back
  (t) => c3 * t ** 3 - c1 * t ** 2, // 21 In Back
  (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2), // 22 In Out Circ
  (t) =>
    t < 0.5
      ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2
      : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2, // 23 In Out Back
  (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1), // 24 Out Elastic
  (t) => (t <= 0 ? 0 : t >= 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * c4)), // 25 In Elastic
  outBounce, // 26 Out Bounce
  (t) => 1 - outBounce(1 - t), // 27 In Bounce
  (t) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2), // 28 In Out Bounce
  (t) =>
    t <= 0
      ? 0
      : t >= 1
        ? 1
        : t < 0.5
          ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1, // 29 In Out Elastic
];

export const EASING_COUNT = 29;

/** 求解三次贝塞尔 x -> y（与 CSS cubic-bezier 一致：牛顿迭代 + 二分兜底） */
export function cubicBezier(x1, y1, x2, y2) {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = -6 * x1 + 3 * x2;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = -6 * y1 + 3 * y2;
  const cy = 3 * y1;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = sampleDX(t);
      const e = sampleX(t) - x;
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      t -= e / d;
      if (t < 0 || t > 1) {
        t = (t < 0 ? 0 : 1);
        break;
      }
    }
    if (Math.abs(sampleX(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (sampleX(mid) < x) lo = mid;
        else hi = mid;
      }
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/**
 * 生成缓动函数。
 * @param {number} [type] RPE easingType（1..29），缺省 1（线性）
 * @param {number[]|null} [bezierPoints] 自定义贝塞尔控制点 [x1,y1,x2,y2]；为 null 时用预设
 * @param {number} [left] easingLeft 裁剪左值 0..1
 * @param {number} [right] easingRight 裁剪右值 0..1
 * @returns {(t: number) => number}
 */
export function makeEasing(type = 1, bezierPoints = null, left = 0, right = 1) {
  let base;
  if (Array.isArray(bezierPoints) && bezierPoints.length === 4) {
    base = cubicBezier(bezierPoints[0], bezierPoints[1], bezierPoints[2], bezierPoints[3]);
  } else {
    const id = Math.min(Math.max(Math.trunc(type) || 1, 1), EASING_COUNT);
    base = EASING_PRESETS[id];
  }
  if ((left > 0 || right < 1) && right > left) {
    const lo = base(left);
    const hi = base(right);
    const span = hi - lo;
    if (Math.abs(span) > 1e-9) {
      return (t) => (base(left + (right - left) * t) - lo) / span;
    }
  }
  return base;
}

export const LINEAR = EASING_PRESETS[1];
