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
        camera: !!ref.camera, // 谱面相机：粘贴时写回 `chart.camera[key]`（拍值与时间轴一致）
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
 * 事件对象所在的数组。
 *  - **谱面相机**（`camera: true`）：`chart.camera[key]`（谱面级，不属于任何判定线）；
 *  - 扩展（故事板）事件**不分事件层**：`layerIndex` 为 null 时取 `line.extended[key]`；
 *  - 其余情况取 `line.layers[层][键]`。找不到返回 null（调用方决定是否新建 / 报错）。
 */
export function eventArrayOf(chart, { lineId, layerIndex, key, camera } = {}) {
  if (!key) return null;
  if (camera) {
    const list = chart?.camera?.[key];
    return Array.isArray(list) ? list : null;
  }
  const line = chart?.lines?.[lineId];
  if (!line) return null;
  if (layerIndex === null || layerIndex === undefined) {
    const list = line.extended?.[key];
    return Array.isArray(list) ? list : null;
  }
  const list = line.layers?.[layerIndex]?.[key];
  return Array.isArray(list) ? list : null;
}

/**
 * 与 `eventArrayOf` 同样的定位，但**缺数组时按需新建**（返回的一定是数组，除非线号根本不存在）。
 *
 * 结构树的「新建轨道」、添加工具与粘贴都用它：以前只认已经存在的数组，于是「这条轨还没有任何事件」
 * 时既放不进事件、也粘贴不进去（用户反馈：事件层 / 扩展事件里缺的那几条轨道没法用）。
 * @returns {object[]|null} 找不到判定线（或线号非法）时返回 null
 */
export function ensureEventArray(chart, { lineId, layerIndex, key, camera } = {}) {
  if (!chart || !key) return null;
  if (camera) {
    chart.camera ??= {};
    if (!Array.isArray(chart.camera[key])) chart.camera[key] = [];
    return chart.camera[key];
  }
  const line = chart.lines?.[lineId];
  if (!line) return null;
  // 扩展（故事板）事件：不分层，每条线每个键一份
  if (layerIndex === null || layerIndex === undefined) {
    line.extended ??= {};
    if (!Array.isArray(line.extended[key])) line.extended[key] = [];
    return line.extended[key];
  }
  // 普通事件层：层本身缺失时也补出来（事件层里空轨道是可以直接放事件的）
  line.layers = Array.isArray(line.layers) ? line.layers : [];
  const layer = (line.layers[layerIndex] ??= {});
  if (!Array.isArray(layer[key])) layer[key] = [];
  return layer[key];
}

/**
 * 剪贴板缓冲里，事件涉及了哪些「来源轨道」（用于判断是否跨层）。
 * 同一条线的同一层同一个键算一条轨道。
 */
export function bufferTrackKeys(buffer) {
  const out = new Set();
  for (const e of asArray(buffer?.events)) {
    out.add(e.camera ? `camera:${e.key}` : `${e.lineId}:${e.layerIndex ?? 'ext'}:${e.key}`);
  }
  return out;
}

/**
 * 把一个**事件**剪贴板条目重新指向目标轨道（跨事件层粘贴时用）。
 *
 * 为什么要重新指向：`serializeRefs` 把每条事件的 `lineId / layerIndex` 一起存了下来，
 * 于是粘贴天然只会回到「原处」。而用户想要的跨层粘贴是「把这条 X 事件搬到另一个事件层」——
 * 目标就是**活跃轨**里与源**同类**的那条（同 `key`；相机轨对相机轨）。
 *
 * @param {object} item 原始条目
 * @param {{lineId:number, layerIndex:number|null, key:string, camera:boolean}} target 目标轨道
 */
function retargetEvent(item, target) {
  return { ...item, lineId: target.lineId, layerIndex: target.layerIndex, key: target.key, camera: !!target.camera };
}

/**
 * 判断剪贴板能否粘贴到 `target` 这条轨道上，并给出**要粘贴什么**。
 *
 * 规则（按用户要求）：
 *  - 剪贴板里的事件**全部来自同一条轨道**时：
 *      · 目标是**同一条**轨道 → 照常粘贴（只是换时间）；
 *      · 目标是活跃轨里与源同 `key` 的那条 → **跨层粘贴**：把内容改指到目标轨；
 *      · 都不是 → 拒绝（避免把 X 事件写进 Y 轨这种语义错乱）。
 *  - 剪贴板里的事件**跨了多条轨道**（选区跨事件层）→ 只允许粘回它自己那条轨道，
 *    也就是「同一轨道、不同时间」；粘到任何别的轨道都拒绝。
 *  - 剪贴板里只有音符：音符跟判定线走，不受事件层影响，永远放行。
 *
 * @returns {{ok:true, events:object[], notes:object[]}|{ok:false, reason:string}}
 */
