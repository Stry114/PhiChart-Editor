/**
 * RPE 格式解析：JSON -> 内部统一模型。依据 docs/Phigros文档.md。
 * 健壮性策略见 docs/项目文档.md 的健壮性策略：脏数据取缺省值 + 诊断，不抛异常。
 *
 * v1 已支持：META/offset(ms)、BPMList 变速、bpmfactor、事件层相加、五种普通事件 + 29 种缓动 +
 * 自定义贝塞尔 + 缓动裁剪、四类音符及其 alpha/size/speed/yOffset/visibleTime/isFake/above、
 * 父子判定线、自定义判定线贴图路径、扩展（故事板）事件里的 scaleX / scaleY / color / z / theta，以及根节点的谱面相机 camera。
 * v1 **未实现**（保留原始字段、渲染时忽略）：扩展事件里的 incline / text / paint / gif、
 * 各 *Control、attachUI、isGif、hitsound 播放、tint/color 与 judgeArea。
 */
import {
  RPE,
  RPE_NOTE_TYPE,
  RPE_SPEED_TO_YPS,
  RPE_X_TO_X,
  RPE_Y_TO_Y,
  CAMERA_DEFAULTS,
  CAMERA_KEYS,
  CAMERA_RPE_FIELD,
  CAMERA_RPE_ROOT,
  CAMERA_VALUE_IN,
  EXTENDED_KEYS,
  EXTENDED_RPE_FIELD,
  EXTENDED_DEFAULTS,
  degToRad,
  rpeCenterOffsetX,
  rpeCenterOffsetY,
} from './units.js';
import { makeEasing } from './easing.js';
import { normalizeColor } from './events.js';
import { createChart } from './model.js';
import { rpeBeat } from './timing.js';
import { asArray, isObj, num, numChecked, int, positive, str } from './sanitize.js';

/** 各事件的「值」换算与缺省值：events 里缺字段时取缺省值（缺省值取「保持原样」的那一侧） */
const EVENT_SPECS = {
  x: { convert: rpeCenterOffsetX, def: 0 },
  y: { convert: rpeCenterOffsetY, def: 0 },
  rotate: { convert: (v) => -degToRad(v), def: 0 },
  alpha: { convert: (v) => v / 255, def: 255 }, // 缺值时按「不透明」，避免线整条消失
  speed: { convert: (v) => v * RPE_SPEED_TO_YPS, def: 1 },
};

/**
 * 扩展事件的值：颜色取 `[r,g,b]`；其余取数值，并按各自的单位换算成内部单位
 *  - `z`（moveZEvents）：RPE 长度单位（900 = 一个画面高）→ 内部「画面高比例」
 *  - `theta`（thetaEvents）：角度制 → 内部弧度（**不取反**：两者都是「往屏幕内为正」）
 */
const EXTENDED_VALUE_IN = {
  z: (v) => v / RPE.HEIGHT,
  theta: (v) => degToRad(v),
};

function readExtendedValue(key, rawValue) {
  if (key === 'color') return normalizeColor(rawValue);
  const raw = num(rawValue, EXTENDED_DEFAULTS[key] ?? 0);
  return EXTENDED_VALUE_IN[key] ? EXTENDED_VALUE_IN[key](raw) : raw;
}

/**
 * 相机通道的值：RPE 里一律是长度单位
 *  - `x`：1350 = 一个画面宽（内部「画面宽比例」）
 *  - `y` / `z` / `focal`：900 = 一个画面高（内部「画面高比例」）
 */
function readCameraValue(key, rawValue) {
  const raw = num(rawValue, CAMERA_DEFAULTS[key] ?? 0);
  return CAMERA_VALUE_IN[key] ? CAMERA_VALUE_IN[key](raw) : raw;
}

const easingOf = (evt, warnBad) => {
  const type = num(evt.easingType, 1);
  if (!Number.isFinite(type) || type < 0 || type > 29) warnBad('easingType');
  const left = num(evt.easingLeft, 0, { min: -10, max: 10 });
  const right = num(evt.easingRight, 1, { min: -10, max: 10 });
  let bezier = null;
  if (evt.bezier !== undefined && evt.bezier !== 0) {
    const pts = evt.bezierPoints;
    if (Array.isArray(pts) && pts.length >= 4 && pts.every((v) => Number.isFinite(Number(v)))) {
      bezier = pts;
    } else if (pts !== undefined) {
      warnBad('bezierPoints');
    }
  }
  return makeEasing(type, bezier, left, right);
};

