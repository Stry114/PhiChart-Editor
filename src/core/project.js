/**
 * 内部项目格式（PhiChart Editor Project，`.pce.json`）：**序列化 + 反序列化**。
 *
 * 为什么需要一个自有格式：官谱与 RPE 都表达不了「编辑器里的完整模型」——
 *  - 事件是**分层相加**的，官谱只有一层；
 *  - 缓动在内部是**函数**（29 种预设 / 自定义贝塞尔 / 缓动裁剪），JSON 里存不下；
 *  - 项目要能记住「从哪种格式来的、原始 JSON 里那些本版本未实现的字段」（导出时原样写回）。
 * 所以项目文件存的是**模型本身**（拍值 + 数值 + 缓动的编号参数），反序列化时再把缓动函数重新建出来。
 *
 * 文件结构（`format` 是识别标记，序列化与反序列化都只认它）：
 * ```json
 * {
 *   "format": "phichart-project", "version": 1, "generator": "PhiChart Editor",
 *   "savedAt": "2025-01-01T00:00:00.000Z", "sourceFormat": "rpe",
 *   "chart": {
 *     "format": "rpe", "source": {...}, "meta": {...},
 *     "timing": { "bpmList": [{"beat":0,"bpm":140}], "bpmFactor": 1 },
 *     "rootExtras": {...}, "extendedKeys": [...],
 *     "lines": [ { 判定线字段…, "layers": [...], "notes": [...], "extras": {...} } ]
 *   }
 * }
 * ```
 *
 * 反序列化产出的对象与 `parse-official.js` / `parse-rpe.js` 的返回值同构，
 * 直接交给 `prepareChart()` 即可（编辑器就是这么用的，见 `src/editor/preview.js`）。
 */
import { createChart, PROJECT_FORMAT, PROJECT_VERSION } from './model.js';
import { makeEasing } from './easing.js';
import { normalizeColor } from './events.js';
import { CAMERA_DEFAULTS, CAMERA_KEYS, EXTENDED_KEYS, EXTENDED_DEFAULTS, focalToAngle } from './units.js';
import { DEFAULT_SPEED_MULTIPLIER, GENERATOR_STAMP, SPEED_MULTIPLIER_MAX } from './meta.js';
import { RPE_LINE_EXTRA_KEYS } from './serialize-rpe.js';
import { asArray, int, isObj, num, positive, str } from './sanitize.js';

/** 生成器标识（写进文件，便于其它工具认出我们；与导出谱面的 `generator` 声明同一句话，含在线地址） */
export const PROJECT_GENERATOR = GENERATOR_STAMP;
/** 事件层里要写出的键（顺序即文件里的顺序） */
const LAYER_KEYS = ['x', 'y', 'rotate', 'alpha', 'speed'];
/** 音符要写出的字段（其余字段一律从 `raw` 里另存） */
const NOTE_KEYS = [
  'type',
  'startBeat',
  'endBeat',
  'positionX',
  'above',
  'speed',
  'alpha',
  'size',
  'yOffset',
  'visibleTime',
  'isFake',
  'hitsound',
  'tint',
  'judgeArea',
  // Hold 尾部速度口径：'line'（非独立，跟随判定线速度；缺省）/ 'own'（独立，官方尾速度）
  'holdSpeed',
];

/** 内部模型事件 -> 项目事件（丢掉 easingFn 这个函数，保留它的编号参数） */
function eventToProject(ev) {
  const out = {
    startBeat: num(ev?.startBeat, 0),
    endBeat: num(ev?.endBeat, num(ev?.startBeat, 0)),
    start: num(ev?.start, 0),
    end: num(ev?.end, 0),
  };
  const hasEasing = ev?.easingFn || ev?.easingType !== undefined || ev?.bezierPoints;
  if (hasEasing) {
    out.easingType = Math.trunc(num(ev?.easingPreset ?? ev?.easingType, 1));
    out.easingLeft = num(ev?.easingLeft, 0);
    out.easingRight = num(ev?.easingRight, 1);
    out.bezierPoints = Array.isArray(ev?.bezierPoints) && ev.bezierPoints.length === 4 ? ev.bezierPoints.map((v) => num(v, 0)) : null;
  }
  if (ev?.linkgroup !== undefined) out.linkgroup = num(ev.linkgroup, 0);
  return out;
}

