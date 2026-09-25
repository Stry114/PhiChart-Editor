/**
 * RPE 格式**写出**：内部统一模型 -> RPE 谱面 JSON。依据 `docs/Phigros文档.md`。
 *
 * 与官方格式相反，RPE 几乎能表达内部模型的全部内容（事件层、缓动、贝塞尔、扩展事件），
 * 所以这里的原则是**尽量无损**：
 *  - 事件层原样写回（层内没有的事件不写该字段，与 RPE 自己的写法一致）；
 *  - 缓动写成 `easingType / easingLeft / easingRight / bezier / bezierPoints`（内部是函数，不能直接 JSON 化）；
 *  - 音符以解析时保留的 `note.raw` 为底，只覆盖模型改过的字段 —— 于是 `tint / hitsound / judgeArea /
 *    tintHitEffects` 以及本版本未实现的字段都能原样回到文件里；
 *  - 判定线上未建模的字段（`anchor`、`attachUI`、各 `*Control`）与 `extended`（故事板事件）原样保留。
 *
 * 时间一律走 `beatToRpe()` 还原成 `[整数, 分子, 分母]`，1/32 拍这类编辑器常用刻度能精确写回。
 */
import { RPE, RPE_SPEED_TO_YPS, RPE_X_TO_X, RPE_Y_TO_Y, RPE_TYPE_CODE, CAMERA_DEFAULTS, CAMERA_KEYS, CAMERA_LEGACY_FOCAL_FIELD, CAMERA_RPE_FIELD, CAMERA_RPE_ROOT, CAMERA_VALUE_OUT, EXTENDED_KEYS, EXTENDED_KEYS_UNSUPPORTED, EXTENDED_RPE_FIELD, EXTENDED_DEFAULTS, clamp } from './units.js';
import { normalizeColor } from './events.js';
import { asArray, isObj, num, positive, str } from './sanitize.js';
import { beatToRpe, round6 } from './serialize-common.js';

/** RPE 判定线上「本版本未建模、但要原样保留」的字段 */
export const RPE_LINE_EXTRA_KEYS = ['anchor', 'attachUI', 'posControl', 'sizeControl', 'skewControl', 'yControl', 'alphaControl'];
/** 事件层里的事件类型（也是 `extended` 之外的全部事件类型） */
const LAYER_KEYS = [
  ['x', 'moveXEvents'],
  ['y', 'moveYEvents'],
  ['rotate', 'rotateEvents'],
  ['alpha', 'alphaEvents'],
  ['speed', 'speedEvents'],
];
/** 每层最多 5 层（RPE 限制，docs/Phigros文档.md 的 RPE 判定线） */
export const RPE_MAX_LAYERS = 5;
export const DEFAULT_RPE_VERSION = 140;

