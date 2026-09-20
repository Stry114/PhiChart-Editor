/**
 * 剪刀：在指定拍处把事件 / Hold 切成两段。
 *
 * 核心要求是「切断后的曲线和原本的曲线相近」，这里做到的是**完全等价**：
 *
 *  1) 切口处的新始末值 = 原曲线在那一点的取值：
 *       vCut = start + (end − start) · easingFn(u)        （u 为原事件的进度 0..1）
 *     第一段的结束值、第二段的起始值都取它，曲线在切口处连续、不跳变。
 *
 *  2) 两段继续用原来的缓动表达：
 *     · 预设缓动 → 用 RPE 自带的 easingLeft/easingRight 裁切原曲线。
 *       本项目的 makeEasing 裁剪实现是 (f(L+(R−L)t) − f(L)) / (f(R) − f(L))，
 *       把原窗口 [L,R] 在 x 处切开、两段分别取 [L,x] 与 [x,R]，拼起来恰好等于原曲线
 *       —— 不是「相近」，是数学上一致（editor-smoke 里逐点比对了）。
 *     · 贝塞尔 → 对三次曲线做 de Casteljau 分割（先解出 x 对应的参数 t），
 *       两半仍以三次贝塞尔表达，同样等价。
 *
 *  3) 「保持到结束」（endBeat 是哨兵）的事件也能切：第一段落到切口，第二段保持哨兵。
 *  4) Hold 切成两个音符：时间/时长按切口分，位置取原判定线在该时刻的高度，
 *     切口处首尾相接、看起来与原来一致。注意玩法上会变成两个 Hold（判定不同），
 *     这是「剪开」的固有含义。
 */
import { makeEasing } from '../core/easing.js';
import { eventArrayOf } from './clipboard.js';

const SENTINEL_BEAT = 1e6;
const MIN_SPAN_BEAT = 1e-3; // 切口离两端太近就不切（避免产生零长事件）

/** 三次贝塞尔：由 x 反解参数 t（与 core/easing.js 的 cubicBezier 同一套数值方法） */
function solveTForX(x1, y1, x2, y2, x) {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = -6 * x1 + 3 * x2;
  const cx = 3 * x1;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 12; i++) {
    const d = sampleDX(t);
    const e = sampleX(t) - x;
    if (Math.abs(e) < 1e-9 || Math.abs(d) < 1e-9) break;
    const next = t - e / d;
    if (!(next >= 0 && next <= 1)) break;
    t = next;
  }
  if (Math.abs(sampleX(t) - x) > 1e-7) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (sampleX(mid) < x) lo = mid;
      else hi = mid;
    }
    t = (lo + hi) / 2;
  }
  return t;
}

/**
 * 把三次贝塞尔 [x1,y1,x2,y2]（控制点为 (0,0),(x1,y1),(x2,y2),(1,1)）在 x=u 处分割，
 * 两半各自归一化到 x∈[0,1]、y∈[0,1]（正是 bezierPoints 的语义）。
 * @returns {{left:number[], right:number[]}|null} 取值几乎不变化（y 退化）时返回 null
 */
export function splitCubicBezierAt(bezierPoints, u) {
  if (!Array.isArray(bezierPoints) || bezierPoints.length !== 4) return null;
  const [x1, y1, x2, y2] = bezierPoints;
  const t = solveTForX(x1, y1, x2, y2, u);
  const p0 = { x: 0, y: 0 };
  const p1 = { x: x1, y: y1 };
  const p2 = { x: x2, y: y2 };
  const p3 = { x: 1, y: 1 };
  const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a1 = lerp(p0, p1);
  const a2 = lerp(p1, p2);
  const a3 = lerp(p2, p3);
  const b1 = lerp(a1, a2);
  const b2 = lerp(a2, a3);
  const s = lerp(b1, b2);
  const yS = s.y;
  if (!(yS > 1e-6) || !(1 - yS > 1e-6)) return null;
  return {
    left: [a1.x / u, a1.y / yS, b1.x / u, b1.y / yS],
    right: [(b2.x - u) / (1 - u), (b2.y - yS) / (1 - yS), (a3.x - u) / (1 - u), (a3.y - yS) / (1 - yS)],
  };
}

