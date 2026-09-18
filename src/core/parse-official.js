/**
 * 官方（official）格式解析：JSON -> 内部统一模型。
 * 依据 docs/01-官方格式规格.md；健壮性策略见 docs/05 §3.4（脏数据取缺省值 + 诊断，不抛异常）。
 */
import {
  OFFICIAL,
  OFFICIAL_NOTE_TYPE,
  degToRad,
  officialCenterOffset,
  unpackOfficialV1,
} from './units.js';
import { createChart } from './model.js';
import { asArray, isObj, num, numChecked, objList, positive, str } from './sanitize.js';

const T = OFFICIAL.TIME_PER_BEAT;
const FALLBACK_BPM = 120;

/** 官方判定线事件：move 事件的坐标读取方式由 formatVersion 决定（见 docs/01 §2.1） */
function moveValues(evt, formatVersion, sx, sy, ex, ey) {
  if (formatVersion === 1) {
    const a = unpackOfficialV1(sx);
    const b = unpackOfficialV1(ex);
    return [officialCenterOffset(a.x), officialCenterOffset(a.y), officialCenterOffset(b.x), officialCenterOffset(b.y)];
  }
  if (formatVersion !== 3 && formatVersion !== 3473) {
    const kx = 0.1 * (9 / 16); // 0.1 H -> 画面宽比例（渲染范围固定 16:9）
    return [sx * kx, sy * 0.1, ex * kx, ey * 0.1];
  }
  return [officialCenterOffset(sx), officialCenterOffset(sy), officialCenterOffset(ex), officialCenterOffset(ey)];
}

function lineHasEvents(raw) {
  return (
    asArray(raw.speedEvents).length > 0 ||
    asArray(raw.judgeLineMoveEvents).length > 0 ||
    asArray(raw.judgeLineRotateEvents).length > 0 ||
    asArray(raw.judgeLineDisappearEvents).length > 0
  );
}

/** 收集事件里的单值字段，缺省/非法时计数（同类问题只报一条汇总） */
function makeEventReader(warnFn, lineIndex, key) {
  const bad = { count: 0, fields: new Set() };
  const read = (evt, field, def) => {
    const { value, ok } = numChecked(evt[field], def);
    if (!ok) {
      bad.count++;
      if (bad.fields.size < 4) bad.fields.add(field);
    }
    return value;
  };
  return {
    read,
    finish() {
      if (bad.count) {
        warnFn(
          `判定线 ${lineIndex} 的 ${key} 事件里有 ${bad.count} 处非数值/缺失字段（${[...bad.fields].join('、')}），已取缺省值`,
        );
      }
    },
  };
}