/** 项目事件 -> 内部模型事件（**反序列化的核心**：把缓动函数重新建出来） */
export function eventFromProject(src, fallbackEasing = true) {
  const out = {
    startBeat: num(src?.startBeat, 0),
    endBeat: num(src?.endBeat, num(src?.startBeat, 0)),
    start: num(src?.start, 0),
    end: num(src?.end, 0),
  };
  const type = num(src?.easingPreset ?? src?.easingType, fallbackEasing ? 1 : num(src?.easingType, 1));
  const points = Array.isArray(src?.bezierPoints) && src.bezierPoints.length === 4 ? src.bezierPoints.map((v) => num(v, 0)) : null;
  const easingFn = makeEasing(type, points, num(src?.easingLeft, 0), num(src?.easingRight, 1));
  out.easingFn = easingFn;
  out.easingType = easingFn.easingType;
  out.easingPreset = easingFn.easingPreset;
  out.bezierPoints = easingFn.bezierPoints;
  out.easingLeft = easingFn.easingLeft;
  out.easingRight = easingFn.easingRight;
  if (src?.linkgroup !== undefined) out.linkgroup = num(src.linkgroup, 0);
  return out;
}

// ───────────────────────── 扩展（故事板）事件 ─────────────────────────
// 扩展事件不分层、每条线每键一份（`line.extended` 是已实现的 scaleX/scaleY/color/z/theta 的规范事件，
// `line.extendedRaw` 是未实现键的原样数据）。项目格式两者都要存，否则重新打开会丢故事板。
// 谱面相机（`chart.camera`）同构但属于整张谱面，见下面的 cameraToProject / cameraFromProject。

/** 扩展事件的值：颜色是 `[r,g,b]`，其余是数值 */
const extendedValueToProject = (key, value, fallback) => (key === 'color' ? normalizeColor(value) : num(value, fallback));

/** 规范扩展事件 -> 项目事件（时间与缓动字段复用 eventToProject） */
function extendedToProject(key, ev) {
  const out = eventToProject({ ...ev, start: 0, end: 0 });
  const def = EXTENDED_DEFAULTS[key] ?? 0;
  out.start = extendedValueToProject(key, ev?.start, def);
  out.end = extendedValueToProject(key, ev?.end, def);
  return out;
}

/** 项目事件 -> 规范扩展事件（反序列化时把缓动函数重建出来） */
export function extendedFromProject(key, src) {
  const out = eventFromProject({ ...src, start: 0, end: 0 });
  const def = EXTENDED_DEFAULTS[key] ?? 0;
  out.start = extendedValueToProject(key, src?.start, def);
  out.end = extendedValueToProject(key, src?.end, def);
  return out;
}

/**
 * 谱面相机（谱面级关键帧，`chart.camera`）：项目文件里存 `chart.camera`，
 * 与扩展事件同构（拍值 + 起止值 + 缓动参数），因此直接复用 `extendedToProject` / `extendedFromProject`。
 * 关键帧的**值**按内部规范单位存（x 画面宽比例、y/z 画面高比例、angle 弧度），见 units.js 的 CAMERA_KEYS。
 */
function cameraToProject(chart) {
  const out = {};
  for (const key of CAMERA_KEYS) {
    const list = asArray(chart?.camera?.[key]).filter(isObj);
    if (!list.length) continue;
    out[key] = list.map((e) => extendedToProject(key, e));
  }
  return Object.keys(out).length ? out : null;
}

