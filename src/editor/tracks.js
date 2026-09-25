/**
 * 时间轴「轨道（轴）」的数据模型：把谱面模型映射成可自由组合的轨道描述。
 *
 * 一条轨道可以是「某条线的某个事件层的某类事件」，也可以是「某条线的音符」。
 * 一个事件层的 5 条事件轨可以**整组导入并绑定**（`group` 字段），之后一起显隐/移除。
 *
 * 时间轴以**拍**为单位（参考图风格）：clip 上同时带秒（`t0/t1`，播放用）与拍（`b0/b1`，绘制用）。
 */
import { createTimeline } from '../core/timing.js';
import { CAMERA_KEYS, CAMERA_LINE_ID, EXTENDED_KEYS } from '../core/units.js';

export const EVENT_KEYS = ['x', 'y', 'rotate', 'alpha', 'speed'];

/** 官方格式用 1000000000 之类的哨兵拍值表示「保持到结束」 */
const SENTINEL_BEAT = 1e6;

/** 音符轨是「宽轨」：行高比普通事件轨高，内部按 positionX 分布高度（再加高 50%） */
export const NOTE_ROW_H = 189;

/** 横向刻度线（positionX 轴）用「线数」表示密度 */
export const POS_LINE_OPTIONS = [2, 3, 4, 5, 7, 9, 11, 13, 16];
export const DEFAULT_POS_LINES = 9;

/** 音符贴图（assets/notes） */
export const NOTE_SPRITES = { tap: 'tap.png', drag: 'drag.png', hold: 'hold.png', flick: 'flick.png' };

/** positionX 没数据时的兜底范围（Phigros 谱面常见 ±9） */
export const FALLBACK_X_RANGE = 9;

export const EVENT_COLORS = {
  x: '#999999',
  y: '#ffd700',
  alpha: '#00FA9A',
  rotate: '#FF1493',
  speed: '#1e90ff',
  notes: '#cfcfcf',
  // 扩展（故事板）事件：不分层，单独成组
  scaleX: '#EEEEEE',
  scaleY: '#FFB26B',
  color: '#66ccff',
  // （伪）3D 扩展事件（本项目的自有扩展：RPE 写 moveZEvents / thetaEvents）
  z: '#FF6347',
  theta: '#7A67EE',
};

export const EVENT_LABELS = {
  x: 'X 位移事件',
  y: 'Y 位移事件',
  rotate: '旋转事件',
  alpha: '不透明度事件',
  speed: '速度事件',
  notes: '音符',
  scaleX: 'X 缩放事件',
  scaleY: 'Y 缩放事件',
  color: '颜色事件',
  z: 'Z 轴位移事件',
  theta: '下落面倾斜事件',
};

/** 事件类型在轨道头里的短名（参考图是两行：线/层 + 事件名） */
/** 轨道头显示的图标名（对应 assets/icons 下的文件名） */
export const EVENT_TRACK_ICONS = {
  x: 'movement_x',
  y: 'movement_y',
  rotate: 'loop',
  alpha: 'visible',
  speed: 'speed',
  notes: 'note',
  scaleX: 'scale',
  scaleY: 'scale',
  color: 'color',
  z: 'movement_z',
  theta: 'theta',
};

export const EVENT_SHORT = {
  x: 'X位移事件',
  y: 'Y位移事件',
  rotate: '旋转事件',
  alpha: '不透明度事件',
  speed: '速度事件',
  notes: '音符',
  scaleX: 'X缩放事件',
  scaleY: 'Y缩放事件',
  color: '颜色事件',
  z: 'Z轴位移',
  theta: '下落面倾斜',
};

/**
 * **谱面相机**（谱面级关键帧，用法与可变 BPM 一样）：通道的颜色 / 名称 / 图标。
 * 相机不属于任何判定线，所以单独一套表（键名与普通事件的 x / y 同名，不能共用一张表）。
 */
