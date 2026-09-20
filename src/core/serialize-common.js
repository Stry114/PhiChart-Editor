/**
 * 序列化（写回谱面格式）的共用工具。
 *
 * 两套格式的差异全在这里消化（见 `格式说明.md` §4）：
 *  - 内部模型的事件是**按事件的层数组 + 缓动函数**；官方格式是**单层、分段线性、无缓动**，
 *    所以导出官谱时必须把「多层相加 + 缓动」合并成一条分段折线（`buildSegments`）。
 *  - RPE 的时间是 **Beat 有理数** `[整数, 分子, 分母]`，浮点拍要还原成好看的有理数（`beatToRpe`）。
 *
 * 本模块只做纯计算（不碰 DOM），因此可以在 Node 里直接测试。
 */
import { evalLayers } from './events.js';

/** 数值输出的有效位数：官方格式是 float32（7 位有效数字），这里统一收敛到小数点后 6 位 */
export const ROUND_DIGITS = 6;

export function round6(v, digits = ROUND_DIGITS) {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** digits;
  const out = Math.round(v * k) / k;
  return Object.is(out, -0) ? 0 : out;
}

/** 取判定线的事件列表（准备过的模型直接用编译结果；没准备过就现场编译，保证序列化器可独立使用） */
export function pickCompiled(rt, layers, key, compile) {
  if (rt && Array.isArray(rt[key])) return rt[key];
  return compile(layers, key);
}

/** 收集一组编译事件列表里的所有时间断点（秒，升序去重） */
export function collectBreakpoints(lists) {
  const set = new Set();
  for (const compiled of lists ?? []) {
    for (const e of compiled?.list ?? []) {
      if (Number.isFinite(e.t0)) set.add(e.t0);
      if (Number.isFinite(e.t1)) set.add(e.t1);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** 一组事件列表在 t 时刻的求和值（与渲染求值同一套语义：多层相加，缺省 0） */
export const listValueAt = (lists, t) => evalLayers(lists ?? [], t, 0);

/** 判定整段是否「线性」：中点等于两端均值（在容差内）即视为线性 */
function isLinearBetween(fn, t0, t1, tol = 1e-9) {
  const a = fn(t0);
  const b = fn(t1);
  const mid = fn((t0 + t1) / 2);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(mid)) return false;
  return Math.abs(mid - (a + b) / 2) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * 把若干「随时间的取值函数」整理成**分段线性/分段常量**的区间列表。
 *
 * @param {number[]} times 时间断点（秒，升序）
 * @param {((t:number)=>number)[]} fns 每个通道一个取值函数（例如 x、y 两个通道一起处理）
 * @param {{segments?:number, constant?:boolean}} [opts]
 *        segments：非线性区间（或速度斜坡）细分成几段；constant：输出分段**常量**（官方速度事件用）
 * @returns {{t0:number,t1:number,v0:number[],v1:number[]}[]}
 */
export function buildSegments(times, fns, opts = {}) {
  const segments = Math.max(1, Math.trunc(opts.segments ?? 12));
  const constant = !!opts.constant;
  const out = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const t0 = times[i];
    const t1 = times[i + 1];
    const len = t1 - t0;
    if (!(len > 0)) continue;
    const eps = Math.min(1e-6, len * 0.25);
    const v0 = fns.map((f) => f(t0 + eps));
    const v1 = fns.map((f) => f(t1 - eps));
    if (v0.some((v) => !Number.isFinite(v)) || v1.some((v) => !Number.isFinite(v))) continue;

    if (constant) {
      // 分段常量（官方 speedEvents：一个区间只有一个 value）：
      // 值取两端均值 —— 对线性斜坡来说这一步的「积分」与原函数完全一致，
      // 于是官谱重新算出来的 floorPosition 与编辑器里的音符高度一致。
      const isFlat = fns.every((_, k) => Math.abs(v0[k] - v1[k]) <= 1e-9 * Math.max(1, Math.abs(v0[k])));
      const steps = isFlat ? 1 : segments;
      const dt = len / steps;
      for (let j = 0; j < steps; j++) {
        const a = j === 0 ? v0 : fns.map((f) => f(t0 + j * dt));
        const b = j === steps - 1 ? v1 : fns.map((f) => f(t0 + (j + 1) * dt));
        out.push({
          t0: t0 + j * dt,
          t1: j === steps - 1 ? t1 : t0 + (j + 1) * dt,
          v0: a.map((v, k) => (v + b[k]) / 2),
          v1: a.map((v, k) => (v + b[k]) / 2),
        });
      }
      continue;
    }

    if (fns.every((f) => isLinearBetween(f, t0 + eps, t1 - eps))) {
      out.push({ t0, t1, v0, v1 });
      continue;
    }
    // 非线性（缓动）：细分成若干折线段近似
    const dt = len / segments;
    for (let j = 0; j < segments; j++) {
      const a = j === 0 ? v0 : fns.map((f) => f(t0 + j * dt));
      const b = j === segments - 1 ? v1 : fns.map((f) => f(t0 + (j + 1) * dt));
      out.push({ t0: t0 + j * dt, t1: j === segments - 1 ? t1 : t0 + (j + 1) * dt, v0: a, v1: b });
    }
  }
  return out;
}

/** 合并相邻的「常量且取值相同」的区间（减少事件条数，不改变曲线） */
export function coalesceFlat(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    const flat = seg.v0.every((v, k) => Math.abs(v - seg.v1[k]) <= 1e-9);
    const prevFlat = prev && prev.v0.every((v, k) => Math.abs(v - prev.v1[k]) <= 1e-9);
    if (prev && flat && prevFlat && prev.v1.every((v, k) => Math.abs(v - seg.v0[k]) <= 1e-9)) {
      prev.t1 = seg.t1;
      prev.v1 = seg.v1;
      continue;
    }
    out.push({ t0: seg.t0, t1: seg.t1, v0: [...seg.v0], v1: [...seg.v1] });
  }
  return out;
}

/** 状态函数：某个键在整个时间轴上的取值（用于把官方事件列表还原成函数，例如导入后校验） */
export function makeValueFn(lists) {
  return (t) => listValueAt(lists, t);
}

// ───────────────────────────── RPE 的 Beat 有理数 ─────────────────────────────

const gcd = (a, b) => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
};