/** 项目文件 -> 谱面相机关键帧（重建缓动函数）；兼容早期版本的 `focal`（焦距 → 等价视角） */
export function cameraFromProject(src) {
  const out = {};
  if (!isObj(src)) return out;
  for (const key of CAMERA_KEYS) {
    const list = asArray(src[key]).filter(isObj);
    if (!list.length) continue;
    out[key] = list
      .slice()
      .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0))
      .map((e) => extendedFromProject(key, e));
  }
  const legacyFocal = asArray(src.focal).filter(isObj);
  if (!out.angle?.length && legacyFocal.length) {
    out.angle = legacyFocal
      .slice()
      .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0))
      .map((e) =>
        extendedFromProject('angle', {
          ...e,
          start: focalToAngle(num(e.start, 1)),
          end: focalToAngle(num(e.end, 1)),
        }),
      );
  }
  return out;
}

/** 内部模型音符 -> 项目音符（源对象 + 原始字段，导出时用得到） */
function noteToProject(src) {
  const out = {};
  for (const key of NOTE_KEYS) if (src?.[key] !== undefined) out[key] = src[key];
  out.type = str(src?.type, 'tap');
  out.startBeat = num(src?.startBeat, 0);
  out.endBeat = num(src?.endBeat, num(src?.startBeat, 0));
  if (isObj(src?.raw)) out.raw = src.raw;
  return out;
}

/** 项目音符 -> 内部模型音符（与解析器产出的源音符同构） */
export function noteFromProject(src) {
  const visibleRaw = num(src?.visibleTime, Infinity);
  return {
    type: str(src?.type, 'tap'),
    startBeat: num(src?.startBeat, 0),
    endBeat: num(src?.endBeat, num(src?.startBeat, 0)),
    positionX: num(src?.positionX, 0, { min: -1e5, max: 1e5 }),
    above: src?.above === undefined ? true : !!src.above,
    speed: num(src?.speed, 1, { min: -1e3, max: 1e3 }),
    alpha: num(src?.alpha, 1, { min: 0, max: 1 }),
    size: positive(src?.size, 1, { max: 100 }),
    yOffset: num(src?.yOffset, 0, { min: -1e5, max: 1e5 }),
    visibleTime: visibleRaw >= 0 && visibleRaw < 1e5 ? visibleRaw : Infinity,
    isFake: src?.isFake === true || num(src?.isFake, 0) === 1,
    hitsound: str(src?.hitsound),
    tint: src?.tint ?? null,
    judgeArea: num(src?.judgeArea, 1),
    // 缺省 = 非独立（跟随判定线速度）：与解析器/RPE 口径一致，也让老项目文件行为不变
    holdSpeed: src?.holdSpeed === 'own' ? 'own' : 'line',
    raw: isObj(src?.raw) ? src.raw : undefined,
  };
}

/**
 * 内部模型 -> 项目文件对象（**序列化**）。
 * @param {object} chart 解析/编辑后的谱面模型
 * @param {{savedAt?:string}} [opts]
 * @returns {{json:object, warnings:string[], stats:object}}
 */
