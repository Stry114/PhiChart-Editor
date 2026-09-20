/**
 * 剪贴板：复制 / 剪切 / 粘贴 / 删除（纯模型操作，不碰 DOM）。
 *
 * **粘贴的语义**：不是「把同一个对象塞回数组」，而是**以复制下来的对象为模板，在目标时间新建对象** ——
 * 新的事件对象 / 新的音符对象，写回模型（因此能被纠错看到、能被撤销）。
 *  - 复制时把每条对象存成「模板」：类型、取值、缓动、时长（拍）+ 相对最早一条的偏移（时间轴拍）。
 *  - 粘贴时把整组**锚定到目标拍**（编辑器里就是指针位置），保留彼此的相对关系。
 *  - 事件回到它原来的线 / 层 / 类型；音符回到它原来的线，`positionX` 等参数照抄。
 *  - 目标位置与已有内容重叠的条目**跳过**（和添加工具一套规则），并在状态里报出条数。
 */
import { makeEasing } from '../core/easing.js';
import { makeNote, insertNote, findOverlappingNote, sourceTemplate, findSourceList } from './insert.js';

/** 一个「引用」= 时间轴里选中的那个对象 + 它属于哪条线/层/类型（由 timeline.js 组装） */
const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 把选中的对象序列化成剪贴板缓冲。
 * @param {{kind:'event'|'note', lineId:number, layerIndex?:number|null, key?:string, obj:object, axisBeat:number}[]} refs
 * @param {{anchorBeat?:number}} [opts] 锚点（不传就用最早一条）
 */
export function serializeRefs(refs, opts = {}) {
  const list = asArray(refs).filter((r) => r?.obj && Number.isFinite(r.axisBeat));
  if (!list.length) return null;
  const anchor = Number.isFinite(opts.anchorBeat) ? opts.anchorBeat : Math.min(...list.map((r) => r.axisBeat));
  const events = [];
  const notes = [];
  for (const ref of list) {
    const obj = ref.obj;
    const offsetBeats = ref.axisBeat - anchor;
    if (ref.kind === 'event') {
      const b0 = Number.isFinite(obj.startBeat) ? obj.startBeat : 0;
      const b1 = Number.isFinite(obj.endBeat) ? obj.endBeat : b0;
      events.push({
        lineId: ref.lineId,
        layerIndex: ref.layerIndex ?? 0,
        key: ref.key,
        offsetBeats,
        lenBeats: Math.max(0, b1 - b0),
        holds: b1 >= 1e6, // 「保持到结束」：粘贴时也保持到结束
        start: obj.start,
        end: obj.end,
        easingType: obj.easingType,
        easingPreset: obj.easingPreset,
        bezierPoints: obj.bezierPoints ?? null,
        easingLeft: obj.easingLeft ?? 0,
        easingRight: obj.easingRight ?? 1,
        ...(obj.linkgroup ? { linkgroup: obj.linkgroup } : {}),
      });
    } else {
      const b0 = Number.isFinite(obj.startBeat) ? obj.startBeat : 0;
      const b1 = Number.isFinite(obj.endBeat) ? obj.endBeat : b0;
      notes.push({
        lineId: ref.lineId,
        type: obj.type,
        positionX: Number.isFinite(obj.positionX) ? obj.positionX : 0,
        above: obj.above !== false,
        isFake: !!obj.isFake,
        speed: Number.isFinite(obj.speed) ? obj.speed : 1,
        offsetBeats,
        lenBeats: Math.max(0, b1 - b0),
      });
    }
  }
  return { events, notes, anchorBeat: anchor, count: events.length + notes.length };
}

/** 「保持到结束」的哨兵拍值 */
const HOLD_BEAT = 1e6;
const TIME_EPS = 1e-4;

/**
 * 粘贴时的冲突判定：**只跟有限区间冲突才算**。
 * 为什么不直接用添加工具的 `findOverlappingEvent`：它把「保持到结束」事件的末值当 +∞，
 * 于是只要该层存在一条「保持到结束」，后面任何位置都被判定成重叠 → 粘贴永远失败。
 * 而渲染器是按「后开始的生效」求值的，粘贴到这种事件之后本来就是有意义的编辑；
 * 真的可疑（与普通区间相交）时才跳过，并在状态里报出来。
 */
function conflictsWith(list, b0, b1) {
  for (const ev of list ?? []) {
    const e0 = Number.isFinite(ev?.startBeat) ? ev.startBeat : 0;
    const raw1 = Number.isFinite(ev?.endBeat) ? ev.endBeat : e0;
    if (raw1 >= HOLD_BEAT) continue; // 保持到结束：不算冲突
    if (b0 < raw1 - TIME_EPS && e0 < b1 - TIME_EPS) return ev;
  }
  return null;
}