/** 判定线上的未建模字段（从解析时保留的 raw 里取） */
export function collectLineExtras(line) {
  const raw = isObj(line?.raw) ? line.raw : null;
  const out = {};
  if (!raw) return out;
  for (const key of RPE_LINE_EXTRA_KEYS) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

const toRpeX = (v) => round6(num(v, 0) / RPE_X_TO_X); // 内部（官方 X 单位）-> RPE 长度单位
const toRpeY = (v) => round6(num(v, 0) / RPE_Y_TO_Y); // 内部（官方 Y 单位）-> RPE 长度单位
const toRpeCenterX = (v) => round6(num(v, 0) * RPE.WIDTH);
const toRpeCenterY = (v) => round6(num(v, 0) * RPE.HEIGHT);
const toRpeRotate = (rad) => round6((-num(rad, 0) * 180) / Math.PI); // 内部逆时针为正 -> RPE 顺时针为正
const toRpeSpeed = (v) => round6(num(v, 1) / RPE_SPEED_TO_YPS);
const toRpeAlpha = (v) => Math.round(clamp(num(v, 1), 0, 1) * 255);
/** alpha 是否会被 0–255 的整数精度量化（官方谱的 alpha 是 0..1 浮点，RPE 是整数） */
const alphaLosesPrecision = (v) => {
  const x = clamp(num(v, 1), 0, 1) * 255;
  return Math.abs(Math.round(x) - x) > 1e-6;
};

/** 事件值 -> RPE 数值 */
function convertValue(key, value) {
  switch (key) {
    case 'x':
      return toRpeCenterX(value);
    case 'y':
      return toRpeCenterY(value);
    case 'rotate':
      return toRpeRotate(value);
    case 'alpha':
      return toRpeAlpha(value);
    case 'speed':
      return toRpeSpeed(value);
    default:
      return round6(num(value, 0));
  }
}

/** 一个模型事件 -> RPE 事件对象（速度事件没有缓动字段，docs/Phigros文档.md 的 RPE 速度事件） */
export function eventToRpe(key, ev) {
  const out = {
    startTime: beatToRpe(num(ev?.startBeat, 0)),
    endTime: beatToRpe(num(ev?.endBeat, num(ev?.startBeat, 0))),
    start: convertValue(key, ev?.start),
    end: convertValue(key, ev?.end),
  };
  if (key !== 'speed') {
    const bezierPoints = Array.isArray(ev?.bezierPoints) && ev.bezierPoints.length === 4 ? ev.bezierPoints.map((v) => round6(num(v, 0))) : null;
    out.easingType = Math.trunc(num(ev?.easingPreset ?? ev?.easingType, 1));
    out.easingLeft = round6(num(ev?.easingLeft, 0));
    out.easingRight = round6(num(ev?.easingRight, 1));
    out.bezier = bezierPoints ? 1 : 0;
    out.bezierPoints = bezierPoints ?? [0, 0, 0, 0];
  }
  if (ev?.linkgroup !== undefined) out.linkgroup = num(ev.linkgroup, 0);
  return out;
}

/** 扩展事件的值 -> RPE 值：颜色写 `[r,g,b]`；`z` 写长度单位、`theta` 写角度制，其余写数值 */
const EXTENDED_VALUE_OUT = {
  z: (v) => round6(v * RPE.HEIGHT), // 内部「画面高比例」→ RPE 长度单位（900 = 一个画面高）
  theta: (v) => round6((v * 180) / Math.PI), // 内部弧度 → 角度制（不取反：都是「往屏幕内为正」）
};

function extendedValueToRpe(key, value) {
  if (key === 'color') return normalizeColor(value);
  const raw = num(value, EXTENDED_DEFAULTS[key] ?? 0);
  return EXTENDED_VALUE_OUT[key] ? EXTENDED_VALUE_OUT[key](raw) : round6(raw);
}

/** 一个规范扩展事件 -> RPE 事件对象（字段与普通事件相同，只是挂在 `extended.<键>Events` 下） */
export function extendedEventToRpe(key, ev) {
  const bezierPoints = Array.isArray(ev?.bezierPoints) && ev.bezierPoints.length === 4 ? ev.bezierPoints.map((v) => round6(num(v, 0))) : null;
  return {
    startTime: beatToRpe(num(ev?.startBeat, 0)),
    endTime: beatToRpe(num(ev?.endBeat, num(ev?.startBeat, 0))),
    start: extendedValueToRpe(key, ev?.start),
    end: extendedValueToRpe(key, ev?.end),
    easingType: Math.trunc(num(ev?.easingPreset ?? ev?.easingType, 1)),
    easingLeft: round6(num(ev?.easingLeft, 0)),
    easingRight: round6(num(ev?.easingRight, 1)),
    bezier: bezierPoints ? 1 : 0,
    bezierPoints: bezierPoints ?? [0, 0, 0, 0],
  };
}

/**
 * 判定线的 `extended`：
 *  - 已实现的键（scaleX / scaleY / color / z / theta）从**规范模型**写（编辑器改过也生效）；
 *  - 未实现的键（incline / text / paint / gif）从解析时保留的 `extendedRaw` **原样写回**；
 *  - 模型里已经删空的键不写出（避免把陈旧的原数据留在文件里）。
 */
export function collectExtended(line) {
  const out = isObj(line?.extendedRaw) ? { ...line.extendedRaw } : {};
  for (const key of EXTENDED_KEYS) {
    const field = EXTENDED_RPE_FIELD[key];
    const list = asArray(line?.extended?.[key]).filter(isObj);
    if (!list.length) {
      delete out[field];
      continue;
    }
    out[field] = list
      .slice()
      .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0))
      .map((e) => extendedEventToRpe(key, e));
  }
  return out;
}

/** 相机通道的值 -> RPE 数值（x / y / z 用长度单位；angle 用角度制） */
function cameraValueToRpe(key, value) {
  const raw = num(value, CAMERA_DEFAULTS[key] ?? 0);
  return CAMERA_VALUE_OUT[key] ? round6(CAMERA_VALUE_OUT[key](raw)) : round6(raw);
}

/**
 * 谱面相机 -> RPE 根节点的 `camera` 对象（本项目的自有扩展，RPE 与其它工具会忽略它）。
 * 与 `collectExtended` 同样的取舍：模型里删空的通道不写出，但不认识的字段原样保留。
 * 旧版的 `focalEvents`（焦距）不写回 —— 解析时已经换算成角度制的 `angleEvents`。
 * @returns {object|null} 没有任何相机关键帧时返回 null（不写这个键）
 */