export function serializeProject(chart, opts = {}) {
  if (!chart || !Array.isArray(chart.lines)) throw new Error('serializeProject 需要解析后的谱面模型（含 lines 数组）');
  const warnings = [];
  const lines = [];
  let notes = 0;
  let events = 0;
  const camera = cameraToProject(chart);
  for (const key of CAMERA_KEYS) events += asArray(camera?.[key]).length;

  for (const line of chart.lines) {
    if (!isObj(line)) continue;
    const layers = asArray(line.layers)
      .filter(isObj)
      .map((layer) => {
        const out = {};
        for (const key of LAYER_KEYS) {
          const list = asArray(layer[key]).filter(isObj);
          if (!list.length) continue;
          out[key] = list.map(eventToProject);
          events += out[key].length;
        }
        return out;
      });
    const sourceNotes = asArray(line.notes).length ? line.notes : asArray(line.rt?.notes).map((n) => n?.src ?? n);
    const outNotes = sourceNotes.filter(isObj).map(noteToProject);
    notes += outNotes.length;

    // 未建模、但导出时要原样写回的判定线字段（RPE 的 *Control / anchor / attachUI 等）
    const raw = isObj(line.raw) ? line.raw : null;
    const extras = {};
    if (raw) for (const key of RPE_LINE_EXTRA_KEYS) if (raw[key] !== undefined) extras[key] = raw[key];

    // 扩展（故事板）事件：已实现的键写规范事件，未实现的键原样存
    const extendedOut = {};
    for (const key of EXTENDED_KEYS) {
      const list = asArray(line.extended?.[key]).filter(isObj);
      if (!list.length) continue;
      extendedOut[key] = list.map((e) => extendedToProject(key, e));
      events += extendedOut[key].length;
    }
    const extendedRaw = isObj(line.extendedRaw) ? line.extendedRaw : null;

    lines.push({
      id: int(line.id, lines.length),
      name: str(line.name),
      group: int(line.group, 0),
      groupName: str(line.groupName),
      zOrder: int(line.zOrder, 0),
      isCover: !!line.isCover,
      texture: str(line.texture),
      isGif: !!line.isGif,
      father: int(line.father, -1),
      rotateWithFather: !!line.rotateWithFather,
      bpm: num(line.bpm, 0),
      bpmFactor: positive(line.bpmFactor, 1, { max: 1e4 }),
      bpmList: asArray(line.bpmList).filter(isObj).map((e) => ({ beat: num(e.beat, 0), bpm: num(e.bpm, 120) })),
      extended: Object.keys(extendedOut).length ? extendedOut : null,
      extendedRaw,
      extras,
      layers,
      notes: outNotes,
    });
  }

  const json = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    generator: PROJECT_GENERATOR,
    savedAt: opts.savedAt ?? new Date().toISOString(),
    sourceFormat: chart.format === 'rpe' ? 'rpe' : chart.format === 'official' ? 'official' : 'unknown',
    chart: {
      format: chart.format ?? 'unknown',
      source: isObj(chart.source) ? { ...chart.source } : {},
      meta: { ...(chart.meta ?? {}) },
      timing: {
        bpmList: asArray(chart.timing?.bpmList).filter(isObj).map((e) => ({ beat: num(e.beat, 0), bpm: num(e.bpm, 120) })),
        bpmFactor: positive(chart.timing?.bpmFactor, 1, { max: 1e4 }),
      },
      rootExtras: isObj(chart.rootExtras) ? chart.rootExtras : undefined,
      // 谱面相机（谱面级关键帧；没有就用 null，读回来是默认视图）
      camera,
      cameraRaw: isObj(chart.cameraRaw) ? chart.cameraRaw : undefined,
      extendedKeys: asArray(chart.extendedKeys),
      lines,
    },
  };

  if (!lines.length) warnings.push('谱面没有任何判定线，项目文件里只有空的 lines 数组');
  return { json, warnings, stats: { lines: lines.length, notes, events } };
}

/**
 * 项目文件对象 -> 内部模型（**反序列化**）。
 *
 * 与解析器一样「脏数据不抛异常」：字段缺失/类型不对时取缺省值并记一条告警；
 * 只有「根本不是项目文件」才抛错。
 *
 * @param {object} json 项目文件内容
 * @param {{file?:string, diagnostics?:object}} [opts]
 * @returns {object} 可交给 prepareChart 的谱面模型
 */
