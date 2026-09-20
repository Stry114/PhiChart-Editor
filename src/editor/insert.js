/**
 * 「添加」工具用到的纯逻辑：建音符、查重叠、取缺省值 / 上一个事件的末值、插入事件。
 *
 * 这里只碰数据、不动 DOM / 画布，便于单独验证。
 * 编辑器里的插入语义：
 *   - 音符轨：点一下放一个音符（Hold 与事件一样「两次点击定首尾」）
 *   - 事件轨：第一次点定起点、第二次点定终点
 *   - 新事件的取值 = **本轨道上一个事件的末值**（前面没有事件时用该类型缺省值），
 *     于是插入的片段与前面的动画接得上，不会跳变
 *   - 任何放置都不允许与同类对象重叠
 */

const SENTINEL_BEAT = 1e6;
const TIME_EPS = 1e-4; // 拍：视为「同一时刻」的容差
const POS_EPS = 1e-4; // positionX 容差

import { EXTENDED_DEFAULTS } from '../core/units.js';

/**
 * 各类事件的缺省值（模型单位：x / y 是官方归一化的偏移，alpha 0..1，speed 为 Y/s）。
 * 扩展事件（scaleX / scaleY / color）的缺省值取「不改变外观」的一侧（见 core/units.js）。
 */
export const EVENT_DEFAULTS = { x: 0, y: 0, rotate: 0, alpha: 1, speed: 1, ...EXTENDED_DEFAULTS };

export function defaultEventValue(key) {
  const v = EVENT_DEFAULTS[key];
  if (Array.isArray(v)) return [...v]; // 颜色事件：拷贝一份，避免多条事件共享同一个数组
  return Number.isFinite(v) ? v : 0;
}

/**
 * 新事件的取值：取本轨道「上一个事件的末值」；该事件之前没有事件就用缺省值。
 * 事件按 startBeat 有序，遇到起点不小于插入点的第一条就停。
 */
export function previousEndValue(events, startBeat, key) {
  if (!Array.isArray(events) || !events.length) return defaultEventValue(key);
  let prev = null;
  for (const ev of events) {
    const b0 = Number.isFinite(ev?.startBeat) ? ev.startBeat : 0;
    if (b0 >= startBeat - TIME_EPS) break;
    prev = ev;
  }
  if (!prev) return defaultEventValue(key);
  // 颜色事件的值是数组：整体照搬（不做逐通道插值）
  if (Array.isArray(prev.end)) return [...prev.end];
  if (Array.isArray(prev.start)) return [...prev.start];
  if (Number.isFinite(prev.end)) return prev.end;
  if (Number.isFinite(prev.start)) return prev.start;
  return defaultEventValue(key);
}

/** 事件在某个拍处的取值（沿事件链求值；用于预览/诊断，插入时不用它） */
export function valueAtBeat(events, beat) {
  if (!Array.isArray(events) || !events.length) return 0;
  let last = null;
  for (const ev of events) {
    const b0 = Number.isFinite(ev?.startBeat) ? ev.startBeat : 0;
    const b1 = ev?.endBeat >= SENTINEL_BEAT ? Infinity : Number.isFinite(ev?.endBeat) ? ev.endBeat : b0;
    if (beat < b0) break; // 事件按时间有序，后面的更晚
    last = ev;
    // 颜色事件（数组值）：不做逐通道插值，直接取该事件的起点
    if (Array.isArray(ev?.start)) return [...ev.start];
    if (beat <= b1) {
      const span = b1 - b0;
      const u = span > 1e-9 ? (beat - b0) / span : 0;
      let k = u;
      if (typeof ev.easingFn === 'function') {
        try {
          k = ev.easingFn(u);
        } catch {
          k = u;
        }
      }
      if (!Number.isFinite(k)) k = u;
      const v0 = Number.isFinite(ev.start) ? ev.start : 0;
      const v1 = Number.isFinite(ev.end) ? ev.end : v0;
      return v0 + (v1 - v0) * k;
    }
  }
  if (!last) {
    const first = events[0];
    if (Array.isArray(first?.start)) return [...first.start];
    return Number.isFinite(first?.start) ? first.start : 0;
  }
  if (Array.isArray(last.end)) return [...last.end];
  if (Array.isArray(last.start)) return [...last.start];
  return Number.isFinite(last.end) ? last.end : Number.isFinite(last.start) ? last.start : 0;
}

