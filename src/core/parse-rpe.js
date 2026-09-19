/**
 * RPE 格式解析：JSON -> 内部统一模型。依据 docs/02-RPE格式规格.md。
 * 健壮性策略见 docs/05 §3.4：脏数据取缺省值 + 诊断，不抛异常。
 *
 * v1 已支持：META/offset(ms)、BPMList 变速、bpmfactor、事件层相加、五种普通事件 + 29 种缓动 +
 * 自定义贝塞尔 + 缓动裁剪、四类音符及其 alpha/size/speed/yOffset/visibleTime/isFake/above、
 * 父子判定线、自定义判定线贴图路径。
 * v1 **未实现**（保留原始字段、渲染时忽略）：extended 扩展事件、各 *Control、attachUI、isGif、
 * hitsound 播放、tint/color 与 judgeArea。
 */
import {
  RPE,
  RPE_NOTE_TYPE,
  RPE_SPEED_TO_YPS,
  RPE_X_TO_X,
  RPE_Y_TO_Y,
  degToRad,
  rpeCenterOffsetX,
  rpeCenterOffsetY,
} from './units.js';
import { makeEasing } from './easing.js';
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
    source: { rpeVersion: num(meta.RPEVersion, 0), file: options.file ?? '' },
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

  if (json.judgeLineList !== undefined && !Array.isArray(json.judgeLineList)) {
    warn('judgeLineList 不是数组，已按空谱面处理');
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

    const extended = isObj(raw.extended) ? raw.extended : null;
    if (extended) {
      for (const key of Object.keys(extended)) {
        if (Array.isArray(extended[key]) && extended[key].length) extendedKeys.add(key);
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
      bpmFactor: positive(raw.bpmFactor, 1, { max: 1e4 }),
      layers,
      notes,
      extended,
      raw,
    });
  });

  if (extendedKeys.size) warn(`谱面使用了扩展事件（v1 未渲染）：${[...extendedKeys].join(', ')}`);
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