export function parseRpeChart(json, options = {}) {
  const diag = options.diagnostics ?? null;
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    diag?.warn(msg);
  };
  if (!isObj(json)) throw new Error('RPE 谱面不是 JSON 对象（无法解析）');

  // 逐条重复的告警合并成一条（避免刷屏，也避免把重要告警挤出面板）
  const repeats = new Map();
  const warnRepeat = (key, label, detail) => {
    const entry = repeats.get(key) ?? { label, count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < 4) entry.samples.push(detail);
    repeats.set(key, entry);
  };
  const flushRepeats = () => {
    for (const { label, count, samples } of repeats.values()) {
      warn(`${label}（共 ${count} 条）：${samples.join('、')}${count > samples.length ? ' 等' : ''}`);
    }
  };

  const meta = isObj(json.META) ? json.META : json;

  if (json.BPMList !== undefined && !Array.isArray(json.BPMList)) warn('BPMList 不是数组，已忽略');
  const bpmList = asArray(json.BPMList)
    .filter((b, i) => {
      if (isObj(b)) return true;
      warnRepeat('bpmItem', 'BPMList 存在非法条目（已忽略）', `第 ${i} 条`);
      return false;
    })
    .map((b, i) => {
      const rawBpm = num(b.bpm, 120);
      const bpm = rawBpm > 0 ? rawBpm : 120;
      if (bpm !== rawBpm) warnRepeat('bpmBad', 'BPMList 存在非法 bpm（已按 120 处理）', `第 ${i} 条 bpm=${String(b.bpm)}`);
      return { beat: rpeBeat(b.startTime), bpm };
    })
    .sort((a, b) => a.beat - b.beat);
  if (!bpmList.length) {
    bpmList.push({ beat: 0, bpm: 120 });
    warn('BPMList 缺失或为空，按 120 BPM 处理');
  }

  const chart = createChart({
    format: 'rpe',
    source: {
      rpeVersion: num(meta.RPEVersion, 0),
      file: options.file ?? '',
      // XY 绑定：为 true 时每个 XEvent 必须有等长的 YEvent（docs/Phigros文档.md 的 RPE 根结构）。纠错会用它来措辞。
      xybind: json.xybind === true,
    },
    warnings,
    diagnostics: diag ? { summary: diag.summary } : undefined,
    timing: { bpmList, bpmFactor: 1 },
    meta: {
      name: str(meta.name),
      composer: str(meta.composer),
      charter: str(meta.charter),
      illustrator: str(meta.illustrator),
      level: str(meta.level),
      id: str(meta.id),
      song: str(meta.song),
      background: str(meta.background),
      offset: num(meta.offset, 0, { min: -36e5, max: 36e5 }) / 1000, // RPE 的 offset 单位是毫秒
    },
  });

  const groups = asArray(json.judgeLineGroup);
  const extendedKeys = new Set();
  let droppedNotes = 0;
  let droppedEvents = 0;

  // 编辑器不编辑、但导出时要原样写回的根字段（RPE 的编辑器视图状态类数据，docs/Phigros文档.md 的 RPE 根结构）
  chart.rootExtras = {
    multiLineString: str(json.multiLineString),
    multiScale: num(json.multiScale, 1),
    judgeLineGroup: asArray(json.judgeLineGroup).map(String),
    chartTime: json.chartTime,
    timeTags: Array.isArray(json.timeTags) ? json.timeTags : undefined,
  };

  if (json.judgeLineList !== undefined && !Array.isArray(json.judgeLineList)) {
    warn('judgeLineList 不是数组，已按空谱面处理');
  }

  // 谱面相机（本项目的自有扩展）：RPE **根节点**的 `camera`，字段是 xEvents / yEvents / zEvents /
  // focalEvents，与扩展事件同构（拍值 + 起止值 + 缓动）。RPE 自己与其它工具会忽略这个键；
  // 不认识的字段原样留在 `chart.cameraRaw` 里，导出时写回。单位见 units.js 的 CAMERA_KEYS。
  {
    const rawCamera = isObj(json[CAMERA_RPE_ROOT]) ? json[CAMERA_RPE_ROOT] : null;
    chart.cameraRaw = rawCamera ?? null;
    let count = 0;
    if (rawCamera) {
      for (const key of CAMERA_KEYS) {
        const list = asArray(rawCamera[CAMERA_RPE_FIELD[key]]).filter(isObj);
        if (!list.length) continue;
        const events = list
          .map((e) => {
            const startBeat = rpeBeat(e.startTime);
            let endBeat = rpeBeat(e.endTime);
            if (!Number.isFinite(endBeat) || endBeat < startBeat) endBeat = startBeat;
            const out = {
              startBeat,
              endBeat,
              start: readCameraValue(key, e.start),
              end: readCameraValue(key, e.end),
            };
            const easingFn = easingOf(e, (f) =>
              warnRepeat(`cam:${key}`, `相机 ${key} 通道的缓动字段非法（已按线性处理）`, `字段 ${f}`),
            );
            out.easingFn = easingFn;
            out.easingType = easingFn?.easingType ?? 1;
            out.easingPreset = easingFn?.easingPreset ?? 1;
            out.bezierPoints = easingFn?.bezierPoints ?? null;
            out.easingLeft = easingFn?.easingLeft ?? 0;
            out.easingRight = easingFn?.easingRight ?? 1;
            return out;
          })
          .sort((a, b) => a.startBeat - b.startBeat);
        chart.camera[key] = events;
        count += events.length;
      }
    }
    if (count) warn(`谱面含相机关键帧（${count} 条，本项目的扩展：RPE 根节点的 ${CAMERA_RPE_ROOT}）`);
  }

  asArray(json.judgeLineList).forEach((raw, index) => {
    if (!isObj(raw)) {
      warn(`判定线 ${index} 不是对象，已忽略`);
      return;
    }

    // ---- 事件层 ----
    const layerRaw = asArray(raw.eventLayers);
    const layers = layerRaw
      .filter((layer) => {
        if (isObj(layer)) return true;
        droppedEvents++;
        return false;
      })
      .map((layer) => {
        const mapList = (list, key) => {
          const spec = EVENT_SPECS[key];
          const bad = { fields: new Set(), count: 0 };
          const out = asArray(list)
            .filter((e) => {
              if (isObj(e)) return true;
              droppedEvents++;
              return false;
            })
            .map((e) => {
              const startBeat = rpeBeat(e.startTime);
              let endBeat = rpeBeat(e.endTime);
              if (!Number.isFinite(endBeat) || endBeat < startBeat) endBeat = startBeat;
              const s = numChecked(e.start, spec.def);
              const en = numChecked(e.end, spec.def);
              for (const [field, r] of [['start', s], ['end', en]]) {
                if (!r.ok) {
                  bad.count++;
                  if (bad.fields.size < 3) bad.fields.add(field);
                }
              }
              const out2 = {
                startBeat,
                endBeat,
                start: spec.convert(s.value),
                end: spec.convert(en.value),
              };
              if (key !== 'speed') {
                const easingFn = easingOf(e, (f) => {
                  bad.count++;
                  if (bad.fields.size < 3) bad.fields.add(f);
                });
                out2.easingFn = easingFn;
                // 把缓动信息也写成普通字段：序列化友好，时间轴也能显示「线性/缓动#N/贝塞尔」
                out2.easingType = easingFn?.easingType ?? 1;
                out2.easingPreset = easingFn?.easingPreset ?? 1;
                out2.bezierPoints = easingFn?.bezierPoints ?? null;
                out2.easingLeft = easingFn?.easingLeft ?? 0;
                out2.easingRight = easingFn?.easingRight ?? 1;
              }
              if (e.linkgroup) out2.linkgroup = e.linkgroup;
              return out2;
            });
          if (bad.count) {
            warnRepeat(`evt:${key}`, `${key} 事件存在非数值字段（已取缺省值）`, `线 ${index}：${[...bad.fields].join('、')}（${bad.count} 处）`);
          }
          return out;
        };
        return {
          x: mapList(layer.moveXEvents, 'x'),
          y: mapList(layer.moveYEvents, 'y'),
          rotate: mapList(layer.rotateEvents, 'rotate'),
          alpha: mapList(layer.alphaEvents, 'alpha'),
          speed: mapList(layer.speedEvents, 'speed'),
        };
      });
    if (!layers.length) warnRepeat('noLayers', '部分判定线没有事件层', `线 ${index}`);

    // ---- 扩展（故事板）事件 ----
    // 扩展事件**不分事件层**：每条线每个键只有一条列表，规范模型收在 `line.extended`。
    // 未实现的键（incline/text/paint/gif）原样留在 `line.extendedRaw` 里，导出时写回。
    const extended = isObj(raw.extended) ? raw.extended : null;
    const extendedRaw = {};
    const extendedCanonical = {};
    if (extended) {
      for (const [field, value] of Object.entries(extended)) {
        if (Array.isArray(value) && value.length) {
          extendedKeys.add(field);
          extendedRaw[field] = value;
        }
      }
      for (const key of EXTENDED_KEYS) {
        const field = EXTENDED_RPE_FIELD[key];
        const list = asArray(extended[field]).filter(isObj);
        if (!list.length) continue;
        extendedCanonical[key] = list
          .map((e) => {
            const startBeat = rpeBeat(e.startTime);
            let endBeat = rpeBeat(e.endTime);
            if (!Number.isFinite(endBeat) || endBeat < startBeat) endBeat = startBeat;
            const out = {
              startBeat,
              endBeat,
              start: readExtendedValue(key, e.start),
              end: readExtendedValue(key, e.end),
            };
            const easingFn = easingOf(e, (f) => warnRepeat(`ext:${key}`, `${key} 事件的缓动字段非法（已按线性处理）`, `线 ${index}：${f}`));
            out.easingFn = easingFn;
            out.easingType = easingFn?.easingType ?? 1;
            out.easingPreset = easingFn?.easingPreset ?? 1;
            out.bezierPoints = easingFn?.bezierPoints ?? null;
            out.easingLeft = easingFn?.easingLeft ?? 0;
            out.easingRight = easingFn?.easingRight ?? 1;
            return out;
          })
          .sort((a, b) => a.startBeat - b.startBeat);
      }
    }

    // ---- 音符 ----
    if (raw.notes !== undefined && !Array.isArray(raw.notes)) {
      warn(`判定线 ${index} 的 notes 不是数组，已忽略`);
    }
    const notes = asArray(raw.notes)
      .map((note) => {
        if (!isObj(note)) {
          droppedNotes++;
          return null;
        }
        const typeRaw = num(note.type, -1);
        const type = RPE_NOTE_TYPE[typeRaw];
        if (!type) {
          warnRepeat('noteType', '存在未知 note 类型（已忽略）', `线 ${index} 的 type=${String(note.type)}`);
          droppedNotes++;
          return null;
        }
        const startBeat = rpeBeat(note.startTime);
        const endBeatRaw = type === 'hold' ? rpeBeat(note.endTime) : startBeat;
        const endBeat = Number.isFinite(endBeatRaw) ? Math.max(endBeatRaw, startBeat) : startBeat;
        const visibleTimeRaw = num(note.visibleTime, Infinity);
        let above = true;
        if (note.above !== undefined) {
          const a = num(note.above, 1);
          above = a === 1;
          if (a !== 1 && a !== 2) warnRepeat('aboveBad', 'note.above 不是 1/2（按 2＝背面处理）', `线 ${index} above=${String(note.above)}`);
        }
        return {
          type,
          startBeat,
          endBeat,
          positionX: num(note.positionX, 0, { min: -1e5, max: 1e5 }) * RPE_X_TO_X,
          above,
          speed: num(note.speed, 1, { min: -1e3, max: 1e3 }),
          alpha: num(note.alpha, 255, { min: 0, max: 255 }) / 255,
          size: positive(note.size, 1, { max: 100 }),
          yOffset: num(note.yOffset, 0, { min: -1e5, max: 1e5 }) * RPE_Y_TO_Y,
          visibleTime: visibleTimeRaw >= 0 && visibleTimeRaw < 1e5 ? visibleTimeRaw : Infinity,
          isFake: num(note.isFake, 0) === 1 || note.isFake === true,
          hitsound: str(note.hitsound),
          tint: note.tint ?? note.color ?? null,
          judgeArea: num(note.judgeArea, 1),
          raw: note,
        };
      })
      .filter(Boolean);

    if (raw.alphaControl || raw.posControl || raw.sizeControl || raw.skewControl || raw.yControl) {
      warnRepeat('control', '含 *Control 字段（本版本未实现，已忽略；谱面其余部分照常渲染）', `线 ${index}`);
    }
    if (raw.attachUI) warnRepeat('attachUI', '含 attachUI（v1 未实现）', `线 ${index}`);

    chart.lines.push({
      id: index,
      name: str(raw.Name, `Line ${index}`),
      group: int(raw.Group, 0, { min: -1e4, max: 1e4 }),
      groupName: str(groups[int(raw.Group, 0, { min: 0, max: 1e4 })]),
      zOrder: int(raw.zOrder, 0, { min: -1e4, max: 1e4 }),
      isCover: num(raw.isCover, 0) === 1,
      texture: str(raw.Texture, 'line.png'),
      isGif: !!raw.isGif,
      father: int(raw.father, -1, { min: -1, max: 1e5 }),
      rotateWithFather: raw.rotateWithFather === undefined ? false : !!raw.rotateWithFather,
      // 注意：RPE 的字段名是全小写的 `bpmfactor`（docs/Phigros文档.md 的 RPE 判定线）。曾经写成 bpmFactor，
      // 因为样本里的值恰好是 1.0 而长期没有被发现 —— 现在两种写法都接受。
      bpmFactor: positive(raw.bpmfactor ?? raw.bpmFactor, 1, { max: 1e4 }),
      layers,
      notes,
      extended: extendedCanonical, // 已实现的扩展事件（scaleX / scaleY / color，不分层）
      extendedRaw, // 原始 extended 对象：未实现的键导出时原样写回
      raw,
    });
  });

  if (extendedKeys.size) {
    const rendered = EXTENDED_KEYS.map((k) => EXTENDED_RPE_FIELD[k]).filter((f) => extendedKeys.has(f));
    const pending = [...extendedKeys].filter((f) => !rendered.includes(f));
    const parts = [];
    if (rendered.length) parts.push(`已渲染：${rendered.join('、')}`);
    if (pending.length) parts.push(`保留但不渲染：${pending.join('、')}`);
    warn(`谱面含扩展事件（${parts.join('；')}）`);
  }
  if (!chart.lines.length) warn('谱面没有任何判定线（judgeLineList 为空或全部非法）');
  if (!chart.lines.some((l) => l.notes.length)) warn('谱面没有任何可识别的音符');
  if (droppedNotes) warn(`共丢弃 ${droppedNotes} 个非法音符（非对象或类型未知）`);
  if (droppedEvents) warn(`共丢弃 ${droppedEvents} 个非法事件/事件层（非对象）`);

  // 父线校验：越界 / 自引用 / 成环 → 视为无父线并告警
  {
    const fathers = chart.lines.map((l) => (Number.isFinite(l.father) ? l.father : -1));
    const invalid = new Set();
    const cyclic = new Set();
    chart.lines.forEach((line, i) => {
      const father = fathers[i];
      if (father === -1) return;
      if (!(father >= 0 && father < chart.lines.length) || father === i) {
        warn(`判定线 ${i} 的 father=${father} 非法，已按无父线处理`);
        invalid.add(i);
        return;
      }
      const seen = new Set([i]);
      let cur = father;
      let steps = 0;
      while (cur >= 0 && steps++ <= chart.lines.length) {
        if (seen.has(cur)) {
          cyclic.add(i);
          invalid.add(i);
          return;
        }
        seen.add(cur);
        cur = fathers[cur] ?? -1;
      }
    });
    if (cyclic.size) {
      warn(`判定线父线关系成环（已按无父线处理，共 ${cyclic.size} 条）：${[...cyclic].slice(0, 8).join('、')}${cyclic.size > 8 ? ' 等' : ''}`);
    }
    for (const i of invalid) chart.lines[i].father = -1;
  }

  flushRepeats();
  chart.extendedKeys = [...extendedKeys];
  return chart;
}

export { RPE };