/** 区间是否与已有事件重叠（用于事件轨放置） */
export function findOverlappingEvent(events, b0, b1, ignore = null) {
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    if (ev === ignore) continue;
    const e0 = Number.isFinite(ev?.startBeat) ? ev.startBeat : 0;
    const e1 = ev?.endBeat >= SENTINEL_BEAT ? Infinity : Number.isFinite(ev?.endBeat) ? ev.endBeat : e0;
    if (b0 < e1 - TIME_EPS && e0 < b1 - TIME_EPS) return ev;
  }
  return null;
}

/**
 * 音符会与已有音符重叠吗？
 * 规则：同一判定线上「时间区间相交」且「positionX 相同」才算重叠 ——
 * 同一时刻不同 X 的叠键（双押）是合法且常见的，不能拦。
 *
 * **唯一的例外（按需求）**：只要涉及 Hold 就允许重叠 —— Hold 与别的音符同位置同时刻是常见写法
 * （按住长条的同时补一个 Tap / Drag），两份长条叠在一起也是作者的自由。所以这里在命中区间之后
 * 还要看一眼类型：`type` 是本次要放的类型，`n.type` 是已有音符的类型。
 */
export function findOverlappingNote(notes, startBeat, endBeat, positionX, type = null) {
  if (!Array.isArray(notes)) return null;
  if (type === 'hold') return null; // 要放的是 Hold：不作重叠限制
  // Tap / Drag / Flick 的起止是同拍（零长区间），先按 TIME_EPS 撑开成有宽度的区间，
  // 否则「同一时刻同一 positionX 放两个」永远判不出重叠。
  const span = (b0, b1) => (b1 - b0 > TIME_EPS ? { b0, b1 } : { b0: b0 - TIME_EPS, b1: b0 + TIME_EPS });
  const a = span(startBeat, endBeat);
  for (const n of notes) {
    if (!n) continue;
    if (n.type === 'hold') continue; // 已有的那个是 Hold：允许叠（唯一例外）
    const px = Number.isFinite(n.positionX) ? n.positionX : 0;
    if (Math.abs(px - positionX) > POS_EPS) continue;
    const b = span(Number.isFinite(n.startBeat) ? n.startBeat : 0, Number.isFinite(n.endBeat) ? n.endBeat : 0);
    if (a.b0 < b.b1 - TIME_EPS && b.b0 < a.b1 - TIME_EPS) return n;
  }
  return null;
}

/** 音符类型 → 官方格式的 type 编号（导出时要用；编辑器内部统一用字符串） */
export const NOTE_TYPE_CODE = { tap: 1, drag: 2, hold: 3, flick: 4 };

/**
 * 造一个音符（渲染器对象 + 源对象）。
 * 源对象按「已有音符的形状」克隆键名，official（type/time/holdTime）与 RPE（type/startTime/endTime）
 * 都能填对，将来实现导出时直接可用。
 */
