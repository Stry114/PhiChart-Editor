/**
 * 「添加」工具用到的纯逻辑：建音符、查重叠、取某拍的事件值、插入事件。
 *
 * 这里只碰数据、不动 DOM / 画布，便于单独验证。
 * 编辑器里的插入语义：
 *   - 音符轨：点一下放一个音符（Hold 用调色板里的时长），位置 = 拍 + positionX
 *   - 事件轨：第一次点定起点、第二次点定终点；两端取值取**原曲线在那两点的值**，
 *     于是新事件与前后动画接得上（插入后是线性过渡，需要别的缓动可在详情页改）
 *   - 任何放置都不允许与同类对象重叠
 */

const SENTINEL_BEAT = 1e6;
const TIME_EPS = 1e-4; // 拍：视为「同一时刻」的容差
const POS_EPS = 1e-4; // positionX 容差

/** 事件在某个拍处的取值（沿事件链求值；没有覆盖该拍的事件时取最近一条的值） */
export function valueAtBeat(events, beat) {
  if (!Array.isArray(events) || !events.length) return 0;
  let last = null;
  for (const ev of events) {
    const b0 = Number.isFinite(ev?.startBeat) ? ev.startBeat : 0;
    const b1 = ev?.endBeat >= SENTINEL_BEAT ? Infinity : Number.isFinite(ev?.endBeat) ? ev.endBeat : b0;
    if (beat < b0) break; // 事件按时间有序，后面的更晚
    last = ev;
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
  // 落在所有事件之外：用最近一条的末值兜底
  if (!last) {
    const first = events[0];
    return Number.isFinite(first?.start) ? first.start : 0;
  }
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
 */
export function findOverlappingNote(notes, startBeat, endBeat, positionX) {
  if (!Array.isArray(notes)) return null;
  for (const n of notes) {
    if (!n) continue;
    const px = Number.isFinite(n.positionX) ? n.positionX : 0;
    if (Math.abs(px - positionX) > POS_EPS) continue;
    const n0 = Number.isFinite(n.startBeat) ? n.startBeat : 0;
    const n1 = Number.isFinite(n.endBeat) ? n.endBeat : n0;
    if (startBeat < n1 - TIME_EPS && n0 < endBeat - TIME_EPS) return n;
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
export function makeNote({ type, startBeat, endBeat, positionX, above = true, line, timeline, template = null, speed = 1 }) {
  const beatToSec = (b) => (timeline?.beatToSeconds ? timeline.beatToSeconds(b) : b);
  const timeSec = beatToSec(startBeat);
  const endSec = beatToSec(endBeat);
  const durationSec = Math.max(0, endSec - timeSec);
  const height = line?.rt?.heightAt ? line.rt.heightAt(timeSec) : 0;
  const note = {
    type,
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
  // 源音符：优先塞进原来那个音符所在的数组（保证导出时有对应条目）
  const srcList = findSourceList(line, note.src);
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
