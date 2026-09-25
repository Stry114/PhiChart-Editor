/**
 * 官方（official）格式**写出**：内部统一模型 -> 官方谱面 JSON。
 * 依据 `docs/Phigros文档.md` 的 official 格式与官方引擎行为约束。
 *
 * 与解析的分工：解析只负责「读进来」（parse-official.js），这里只负责「写出去」。
 *
 * 官方格式的三个硬约束，本模块会主动保证（否则游戏卡死或表现异常）：
 *  1. 四条事件列表**都不能为空**（缺的事件按缺省值补一条常量事件）；
 *  2. 事件必须**首尾相接**、首条从极小哨兵开始、末条到极大哨兵结束（谱面运行时刻不允许越过后无事件）；
 *  3. 判定线 `bpm` 必须为正。
 *
 * 另一件必须在这里做的事：官方格式**只有一层、没有缓动**，而内部模型允许多层相加 + 29 种缓动。
 * 因此这里把「多层 + 缓动」合并成一条分段折线（缓动区间按 `curveSegments` 段细分近似）。
 * 时间统一按「秒」换算：内部拍 -> 秒 -> 官方 time（1 拍 = 32 单位），
 * 因此 RPE 的变速 BPM 谱导出成官谱后**时长与画面上的一切都保持不变**（官谱的 time 单位比例是任意的）。
 */
import { createTimeline } from './timing.js';
import { compileLayers } from './events.js';
import { OFFICIAL, OFFICIAL_TYPE_CODE, CAMERA_KEYS } from './units.js';
import { asArray, isObj, num } from './sanitize.js';
import {
  ROUND_DIGITS,
  buildSegments,
  coalesceFlat,
  collectBreakpoints,
  listValueAt,
  pickCompiled,
  round6,
} from './serialize-common.js';

/** 默认写出的 formatVersion：本项目的内部坐标就是「左下角原点、0..1」（等价 v3） */
export const DEFAULT_FORMAT_VERSION = 3;

/** v3 的坐标原点在左下角；内部模型以画面中心为原点 —— 两者互为 ±0.5 偏移 */
const toOfficialX = (v) => round6(v + 0.5);
const toOfficialY = (v) => round6(v + 0.5);
const radToDeg = (rad) => round6((rad * 180) / Math.PI);

function pickLineBpm(line, chart) {
  const own = num(line?.bpm, NaN);
  if (Number.isFinite(own) && own > 0) return own;
  const global = num(asArray(chart?.timing?.bpmList)[0]?.bpm, 120);
  const factor = num(line?.bpmFactor, 1) || 1;
  const eff = global / factor;
  return Number.isFinite(eff) && eff > 0 ? eff : 120;
}

/** 秒 -> 官方 time 单位（time = 秒 × bpm / 1.875） */
const makeSecToTime = (bpm) => (sec) => (Number.isFinite(sec) ? (sec * bpm) / 1.875 : 0);

/**
 * 把「秒域的分段列表」转成官方事件：时间取整、首尾相接、首尾哨兵。
 * @param {{t0:number,t1:number,v0:number[],v1:number[]}[]} segments
 * @param {(v:number[])=>object} toEvent 把一段的值转成官方事件字段（不含 startTime/endTime）
 */
function toOfficialEvents(segments, secToTime, toEvent) {
  const out = [];
  let prevEnd = null;
  for (const seg of segments) {
    let t0 = Math.round(secToTime(seg.t0));
    const t1 = Math.round(secToTime(seg.t1));
    if (prevEnd !== null) t0 = prevEnd; // 首尾相接（官方规则 6）
    if (!(t1 > t0)) continue; // 取整后塌成零长：丢掉（官方会忽略这种事件）
    out.push({ startTime: t0, endTime: t1, ...toEvent(seg) });
    prevEnd = t1;
  }
  return out;
}

/** 四条事件列表的收尾：补哨兵（保证「不为空」且「不会越过末尾」） */
function finishEventList(events, { firstStart, defaultValue }) {
  if (!events.length) return [{ startTime: firstStart, endTime: OFFICIAL.SENTINEL_MAX, ...defaultValue }];
  const first = events[0];
  if (first.startTime > firstStart && firstStart < first.endTime) {
    // 首条之前补一条常量事件（不外推斜率，避免把曲线改形）
    events.unshift({ ...first, startTime: firstStart, endTime: first.startTime });
  } else if (first.startTime < firstStart) {
    first.startTime = firstStart; // 速度事件必须从 0 开始（负拍事件在官谱里没有意义）
  }
  const last = events[events.length - 1];
  if (last.endTime < OFFICIAL.SENTINEL_MAX) {
    events.push({ ...last, startTime: last.endTime, endTime: OFFICIAL.SENTINEL_MAX });
  } else if (last.endTime > OFFICIAL.SENTINEL_MAX && last.startTime < OFFICIAL.SENTINEL_MAX) {
    // 源谱面（RPE）的「无限远」哨兵拍换算成官方 time 后可能超过 1e9：
    // 官谱只要求「末尾足够远」，这里统一收敛到官方样本的哨兵值，输出更规范。
    last.endTime = OFFICIAL.SENTINEL_MAX;
  }
  return events;
}