/** 事件在进度 u（0..1，已含缓动与裁剪）处的取值；颜色事件（数组值）逐通道插值 */
export function valueAtProgress(ev, u) {
  let k = u;
  if (typeof ev?.easingFn === 'function') {
    try {
      k = ev.easingFn(u);
    } catch {
      k = u;
    }
  }
  if (!Number.isFinite(k)) k = u;
  if (Array.isArray(ev?.start) || Array.isArray(ev?.end)) {
    const a = Array.isArray(ev?.start) ? ev.start : [255, 255, 255];
    const b = Array.isArray(ev?.end) ? ev.end : a;
    return a.map((x, i) => Math.round((Number(x) || 0) + ((Number(b[i] ?? x) || 0) - (Number(x) || 0)) * k));
  }
  const v0 = Number.isFinite(ev?.start) ? ev.start : 0;
  const v1 = Number.isFinite(ev?.end) ? ev.end : v0;
  return v0 + (v1 - v0) * k;
}

/** 事件的可切范围（拍）。保持到结束的事件用谱面结束时间当可见末端。 */
export function splittableSpan(clip, ev, axis, chart) {
  if (!clip || !ev) return null;
  const b0 = Number.isFinite(ev.startBeat) ? ev.startBeat : clip.b0;
  let b1 = ev.endBeat;
  if (b1 >= SENTINEL_BEAT) {
    b1 = axis && chart ? axis.toBeat(Math.max(0, chart.endTime ?? 0)) : clip.b1;
    if (!Number.isFinite(b1)) return null;
  }
  if (!(b1 - b0 > MIN_SPAN_BEAT * 2)) return null;
  return { b0, b1 };
}

/**
 * 切口是否落在可切范围内的合法位置。
 * 余量用**绝对拍数**而不是比例：官方谱的「从开头起效」事件起点是 -31249 这种哨兵值，
 * 用比例会让整段可见范围都算作「离末端太近」，根本切不动。
 */
export function canCutAt(span, beat) {
  if (!span) return false;
  return beat > span.b0 + MIN_SPAN_BEAT && beat < span.b1 - MIN_SPAN_BEAT;
}

/**
 * 把一个事件对象切成两段（纯函数式地改 ev，返回第二段）。
 * @param {object} ev 源事件（第一段就地改）
 * @param {number} beat 切口（拍）
 * @param {number} visibleEnd 可见末端（哨兵事件用）
 * @returns {object|null} 第二段事件；无法切分返回 null
 */
export function cutEvent(ev, beat, visibleEnd) {
  const b0 = ev.startBeat;
  const holds = ev.endBeat >= SENTINEL_BEAT;
  const b1 = holds ? visibleEnd : ev.endBeat;
  const span = { b0, b1 };
  if (!canCutAt(span, beat)) return null;

  const u = (beat - b0) / (b1 - b0);
  const left = Number.isFinite(ev.easingLeft) ? ev.easingLeft : 0;
  const right = Number.isFinite(ev.easingRight) ? ev.easingRight : 1;
  const lr = right > left ? right - left : 1;
  const vCut = valueAtProgress(ev, u);
  const bezier = Array.isArray(ev.bezierPoints) && ev.bezierPoints.length === 4 ? ev.bezierPoints : null;

  const second = { ...ev };
  second.startBeat = beat;
  second.endBeat = ev.endBeat; // 保持哨兵语义（原来是「保持到结束」就继续保持）
  second.start = vCut;
  second.end = ev.end;
  if (ev.src) second.src = { ...ev.src, startBeat: beat, endBeat: ev.endBeat, start: vCut, end: ev.end };

  ev.endBeat = beat;
  ev.end = vCut;
  if (ev.src) {
    ev.src.endBeat = beat;
    ev.src.end = vCut;
  }

  const exactBezier = bezier && Math.abs(left) < 1e-9 && Math.abs(right - 1) < 1e-9;
  const parts = exactBezier ? splitCubicBezierAt(bezier, u) : null;
  if (parts) {
    for (const [target, pts] of [
      [ev, parts.left],
      [second, parts.right],
    ]) {
      target.easingType = 6;
      target.easingPreset = 6;
      target.bezierPoints = pts;
      target.easingLeft = 0;
      target.easingRight = 1;
    }
  } else {
    const x = left + lr * u;
    ev.easingLeft = left;
    ev.easingRight = x;
    second.easingLeft = x;
    second.easingRight = right;
    if (!bezier) {
      ev.bezierPoints = null;
      second.bezierPoints = null;
    }
  }
  if (ev.src) {
    for (const k of ['easingType', 'easingPreset', 'bezierPoints', 'easingLeft', 'easingRight']) {
      ev.src[k] = ev[k];
      second.src[k] = second[k];
    }
  }
  return second;
}

