/**
 * 官方（official）格式解析：JSON -> 内部统一模型。
 * 依据 docs/01-官方格式规格.md。
 */
import {
  OFFICIAL,
  OFFICIAL_NOTE_TYPE,
  degToRad,
  officialCenterOffset,
  unpackOfficialV1,
} from './units.js';
import { createChart } from './model.js';

const T = OFFICIAL.TIME_PER_BEAT;

/**
 * 官方判定线事件：move 事件的坐标读取方式由 formatVersion 决定
 *  - 1：压缩整数 1000x + y，左下角原点、右上角 (880, 520)
 *  - 3（以及彩蛋值 3473，sim-phi 视其与 3 同构）：start/end = x，start2/end2 = y（左下角 0..1）
 *  - 其它（普遍认为是 2）：以画面**中心**为原点，两轴单位长度均为 0.1 H。
 *    0.1 H 在 16:9 渲染范围下等于 0.05625 W（= 1 X），因此换算为「画面宽比例」= v × 0.05625、
 *    「画面高比例」= v × 0.1。
 */
function moveValues(evt, formatVersion, warn) {
  if (formatVersion === 1) {
    const a = unpackOfficialV1(evt.start);
    const b = unpackOfficialV1(evt.end);
    return [officialCenterOffset(a.x), officialCenterOffset(a.y), officialCenterOffset(b.x), officialCenterOffset(b.y)];
  }
  if (formatVersion !== 3 && formatVersion !== 3473) {
    warn(`formatVersion=${formatVersion}：按「中心原点、0.1H 单位」规则解析（见 docs/01 §2.1）`);
    const kx = 0.1 * (9 / 16); // 0.1 H -> 画面宽比例（渲染范围固定 16:9）
    return [evt.start * kx, (evt.start2 ?? 0) * 0.1, evt.end * kx, (evt.end2 ?? 0) * 0.1];
  }
  return [
    officialCenterOffset(evt.start),
    officialCenterOffset(evt.start2 ?? 0),
    officialCenterOffset(evt.end),
    officialCenterOffset(evt.end2 ?? 0),
  ];
}

function lineHasEvents(raw) {
  return (
    (raw.speedEvents?.length ?? 0) > 0 ||
    (raw.judgeLineMoveEvents?.length ?? 0) > 0 ||
    (raw.judgeLineRotateEvents?.length ?? 0) > 0 ||
    (raw.judgeLineDisappearEvents?.length ?? 0) > 0
  );
}

export function parseOfficialChart(json, options = {}) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const formatVersion = json.formatVersion ?? 3;

  const chart = createChart({
    format: 'official',
    source: { formatVersion, file: options.file ?? '' },
    warnings,
    timing: { bpmList: [], bpmFactor: 1 },
    meta: {
      name: options.meta?.name ?? '',
      composer: options.meta?.composer ?? '',
      charter: options.meta?.charter ?? '',
      illustrator: options.meta?.illustrator ?? '',
      level: options.meta?.level ?? '',
      id: options.meta?.id ?? '',
      song: options.meta?.song ?? '',
      background: options.meta?.background ?? '',
      offset: Number(json.offset) || 0, // 秒
    },
  });

  if (![1, 3, 3473].includes(formatVersion) && formatVersion !== 2) {
    warn(`官方格式 formatVersion=${formatVersion} 未在文档中定义，按「中心原点、0.1H 单位」处理`);
  }
  if (json.numOfNotes !== undefined) warn('根结构存在已移除字段 numOfNotes（v2.5.0 起移除），已忽略');

  const rawLines = json.judgeLineList ?? [];
  chart.timing.bpmList = [{ beat: 0, bpm: rawLines[0]?.bpm || 120 }];

  rawLines.forEach((raw, index) => {
    const bpm = Number(raw.bpm) || 120;
    if (!(bpm > 0)) warn(`判定线 ${index} 的 bpm 非法（${raw.bpm}）`);
    if (!lineHasEvents(raw)) warn(`判定线 ${index} 没有任何事件（官方引擎会表现异常）`);

    const moveCanonical = (raw.judgeLineMoveEvents ?? []).map((evt) => {
      const [x0, y0, x1, y1] = moveValues(evt, formatVersion, warn);
      return { startBeat: evt.startTime / T, endBeat: evt.endTime / T, x0, y0, x1, y1 };
    });

    const layers = [
      {
        x: moveCanonical.map((m) => ({ startBeat: m.startBeat, endBeat: m.endBeat, start: m.x0, end: m.x1 })),
        y: moveCanonical.map((m) => ({ startBeat: m.startBeat, endBeat: m.endBeat, start: m.y0, end: m.y1 })),
        rotate: (raw.judgeLineRotateEvents ?? []).map((evt) => ({
          startBeat: evt.startTime / T,
          endBeat: evt.endTime / T,
          start: degToRad(evt.start ?? 0), // 官方为逆时针为正的度数
          end: degToRad(evt.end ?? 0),
        })),
        alpha: (raw.judgeLineDisappearEvents ?? []).map((evt) => ({
          startBeat: evt.startTime / T,
          endBeat: evt.endTime / T,
          start: Number(evt.start) || 0,
          end: Number(evt.end) || 0,
        })),
        speed: (raw.speedEvents ?? []).map((evt) => ({
          startBeat: evt.startTime / T,
          endBeat: evt.endTime / T,
          start: evt.value,
          end: evt.value,
        })),
      },
    ];

    const mapNote = (note, above) => {
      const type = OFFICIAL_NOTE_TYPE[note.type];
      if (!type) warn(`判定线 ${index} 存在未知 note 类型 ${note.type}（游戏内不可见也不可判定），已忽略`);
      if (!type) return null;
      const startBeat = note.time / T;
      const holdBeats = type === 'hold' ? (note.holdTime ?? 0) / T : 0;
      return {
        type,
        startBeat,
        endBeat: startBeat + holdBeats,
        positionX: Number(note.positionX) || 0, // 已是官方 X 单位
        above,
        speed: Number.isFinite(note.speed) ? note.speed : 1,
        alpha: 1,
        size: 1,
        yOffset: 0,
        visibleTime: Infinity,
        isFake: false,
        hitsound: '',
        tint: null,
        floorPositionRaw: note.floorPosition,
      };
    };

    const notes = [
      ...(raw.notesAbove ?? []).map((n) => mapNote(n, true)),
      ...(raw.notesBelow ?? []).map((n) => mapNote(n, false)),
    ].filter(Boolean);

    chart.lines.push({
      id: index,
      name: raw.name ?? `Line ${index}`,
      group: 0,
      zOrder: 0,
      isCover: false,
      texture: raw.texture ?? '',
      isGif: false,
      father: -1,
      rotateWithFather: false,
      bpm,
      bpmFactor: 1,
      bpmList: [{ beat: 0, bpm }],
      layers,
      notes,
      raw,
    });
  });

  return chart;
}