export function parseProject(json, options = {}) {
  const diag = options.diagnostics ?? null;
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    diag?.warn?.(msg);
  };
  if (!isObj(json) || (json.format ?? json.phichartProject) !== PROJECT_FORMAT) {
    throw new Error('不是 PhiChart Editor 项目文件（缺少 format: "phichart-project"）');
  }
  const version = num(json.version, 0);
  if (version > PROJECT_VERSION) warn(`项目文件版本 ${version} 高于本编辑器支持的 ${PROJECT_VERSION}，多余字段会被忽略`);
  const src = isObj(json.chart) ? json.chart : {};
  const sourceFormat = str(json.sourceFormat, src.format ?? 'unknown');

  const chart = createChart({
    format: src.format === 'rpe' || src.format === 'official' ? src.format : 'unknown',
    // 记住「这是从项目文件恢复的」以及它原本来自哪种格式 —— 导出页据此给建议
    source: { ...(isObj(src.source) ? src.source : {}), projectVersion: version, sourceFormat },
    warnings,
    diagnostics: diag ? { summary: diag.summary } : undefined,
    timing: {
      bpmList: asArray(src.timing?.bpmList)
        .filter(isObj)
        .map((e) => ({ beat: num(e.beat, 0), bpm: num(e.bpm, 120) }))
        .sort((a, b) => a.beat - b.beat),
      bpmFactor: positive(src.timing?.bpmFactor, 1, { max: 1e4 }),
    },
    meta: {
      name: str(src.meta?.name),
      composer: str(src.meta?.composer),
      charter: str(src.meta?.charter),
      illustrator: str(src.meta?.illustrator),
      level: str(src.meta?.level),
      id: str(src.meta?.id),
      song: str(src.meta?.song),
      background: str(src.meta?.background),
      offset: num(src.meta?.offset, 0, { min: -36e5, max: 36e5 }), // 内部单位：秒（项目文件与模型一致）
      speedMultiplier: num(src.meta?.speedMultiplier, DEFAULT_SPEED_MULTIPLIER, { min: 0, max: SPEED_MULTIPLIER_MAX }),
    },
    // 谱面相机（谱面级关键帧；缓动函数在 cameraFromProject 里重建）
    camera: cameraFromProject(src.camera),
  });
  if (!chart.timing.bpmList.length) {
    chart.timing.bpmList.push({ beat: 0, bpm: 120 });
    warn('项目文件里没有 BPMList，已按 120 BPM 处理');
  }
  chart.rootExtras = isObj(src.rootExtras) ? src.rootExtras : undefined;
  chart.cameraRaw = isObj(src.cameraRaw) ? src.cameraRaw : null;
  chart.extendedKeys = asArray(src.extendedKeys).map(String);
  chart.metaSources = { name: '项目文件' };

  asArray(src.lines).forEach((rawLine, index) => {
    if (!isObj(rawLine)) {
      warn(`项目文件第 ${index} 条判定线不是对象，已忽略`);
      return;
    }
    const layers = asArray(rawLine.layers)
      .filter(isObj)
      .map((layer) => {
        const out = {};
        for (const key of LAYER_KEYS) {
          const list = asArray(layer[key]);
          if (!list.length) continue;
          out[key] =
            key === 'speed'
              ? list.filter(isObj).map((e) => ({ startBeat: num(e?.startBeat, 0), endBeat: num(e?.endBeat, num(e?.startBeat, 0)), start: num(e?.start, 1), end: num(e?.end, 1) }))
              : list.filter(isObj).map((e) => eventFromProject(e));
        }
        return out;
      });
    const notes = asArray(rawLine.notes).filter(isObj).map(noteFromProject).sort((a, b) => a.startBeat - b.startBeat);

    // raw 只放「未建模字段」：导出 RPE 时 `collectLineExtras()` 会从这里取回
    const raw = { ...(isObj(rawLine.extras) ? rawLine.extras : {}) };

    // 扩展（故事板）事件：已实现的键重建缓动函数，未实现的键原样恢复
    const extended = {};
    for (const key of EXTENDED_KEYS) {
      const list = asArray(rawLine.extended?.[key]).filter(isObj);
      if (!list.length) continue;
      extended[key] = list.sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0)).map((e) => extendedFromProject(key, e));
    }

    chart.lines.push({
      id: int(rawLine.id, index),
      name: str(rawLine.name, `Line ${index}`),
      group: int(rawLine.group, 0),
      groupName: str(rawLine.groupName),
      zOrder: int(rawLine.zOrder, 0),
      isCover: !!rawLine.isCover,
      texture: str(rawLine.texture, 'line.png'),
      isGif: !!rawLine.isGif,
      father: int(rawLine.father, -1),
      rotateWithFather: !!rawLine.rotateWithFather,
      bpm: num(rawLine.bpm, 0),
      bpmFactor: positive(rawLine.bpmFactor, 1, { max: 1e4 }),
      bpmList: asArray(rawLine.bpmList).filter(isObj).map((e) => ({ beat: num(e.beat, 0), bpm: num(e.bpm, 120) })),
      layers,
      notes,
      extended: Object.keys(extended).length ? extended : null,
      extendedRaw: isObj(rawLine.extendedRaw) ? rawLine.extendedRaw : null,
      raw,
    });
  });

  if (!chart.lines.length) warn('项目文件里没有任何判定线');
  return chart;
}