export function collectCamera(chart) {
  const raw = isObj(chart?.cameraRaw) ? chart.cameraRaw : {};
  const out = {};
  const known = [...Object.values(CAMERA_RPE_FIELD), CAMERA_LEGACY_FOCAL_FIELD];
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) out[k] = v;
  let count = 0;
  for (const key of CAMERA_KEYS) {
    const list = asArray(chart?.camera?.[key]).filter(isObj);
    if (!list.length) continue;
    count += list.length;
    out[CAMERA_RPE_FIELD[key]] = list
      .slice()
      .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0))
      .map((e) => ({
        startTime: beatToRpe(num(e.startBeat, 0)),
        endTime: beatToRpe(num(e.endBeat, num(e.startBeat, 0))),
        start: cameraValueToRpe(key, e.start),
        end: cameraValueToRpe(key, e.end),
        easingType: Math.trunc(num(e.easingPreset ?? e.easingType, 1)),
        easingLeft: round6(num(e.easingLeft, 0)),
        easingRight: round6(num(e.easingRight, 1)),
        bezier: Array.isArray(e.bezierPoints) && e.bezierPoints.length === 4 ? 1 : 0,
        bezierPoints:
          Array.isArray(e.bezierPoints) && e.bezierPoints.length === 4 ? e.bezierPoints.map((v) => round6(num(v, 0))) : [0, 0, 0, 0],
      }));
  }
  if (!count && !Object.keys(out).length) return null;
  return out;
}

/** 一个模型音符 -> RPE 音符对象（以 `note.raw` 为底，保留未建模字段） */export function noteToRpe(note) {
  const startBeat = num(note?.startBeat, 0);
  const endBeat = num(note?.endBeat, startBeat);
  const out = {
    type: RPE_TYPE_CODE[note?.type] ?? 1,
    startTime: beatToRpe(startBeat),
    endTime: beatToRpe(Math.max(endBeat, startBeat)),
    positionX: toRpeX(note?.positionX),
    above: note?.above ? 1 : 2,
    isFake: note?.isFake ? 1 : 0,
    speed: round6(num(note?.speed, 1)),
    size: round6(positive(note?.size, 1, { max: 100 })),
    yOffset: toRpeY(note?.yOffset),
    visibleTime: Number.isFinite(note?.visibleTime) ? round6(note.visibleTime) : 999999,
    alpha: toRpeAlpha(note?.alpha),
  };
  const raw = isObj(note?.raw) ? note.raw : null;
  if (raw) for (const [k, v] of Object.entries(raw)) if (!(k in out)) out[k] = v; // tint / hitsound / judgeArea / tintHitEffects …
  return out;
}

/**
 * 内部模型 -> RPE 谱面 JSON。
 * @param {object} chart 解析后的谱面模型
 * @param {{meta?:object, rpeVersion?:number, xybind?:boolean}} [opts]
 * @returns {{json:object, warnings:string[], stats:object}}
 */