/**
 * 内部模型 -> 官方谱面 JSON。
 *
 * @param {object} chart 解析后的谱面模型（准备过更好：会用编译结果，避免重复编译）
 * @param {{formatVersion?:number, meta?:object, curveSegments?:number}} [opts]
 *        meta：覆盖导出的元数据（例如 zip 打包时把音频/曲绘文件名改成包内实际名字）
 * @returns {{json:object, warnings:string[], stats:object}}
 */
export function serializeOfficial(chart, opts = {}) {
  if (!chart || !Array.isArray(chart.lines)) throw new Error('serializeOfficial 需要解析后的谱面模型（含 lines 数组）');
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const meta = opts.meta ?? chart?.meta ?? {};
  const formatVersion = opts.formatVersion ?? DEFAULT_FORMAT_VERSION;
  const curveSegments = Math.max(1, Math.trunc(opts.curveSegments ?? 12));

  const judgeLineList = [];
  const missing = { x: 0, y: 0, rotate: 0, alpha: 0, speed: 0 };
  let eased = 0;
  let ramps = 0;
  let notes = 0;
  /** 有多少个 Hold 的尾速度是按「跟随判定线速度」换算出来的（见下面的告警） */
  let lineSpeedRewrites = 0;

  for (const line of asArray(chart.lines)) {
    if (!isObj(line)) {
      judgeLineList.push(null);
      continue;
    }
    const bpm = pickLineBpm(line, chart);
    const rt = line.rt;
    const timeline =
      rt?.timeline ?? createTimeline(asArray(line.bpmList).length ? line.bpmList : chart.timing?.bpmList ?? [], num(line.bpmFactor, 1));
    const layers = asArray(line.layers).filter(isObj);
    const compiled = (key) => pickCompiled(rt, layers, key, (ls, k) => compileLayers(ls, k, timeline));
    const secToTime = makeSecToTime(bpm);

    // ── 事件：x/y 一起合并（官方只有一个 move 事件数组，同时携带两轴）──
    const xLists = compiled('x');
    const yLists = compiled('y');
    if (!xLists.length) missing.x++;
    if (!yLists.length) missing.y++;
    const moveSegments = coalesceFlat(
      buildSegments(collectBreakpoints([...xLists, ...yLists]), [listValueAt.bind(null, xLists), listValueAt.bind(null, yLists)], {
        segments: curveSegments,
      }),
    );
    const moveEvents = toOfficialEvents(moveSegments, secToTime, (seg) => ({
      start: toOfficialX(seg.v0[0]),
      start2: toOfficialY(seg.v0[1]),
      end: toOfficialX(seg.v1[0]),
      end2: toOfficialY(seg.v1[1]),
    }));

    const rotateLists = compiled('rotate');
    if (!rotateLists.length) missing.rotate++;
    const rotateEvents = toOfficialEvents(
      coalesceFlat(buildSegments(collectBreakpoints(rotateLists), [listValueAt.bind(null, rotateLists)], { segments: curveSegments })),
      secToTime,
      (seg) => ({ start: radToDeg(seg.v0[0]), end: radToDeg(seg.v1[0]) }),
    );

    const alphaLists = compiled('alpha');
    if (!alphaLists.length) missing.alpha++;
    const alphaEvents = toOfficialEvents(
      coalesceFlat(buildSegments(collectBreakpoints(alphaLists), [listValueAt.bind(null, alphaLists)], { segments: curveSegments })),
      secToTime,
      (seg) => ({ start: round6(seg.v0[0]), end: round6(seg.v1[0]) }),
    );

    const speedLists = compiled('speed');
    if (!speedLists.length) missing.speed++;
    const speedSegments = buildSegments(collectBreakpoints(speedLists), [listValueAt.bind(null, speedLists)], {
      segments: curveSegments,
      constant: true,
    });
    const speedEvents = toOfficialEvents(speedSegments, secToTime, (seg) => ({ value: round6(seg.v0[0]) }));

    // 缓动带来的精度损失只统计一次（官谱没有缓动字段）
    for (const key of ['x', 'y', 'rotate', 'alpha']) {
      for (const list of compiled(key)) for (const e of list.list ?? []) if (e.f && e.f.easingPreset !== 1 && e.f.easingType !== 1) eased++;
    }
    for (const list of speedLists) for (const e of list.list ?? []) if (Math.abs(e.v0 - e.v1) > 1e-9) ramps++;

    // ── 音符 ──
    const notesAbove = [];
    const notesBelow = [];
    const srcNotes = asArray(line.notes).length ? line.notes : asArray(rt?.notes).map((n) => n?.src ?? n);
    for (const note of srcNotes) {
      if (!isObj(note)) continue;
      const type = OFFICIAL_TYPE_CODE[note.type];
      if (!type) continue;
      const startBeat = num(note.startBeat, NaN);
      if (!Number.isFinite(startBeat)) continue;
      const timeSec = timeline.beatToSeconds(startBeat);
      if (!Number.isFinite(timeSec)) continue;
      const endBeat = num(note.endBeat, startBeat);
      const endSec = Math.max(timeSec, timeline.beatToSeconds(endBeat));
      const time = Math.round(secToTime(timeSec));
      const holdTime = type === 3 ? Math.max(0, Math.round(secToTime(endSec) - time)) : 0;
      // Hold 的速度口径：官方只有「尾速度」这一个参数（头速度恒为 1）。
      //  - `own`（独立，官方口径）：原样写 note.speed；
      //  - `line`（非独立，RPE 口径；缺省）：改写成**等价尾速度** η = (PJ(endSec) − PJ(tN)) / 时长，
      //    这样官谱里的长度与编辑器里「跟随判定线速度」的长度一致（快照近似：官谱表达不了随时间变化）。
      let speed = num(note.speed, 1);
      if (type === 3 && note.holdSpeed !== 'own') {
        const durationSec = endSec - timeSec;
        const headH = num(note.height, NaN);
        const tailH = num(note.tailHeight, NaN);
        if (durationSec > 1e-6 && Number.isFinite(headH) && Number.isFinite(tailH)) {
          const eta = (tailH - headH) / durationSec;
          if (Number.isFinite(eta)) speed = eta;
          lineSpeedRewrites++;
        }
      }
      const item = {
        type,
        time,
        positionX: round6(num(note.positionX, 0)),
        holdTime,
        speed: round6(speed),
        // 官方引擎不读这个值（会实时重算），但写成「模型里的高度」便于其它工具校验
        floorPosition: round6(num(note.height, 0)),
      };
      (num(note.above, 1) ? notesAbove : notesBelow).push(item);
      notes++;
    }
    notesAbove.sort((a, b) => a.time - b.time);
    notesBelow.sort((a, b) => a.time - b.time);

    judgeLineList.push({
      bpm,
      notesAbove,
      notesBelow,
      speedEvents: finishEventList(speedEvents, {
        firstStart: 0,
        defaultValue: { value: 1 },
      }),
      judgeLineMoveEvents: finishEventList(moveEvents, {
        firstStart: OFFICIAL.SENTINEL_MIN,
        defaultValue: { start: 0.5, start2: 0.5, end: 0.5, end2: 0.5 },
      }),
      judgeLineRotateEvents: finishEventList(rotateEvents, {
        firstStart: OFFICIAL.SENTINEL_MIN,
        defaultValue: { start: 0, end: 0 },
      }),
      judgeLineDisappearEvents: finishEventList(alphaEvents, {
        firstStart: OFFICIAL.SENTINEL_MIN,
        defaultValue: { start: 0, end: 0 },
      }),
    });
  }

  const json = {
    formatVersion,
    offset: round6(num(meta.offset, 0)),
    judgeLineList: judgeLineList.filter(Boolean),
  };

  const missingTotal = Object.values(missing).reduce((a, b) => a + b, 0);
  if (missingTotal) {
    const parts = Object.entries(missing)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k}×${n}`);
    warn(`有判定线缺少事件（${parts.join('、')} 条线），已按缺省值补常量事件（位移=画面中心、旋转=0、透明度=0、速度=1）`);
  }
  if (eased) warn(`共 ${eased} 条事件使用了缓动，官谱格式不支持缓动，已按 ${curveSegments} 段折线近似（曲线形状基本保留，数值不再逐点相等）`);
  if (ramps) warn(`共 ${ramps} 段速度为渐变，官谱的速度事件是分段常量，已细分为等值小段近似（积分=判定线高度，误差可忽略）`);
  if (chart.format === 'rpe') warn('源谱面是 RPE 格式：事件层已合并为单层，缓动/扩展事件（故事板）/Control 等官谱不支持的内容会被丢弃');
  if (lineSpeedRewrites) {
    warn(`有 ${lineSpeedRewrites} 个 Hold 的尾部在编辑器里是「跟随判定线速度」（RPE 口径）：官方格式只有固定的尾速度，已按判定时刻的线速度换算成等价 η（区间内的速度变化无法表达）`);
  }
  if (chart.extendedKeys?.length) warn(`谱面含扩展事件（${chart.extendedKeys.join('、')}），官谱格式无法表达，已丢弃`);
  const cameraEvents = CAMERA_KEYS.reduce((n, k) => n + asArray(chart.camera?.[k]).length, 0);
  if (cameraEvents) warn(`谱面含 ${cameraEvents} 条相机关键帧（本项目的自有扩展），官谱格式无法表达，已丢弃`);
  if (json.judgeLineList.length > 100) warn(`判定线 ${json.judgeLineList.length} 条，官方引擎建议不超过 100 条`);

  return {
    json,
    warnings,
    stats: {
      lines: json.judgeLineList.length,
      notes,
      events: json.judgeLineList.reduce(
        (n, l) => n + l.speedEvents.length + l.judgeLineMoveEvents.length + l.judgeLineRotateEvents.length + l.judgeLineDisappearEvents.length,
        0,
      ),
      missingEvents: missingTotal,
      roundedDigits: ROUND_DIGITS,
    },
  };
}