export const CAMERA_COLORS = { x: '#4FC3F7', y: '#FFD166', z: '#FF6347', focal: '#B388FF' };
export const CAMERA_LABELS = { x: '相机 X 平移事件', y: '相机 Y 平移事件', z: '相机 Z 推拉事件', focal: '相机焦距事件' };
export const CAMERA_SHORT = { x: '相机X', y: '相机Y', z: '相机Z', focal: '相机焦距' };
export const CAMERA_ICONS = { x: 'movement_x', y: 'movement_y', z: 'movement_z', focal: 'zoom_in' };
/** 相机组的图标与名称（结构树 / 轨道头用） */
export const CAMERA_GROUP_LABEL = '谱面相机';
export const CAMERA_GROUP_ICON = 'configure';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * 拍轴：整条谱面共用一个（用 chart.timing.bpmList）。
 * 说明：官方格式每条线自带 bpm，这里用全局 BPMList 作横轴；单 bpm 的谱面与事件自身拍完全一致。
 */
export function createBeatAxis(chart) {
  const bpmList = chart?.timing?.bpmList?.length ? chart.timing.bpmList : chart?.lines?.[0]?.bpmList ?? [{ beat: 0, bpm: 120 }];
  const timeline = createTimeline(bpmList, 1);
  return {
    timeline,
    toBeat: (sec) => timeline.secondsToBeat(Math.max(0, sec || 0)),
    toSec: (beat) => timeline.beatToSeconds(beat || 0),
    get totalBeats() {
      return timeline.secondsToBeat(Math.max(0, chart?.endTime ?? 0));
    },
  };
}

/** 缓动标签：线性 / 缓动#N / 贝塞尔 */
function easingLabel(ev) {
  const fn = ev?.easingFn;
  const type = Number.isFinite(ev?.easingType) ? ev.easingType : Number.isFinite(fn?.easingType) ? fn.easingType : 1;
  const preset = Number.isFinite(ev?.easingPreset) ? ev.easingPreset : Number.isFinite(fn?.easingPreset) ? fn.easingPreset : type;
  // 只有真的带 4 个控制点才算贝塞尔（6 号预设本身是 In Out Sine，不是贝塞尔）
  const bezier = !!ev?.bezierPoints?.length || fn?.isBezier === true;
  if (bezier) return '贝塞尔';
  if (preset === 1 || type === 1) return '线性';
  return `缓动#${preset}`;
}

const fmtNum = (v) =>
  Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2);

/** 事件取值可能是数值或 `[r,g,b]`（颜色事件） */
export const fmtValue = (v) => (Array.isArray(v) ? v.map((x) => Math.round(Number(x) || 0)).join(',') : fmtNum(v));

/** 颜色事件的趋势线用「最大通道」当标量（0–255），否则范围没有意义 */
const colorTrend = (v) => (Array.isArray(v) ? Math.max(...v.map((x) => Number(x) || 0)) : v);