export function serializeRpe(chart, opts = {}) {
  if (!chart || !Array.isArray(chart.lines)) throw new Error('serializeRpe 需要解析后的谱面模型（含 lines 数组）');
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const meta = opts.meta ?? chart?.meta ?? {};
  const chartMeta = chart?.meta ?? {};
  const rpeVersion = Math.trunc(num(opts.rpeVersion ?? chart?.source?.rpeVersion, DEFAULT_RPE_VERSION)) || DEFAULT_RPE_VERSION;

  const bpmList = asArray(chart.timing?.bpmList).filter(isObj);
  const outBpmList = (bpmList.length ? bpmList : [{ beat: 0, bpm: 120 }]).map((e) => ({
    startTime: beatToRpe(num(e.beat, 0)),
    bpm: round6(num(e.bpm, 120)),
  }));
  const usedBpm = num(outBpmList[0]?.bpm, 120);
  if (!(usedBpm > 0)) warn('BPMList 非法（首条 BPM ≤ 0），RPE 会把它当异常谱面处理');

  const judgeLineList = [];
  const lines = asArray(chart.lines);
  let alphaRounded = 0;
  lines.forEach((line, index) => {
    if (!isObj(line)) return;
    const layers = asArray(line.layers).filter(isObj);
    if (layers.length > RPE_MAX_LAYERS) {
      warn(`判定线 ${index} 有 ${layers.length} 个事件层，RPE 最多 ${RPE_MAX_LAYERS} 层，第 ${RPE_MAX_LAYERS + 1} 层起会被 RPE 忽略`);
    }
    for (const layer of layers) for (const e of asArray(layer.alpha)) if (isObj(e) && (alphaLosesPrecision(e.start) || alphaLosesPrecision(e.end))) alphaRounded++;
    const eventLayers = layers.map((layer) => {
      const out = {};
      for (const [key, rpeKey] of LAYER_KEYS) {
        const events = asArray(layer[key]).filter(isObj);
        if (!events.length) continue; // RPE 里「层内没有这类事件」就是不写该字段
        out[rpeKey] = events
          .slice()
          .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0))
          .map((e) => eventToRpe(key, e));
      }
      return out;
    });

    const notes = asArray(line.notes)
      .filter(isObj)
      .slice()
      .sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0));
    for (const note of notes) if (alphaLosesPrecision(note.alpha)) alphaRounded++;
    const outNotes = notes.map(noteToRpe);
    const numOfNotes = notes.reduce((n, note) => (note.type === 'hold' ? n : n + 1), 0); // RPE 口径：含假音符、不含 Hold

    const out = {
      Group: Math.trunc(num(line.group, 0)),
      Name: str(line.name) || `Line ${index}`,
      Texture: str(line.texture) || 'line.png',
    };
    if (eventLayers.length) out.eventLayers = eventLayers;
    const extendedOut = collectExtended(line);
    if (Object.keys(extendedOut).length) out.extended = extendedOut;
    Object.assign(out, collectLineExtras(line));
    out.father = Math.trunc(num(line.father, -1));
    out.rotateWithFather = !!line.rotateWithFather;
    out.isCover = line.isCover ? 1 : 0;
    out.notes = outNotes;
    out.numOfNotes = numOfNotes;
    out.zOrder = Math.trunc(num(line.zOrder, 0));
    out.bpmfactor = round6(positive(line.bpmFactor, 1, { max: 1e4 }));
    judgeLineList.push(out);
  });

  // 判定线分组名：保留原有分组表，并补上模型里出现过的组名
  const groupNames = asArray(chart.rootExtras?.judgeLineGroup).map(String).filter(Boolean);
  for (const line of lines) {
    const name = str(line?.groupName);
    if (name && !groupNames.includes(name)) groupNames.push(name);
  }
  if (!groupNames.length) groupNames.push('Default');

  const json = {
    BPMList: outBpmList,
    META: {
      RPEVersion: rpeVersion,
      background: str(meta.background),
      charter: str(meta.charter),
      composer: str(meta.composer),
      id: str(meta.id),
      level: str(meta.level),
      name: str(meta.name),
      offset: Math.round(num(meta.offset, 0) * 1000), // RPE 的 offset 单位是毫秒
      song: str(meta.song),
      illustration: str(meta.illustrator),
    },
    judgeLineGroup: groupNames,
    judgeLineList,
    multiLineString: str(chart.rootExtras?.multiLineString, 'all') || 'all',
    multiScale: num(chart.rootExtras?.multiScale, 1),
  };
  if (chart.rootExtras?.chartTime !== undefined) json.chartTime = num(chart.rootExtras.chartTime, 0);
  if (Array.isArray(chart.rootExtras?.timeTags)) json.timeTags = chart.rootExtras.timeTags;
  // 谱面相机（本项目的自有扩展）：写在根节点，RPE 与其它工具会忽略它
  const cameraOut = collectCamera(chart);
  if (cameraOut) json[CAMERA_RPE_ROOT] = cameraOut;
  if (opts.xybind ?? chart.source?.xybind) json.xybind = true;

  if (chart.format === 'official') {
    warn('源谱面是官方格式：事件已按 RPE 的单位/方向换算（旋转取反、alpha 换成 0–255、速度 ×4.5），缓动恒为线性');
  }
  if (alphaRounded) {
    warn(`有 ${alphaRounded} 条 alpha 事件不是 1/255 的整数倍，RPE 的 alpha 是 0–255 整数，已四舍五入（透明度误差 ≤ 1/255）`);
  }
  if (!chartMeta.name) warn('元数据里没有曲名（RPE 的 META.name 会写成空串）');
  const unsupportedFields = EXTENDED_KEYS_UNSUPPORTED.map((k) => EXTENDED_RPE_FIELD[k]);
  const unsupported = asArray(chart.extendedKeys).filter((f) => unsupportedFields.includes(f));
  if (unsupported.length) warn(`谱面含未实现的扩展事件（${unsupported.join('、')}）：已原样写回，但本编辑器不渲染它们`);
  const cameraCount = CAMERA_KEYS.reduce((n, k) => n + asArray(chart.camera?.[k]).length, 0);
  if (cameraCount) {
    warn(`谱面含 ${cameraCount} 条相机关键帧：已写到 RPE 根节点的 ${CAMERA_RPE_ROOT}（本项目的扩展，RPE 与其它工具会忽略它）`);
  }

  return {
    json,
    warnings,
    stats: {
      lines: judgeLineList.length,
      notes: judgeLineList.reduce((n, l) => n + l.notes.length, 0),
      numOfNotes: judgeLineList.reduce((n, l) => n + l.numOfNotes, 0),
      events: judgeLineList.reduce(
        (n, l) =>
          n +
          asArray(l.eventLayers).reduce((m, layer) => m + Object.values(layer).reduce((k, arr) => k + (Array.isArray(arr) ? arr.length : 0), 0), 0),
        0,
      ),
    },
  };
}