/** 优先尝试的分母（编辑器里常见的等分刻度：2 的幂 + 三/五等分） */
const NICE_DENOMINATORS = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 256, 320, 384, 512, 640, 768, 1024, 1280, 1536, 2048,
];

/**
 * 浮点拍 → RPE 的 `[整数, 分子, 分母]`。
 *
 * 先在「好看的分母」里找精确表示（1/3 拍、1/32 拍都能原样写回），
 * 找不到就退回 1e-6 精度的既约分数（误差 ≤ 1 微拍）。
 */
export function beatToRpe(beat) {
  const value = Number.isFinite(beat) ? beat : 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const whole = Math.floor(abs + 1e-12);
  let frac = abs - whole;
  if (whole >= 2 ** 31 - 1) return [sign * (2 ** 31 - 1), 0, 1]; // RPE 的整数部分也是 32 位
  if (frac < 1e-9) return [sign * whole, 0, 1];
  for (const den of NICE_DENOMINATORS) {
    const num = Math.round(frac * den);
    if (num > 0 && num < den && Math.abs(num / den - frac) <= 1e-9) return [sign * whole, sign * num, den];
  }
  let num = Math.round(frac * 1e6);
  let den = 1e6;
  const g = gcd(num, den);
  num /= g;
  den /= g;
  if (num >= den) return [sign * (whole + 1), 0, 1];
  return [sign * whole, sign * num, den];
}

/** 拍 → 官方 time 单位（1 拍 = 32 单位） */
export const beatToOfficialTime = (beat) => Math.round((Number.isFinite(beat) ? beat : 0) * 32);

/** 官方 time 单位 → 拍 */
export const officialTimeToBeat = (time) => (Number.isFinite(time) ? time : 0) / 32;

/** 按纯文本安全化的文件名（去掉路径分隔符与非法字符，保留空格与 #） */
export function safeFileName(name, fallback = 'chart') {
  const base = String(name ?? '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim();
  return base || fallback;
}