/** 把一组事件块的取值折算成统一的纵向范围，用于画变化趋势线 */
export function valueRange(clips) {
  let min = Infinity;
  let max = -Infinity;
  for (const c of clips) {
    for (const raw of [c.v0, c.v1]) {
      const v = Number.isFinite(c.trend0) || Number.isFinite(c.trend1) ? colorTrend(raw) : raw;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max - min < 1e-9) {
    // 全部相等：给一个虚拟范围，让趋势线画在中间（参考图里 0 → 0 就是一条平线）
    const pad = Math.max(1, Math.abs(min) * 0.5);
    return { min: min - pad, max: min + pad };
  }
  return { min, max };
}

/**
 * 把一个事件描述成时间轴需要的信息（拍数、是否保持、文案）。
 * 时间轴建轨与「Event 详情」改完参数后就地刷新都用它，避免两处逻辑不一致。
 */
export function describeEvent(ev) {
  const holds = ev.endBeat >= SENTINEL_BEAT;
  const beats = holds ? 0 : Math.max(0, ev.endBeat - ev.startBeat);
  const tail = holds ? '保持' : `${Number.isInteger(beats) ? beats : beats.toFixed(2)}拍, ${easingLabel(ev)}`;
  return {
    holds,
    beats,
    easing: easingLabel(ev),
    text: `${fmtValue(ev.start)} → ${fmtValue(ev.end)}, ${tail}`,
  };
}

/** 某条线 + 某个事件层 + 某类事件 → 一条轨道 */
export function makeEventTrack(chart, lineId, layerIndex, key, axis = createBeatAxis(chart)) {
  const line = chart.lines[lineId];
  const layer = line?.layers?.[layerIndex] ?? {};
  const events = layer[key] ?? [];
  const timeline = line?.rt?.timeline;
  const chartEnd = Number.isFinite(chart.endTime) ? chart.endTime : 0;

  const clips = events
    .map((ev) => {
      const t0 = timeline ? timeline.beatToSeconds(ev.startBeat) : ev.startBeat;
      const holds = ev.endBeat >= SENTINEL_BEAT;
      let t1 = timeline ? timeline.beatToSeconds(ev.endBeat) : ev.endBeat;
      if (holds || !Number.isFinite(t1)) t1 = chartEnd;
      const desc = describeEvent(ev);
      return {
        ev, // 源事件对象：编辑器改参数时直接改它，再就地刷新下面的派生字段
        key,
        lineId,
        layerIndex,
        startBeat: ev.startBeat,
        endBeat: ev.endBeat,
        t0,
        t1: Math.max(t0, t1),
        b0: axis.toBeat(t0),
        b1: Math.max(axis.toBeat(t0), axis.toBeat(Math.max(t0, t1))),
        beats: desc.beats,
        holds: desc.holds,
        v0: ev.start,
        v1: ev.end,
        easingFn: ev.easingFn ?? null,
        easingType: ev.easingType,
        easingPreset: ev.easingPreset,
        bezierPoints: ev.bezierPoints ?? null,
        text: desc.text,
        sub: `${line?.name ?? `线 ${lineId}`} · 层 ${layerIndex + 1}`,
      };
    })
    .sort((a, b) => a.b0 - b.b0); // 按时间排序：小事件合并渲染需要顺序

  const group = `layer:${lineId}:${layerIndex}`;
  return {
    id: `ev:${lineId}:${layerIndex}:${key}`,
    kind: 'events',
    lineId,
    layerIndex,
    key,
    timeline, // 用于把拍换算成秒
    maxTime: chartEnd,
    group,
    groupLabel: `${lineId + 1}号线 事件层${ROMAN[layerIndex] ?? layerIndex + 1}`,
    label: `${line?.name ?? `${lineId + 1}号线`} 事件层${ROMAN[layerIndex] ?? layerIndex + 1} · ${EVENT_SHORT[key] ?? key}`,
    headTitle: `${lineId + 1}号线 事件层${ROMAN[layerIndex] ?? layerIndex + 1}`,
    headSub: EVENT_SHORT[key] ?? key,
    icon: EVENT_TRACK_ICONS[key] ?? 'note',
    color: EVENT_COLORS[key] ?? '#a8b0bd',
    visible: true,
    clips,
    range: valueRange(clips),
  };
}

/**
 * 一个事件层的 5 条事件轨（**整组导入并绑定**：以后一起显隐/移动/移除）。
 * 只导出该层里真正存在的事件类型。
 */
export function makeLayerTracks(chart, lineId, layerIndex, axis = createBeatAxis(chart)) {
  const layer = chart.lines[lineId]?.layers?.[layerIndex] ?? {};
  return EVENT_KEYS.filter((key) => (layer[key]?.length ?? 0) > 0).map((key) =>
    makeEventTrack(chart, lineId, layerIndex, key, axis),
  );
}

/**
 * 一条扩展（故事板）事件 → 一条轨道。
 * 扩展事件**不分事件层**：数据在 `line.extended[key]`，轨道 id 用 `ev:<线>:ext:<键>`，
 * `layerIndex` 为 null（时间轴的写回路径据此走扩展分支）。
 */
export function makeExtendedTrack(chart, lineId, key, axis = createBeatAxis(chart)) {
  const line = chart.lines[lineId];
  const events = line?.extended?.[key] ?? [];
  const timeline = line?.rt?.timeline;
  const chartEnd = Number.isFinite(chart.endTime) ? chart.endTime : 0;
  const isColor = key === 'color';

  const clips = events
    .map((ev) => {
      const t0 = timeline ? timeline.beatToSeconds(ev.startBeat) : ev.startBeat;
      const holds = ev.endBeat >= SENTINEL_BEAT;
      let t1 = timeline ? timeline.beatToSeconds(ev.endBeat) : ev.endBeat;
      if (holds || !Number.isFinite(t1)) t1 = chartEnd;
      const desc = describeEvent(ev);
      return {
        ev,
        key,
        lineId,
        layerIndex: null,
        extended: true,
        startBeat: ev.startBeat,
        endBeat: ev.endBeat,
        t0,
        t1: Math.max(t0, t1),
        b0: axis.toBeat(t0),
        b1: Math.max(axis.toBeat(t0), axis.toBeat(Math.max(t0, t1))),
        beats: desc.beats,
        holds: desc.holds,
        v0: ev.start,
        v1: ev.end,
        // 颜色事件没有单一标量：趋势线用最大通道
        trend0: isColor ? colorTrend(ev.start) : undefined,
        trend1: isColor ? colorTrend(ev.end) : undefined,
        easingFn: ev.easingFn ?? null,
        easingType: ev.easingType,
        easingPreset: ev.easingPreset,
        bezierPoints: ev.bezierPoints ?? null,
        text: desc.text,
        sub: `${line?.name ?? `线 ${lineId}`} · 扩展事件`,
      };
    })
    .sort((a, b) => a.b0 - b.b0);

  return {
    id: `ev:${lineId}:ext:${key}`,
    kind: 'events',
    lineId,
    layerIndex: null,
    extended: true,
    key,
    timeline,
    maxTime: chartEnd,
    group: `ext:${lineId}`,
    groupLabel: `${lineId + 1}号线 扩展事件`,
    label: `${line?.name ?? `${lineId + 1}号线`} 扩展事件 · ${EVENT_SHORT[key] ?? key}`,
    headTitle: `${lineId + 1}号线 扩展事件`,
    headSub: EVENT_SHORT[key] ?? key,
    icon: EVENT_TRACK_ICONS[key] ?? 'note',
    color: EVENT_COLORS[key] ?? '#a8b0bd',
    visible: true,
    clips,
    range: valueRange(clips),
  };
}

/** 一条线的全部扩展事件轨（只导出真正有事件、且本版本已实现的键） */
export function makeExtendedTracks(chart, lineId, axis = createBeatAxis(chart)) {
  const extended = chart.lines[lineId]?.extended ?? {};
  return EXTENDED_KEYS.filter((key) => (extended[key]?.length ?? 0) > 0).map((key) =>
    makeExtendedTrack(chart, lineId, key, axis),
  );
}

/**
 * 谱面相机的**时间轴**（相机是谱面级的，用全局 BPMList —— 与 `model.js` 的 `refreshCamera`
 * 以及时间轴的拍轴完全一致，因此相机事件用的就是时间轴上的拍）。
 */
export function createCameraTimeline(chart) {
  const bpmList = chart?.timing?.bpmList?.length ? chart.timing.bpmList : [{ beat: 0, bpm: 120 }];
  return createTimeline(bpmList, Number.isFinite(chart?.timing?.bpmFactor) ? chart.timing.bpmFactor : 1);
}

/**
 * 谱面相机的一个通道 → 一条轨道。
 * 与扩展事件轨的区别只有两点：数据在 `chart.camera[key]`（**谱面级**，不属于任何判定线），
 * 轨道 id 用 `cam:<键>`、`lineId` 用哨兵 `CAMERA_LINE_ID`（于是拖动 / 撤销 / 粘贴这些
 * 「按线重编译」的既有路径原样可用）。
 */
export function makeCameraTrack(chart, key, axis = createBeatAxis(chart)) {
  const events = chart?.camera?.[key] ?? [];
  const timeline = createCameraTimeline(chart);
  const chartEnd = Number.isFinite(chart?.endTime) ? chart.endTime : 0;

  const clips = events
    .map((ev) => {
      const t0 = timeline.beatToSeconds(ev.startBeat);
      const holds = ev.endBeat >= SENTINEL_BEAT;
      let t1 = timeline.beatToSeconds(ev.endBeat);
      if (holds || !Number.isFinite(t1)) t1 = chartEnd;
      const desc = describeEvent(ev);
      return {
        ev,
        key,
        lineId: CAMERA_LINE_ID,
        layerIndex: null,
        camera: true, // 标记：写回 / 重编译走相机分支（见 timeline.js / clipboard.js）
        startBeat: ev.startBeat,
        endBeat: ev.endBeat,
        t0,
        t1: Math.max(t0, t1),
        b0: axis.toBeat(t0),
        b1: Math.max(axis.toBeat(t0), axis.toBeat(Math.max(t0, t1))),
        beats: desc.beats,
        holds: desc.holds,
        v0: ev.start,
        v1: ev.end,
        easingFn: ev.easingFn ?? null,
        easingType: ev.easingType,
        easingPreset: ev.easingPreset,
        bezierPoints: ev.bezierPoints ?? null,
        text: desc.text,
        sub: `${CAMERA_GROUP_LABEL} · ${CAMERA_SHORT[key] ?? key}`,
      };
    })
    .sort((a, b) => a.b0 - b.b0);

  return {
    id: `cam:${key}`,
    kind: 'events',
    camera: true,
    lineId: CAMERA_LINE_ID,
    layerIndex: null,
    key,
    timeline,
    maxTime: chartEnd,
    group: 'camera',
    groupLabel: CAMERA_GROUP_LABEL,
    label: `${CAMERA_GROUP_LABEL} · ${CAMERA_SHORT[key] ?? key}`,
    headTitle: CAMERA_GROUP_LABEL,
    headSub: CAMERA_SHORT[key] ?? key,
    icon: CAMERA_ICONS[key] ?? 'configure',
    color: CAMERA_COLORS[key] ?? '#a8b0bd',
    visible: true,
    clips,
    range: valueRange(clips),
  };
}

/** 谱面相机的全部通道轨（只导出真正有事件的通道） */
export function makeCameraTracks(chart, axis = createBeatAxis(chart)) {
  const camera = chart?.camera ?? {};
  return CAMERA_KEYS.filter((key) => (camera[key]?.length ?? 0) > 0).map((key) => makeCameraTrack(chart, key, axis));
}

/**
 * 就地刷新单个事件 clip 的派生字段（改完 ev 之后调用）。
 * 不重排、不重建轨道，因此时间轴上的选中状态不会丢。
 * @returns {boolean} 是否刷新成功
 */
export function refreshEventClip(track, index, axis) {
  const clip = track?.clips?.[index];
  const ev = clip?.ev;
  if (!ev || !axis) return false;
  const timeline = track.timeline ?? null;
  const t0 = timeline ? timeline.beatToSeconds(ev.startBeat) : ev.startBeat;
  const holds = ev.endBeat >= SENTINEL_BEAT;
  let t1 = timeline ? timeline.beatToSeconds(ev.endBeat) : ev.endBeat;
  if (holds || !Number.isFinite(t1)) t1 = track.maxTime ?? t0;
  const desc = describeEvent(ev);
  clip.key = ev.key ?? clip.key;
  clip.startBeat = ev.startBeat;
  clip.endBeat = ev.endBeat;
  clip.t0 = t0;
  clip.t1 = Math.max(t0, t1);
  clip.b0 = axis.toBeat(t0);
  clip.b1 = Math.max(clip.b0, axis.toBeat(Math.max(t0, t1)));
  clip.beats = desc.beats;
  clip.holds = desc.holds;
  clip.v0 = ev.start;
  clip.v1 = ev.end;
  clip.easingFn = ev.easingFn ?? null;
  clip.easingType = ev.easingType;
  clip.easingPreset = ev.easingPreset;
  clip.bezierPoints = ev.bezierPoints ?? null;
  clip.text = desc.text;
  track.range = valueRange(track.clips);
  return true;
}

/** 某条线的音符 → 一条轨道（Hold 按时长画成块，其余画成小标记） */
export function makeNotesTrack(chart, lineId, axis = createBeatAxis(chart)) {
  const line = chart.lines[lineId];
  const notes = line?.rt?.notes ?? [];
  const clips = notes
    .map((n) => ({
      t0: n.timeSec,
      t1: n.timeSec + Math.max(n.durationSec ?? 0, 0),
      b0: axis.toBeat(n.timeSec),
      b1: axis.toBeat(n.timeSec + Math.max(n.durationSec ?? 0, 0)),
      type: n.type,
      positionX: Number.isFinite(n.positionX) ? n.positionX : 0,
      above: !!n.above,
      isFake: !!n.isFake,
      speed: Number.isFinite(n.speed) ? n.speed : 1,
      holdBeats: Number.isFinite(n.endBeat) && Number.isFinite(n.startBeat) ? Math.max(0, n.endBeat - n.startBeat) : 0,
      note: n, // 渲染器音符对象（编辑参数时写回）
      text: `${n.type}${n.isFake ? ' · fake' : ''}`,
      sub: `X ${fmtNum(n.positionX)}${n.above ? '' : ' · 背面'}`,
    }))
    .sort((a, b) => a.b0 - b.b0);

  // 音符的 positionX 范围（决定它在宽轨里分布多高）
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const c of clips) {
    if (c.positionX < xMin) xMin = c.positionX;
    if (c.positionX > xMax) xMax = c.positionX;
  }
  const xRange =
    Number.isFinite(xMin) && Number.isFinite(xMax) && xMax - xMin > 1e-6
      ? { min: xMin, max: xMax }
      : { min: -FALLBACK_X_RANGE, max: FALLBACK_X_RANGE };
  return {
    id: `notes:${lineId}`,
    kind: 'notes',
    lineId,
    label: `${lineId + 1}号线 · ${EVENT_LABELS.notes}`,
    headTitle: `${lineId + 1}号线`,
    headSub: EVENT_LABELS.notes,
    icon: EVENT_TRACK_ICONS.notes,
    color: EVENT_COLORS.notes,
    visible: true,
    rowHeight: NOTE_ROW_H, // 宽轨
    xRange, // 横向刻度线步长由时间轴全局设置（timeline.posStep）
    clips,
  };
}