export function parseOfficialChart(json, options = {}) {
  const diag = options.diagnostics ?? null;
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    diag?.warn(msg);
  };

  if (!isObj(json)) {
    throw new Error('官方谱面不是 JSON 对象（无法解析）');
  }

  const formatVersion = num(json.formatVersion, 3);
  const bpmRaw = json.judgeLineList;
  if (bpmRaw !== undefined && !Array.isArray(bpmRaw)) {
    warn('judgeLineList 不是数组，已按空谱面处理');
  }
  const rawLines = asArray(json.judgeLineList);

  const chart = createChart({
    format: 'official',
    source: { formatVersion, file: options.file ?? '' },
    warnings,
    diagnostics: diag ? { summary: diag.summary } : undefined,
    timing: { bpmList: [], bpmFactor: 1 },
    meta: {
      name: str(options.meta?.name),
      composer: str(options.meta?.composer),
      charter: str(options.meta?.charter),
      illustrator: str(options.meta?.illustrator),
      level: str(options.meta?.level),
      id: str(options.meta?.id),
      song: str(options.meta?.song),
      background: str(options.meta?.background),
      offset: num(json.offset, 0, { min: -3600, max: 3600 }), // 秒
    },
  });

  if (![1, 2, 3, 3473].includes(formatVersion)) {
    warn(`官方格式 formatVersion=${formatVersion} 未在文档中定义，按「中心原点、0.1H 单位」处理`);
  }
  if (json.numOfNotes !== undefined) warn('根结构存在已移除字段 numOfNotes（v2.5.0 起移除），已忽略');

  chart.timing.bpmList = [{ beat: 0, bpm: positive(rawLines.find(isObj)?.bpm, FALLBACK_BPM) }];

  rawLines.forEach((raw, index) => {
    if (!isObj(raw)) {
      warn(`判定线 ${index} 不是对象，已忽略`);
      return;
    }
    const bpmVal = num(raw.bpm, FALLBACK_BPM);
    const bpm = bpmVal > 0 ? bpmVal : FALLBACK_BPM;
    if (bpm !== bpmVal) warn(`判定线 ${index} 的 bpm 非法（${String(raw.bpm)}），已按 ${FALLBACK_BPM} 处理`);
    if (!lineHasEvents(raw)) warn(`判定线 ${index} 没有任何事件（官方引擎会表现异常）`);

    // ---- 事件 ----
    const readMove = makeEventReader(warn, index, 'move');
    const readRotate = makeEventReader(warn, index, 'rotate');
    const readAlpha = makeEventReader(warn, index, 'disappear');
    const readSpeed = makeEventReader(warn, index, 'speed');

    const moveEvents = objList(raw.judgeLineMoveEvents).kept;
    const rotateEvents = objList(raw.judgeLineRotateEvents).kept;
    const alphaEvents = objList(raw.judgeLineDisappearEvents).kept;
    const speedEvents = objList(raw.speedEvents).kept;

    const moveCanonical = moveEvents.map((evt) => {
      const sx = readMove.read(evt, 'start', 0);
      const sy = readMove.read(evt, 'start2', 0);
      const ex = readMove.read(evt, 'end', sx);
      const ey = readMove.read(evt, 'end2', sy);
      const [x0, y0, x1, y1] = moveValues(evt, formatVersion, sx, sy, ex, ey);
      return {
        startBeat: num(evt.startTime, 0) / T,
        endBeat: num(evt.endTime, 0) / T,
        x0,
        y0,
        x1,
        y1,
      };
    });

    const layers = [
      {
        x: moveCanonical.map((m) => ({ startBeat: m.startBeat, endBeat: m.endBeat, start: m.x0, end: m.x1 })),
        y: moveCanonical.map((m) => ({ startBeat: m.startBeat, endBeat: m.endBeat, start: m.y0, end: m.y1 })),
        rotate: rotateEvents.map((evt) => ({
          startBeat: num(evt.startTime, 0) / T,
          endBeat: num(evt.endTime, 0) / T,
          start: degToRad(readRotate.read(evt, 'start', 0)), // 官方为逆时针为正的度数
          end: degToRad(readRotate.read(evt, 'end', 0)),
        })),
        alpha: alphaEvents.map((evt) => ({
          startBeat: num(evt.startTime, 0) / T,
          endBeat: num(evt.endTime, 0) / T,
          start: readAlpha.read(evt, 'start', 0),
          end: readAlpha.read(evt, 'end', 0),
        })),
        speed: speedEvents.map((evt) => {
          const v = readSpeed.read(evt, 'value', 1);
          const startBeat = num(evt.startTime, 0) / T;
          const endBeatRaw = num(evt.endTime, num(evt.startTime, 0)) / T;
          // 注意：不在这里校正 endBeat < startBeat —— 交给 compileEventList 丢弃非法事件（docs/01 §7）
          return { startBeat, endBeat: endBeatRaw, start: v, end: v };
        }),
      },
    ];
    for (const r of [readMove, readRotate, readAlpha, readSpeed]) r.finish();

    // ---- 音符 ----
    const mapNote = (note, above) => {
      if (!isObj(note)) {
        warn(`判定线 ${index} 存在非对象音符，已忽略`);
        return null;
      }
      const type = OFFICIAL_NOTE_TYPE[num(note.type, -1)];
      if (!type) {
        warn(`判定线 ${index} 存在未知 note 类型 ${String(note.type)}（游戏内不可见也不可判定），已忽略`);
        return null;
      }
      const timeUnits = num(note.time, 0);
      const startBeat = timeUnits / T;
      const holdBeats = type === 'hold' ? Math.max(0, num(note.holdTime, 0)) / T : 0;
      const speedVal = num(note.speed, 1, { min: -1e3, max: 1e3 });
      return {
        type,
        startBeat,
        endBeat: startBeat + holdBeats,
        positionX: num(note.positionX, 0, { min: -1e4, max: 1e4 }), // 已是官方 X 单位
        above,
        speed: speedVal,
        alpha: 1,
        size: 1,
        yOffset: 0,
        visibleTime: Infinity,
        isFake: false,
        hitsound: '',
        tint: null,
        floorPositionRaw: note.floorPosition,
        raw: note,
      };
    };

    const notes = [
      ...objList(raw.notesAbove).kept.map((n) => mapNote(n, true)),
      ...objList(raw.notesBelow).kept.map((n) => mapNote(n, false)),
    ].filter(Boolean);

    chart.lines.push({
      id: index,
      name: str(raw.name, `Line ${index}`),
      group: 0,
      zOrder: 0,
      isCover: false,
      texture: str(raw.texture),
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

  if (!chart.lines.length) warn('谱面没有任何判定线（judgeLineList 为空或全部非法）');
  const noteTotal = chart.lines.reduce((a, l) => a + l.notes.length, 0);
  if (!noteTotal) warn('谱面没有任何可识别的音符');
  return chart;
}