export function makeNote({
  type,
  startBeat,
  endBeat,
  positionX,
  above = true,
  line,
  lineId = 0,
  timeline,
  template = null,
  speed = 1,
}) {
  const beatToSec = (b) => (timeline?.beatToSeconds ? timeline.beatToSeconds(b) : b);
  const timeSec = beatToSec(startBeat);
  const endSec = beatToSec(endBeat);
  const durationSec = Math.max(0, endSec - timeSec);
  const height = line?.rt?.heightAt ? line.rt.heightAt(timeSec) : 0;
  const note = {
    type,
    lineId, // 模型里的音符都带 lineId，详情页/导出都会用到
    startBeat,
    endBeat,
    timeSec,
    endSec,
    durationSec,
    height,
    positionX,
    above: !!above,
    isFake: false,
    speed,
    src: null,
  };
  const src = {};
  const keys = template ? Object.keys(template) : ['type', 'time', 'positionX', 'holdTime', 'speed', 'floorPosition'];
  for (const k of keys) src[k] = template ? template[k] : 0;
  src.type = NOTE_TYPE_CODE[type] ?? 1;
  if ('time' in src) src.time = startBeat * 32; // 官方格式：1 拍 = 32 单位
  if ('startTime' in src) src.startTime = startBeat;
  if ('endTime' in src) src.endTime = endBeat;
  if ('holdTime' in src) src.holdTime = type === 'hold' ? Math.max(0, endBeat - startBeat) * 32 : 0;
  if ('positionX' in src) src.positionX = positionX;
  if ('speed' in src) src.speed = speed;
  if ('above' in src) src.above = above ? 1 : 0;
  note.src = src;
  return note;
}

/**
 * 把线内拍写回**源**音符对象。
 * official 用 time / holdTime（1 拍 = 32 单位）、RPE 用 startTime / endTime，两套都要跟着改，
 * 否则将来导出写出来的还是旧时间（编辑器内部时间真值在编译对象上，源对象是给导出用的）。
 */
export function writeSourceTimes(src, startBeat, endBeat) {
  if (!src || typeof src !== 'object') return false;
  src.startBeat = startBeat;
  src.endBeat = endBeat;
  if ('time' in src) src.time = startBeat * 32;
  if ('startTime' in src) src.startTime = startBeat;
  if ('endTime' in src) src.endTime = endBeat;
  if ('holdTime' in src) src.holdTime = Math.max(0, endBeat - startBeat) * 32;
  return true;
}

/** 把音符插入线内列表与谱面级列表（都按时间有序；同一个数组只插一次） */
export function insertNote(chart, line, note) {
  const at = (list) => {
    if (!Array.isArray(list)) return;
    const i = list.findIndex((n) => Number.isFinite(n?.timeSec) && n.timeSec > note.timeSec);
    if (i < 0) list.push(note);
    else list.splice(i, 0, note);
  };
  const lineNotes = line?.rt?.notes;
  at(lineNotes);
  if (Array.isArray(chart?.notes) && chart.notes !== lineNotes) {
    const i = chart.notes.findIndex((n) => Number.isFinite(n?.timeSec) && n.timeSec > note.timeSec);
    if (i < 0) chart.notes.push(note);
    else chart.notes.splice(i, 0, note);
  }
  // 源音符：塞进这条线的源音符列表（prepareChart 读的就是 line.notes，导出也用它）。
  // 注意不能拿 note.src 去找数组 —— 它是刚造出来的，哪个数组都不包含它（曾因此一直没插进去）。
  const srcList = Array.isArray(line?.notes) ? line.notes : findSourceList(line, sourceTemplate(line));
  if (srcList) {
    const i = srcList.findIndex((n) => n === note.src);
    if (i >= 0) srcList.splice(i + 1, 0, note.src);
    else srcList.push(note.src);
  }
  return note;
}

/** 在层的各个数组里找「包含这个对象」的那个数组 */
export function findSourceList(line, obj) {
  if (!obj) return null;
  for (const layer of line?.layers ?? []) {
    for (const list of Object.values(layer ?? {})) {
      if (Array.isArray(list) && list.includes(obj)) return list;
    }
  }
  return null;
}

/** 取该线第一条源音符当模板（新音符照它的键名构造） */
export function sourceTemplate(line) {
  for (const layer of line?.layers ?? []) {
    for (const [key, list] of Object.entries(layer ?? {})) {
      if (key !== 'notes' || !Array.isArray(list)) continue;
      if (list[0]) return list[0];
    }
  }
  return null;
}

export const INSERT_LIMITS = { TIME_EPS, POS_EPS };
