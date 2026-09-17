/**
 * RPE 格式解析：JSON -> 内部统一模型。
 * 依据 docs/02-RPE格式规格.md。
 *
 * v1 已支持的 RPE 特性：META/offset(ms)、BPMList 变速、bpmfactor、事件层相加、
 * 五种普通事件 + 29 种缓动 + 自定义贝塞尔 + 缓动裁剪、四类音符及其
 * alpha/size/speed/yOffset/visibleTime/isFake/above、父子判定线、自定义判定线贴图路径。
 * v1 **未实现**（保留原始字段、渲染时忽略）：extended 扩展事件（text/paint/gif/color/scale/incline）、
 * 各 *Control、attachUI、isGif、hitsound 播放、tint/color 与 judgeArea。
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

const easingOf = (evt) =>
  makeEasing(
    evt.easingType ?? 1,
    evt.bezier ? evt.bezierPoints : null,
    evt.easingLeft ?? 0,
    evt.easingRight ?? 1,
  );

/** RPE 事件 -> 统一事件对象（convert 负责单位换算） */
function mapEvent(evt, convert, keepEasing = true) {
  const startBeat = rpeBeat(evt.startTime);
  let endBeat = rpeBeat(evt.endTime);
  if (!Number.isFinite(endBeat) || endBeat < startBeat) endBeat = startBeat;
  const out = {
    startBeat,
    endBeat,
    start: convert(evt.start),
    end: convert(evt.end),
  };
  if (keepEasing) out.easingFn = easingOf(evt);
  if (evt.linkgroup) out.linkgroup = evt.linkgroup; // RPE 标记，对读取无影响（保留仅作记录）
  return out;
}

export function parseRpeChart(json, options = {}) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  // 逐条重复的告警（如「每条线都含 *Control」）合并成一条，避免刷屏、也避免把重要告警挤出面板
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
  const meta = json.META ?? json;

  const bpmList = (json.BPMList ?? [])
    .map((b) => ({ beat: rpeBeat(b.startTime), bpm: Number(b.bpm) || 120 }))
    .sort((a, b) => a.beat - b.beat);
  if (!bpmList.length) {
    bpmList.push({ beat: 0, bpm: 120 });
    warn('BPMList 缺失或为空，按 120 BPM 处理');
  }

  const chart = createChart({
    format: 'rpe',
    source: { rpeVersion: meta.RPEVersion ?? 0, file: options.file ?? '' },
    warnings,
    timing: { bpmList, bpmFactor: 1 },
    meta: {
      name: meta.name ?? '',
      composer: meta.composer ?? '',
      charter: meta.charter ?? '',
      illustrator: meta.illustrator ?? '',
      level: meta.level ?? '',
      id: meta.id ?? '',
      song: meta.song ?? '',
      background: meta.background ?? '',
      offset: (Number(meta.offset) || 0) / 1000, // RPE 的 offset 单位是毫秒
    },
  });

  const groups = json.judgeLineGroup ?? [];
  const extendedKeys = new Set();

  (json.judgeLineList ?? []).forEach((raw, index) => {
    const layers = (raw.eventLayers ?? [])
      .filter((layer) => layer && typeof layer === 'object')
      .map((layer) => ({
        x: (layer.moveXEvents ?? []).map((e) => mapEvent(e, rpeCenterOffsetX)),
        y: (layer.moveYEvents ?? []).map((e) => mapEvent(e, rpeCenterOffsetY)),
        rotate: (layer.rotateEvents ?? []).map((e) => mapEvent(e, (v) => -degToRad(v))),
        alpha: (layer.alphaEvents ?? []).map((e) => mapEvent(e, (v) => v / 255)),
        speed: (layer.speedEvents ?? []).map((e) => mapEvent(e, (v) => v * RPE_SPEED_TO_YPS, false)),
      }));
    if (!layers.length) warnRepeat('noLayers', '部分判定线没有事件层', `线 ${index}`);

    const extended = raw.extended ?? null;
    if (extended) for (const key of Object.keys(extended)) {
      if (Array.isArray(extended[key]) && extended[key].length) extendedKeys.add(key);
    }

    const notes = (raw.notes ?? [])
      .map((note) => {
        const type = RPE_NOTE_TYPE[note.type];
        if (!type) {
          warnRepeat('noteType', '存在未知 note 类型（已忽略）', `线 ${index} 的 type=${note.type}`);
          return null;
        }
        const startBeat = rpeBeat(note.startTime);
        const endBeat = type === 'hold' ? rpeBeat(note.endTime) : startBeat;
        const visibleTime = Number(note.visibleTime);
        return {
          type,
          startBeat,
          endBeat: Math.max(endBeat, startBeat),
          positionX: (Number(note.positionX) || 0) * RPE_X_TO_X,
          above: note.above === 1, // 1 = 正面，其他 = 背面
          speed: Number.isFinite(note.speed) ? note.speed : 1,
          alpha: (Number.isFinite(note.alpha) ? note.alpha : 255) / 255,
          size: Number.isFinite(note.size) && note.size > 0 ? note.size : 1,
          yOffset: (Number(note.yOffset) || 0) * RPE_Y_TO_Y,
          visibleTime: Number.isFinite(visibleTime) && visibleTime < 1e5 ? visibleTime : Infinity,
          isFake: Number(note.isFake) === 1 || note.isFake === true,
          hitsound: note.hitsound ?? '',
          tint: note.tint ?? note.color ?? null,
          judgeArea: note.judgeArea ?? 1,
          raw: note,
        };
      })
      .filter(Boolean);

    if (raw.alphaControl || raw.posControl || raw.sizeControl || raw.skewControl || raw.yControl) {
      warnRepeat('control', '含 *Control 字段（v1 未实现）', `线 ${index}`);
    }
    if (raw.attachUI) warnRepeat('attachUI', '含 attachUI（v1 未实现）', `线 ${index}`);

    chart.lines.push({
      id: index,
      name: raw.Name ?? `Line ${index}`,
      group: Number(raw.Group) || 0,
      groupName: groups[Number(raw.Group)] ?? '',
      zOrder: Number(raw.zOrder) || 0,
      isCover: Number(raw.isCover) === 1,
      texture: raw.Texture ?? 'line.png',
      isGif: !!raw.isGif,
      father: Number.isFinite(raw.father) ? raw.father : -1,
      rotateWithFather: raw.rotateWithFather === undefined ? false : !!raw.rotateWithFather,
      bpmFactor: Number(raw.bpmFactor) || 1,
      layers,
      notes,
      extended,
      raw,
    });
  });

  // 先报告「会改变观感但未渲染」的项，再报告逐条的结构性问题，最后是合并后的重复告警
  if (extendedKeys.size) {
    warn(`谱面使用了扩展事件（v1 未渲染）：${[...extendedKeys].join(', ')}`);
  }

  // 父线校验：越界 / 自引用 / 成环 → 视为无父线并告警
  // （Phira 遇到成环会直接报 "found infinite recursive parent relations" 并拒绝谱面，这里降级处理）
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
  if (json.multiLineString || json.multiScale !== undefined) {
    // 制谱器专用字段，渲染无关
  }
  chart.extendedKeys = [...extendedKeys];
  return chart;
}

export { RPE };
