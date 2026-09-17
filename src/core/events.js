/**
 * 事件与层：
 *  - 事件在模型层用「拍」表示，编译时统一转成秒（点击求值全部在秒域进行）。
 *  - RPE 的事件层**相加**（docs/02 §4）；官方格式只有一层。
 *  - 只有「含该事件的层」参与求和；所有层都没有该事件时取默认值（x/y/rotate = 0 即画面中心、
 *    alpha = 0 即不显示、speed = 1 Y/s）。
 *  - speed 事件对**秒**积分得到判定线高度 PJ(t)（docs/03 §2）。
 */
import { LINEAR } from './easing.js';
import { OFFICIAL } from './units.js';

/**
 * 编译单条事件列表。
 * @param {{startBeat:number,endBeat:number,start:number,end:number,easingFn?:Function}[]} events 已按单位换算
 * @param {ReturnType<import('./timing.js').createTimeline>} timeline
 */
export function compileEventList(events, timeline) {
  const list = [];
  for (const e of events || []) {
    const t0 = timeline.beatToSeconds(e.startBeat);
    let t1 = timeline.beatToSeconds(e.endBeat);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (t1 < t0) continue; // startTime > endTime：忽略（docs/01 §7）
    if (t1 === t0) t1 = t0; // 零长事件：瞬时取值
    list.push({ t0, t1, v0: e.start, v1: e.end, f: e.easingFn || LINEAR, instant: t1 <= t0 });
  }
  list.sort((a, b) => a.t0 - b.t0);
  const starts = list.map((e) => e.t0);
  return { list, starts };
}

/** 在给定时刻求一条事件列表的值；t 早于首事件时返回 fallback，晚于末事件时保持末值 */
export function evalEventList(compiled, t, fallback = 0) {
  const { list, starts } = compiled;
  if (!list.length) return fallback;
  if (t < starts[0]) return fallback;
  // 找到最后一个 t0 <= t 的事件
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const e = list[lo];
  if (t >= e.t1) {
    // 可能是「事件之间的空隙」：向后找是否有覆盖 t 的事件（一般不会出现，兼容不规范谱面）
    for (let i = lo + 1; i < list.length; i++) {
      const n = list[i];
      if (n.t0 > t) return e.v1;
      if (t <= n.t1) return n.instant ? n.v1 : lerpEvent(n, t);
    }
    return e.v1;
  }
  return e.instant ? e.v1 : lerpEvent(e, t);
}

function lerpEvent(e, t) {
  const span = e.t1 - e.t0;
  if (span <= 0) return e.v1;
  const u = (t - e.t0) / span;
  if (e.v0 === e.v1) return e.v0;
  return e.v0 + (e.v1 - e.v0) * e.f(Math.min(Math.max(u, 0), 1));
}

/**
 * 编译多层事件（RPE 事件层）。
 * @param {object[]} layers 每层形如 { x: [...], y: [...], rotate: [...], alpha: [...], speed: [...] }
 * @param {string} key 事件键名
 */
export function compileLayers(layers, key, timeline) {
  const out = [];
  for (const layer of layers || []) {
    const raw = layer?.[key];
    if (!raw || !raw.length) continue; // 该层没有这类事件：不参与求和
    out.push(compileEventList(raw, timeline));
  }
  return out;
}

/** 多层求和求值 */
export function evalLayers(compiledLists, t, fallback = 0) {
  if (!compiledLists.length) return fallback;
  let sum = 0;
  for (const c of compiledLists) {
    const v = evalEventList(c, t, fallback);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

/** 所有层都含该事件才求和；否则按「仅含该事件的层」求和 */
export function evalLayersWithDefault(compiledLists, t, fallbackWhenEmpty) {
  if (!compiledLists.length) return fallbackWhenEmpty;
  return evalLayers(compiledLists, t, 0);
}

/**
 * 段内数值积分（辛普森，n 为偶数）。
 * 注意：右端点必须取**段内极限值**——事件边界处速度函数会跳变，
 * 若直接取 fn(t1) 会拿到下一段的值，导致常量段积分出现 O(h·Δv) 的误差。
 * 常量段直接返回 精确值，避免辛普森舍入。
 */
function integrateSegment(fn, t0, t1, n = 8) {
  if (!(t1 > t0)) return 0;
  const h = (t1 - t0) / n;
  const eps = Math.max(1e-9, (t1 - t0) * 1e-9);
  const vals = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = t0 + i * h;
    vals[i] = fn(t === t1 ? t1 - eps : t);
  }
  const first = vals[0];
  if (vals.every((v) => v === first)) return first * (t1 - t0);
  let sum = vals[0] + vals[n];
  for (let i = 1; i < n; i++) sum += vals[i] * (i % 2 ? 4 : 2);
  return (sum * h) / 3;
}

/**
 * 构造判定线高度函数 PJ(t)（单位 Y）：速度事件对秒积分。
 * 官方规则：若首条速度事件的 startTime 不为 0，等价于在其前插入 [0, startTime] value = 1 的事件（docs/01 §7）。
 * @param {{list:any[],starts:number[]}[]} speedLayers 已编译的各层速度事件
 * @returns {(t:number)=>number} 高度（Y）
 */
export function buildHeightFn(speedLayers) {
  const boundaries = new Set();
  const layers = speedLayers.map((c) => c.list).filter((l) => l.length);
  for (const l of layers) {
    for (const e of l) {
      boundaries.add(e.t0);
      boundaries.add(e.t1);
    }
  }
  const times = [...boundaries].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!times.length) return () => 0;

  // 首事件不从 0 开始时补齐 [0, firstT] value = 1
  const firstT = times[0];
  const useImplicit = firstT > 0;

  const valueAt = (t) => {
    let sum = 0;
    for (const l of layers) {
      const compiled = { list: l, starts: l.map((e) => e.t0) };
      const v = evalEventList(compiled, t, 0);
      if (Number.isFinite(v)) sum += v;
    }
    return sum;
  };
  const valueWithImplicit = (t) => (useImplicit && t < firstT ? 1 : valueAt(t));

  const keys = useImplicit ? [0, ...times] : times;
  const cum = new Float64Array(keys.length);
  for (let i = 1; i < keys.length; i++) {
    cum[i] = cum[i - 1] + integrateSegment(valueWithImplicit, keys[i - 1], keys[i]);
  }

  return function heightAt(t) {
    if (!Number.isFinite(t)) return 0;
    if (t <= keys[0]) {
      // 首事件之前：按首段速度外推（官方对负时间同样处理）
      return valueWithImplicit(keys[0]) * (t - keys[0]);
    }
    let lo = 0;
    let hi = keys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keys[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return cum[lo] + integrateSegment(valueWithImplicit, keys[lo], t);
  };
}

/** 官方速度事件 -> 统一事件对象（value 同时作为 start/end，单位为 Y/s） */
export function officialSpeedEventToEvent(evt) {
  return { startBeat: evt.startTime / 32, endBeat: evt.endTime / 32, start: evt.value, end: evt.value };
}

/** 官方判定线事件 -> 统一事件对象（values 由调用方给出） */
export function officialEventToEvent(evt, startValue, endValue) {
  const startBeat = evt.startTime / 32;
  let endBeat = evt.endTime / 32;
  if (endBeat < startBeat) endBeat = startBeat;
  if (endBeat > OFFICIAL.SENTINEL_MAX) endBeat = 1e9; // 哨兵：保持为极大值
  return { startBeat, endBeat, start: startValue, end: endValue };
}