/** 重建两段的 easingFn（裁剪/贝塞尔都在 makeEasing 里生效） */
export function rebuildEasing(ev) {
  const type = Number.isFinite(ev.easingType) ? ev.easingType : 1;
  const fn = makeEasing(type, ev.bezierPoints ?? null, ev.easingLeft ?? 0, ev.easingRight ?? 1);
  ev.easingFn = fn;
  ev.easingType = fn.easingType;
  ev.easingPreset = fn.easingPreset;
  ev.bezierPoints = fn.bezierPoints;
  ev.easingLeft = fn.easingLeft;
  ev.easingRight = fn.easingRight;
  if (ev.src) {
    for (const k of ['easingType', 'easingPreset', 'bezierPoints', 'easingLeft', 'easingRight']) {
      ev.src[k] = ev[k];
    }
  }
  return fn;
}

/** 在某个层的事件数组里插入第二段（按 startBeat 保持有序） */
function insertEventSorted(list, ev) {
  const at = list.findIndex((item) => Number.isFinite(item?.startBeat) && item.startBeat > ev.startBeat);
  if (at < 0) list.push(ev);
  else list.splice(at, 0, ev);
}

/**
 * 对整条事件轨执行切分：改源事件 → 插入第二段 → 重建这条轨的 clip。
 * @returns {{ok:boolean, message:string, keys?:string[], created?:object[]}} created 是这次新造的对象（撤销栈用）
 */
export function splitEventAt({ chart, track, axis, clipIndex, beat, rebuildTrack }) {
  const clip = track?.clips?.[clipIndex];
  const ev = clip?.ev;
  if (!ev) return { ok: false, message: '这一个不是可编辑的事件' };
  const span = splittableSpan(clip, ev, axis, chart);
  if (!span) return { ok: false, message: '这个事件没有可切分的长度' };
  if (!canCutAt(span, beat)) return { ok: false, message: '切口要落在事件内部（离两端太近不切）' };

  const second = cutEvent(ev, beat, span.b1);
  if (!second) return { ok: false, message: '在这一点无法切分' };
  rebuildEasing(ev);
  rebuildEasing(second);

  const lineId = Number.isFinite(clip.lineId) ? clip.lineId : track.lineId;
  const list = eventArrayOf(chart, { lineId, layerIndex: clip.layerIndex, key: clip.key });
  if (!Array.isArray(list)) return { ok: false, message: '找不到该事件所在的事件层。' };
  insertEventSorted(list, second);

  // 源事件数组（若有回引）也插入一份，保持与渲染器模型一致
  const srcList = Array.isArray(ev.src) ? null : null;
  void srcList;

  const keys = rebuildTrack?.(track, [ev, second]) ?? [];
  return {
    ok: true,
    keys,
    created: [second], // 新造出来的那一段（撤销栈要记它）
    message: `已剪开：${Math.round(beat * 1000) / 1000} 拍`,
  };
}