export function resolvePasteTarget(buffer, target = null) {
  const events = asArray(buffer?.events);
  const notes = asArray(buffer?.notes);
  const keys = bufferTrackKeys(buffer);

  // 只有音符（或空）→ 不涉及事件层，放行
  if (!events.length) return { ok: true, events: [], notes };

  const srcKey = `${events[0].lineId}:${events[0].layerIndex ?? 'ext'}:${events[0].key}`;
  const srcCamera = !!events[0].camera;
  const sameKeyOf = (e) => (srcCamera ? `camera:${e.key}` : `${e.lineId}:${e.layerIndex ?? 'ext'}:${e.key}`);

  // 选区跨了多条轨道：只允许「同一轨道、不同时间」，但那要求**活跃轨就是唯一的来源轨** ——
  // 既然来源有 2 条以上，任何单个活跃轨都不可能同时是它们全部，所以一律拒绝。
  if (keys.size > 1) {
    if (!target) return { ok: true, events, notes }; // 没有活跃轨信息时按老行为（粘回各自的原处）
    return {
      ok: false,
      reason: `选区跨了 ${keys.size} 个事件层，只能在同一条轨道内换个时间粘贴（请只选中单条轨道上的事件）`,
    };
  }

  // 单一来源轨道：目标就是它本身 → 同轨换时间
  if (!target) return { ok: true, events, notes };
  const targetKey = target.camera ? `camera:${target.key}` : `${target.lineId}:${target.layerIndex ?? 'ext'}:${target.key}`;
  if (targetKey === srcKey) return { ok: true, events, notes };

  // 跨层：目标必须是「活跃轨里与源同类」的那条（同 key、同相机属性）
  const sameKind = srcCamera ? !!target.camera : !target.camera && target.key === events[0].key;
  if (!sameKind) {
    return {
      ok: false,
      reason: srcCamera
        ? '剪贴板里是相机事件，只能粘贴到相机轨'
        : `剪贴板里是「${events[0].key}」事件，只能粘贴到同类型的轨道上`,
    };
  }
  return { ok: true, events: events.map((e) => retargetEvent(e, target)), notes };
}

/**
 * 粘贴：在 `atAxisBeat`（通常是指针所在的拍）处按模板新建对象。
 * @param {object} [opts.target] 活跃轨（`{lineId, layerIndex, key, camera}`）；给了就按
 *   `resolvePasteTarget` 的规则决定是「同轨换时间」还是「跨层改指」。
 * @returns {{events:{list:object[],ev:object,lineId:number,layerIndex:number,key:string}[], notes:{list:object[],note:object,lineId:number}[], skipped:number, refused?:string}}
 */
export function pasteBuffer(buffer, { chart, axis = null, atAxisBeat = 0, target = null } = {}) {
  const out = { events: [], notes: [], skipped: 0 };
  if (!buffer || !chart) return out;

  const resolved = resolvePasteTarget(buffer, target);
  if (!resolved.ok) {
    out.refused = resolved.reason;
    return out;
  }

  for (const item of resolved.events) {
    const line = chart.lines?.[item.lineId];
    // 目标轨还没有任何事件时按需建出数组（结构树里新建的空轨也能直接粘贴）
    const list = ensureEventArray(chart, item);
    // 相机是谱面级的：它的拍**就是**时间轴上的拍（与全局 BPMList 一致），不经判定线的时间轴换算
    const startBeat = item.camera
      ? atAxisBeat + item.offsetBeats
      : lineBeatOf(line, axis, atAxisBeat + item.offsetBeats);
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
    out.events.push({
      list,
      ev,
      lineId: item.lineId,
      layerIndex: item.layerIndex,
      key: item.key,
      camera: !!item.camera,
      index: at,
    });
  }

  for (const item of resolved.notes) {
    const line = chart.lines?.[item.lineId];
    const startBeat = lineBeatOf(line, axis, atAxisBeat + item.offsetBeats);
    if (!line || !Number.isFinite(startBeat)) {
      out.skipped++;
      continue;
    }
    const b0 = Math.max(0, startBeat);
    const b1 = b0 + item.lenBeats;
    if (findOverlappingNote(line.rt?.notes ?? [], b0, b1, item.positionX, item.type)) {
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

/** 事件对象所在的数组（按时间轴的轨道信息定位；扩展事件走 `line.extended`） */
export function eventList(chart, ref) {
  const list = eventArrayOf(chart, ref);
  if (!Array.isArray(list)) return null;
  const index = list.indexOf(ref.obj);
  return index < 0 ? null : { list, obj: ref.obj, index };
}