/** 时间轴上的拍 → 这条线自己的拍（多条线 BPM 倍率不同，必须经秒换算） */
function lineBeatOf(line, axis, axisBeat) {
  const tl = line?.rt?.timeline;
  if (!tl) return null;
  if (!axis) return axisBeat;
  const sec = axis.toSec(axisBeat);
  return Number.isFinite(sec) ? tl.secondsToBeat(sec) : null;
}

/**
 * 粘贴：在 `atAxisBeat`（通常是指针所在的拍）处按模板新建对象。
 * @returns {{events:{list:object[],ev:object,lineId:number,layerIndex:number,key:string}[], notes:{list:object[],note:object,lineId:number}[], skipped:number}}
 */
export function pasteBuffer(buffer, { chart, axis = null, atAxisBeat = 0 }) {
  const out = { events: [], notes: [], skipped: 0 };
  if (!buffer || !chart) return out;

  for (const item of asArray(buffer.events)) {
    const line = chart.lines?.[item.lineId];
    const list = line?.layers?.[item.layerIndex]?.[item.key];
    const startBeat = lineBeatOf(line, axis, atAxisBeat + item.offsetBeats);
    if (!Array.isArray(list) || !Number.isFinite(startBeat)) {
      out.skipped++;
      continue;
    }
    const b0 = Math.max(0, startBeat);
    const b1 = item.holds ? 1e9 : b0 + item.lenBeats; // 「保持到结束」粘贴后也保持到结束
    if (conflictsWith(list, b0, b1)) {
      out.skipped++;
      continue;
    }
    const fn = makeEasing(Number.isFinite(item.easingType) ? item.easingType : 1, item.bezierPoints ?? null, item.easingLeft ?? 0, item.easingRight ?? 1);
    const ev = {
      startBeat: b0,
      endBeat: b1,
      start: item.start,
      end: item.end,
      easingType: fn.easingType,
      easingPreset: fn.easingPreset,
      bezierPoints: fn.bezierPoints,
      easingLeft: item.easingLeft ?? 0,
      easingRight: item.easingRight ?? 1,
      easingFn: fn,
    };
    if (item.linkgroup) ev.linkgroup = item.linkgroup;
    // 插到按时间有序的位置（源数组保持有序，纠错的「未按时间排序」就不会误报）
    let at = list.findIndex((e) => Number.isFinite(e?.startBeat) && e.startBeat > b0);
    if (at < 0) at = list.length;
    list.splice(at, 0, ev);
    out.events.push({ list, ev, lineId: item.lineId, layerIndex: item.layerIndex, key: item.key, index: at });
  }

  for (const item of asArray(buffer.notes)) {
    const line = chart.lines?.[item.lineId];
    const startBeat = lineBeatOf(line, axis, atAxisBeat + item.offsetBeats);
    if (!line || !Number.isFinite(startBeat)) {
      out.skipped++;
      continue;
    }
    const b0 = Math.max(0, startBeat);
    const b1 = b0 + item.lenBeats;
    if (findOverlappingNote(line.rt?.notes ?? [], b0, b1, item.positionX)) {
      out.skipped++;
      continue;
    }
    const note = makeNote({
      type: item.type,
      startBeat: b0,
      endBeat: b1,
      positionX: item.positionX,
      above: item.above,
      line,
      lineId: item.lineId,
      timeline: line.rt?.timeline ?? null,
      template: sourceTemplate(line),
      speed: item.speed,
    });
    note.isFake = !!item.isFake;
    if (note.src && 'isFake' in note.src) note.src.isFake = note.isFake;
    insertNote(chart, line, note);
    out.notes.push({ list: line.rt?.notes ?? null, note, lineId: item.lineId });
  }

  return out;
}

/** 一个音符（编译对象 + 它的源对象）出现在哪些数组里 —— 删除/撤销插回都要按这些数组来 */
export function noteLists(chart, line, note) {
  const out = [];
  const seen = new Set();
  const push = (list, obj) => {
    if (!Array.isArray(list) || !obj || seen.has(list)) return;
    const index = list.indexOf(obj);
    if (index < 0) return;
    seen.add(list);
    out.push({ list, obj, index });
  };
  push(line?.rt?.notes, note);
  push(chart?.notes, note);
  const src = note?.src;
  if (src) {
    push(line?.notes, src);
    push(findSourceList(line, src), src);
  }
  return out;
}

/** 事件对象所在的数组（按时间轴的轨道信息定位） */
export function eventList(chart, ref) {
  const list = chart?.lines?.[ref.lineId]?.layers?.[ref.layerIndex]?.[ref.key];
  if (!Array.isArray(list)) return null;
  const index = list.indexOf(ref.obj);
  return index < 0 ? null : { list, obj: ref.obj, index };
}