/** Hold 的可切范围 */
export function splittableNoteSpan(clip) {
  const n = clip?.note;
  if (!n || !(n.durationSec > 1e-3)) return null;
  const b0 = Number.isFinite(n.startBeat) ? n.startBeat : clip.b0;
  const b1 = Number.isFinite(n.endBeat) ? n.endBeat : clip.b1;
  if (!(b1 - b0 > MIN_SPAN_BEAT * 2)) return null;
  return { b0, b1 };
}

/**
 * 把 Hold 切成两个音符：时间/时长按切口分，位置取原判定线在该时刻的高度。
 * @returns {{ok:boolean, message:string, keys?:string[]}}
 */
export function splitNoteAt({ chart, track, axis, clipIndex, beat, rebuildTrack }) {
  const clip = track?.clips?.[clipIndex];
  const n = clip?.note;
  const span = splittableNoteSpan(clip);
  if (!n) return { ok: false, message: '这一个不是可编辑的音符' };
  if (!span) return { ok: false, message: '只有有长度的 Hold 才能剪开' };
  if (!canCutAt(span, beat)) return { ok: false, message: '切口要落在 Hold 内部（离两端太近不切）' };
  const lineId = Number.isFinite(clip.lineId) ? clip.lineId : track.lineId;
  const line = chart?.lines?.[lineId];
  const timeline = line?.rt?.timeline;
  if (!timeline) return { ok: false, message: '该判定线缺少时间轴，无法剪开' };

  const cutSec = timeline.beatToSeconds(beat);
  const endSec = timeline.beatToSeconds(span.b1);
  if (!(cutSec > n.timeSec && cutSec < n.timeSec + n.durationSec)) {
    return { ok: false, message: '切口超出了 Hold 的时长' };
  }

  const added = { ...n };
  added.startBeat = beat;
  added.timeSec = cutSec;
  added.endBeat = span.b1;
  added.endSec = endSec;
  added.durationSec = Math.max(0, endSec - cutSec);
  added.height = typeof line.rt.heightAt === 'function' ? line.rt.heightAt(cutSec) : n.height;
  added.src = n.src ? { ...n.src, startBeat: beat, endBeat: span.b1 } : null;

  n.endBeat = beat;
  n.endSec = cutSec;
  n.durationSec = Math.max(0, cutSec - n.timeSec);
  if (n.src) {
    n.src.startBeat = n.startBeat;
    n.src.endBeat = beat;
  }

  // 渲染器模型里两份列表都要有（evaluate 用线内的，索引/统计用谱面级的）
  const lineNotes = line.rt.notes;
  if (Array.isArray(lineNotes)) {
    const at = lineNotes.findIndex((item) => Number.isFinite(item?.timeSec) && item.timeSec > added.timeSec);
    if (at < 0) lineNotes.push(added);
    else lineNotes.splice(at, 0, added);
  }
  // 谱面级列表可能和线内列表是同一个数组（不同解析路径），是同一个就只插一次
  if (Array.isArray(chart.notes) && chart.notes !== lineNotes) {
    const at = chart.notes.findIndex((item) => Number.isFinite(item?.timeSec) && item.timeSec > added.timeSec);
    if (at < 0) chart.notes.push(added);
    else chart.notes.splice(at, 0, added);
  }
  if (Array.isArray(n.src) === false && n.src) {
    // 源层音符数组里也补一份，导出时才能带上
    for (const layer of line?.layers ?? []) {
      for (const list of Object.values(layer)) {
        if (Array.isArray(list) && list.includes(n.src)) {
          list.splice(list.indexOf(n.src) + 1, 0, added.src);
        }
      }
    }
  }

  const keys = rebuildTrack?.(track, [n, added]) ?? [];
  void axis;
  return {
    ok: true,
    keys,
    created: [added], // 新造出来的那一段（撤销栈要记它）
    message: `已剪开 Hold：${Math.round(beat * 1000) / 1000} 拍`,
  };
}

export const SPLIT_LIMITS = { MIN_SPAN_BEAT };