/** 新建项目时事件覆盖到多远的将来（拍）：足够大即可，语义等同解析器里的哨兵 */
const BLANK_SENTINEL_BEAT = 1e6;

/**
 * **新建空项目**：返回**项目文件对象**（与 `serializeProject()` 同构），
 * 直接丢给 `parseProject()` / `preview.loadJson()` 即可载入。
 *
 * 生成的内容：N 条判定线，每条 1 个事件层，5 类事件各一条从 0 覆盖到远未来的常量事件
 * （位移=画面中心、旋转=0、**不透明度=1（可见）**、速度=1 Y/s），没有音符 ——
 * 于是新项目一进来就是「干净的、可见的、可以直接往上放音符」的状态。
 *
 * @param {{meta?:object, bpm?:number, lines?:number, savedAt?:string}} [opts]
 */
export function createBlankProject(opts = {}) {
  const bpm = positive(opts.bpm, 174, { max: 1000 });
  const lineCount = Math.max(1, Math.min(200, Math.trunc(num(opts.lines, 4, { min: 1, max: 200 })) || 4));
  const src = isObj(opts.meta) ? opts.meta : {};
  const meta = {
    name: str(src.name),
    composer: str(src.composer),
    charter: str(src.charter),
    illustrator: str(src.illustrator),
    level: str(src.level),
    id: str(src.id),
    song: str(src.song),
    background: str(src.background),
    offset: num(src.offset, 0, { min: -3600, max: 3600 }), // 秒
    speedMultiplier: num(src.speedMultiplier, DEFAULT_SPEED_MULTIPLIER, { min: 0, max: SPEED_MULTIPLIER_MAX }),
  };
  const flat = (value) => ({ startBeat: 0, endBeat: BLANK_SENTINEL_BEAT, start: value, end: value });
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push({
      id: i,
      name: `Line ${i}`,
      group: 0,
      groupName: 'Default',
      zOrder: 0,
      isCover: false,
      texture: 'line.png',
      isGif: false,
      father: -1,
      rotateWithFather: false,
      bpm,
      bpmFactor: 1,
      bpmList: [{ beat: 0, bpm }],
      extended: null,
      extras: {},
      // 五类事件各一条常量事件：x/y/rotate = 0（画面中心）、alpha = 1（看得见）、speed = 1 Y/s
      layers: [{ x: [flat(0)], y: [flat(0)], rotate: [flat(0)], alpha: [flat(1)], speed: [flat(1)] }],
      notes: [],
    });
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    generator: PROJECT_GENERATOR,
    savedAt: opts.savedAt ?? new Date().toISOString(),
    sourceFormat: 'unknown',
    chart: {
      format: 'project',
      source: { sourceFormat: 'unknown' },
      meta,
      timing: { bpmList: [{ beat: 0, bpm }], bpmFactor: 1 },
      camera: null,
      extendedKeys: [],
      lines,
    },
  };
}