/**
 * 一条线的**全部内容**：音符轨（排最前）+ 每个事件层的 5 条事件轨。
 * 结构树里单击「n 号线」时用它：先清空时间轴，再整条线放进来。
 */
export function makeLineTracks(chart, lineId, axis = createBeatAxis(chart)) {
  const line = chart.lines[lineId];
  const out = [];
  if (line?.rt?.notes?.length) out.push(makeNotesTrack(chart, lineId, axis));
  const layers = line?.layers ?? [];
  for (let li = 0; li < layers.length; li++) out.push(...makeLayerTracks(chart, lineId, li, axis));
  out.push(...makeExtendedTracks(chart, lineId, axis)); // 扩展事件排在各事件层之后
  return out;
}

/**
 * 默认布局：**1 号线的第 1 个事件层**（整组绑定）。
 * 只导入该层里实际有事件的类型，避免出现空轨。
 */
export function defaultTracks(chart) {
  const axis = createBeatAxis(chart);
  const layerCount = chart.lines[0]?.layers?.length ?? 0;
  const notes = chart.lines[0]?.rt?.notes?.length ? [makeNotesTrack(chart, 0, axis)] : [];
  // 1 号线的音符轨（宽轨）始终带上
  for (let li = 0; li < layerCount; li++) {
    const tracks = makeLayerTracks(chart, 0, li, axis);
    if (tracks.length) return { axis, tracks: [...notes, ...tracks] }; // 音符轨排在事件层前面
  }
  return { axis, tracks: notes };
}

/** 轨道里的事件总数（信息展示用） */
export const countClips = (tracks) => tracks.reduce((a, t) => a + t.clips.length, 0);
