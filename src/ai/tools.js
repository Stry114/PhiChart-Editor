/**
 * AI 助手的工具层（见 docs/LLM辅助写谱方案.md §5）。
 *
 * 两类行为，边界很清楚：
 *  - **只读/视图**（`read_chart` / `check_chart`）：立刻在 chart / viewport 上执行，返回数据；
 *  - **写入**（`add_notes` / `edit_notes` / `write_events` / `write_camera` / `set_meta`）：
 *    **不改任何数据**，只产出一份「改动计划」（ops + 中文摘要），由用户确认后交给 ai-apply.js 落地。
 *
 * 模型侧词汇统一为写谱语言（beat / endBeat / x / value / endValue / easing），内部字段名
 * （startBeat / positionX / start / end）只在本文件里换算一次。
 */
import { LIMITS, RULES, valueIssue, auditChart, summarize } from '../editor/lint.js';
import { findOverlappingNote } from '../editor/insert.js';
import { EVENT_KEYS, EXTENDED_KEYS } from '../core/model.js';
import { CAMERA_KEYS, EXTENDED_DEFAULTS, NOTE_TYPES } from '../core/units.js';
import { evalLayers, evalExtended } from '../core/events.js';

/**
 * 读取与写入的上限。**单条轨道可能有上万条事件**，所以读取一律按「拍区间 + 条数 + 分页」给，
 * 并且默认在事件密集时自动改走分段摘要（见 summarizeEvents / summarizeNotes）。
 */
export const CAPS = {
  /** 单次读取里，音符与「每条事件键」各自最多返回多少条（可被 limit 调小，最大 perReadMax） */
  perRead: 60,
  perReadMax: 120,
  /** 单次读取的拍区间上限（拍）：区间再大也会被夹住，并提示改用更小的窗或 summary */
  maxWindowBeats: 64,
  /** 分段摘要最多给多少段（超出就省略并给统计） */
  summarySegments: 40,
  /** 音符摘要的密度分桶上限 */
  summaryBuckets: 24,
  /** 读取多少条以上就默认走摘要（除非显式 summary:false） */
  summaryThreshold: 160,
  /** 求值采样点 */
  samples: 64,
  /** 总览里最多列出多少条判定线（按物量取前 N 条，避免上千条线时撑爆上下文） */
  overviewLines: 40,
  /** check_chart 返回的问题条数 */
  lintItems: 100,
  /** 单次写的对象数 */
  write: 200,
  /** 单批计划的累计对象数 */
  plan: 1000,
  /** 单条工具结果的字符数（超出则换成「结果过长」的说明，仍是合法 JSON） */
  resultChars: 6000,
};

/** 写工具名集合（其余为只读/视图工具） */
export const WRITE_TOOLS = new Set(['add_notes', 'edit_notes', 'write_events', 'write_camera', 'set_meta']);

const num = (v) => (Number.isFinite(v) ? v : Number(v));
const round = (v, n = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v);

// ───────────────────────────── 工具 schema ─────────────────────────────

const easingSchema = {
  description: '缓动：预设编号 1..29（1 = 线性），或 {bezier:[x1,y1,x2,y2]}。默认 1。',
  type: ['integer', 'object'],
};

const eventItem = {
  type: 'object',
  properties: {
    beat: { type: 'number', description: '起始拍' },
    endBeat: { type: 'number', description: '结束拍（省略 = 与 beat 相同，即瞬时事件）' },
    value: { type: 'number', description: '起始值' },
    endValue: { type: 'number', description: '结束值（省略 = 与 value 相同，即常量事件）' },
    easing: easingSchema,
  },
  required: ['beat', 'value'],
  additionalProperties: false,
};

const noteRef = {
  type: 'object',
  properties: {
    lineId: { type: 'integer' },
    beat: { type: 'number' },
    x: { type: 'number' },
    type: { type: 'string', enum: NOTE_TYPES },
  },
  required: ['lineId', 'beat', 'x', 'type'],
  additionalProperties: false,
};

const noteItem = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: NOTE_TYPES, description: 'Tap / Drag / Hold / Flick' },
    beat: { type: 'number', description: '起始拍' },
    endBeat: { type: 'number', description: '仅 Hold 需要：结束拍' },
    x: { type: 'number', description: `横向位置（官方 X 单位，正为右，常用 |x| ≤ 4，上限 ±${round(LIMITS.positionX, 2)}）` },
    above: { type: 'boolean', description: '是否在判定线上方，默认 true' },
    speed: { type: 'number', description: '音符下落倍速，默认 1' },
    holdSpeed: { type: 'string', enum: ['line', 'own'], description: 'Hold 尾速口径：line 跟随判定线速度（默认），own 独立' },
  },
  required: ['type', 'beat', 'x'],
  additionalProperties: false,
};

/** OpenAI `tools` 数组（7 个工具，按写谱操作组织） */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_chart',
      description:
        `读谱面。不给 lineId：返回元数据、BPM、判定线列表（最多列物量最大的 ${CAPS.overviewLines} 条，其余给计数）与物量；给 lineId：返回该线在**拍区间**内的音符与事件。单轨事件可能上万条，所以：区间一次最多 ${CAPS.maxWindowBeats} 拍、一次最多返回 ${CAPS.perReadMax} 条（用 offset 翻页），条数多时会自动改给**分段摘要**（段数上限 ${CAPS.summarySegments}）。`,
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'integer', description: '判定线序号，从 0 开始' },
          fromBeat: { type: 'number', description: '拍区间起点，省略 = 指针附近' },
          toBeat: { type: 'number', description: `拍区间终点（一次最多 ${CAPS.maxWindowBeats} 拍，超出会被夹住）` },
          notes: { type: 'boolean', description: '是否包含音符，默认 true（给了 lineId 时）' },
          events: { type: 'array', items: { type: 'string', enum: EVENT_KEYS }, description: `要读的事件键，默认全部有内容的键（${EVENT_KEYS.join(' / ')}）` },
          summary: { type: 'boolean', description: `true = 只看分段摘要（不逐条）；false = 强制逐条（仍受 ${CAPS.perReadMax} 条上限）；省略 = 条数多时自动摘要` },
          offset: { type: 'integer', description: '分页起点（音符与每条事件键共用），配合返回的 nextOffset 使用' },
          limit: { type: 'integer', description: `本次最多返回多少条（默认 ${CAPS.perRead}，最大 ${CAPS.perReadMax}）` },
          samples: { type: 'integer', description: `在拍区间内等距采样求值结果（0 = 不采样，上限 ${CAPS.samples}）` },
          focus: { type: 'boolean', description: '是否把编辑器视图移到该线 / 该拍区间，默认 false' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_chart',
      description: '纠错扫描，返回问题清单（音符重叠、事件重叠、越界值等）。写完之后建议自查一次。',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'integer', description: '只查这一条线，省略 = 整张谱面' },
          rules: { type: 'array', items: { type: 'string' }, description: '只看这些规则 id，省略 = 全部' },
          limit: { type: 'integer', description: `返回条数上限，默认 50，最大 ${CAPS.lintItems}` },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_notes',
      description: `在指定判定线上放音符（${NOTE_TYPES.join(' / ')}）。一次不超过 ${CAPS.write} 个。`,
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'integer' },
          notes: { type: 'array', items: noteItem, description: '要放下的音符' },
          reason: { type: 'string', description: '一句话说明这次改动' },
        },
        required: ['lineId', 'notes'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_notes',
      description: `按引用（refs）或拍区间修改、删除音符。两种选择器必须二选一。一次不超过 ${CAPS.write} 个。`,
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'integer' },
          refs: { type: 'array', items: noteRef, description: 'read_chart 返回的音符引用' },
          fromBeat: { type: 'number', description: '拍区间起点（区间模式）' },
          toBeat: { type: 'number', description: '拍区间终点（区间模式）' },
          types: { type: 'array', items: { type: 'string', enum: NOTE_TYPES }, description: '区间模式下只改这些类型' },
          changes: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              above: { type: 'boolean' },
              speed: { type: 'number' },
              type: { type: 'string', enum: NOTE_TYPES },
              beat: { type: 'number' },
              endBeat: { type: 'number' },
            },
            additionalProperties: false,
            description: '要改的字段',
          },
          delete: { type: 'boolean', description: '为 true 时删除选中的音符' },
          reason: { type: 'string' },
        },
        required: ['lineId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_events',
      description: `写判定线事件（${EVENT_KEYS.join(' / ')}）。mode=add 追加；mode=replace 先删掉区间内同类事件再写入；mode=delete 删除区间内的事件。一次不超过 ${CAPS.write} 条。`,
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'integer' },
          key: { type: 'string', enum: EVENT_KEYS },
          layerIndex: { type: 'integer', description: '事件层序号，默认 0' },
          mode: { type: 'string', enum: ['add', 'replace', 'delete'], description: '默认 add' },
          fromBeat: { type: 'number', description: 'replace / delete 必填：区间起点' },
          toBeat: { type: 'number', description: 'replace / delete 必填：区间终点' },
          events: { type: 'array', items: eventItem, description: 'add / replace 时必填' },
          reason: { type: 'string' },
        },
        required: ['lineId', 'key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_camera',
      description: `写谱面相机事件（${CAMERA_KEYS.join(' / ')}），影响整张谱面的视角。模式同 write_events。`,
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: CAMERA_KEYS },
          mode: { type: 'string', enum: ['add', 'replace', 'delete'], description: '默认 add' },
          fromBeat: { type: 'number' },
          toBeat: { type: 'number' },
          events: { type: 'array', items: eventItem },
          reason: { type: 'string' },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_meta',
      description: '改元数据。可改：name / composer / charter / illustrator / level / id / offset / speedMultiplier（音频与曲绘不归 AI 管）。',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['name', 'composer', 'charter', 'illustrator', 'level', 'id', 'offset', 'speedMultiplier'] },
          value: { type: ['string', 'number'] },
          reason: { type: 'string' },
        },
        required: ['field', 'value'],
        additionalProperties: false,
      },
    },
  },
];

// ───────────────────────────── 公共小工具 ─────────────────────────────

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

const fail = (msg) => {
  throw new ToolError(msg);
};

/** 结果文本：JSON + 截断标记。超长时**不切断 JSON**，而是换成一个说明对象（模型仍能解析并知道下一步） */
export function toolResultText(value, budget = CAPS.resultChars) {
  let text = JSON.stringify(value);
  if (typeof text !== 'string') text = String(value);
  if (text.length <= budget) return text;
  return JSON.stringify({
    ok: value?.ok !== false,
    truncated: true,
    note: `结果过长（${text.length} 字符 > ${budget}），已省略明细：请缩小拍区间、用 summary:true 看分段摘要，或用 offset/limit 翻页。`,
  });
}

/** 事件的缓动 → 输出用的紧凑写法 */
function easingOut(ev) {
  const preset = Number.isFinite(ev?.easingPreset) ? ev.easingPreset : 1;
  if (Array.isArray(ev?.bezierPoints) && ev.bezierPoints.length === 4 && preset === 2) return { bezier: ev.bezierPoints.map((v) => round(v)) };
  return round(preset, 2);
}

/** 音符 → 模型侧（含引用） */
const noteOut = (n) => ({
  ref: { lineId: n.lineId, beat: round(n.startBeat), x: round(n.positionX), type: n.type },
  type: n.type,
  beat: round(n.startBeat),
  endBeat: n.type === 'hold' ? round(n.endBeat) : undefined,
  x: round(n.positionX),
  above: n.above !== false,
  speed: round(n.speed ?? 1, 3),
  holdSpeed: n.type === 'hold' ? n.holdSpeed ?? 'line' : undefined,
  isFake: n.isFake ? true : undefined,
});

/** 事件 → 模型侧（含引用） */
const eventOut = (ev, where) => ({
  ref: { lineId: where.lineId, layer: where.layer, key: where.key, beat: round(ev.startBeat) },
  beat: round(ev.startBeat),
  endBeat: round(ev.endBeat),
  value: Array.isArray(ev.start) ? ev.start.map((v) => round(v, 3)) : round(ev.start),
  endValue: Array.isArray(ev.end) ? ev.end.map((v) => round(v, 3)) : round(ev.end),
  easing: easingOut(ev),
});

/** 事件列表（源对象）→ 模型侧；按拍区间过滤 */
function collectEvents({ chart, lineId = null, layerIndex = null, key, fromBeat = null, toBeat = null, camera = false }) {
  const lists = [];
  if (camera) {
    lists.push({ layer: null, list: chart?.camera?.[key] ?? [] });
  } else {
    const line = chart?.lines?.[lineId];
    if (!line) fail(`找不到判定线 ${lineId}`);
    const layers = Array.isArray(line.layers) ? line.layers : [];
    layers.forEach((layer, li) => {
      if (layerIndex !== null && li !== layerIndex) return;
      if (Array.isArray(layer?.[key])) lists.push({ layer: li, list: layer[key] });
    });
  }
  const out = [];
  for (const { layer, list } of lists) {
    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue;
      const b = num(ev.startBeat);
      const e = num(ev.endBeat);
      if (fromBeat !== null && Number.isFinite(e) && e < fromBeat - 1e-6) continue;
      if (toBeat !== null && Number.isFinite(b) && b > toBeat + 1e-6) continue;
      out.push(eventOut(ev, { lineId, layer, key }));
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

// ───────────────────────────── 摘要（单轨事件上万条时用） ─────────────────────────────

const near = (a, b, eps = 1e-3) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= eps * Math.max(1, Math.abs(x), Math.abs(y));
};
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 颜色这类数组值不做数值近似 */
const sameValue = (a, b, eps) => (Array.isArray(a) || Array.isArray(b) ? sameJson(a, b) : near(a, b, eps));

/**
 * 把一条轨道的逐条事件压成**分段描述**（写谱时真正需要的形式）：
 * 「0~32 拍常量 2 → 32~64 拍线性升到 8 → 之后一直 8」，并给出条数与值域。
 *
 * 合并规则：上一段的终值 ≈ 本段起值，且两段「同为常量」或「同为斜率一致的线性段（缓动相同）」。
 * 任何不确定的情况都**不合并** —— 宁可多给几段，也不给错。
 *
 * @param {{beat:number,endBeat:number,value:any,endValue:any,easing:any}[]} items 按拍有序
 * @param {{maxSegments?:number, eps?:number}} [opts]
 */
export function summarizeEvents(items, { maxSegments = CAPS.summarySegments, eps = 1e-3 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const segments = [];
  const slopeOf = (seg) => {
    const span = Number(seg.toBeat) - Number(seg.fromBeat);
    if (!(span > 1e-9)) return 0;
    const a = Array.isArray(seg.value) ? NaN : Number(seg.value);
    const b = Array.isArray(seg.endValue) ? NaN : Number(seg.endValue);
    return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / span : NaN;
  };
  for (const ev of list) {
    const last = segments[segments.length - 1];
    const constant = sameValue(ev.value, ev.endValue, eps);
    let merge = false;
    if (last) {
      const continues = sameValue(last.endValue, ev.value, eps);
      const bothConstant = sameValue(last.value, last.endValue, eps) && constant;
      const bothRamp =
        !constant &&
        !sameValue(last.value, last.endValue, eps) &&
        sameJson(last.easing, ev.easing) &&
        near(slopeOf(last), slopeOf({ fromBeat: ev.beat, toBeat: ev.endBeat, value: ev.value, endValue: ev.endValue }), 0.02);
      merge = continues && (bothConstant || bothRamp);
    }
    if (merge) {
      last.toBeat = round(ev.endBeat);
      last.endValue = ev.endValue;
      last.events += 1;
      if (constant) last.value = ev.endValue; // 常量段：值统一（缓动对常量没有可见影响）
    } else {
      segments.push({ fromBeat: round(ev.beat), toBeat: round(ev.endBeat), value: ev.value, endValue: ev.endValue, easing: ev.easing, events: 1 });
    }
  }

  const values = list.flatMap((e) => (Array.isArray(e.value) ? [] : [Number(e.value), Number(e.endValue)])).filter(Number.isFinite);
  const beats = list.map((e) => Number(e.beat)).filter(Number.isFinite);
  const fromBeat = beats.length ? Math.min(...beats) : null;
  const toBeat = list.length ? Math.max(...list.map((e) => Number(e.endBeat))) : null;
  const span = Number.isFinite(fromBeat) && Number.isFinite(toBeat) ? Math.max(1e-9, toBeat - fromBeat) : null;
  const shown = segments.length > maxSegments ? segments.slice(0, maxSegments) : segments;
  const out = {
    events: list.length,
    segments: shown,
    segmentCount: segments.length,
    valueRange: values.length ? { min: round(Math.min(...values)), max: round(Math.max(...values)) } : undefined,
    density: span ? round(list.length / span, 2) : undefined,
  };
  if (segments.length > shown.length) {
    const rest = segments.slice(shown.length);
    const restValues = rest.flatMap((s) => (Array.isArray(s.value) ? [] : [Number(s.value), Number(s.endValue)])).filter(Number.isFinite);
    out.omitted = {
      segments: rest.length,
      afterBeat: shown.length ? shown[shown.length - 1].toBeat : undefined,
      valueRange: restValues.length ? { min: round(Math.min(...restValues)), max: round(Math.max(...restValues)) } : undefined,
    };
  }
  return out;
}

/** 音符的摘要：数量 / 类型分布 / X 范围 + 密度分桶（让模型看出「哪几拍最密」而不必读完列表） */
export function summarizeNotes(items, { maxBuckets = CAPS.summaryBuckets } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { notes: 0 };
  const beats = list.map((n) => Number(n.beat)).filter(Number.isFinite);
  const ends = list.map((n) => Number(n.endBeat ?? n.beat)).filter(Number.isFinite);
  const fromBeat = Math.min(...beats);
  const toBeat = Math.max(...ends, ...beats);
  const byType = {};
  for (const n of list) byType[n.type] = (byType[n.type] ?? 0) + 1;
  const xs = list.map((n) => Number(n.x)).filter(Number.isFinite);
  const span = Math.max(1e-9, toBeat - fromBeat);
  const bucketBeats = Math.max(1, Math.ceil(span / maxBuckets));
  const bucketCount = Math.max(1, Math.ceil(span / bucketBeats));
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    fromBeat: round(fromBeat + i * bucketBeats),
    toBeat: round(Math.min(toBeat, fromBeat + (i + 1) * bucketBeats)),
    notes: 0,
    xMin: Infinity,
    xMax: -Infinity,
  }));
  for (const n of list) {
    const i = Math.min(bucketCount - 1, Math.max(0, Math.floor((Number(n.beat) - fromBeat) / bucketBeats)));
    const b = buckets[i];
    b.notes += 1;
    const x = Number(n.x);
    if (Number.isFinite(x)) {
      b.xMin = Math.min(b.xMin, x);
      b.xMax = Math.max(b.xMax, x);
    }
  }
  return {
    notes: list.length,
    byType,
    beatRange: { from: round(fromBeat), to: round(toBeat) },
    xRange: xs.length ? { min: round(Math.min(...xs)), max: round(Math.max(...xs)) } : undefined,
    density: round(list.length / span, 2),
    buckets: buckets.map((b) => ({
      fromBeat: b.fromBeat,
      toBeat: b.toBeat,
      notes: b.notes,
      xRange: Number.isFinite(b.xMin) ? { min: round(b.xMin), max: round(b.xMax) } : undefined,
    })),
  };
}

/** 一条线的各键事件数 / 层数（源数据，O(事件数)） */
function lineStats(line) {
  const events = {};
  const layers = Array.isArray(line?.layers) ? line.layers : [];
  for (const key of [...EVENT_KEYS, ...EXTENDED_KEYS]) {
    let n = 0;
    if (EXTENDED_KEYS.includes(key)) n = Array.isArray(line?.extended?.[key]) ? line.extended[key].length : 0;
    else for (const layer of layers) if (Array.isArray(layer?.[key])) n += layer[key].length;
    if (n) events[key] = n;
  }
  return {
    lineId: line?.id ?? null,
    name: line?.name || '',
    layers: layers.length,
    notes: Array.isArray(line?.notes) ? line.notes.length : (line?.rt?.notes?.length ?? 0),
    events,
  };
}

/** 判定线序号：模型用 0 起；编辑器内部用数组下标（与结构树一致） */
const lineIndexOf = (chart, lineId) => {
  const lines = Array.isArray(chart?.lines) ? chart.lines : [];
  if (!Number.isFinite(lineId)) return -1;
  if (chart?.lines?.[lineId]) return lineId;
  const i = lines.findIndex((l) => l && (l.id === lineId));
  return i;
};

// ───────────────────────────── 只读：read_chart ─────────────────────────────

function readOverview(chart, ctx) {
  const lines = (chart?.lines ?? []).filter(Boolean);
  const all = lines.map((line) => lineStats(line));
  const meta = chart?.meta ?? {};
  const bpmList = Array.isArray(chart?.timing?.bpmList) ? chart.timing.bpmList.slice(0, 8) : [];
  let eventTotal = 0;
  for (const s of all) for (const n of Object.values(s.events)) eventTotal += n;

  // 判定线可能上千条（每条线只放一个音符的写法）：只列物量最大的前 N 条，其余用计数概括
  let list = all;
  let linesOmitted;
  if (all.length > CAPS.overviewLines) {
    const weight = (s) => s.notes + Object.values(s.events).reduce((a, b) => a + b, 0);
    list = all
      .slice()
      .sort((a, b) => weight(b) - weight(a) || a.lineId - b.lineId)
      .slice(0, CAPS.overviewLines)
      .sort((a, b) => a.lineId - b.lineId);
    linesOmitted = {
      count: all.length - list.length,
      note: `判定线较多（共 ${all.length} 条），这里只列物量最大的 ${list.length} 条；要读别的线直接给 lineId（0 ~ ${all.length - 1}，从 0 开始）。`,
    };
  }

  const lint = typeof ctx?.lintSummary === 'function' ? ctx.lintSummary() : null;
  return {
    ok: true,
    chart: {
      name: meta.name || '',
      level: meta.level || '',
      charter: meta.charter || '',
      composer: meta.composer || '',
      offsetSec: round(meta.offset ?? 0, 3),
      speedMultiplier: meta.speedMultiplier ?? 1,
      format: chart?.format ?? 'unknown',
    },
    bpm: bpmList.map((b) => ({ beat: round(b?.startBeat ?? 0, 3), bpm: round(b?.bpm ?? 0, 3) })),
    lines: list,
    ...(linesOmitted ? { linesOmitted } : {}),
    totals: {
      lines: all.length,
      notes: chart?.noteCount ?? 0,
      durationSec: round(chart?.endTime ?? 0, 2),
      events: eventTotal,
    },
    lint: lint ? { error: lint.error ?? 0, warn: lint.warn ?? 0 } : undefined,
  };
}

function readLine(chart, ctx, args) {
  const lineId = lineIndexOf(chart, args.lineId);
  if (lineId < 0) fail(`找不到判定线 ${args.lineId}`);
  const line = chart.lines[lineId];
  const rt = line?.rt ?? {};
  const timeline = rt.timeline ?? null;
  const beat = (v) => (timeline?.beatToSeconds ? timeline.beatToSeconds(v) : v);

  // 默认窗口：指针附近 ±4 拍；区间过宽会被夹到 maxWindowBeats（避免「一次读完一条线」）
  const center = Number.isFinite(ctx?.viewport?.currentBeat) ? ctx.viewport.currentBeat : 0;
  let fromBeat = Number.isFinite(num(args.fromBeat)) ? num(args.fromBeat) : Math.max(0, round(center - 4, 3));
  let toBeat = Number.isFinite(num(args.toBeat)) ? num(args.toBeat) : round(fromBeat + 8, 3);
  if (toBeat < fromBeat) [fromBeat, toBeat] = [toBeat, fromBeat];
  const askedSpan = round(toBeat - fromBeat, 3);
  let windowClamped = false;
  if (askedSpan > CAPS.maxWindowBeats) {
    toBeat = round(fromBeat + CAPS.maxWindowBeats, 3);
    windowClamped = true;
  }

  const keyFilter = Array.isArray(args.events) && args.events.length ? args.events : null;
  const keys = keyFilter ? keyFilter.filter((k) => EVENT_KEYS.includes(k)) : EVENT_KEYS;
  const limit = Math.max(1, Math.min(CAPS.perReadMax, Math.round(num(args.limit) || CAPS.perRead)));
  const offset = Math.max(0, Math.round(num(args.offset) || 0));
  const wantSamples = Math.max(0, Math.min(CAPS.samples, Math.round(num(args.samples) || 0)));

  // 先按窗口收一遍（数量决定走「逐条」还是「摘要」）
  const notesAll = [];
  if (args.notes !== false) {
    for (const n of rt.notes ?? []) {
      const b = num(n.startBeat);
      const e = num(n.endBeat);
      const overlaps = !(Number.isFinite(e) && e < fromBeat - 1e-6) && !(b > toBeat + 1e-6);
      if (overlaps) notesAll.push(noteOut(n));
    }
  }
  const eventsByKey = {};
  let eventCount = 0;
  for (const key of keys) {
    const list = collectEvents({ chart, lineId, key, fromBeat, toBeat });
    if (!list.length) continue;
    eventsByKey[key] = list;
    eventCount += list.length;
  }
  const summaryMode = args.summary === true || (args.summary !== false && eventCount + notesAll.length > CAPS.summaryThreshold);
  const stats = lineStats(line);

  /** 按给定「页大小 / 采样点数 / 每键段数」组装一次结果；超预算时会被逐步调小重试 */
  const build = (pageLimit, sampleCount, segMax) => {
    const o = {
      ok: true,
      line: stats,
      window: { fromBeat: round(fromBeat, 3), toBeat: round(toBeat, 3) },
      mode: summaryMode ? 'summary' : 'raw',
    };
    if (windowClamped) {
      o.windowClamped = true;
      o.hint = `拍区间一次最多 ${CAPS.maxWindowBeats} 拍（你给了 ${askedSpan} 拍）：请缩小 fromBeat/toBeat 逐段读，或用 summary:true 看分段摘要。`;
    }
    if (summaryMode) {
      o.hint =
        o.hint ??
        `区间内共 ${eventCount} 条事件 / ${notesAll.length} 个音符，已给分段摘要；要逐条请看更小的拍区间（≤ ${CAPS.maxWindowBeats} 拍）并加 summary:false。`;
      if (notesAll.length) o.notesSummary = summarizeNotes(notesAll);
      const ev = {};
      for (const [key, list] of Object.entries(eventsByKey)) ev[key] = summarizeEvents(list, { maxSegments: segMax });
      if (Object.keys(ev).length) o.eventsSummary = ev;
    } else {
      if (args.notes !== false) {
        const page = notesAll.slice(offset, offset + pageLimit);
        o.notes = page;
        o.notesTotal = notesAll.length;
        if (offset + page.length < notesAll.length) o.notesNextOffset = offset + page.length;
      }
      const ev = {};
      for (const [key, list] of Object.entries(eventsByKey)) {
        const page = list.slice(offset, offset + pageLimit);
        ev[key] = page;
        if (offset > 0 || offset + page.length < list.length) {
          ev[`${key}Info`] = {
            total: list.length,
            offset,
            ...(offset + page.length < list.length ? { nextOffset: offset + page.length } : {}),
          };
        }
      }
      if (Object.keys(ev).length) o.events = ev;
    }
    if (sampleCount > 0) {
      const rows = [];
      for (let i = 0; i < sampleCount; i++) {
        const b = fromBeat + ((toBeat - fromBeat) * i) / Math.max(1, sampleCount - 1);
        const t = beat(b);
        const row = { beat: round(b, 3) };
        for (const key of EVENT_KEYS) row[key] = round(evalLayers(rt[key], t, 0), 4);
        for (const key of EXTENDED_KEYS) {
          const v = evalExtended(rt.extended?.[key], key, t, EXTENDED_DEFAULTS[key]);
          row[key] = Array.isArray(v) ? v.map((x) => round(x, 3)) : round(v, 4);
        }
        rows.push(row);
      }
      o.samples = rows;
    }
    return o;
  };

  // 一次读取（尤其带 samples 时）很容易超过单条结果上限：把「采样点 + 页大小 / 摘要段数」一起按比例
  // 缩小到预算内，并把缩减结果如实告诉模型（比整条丢弃换成「结果过长」有用得多）。
  let usedLimit = limit;
  let usedSamples = wantSamples;
  let usedSegMax = CAPS.summarySegments;
  let out = build(usedLimit, usedSamples, usedSegMax);
  const sizeOf = (o) => JSON.stringify(o).length;
  let shrunk = false;
  // 缩减说明本身也要占字符，所以按「预算 − 余量」来收敛，避免说明加上去刚好越界
  const fitBudget = CAPS.resultChars - 400;
  for (let guard = 0; guard < 12 && sizeOf(out) > fitBudget; guard++) {
    let step = false;
    if (usedSamples > 0) {
      usedSamples = Math.max(usedSamples > 8 ? 4 : 1, Math.floor(usedSamples * 0.7));
      step = true;
    }
    if (summaryMode) {
      if (usedSegMax > 4) {
        usedSegMax = Math.max(4, Math.floor(usedSegMax * 0.7));
        step = true;
      }
    } else if (usedLimit > 8) {
      usedLimit = Math.max(8, Math.floor(usedLimit * 0.7));
      step = true;
    }
    if (!step) break;
    shrunk = true;
    out = build(usedLimit, usedSamples, usedSegMax);
  }
  if (shrunk && sizeOf(out) <= CAPS.resultChars) {
    const parts = [];
    if (wantSamples > 0) parts.push(`采样点 ${wantSamples} → ${usedSamples}`);
    if (!summaryMode && usedLimit < limit) parts.push(`页大小 ${limit} → ${usedLimit}`);
    if (summaryMode && usedSegMax < CAPS.summarySegments) parts.push(`每键段数 ${CAPS.summarySegments} → ${usedSegMax}`);
    out.shrunk = {
      reason: `结果接近单条上限（${CAPS.resultChars} 字符），已自动缩减：${parts.join('，') || '明细行数'}。`,
      limit: usedLimit,
      samples: usedSamples,
      chars: sizeOf(out),
      note: '要更多逐条明细请缩小拍区间或按 nextOffset 翻页；要更密的采样点请收窄区间再调小 samples。',
    };
  }

  if (args.focus) ctx?.viewport?.focus?.({ lineId, fromBeat, toBeat });
  return out;
}

// ───────────────────────────── 只读：check_chart ─────────────────────────────

function checkChart(chart, args, ctx = {}) {
  if (!chart?.lines?.length) fail('谱面里还没有判定线');
  // 编辑器已经扫过且没有变脏时直接用它缓存的结果（大谱面上重新扫一遍要几百毫秒）
  let items = null;
  let summary = null;
  let source = 'scan';
  const cached = typeof ctx.lintScan === 'function' ? ctx.lintScan() : null;
  if (cached?.summary && cached.dirty === false) {
    items = cached.items ?? [];
    summary = cached.summary;
    source = 'cache';
  }
  if (!items) {
    const scan = auditChart(chart, {});
    items = scan.items ?? [];
    summary = summarize(scan);
  }
  const ruleFilter = Array.isArray(args.rules) && args.rules.length ? new Set(args.rules) : null;
  const lineFilter = Number.isFinite(num(args.lineId)) ? lineIndexOf(chart, num(args.lineId)) : null;
  const limit = Math.max(1, Math.min(CAPS.lintItems, Math.round(num(args.limit) || 50)));
  const picked = [];
  let matched = 0;
  for (const it of items) {
    if (ruleFilter && !ruleFilter.has(it.rule)) continue;
    if (lineFilter !== null && lineFilter >= 0 && it.lineId !== lineFilter) continue;
    matched += 1;
    if (picked.length >= limit) continue;
    picked.push({
      rule: it.rule,
      ruleName: RULES[it.rule]?.name ?? it.rule,
      severity: it.severity,
      lineId: it.lineId,
      key: it.key,
      beat: round(it.beat, 3),
      text: it.text,
    });
  }
  return {
    ok: true,
    source,
    summary: { error: summary.error, warn: summary.warn, total: summary.total, byRule: summary.byRule },
    items: picked,
    matched,
    truncated: matched > picked.length,
    ...(matched > picked.length ? { hint: `共命中 ${matched} 条，只给了前 ${picked.length} 条：可用 rules / lineId / limit 收窄。` } : {}),
  };
}

// ───────────────────────────── 校验（写工具共用） ─────────────────────────────

const validateEventKey = (key) => {
  if (!EVENT_KEYS.includes(key)) fail(`key 必须是 ${EVENT_KEYS.join(' / ')} 之一（收到 ${key}）`);
};

const validateEasing = (easing) => {
  if (easing === undefined || easing === null) return 1;
  if (typeof easing === 'number') {
    if (!Number.isInteger(easing) || easing < 1 || easing > 29) fail(`缓动编号必须是 1..29 的整数（收到 ${easing}）`);
    return easing;
  }
  if (typeof easing === 'object' && Array.isArray(easing.bezier) && easing.bezier.length === 4) {
    if (!easing.bezier.every((v) => Number.isFinite(v))) fail('贝塞尔控制点必须是 4 个数字');
    return { bezier: easing.bezier };
  }
  fail('缓动只能是 1..29 的编号，或 {bezier:[x1,y1,x2,y2]}');
  return 1;
};

/** 校验一个事件的取值（复用 lint 的阈值与措辞） */
function validateEventValue(key, value, label) {
  const issue = key === 'speed' ? null : valueIssue(key, value);
  if (issue) fail(`${label}：${issue}`);
  if (!Number.isFinite(value)) fail(`${label}：取值不是有限数字`);
}

function validateNote(args) {
  const type = String(args?.type ?? '');
  if (!NOTE_TYPES.includes(type)) fail(`音符类型必须是 ${NOTE_TYPES.join(' / ')}（收到 ${args?.type}）`);
  const beat = num(args?.beat);
  if (!Number.isFinite(beat) || beat < 0) fail('beat 必须是不小于 0 的拍数');
  const x = num(args?.x);
  if (!Number.isFinite(x)) fail('x 必须是数字');
  if (Math.abs(x) > LIMITS.positionX) fail(`positionX ${round(x, 3)} 超出画面半宽 ±${round(LIMITS.positionX, 3)}（会落在画面之外）`);
  if (type === 'hold') {
    const endBeat = num(args?.endBeat);
    if (!Number.isFinite(endBeat)) fail('Hold 必须给 endBeat');
    if (endBeat <= beat) fail(`Hold 的 endBeat 必须大于 beat（${beat} → ${endBeat}）`);
  } else if (Number.isFinite(num(args?.endBeat)) && num(args.endBeat) > beat + 1e-6) {
    fail(`${type} 不需要 endBeat（只有 Hold 有长度）`);
  }
  if (args?.holdSpeed !== undefined && !['line', 'own'].includes(args.holdSpeed)) fail('holdSpeed 只能是 line 或 own');
  const speed = num(args?.speed ?? 1);
  if (!Number.isFinite(speed) || speed <= 0) fail('speed 必须是大于 0 的数字');
  return true;
}

// ───────────────────────────── 写工具 → 计划原语 ─────────────────────────────

const planSummaryOf = (ops) => {
  const groups = new Map();
  for (const op of ops) {
    const key = op.label;
    const g = groups.get(key) ?? { label: op.label, count: 0, danger: !!op.danger };
    g.count += op.count ?? 1;
    g.danger = g.danger || !!op.danger;
    groups.set(key, g);
  }
  return [...groups.values()];
};

const planLabelOf = (ops) => {
  const s = planSummaryOf(ops);
  if (!s.length) return 'AI 改动';
  return `AI：${s.map((g) => `${g.label} ${g.count} 个`).join('，')}`;
};

/** 计划对象：ops + 摘要 + 标签（供卡片显示与 ai-apply 落地） */
const makePlan = (ops, extra = {}) => ({
  ops,
  summary: planSummaryOf(ops),
  label: planLabelOf(ops),
  count: ops.reduce((n, op) => n + (op.count ?? 1), 0),
  ...extra,
});

function planAddNotes(chart, args, ctx) {
  const lineId = lineIndexOf(chart, args?.lineId);
  if (lineId < 0) fail(`找不到判定线 ${args?.lineId}`);
  const line = chart.lines[lineId];
  const list = Array.isArray(args?.notes) ? args.notes : [];
  if (!list.length) fail('notes 不能为空');
  if (list.length > CAPS.write) fail(`一次最多 ${CAPS.write} 个音符（收到 ${list.length} 个）`);
  const ops = [];
  // 与「添加」工具同一套重叠规则：同一线、同 positionX、同面的时间相交会被拦（Hold 例外）
  const existing = (line?.rt?.notes ?? []).map((n) => ({
    type: n.type,
    startBeat: n.startBeat,
    endBeat: n.endBeat,
    positionX: n.positionX,
  }));
  for (const raw of list) {
    validateNote(raw);
    const type = raw.type;
    const startBeat = num(raw.beat);
    const endBeat = type === 'hold' ? num(raw.endBeat) : startBeat;
    const x = num(raw.x);
    const clash = findOverlappingNote(existing, startBeat, endBeat, x, type);
    if (clash) fail(`第 ${round(startBeat)} 拍 x=${round(x)} 处已有同位置音符（${round(clash.startBeat)} 拍），与「添加」工具一样不允许重叠`);
    existing.push({ type, startBeat, endBeat, positionX: x });
    ops.push({
      op: 'note.add',
      lineId,
      label: '新增音符',
      note: {
        type,
        startBeat: round(startBeat),
        endBeat: round(endBeat),
        positionX: round(x),
        above: raw.above !== false,
        speed: round(num(raw.speed ?? 1), 4),
        holdSpeed: type === 'hold' ? (raw.holdSpeed ?? 'line') : undefined,
      },
    });
  }
  const sp = beatSpanOf(ops.map((o) => o.note.startBeat).concat(ops.map((o) => o.note.endBeat)));
  return makePlan(ops, { reason: args?.reason ?? '', lineIds: [lineId], notes: true, span: sp });
}

function planEditNotes(chart, args, ctx) {
  const lineId = lineIndexOf(chart, args?.lineId);
  if (lineId < 0) fail(`找不到判定线 ${args?.lineId}`);
  const line = chart.lines[lineId];
  const notes = line?.rt?.notes ?? [];
  const hasRefs = Array.isArray(args?.refs) && args.refs.length > 0;
  const hasRange = Number.isFinite(num(args?.fromBeat)) && Number.isFinite(num(args?.toBeat));
  if (!hasRefs && !hasRange) fail('必须给 refs，或给 fromBeat + toBeat（二选一）');
  const del = args?.delete === true;
  const changes = args?.changes && typeof args.changes === 'object' ? args.changes : {};
  if (!del && !Object.keys(changes).length) fail('没有要改的字段：请给 changes，或 delete: true');
  if (del && Object.keys(changes).length) fail('delete 与 changes 不能同时给');

  const picked = [];
  if (hasRefs) {
    for (const ref of args.refs) {
      const hit = notes.find(
        (n) => Math.abs(num(n.startBeat) - num(ref.beat)) < 1e-6 && Math.abs(num(n.positionX) - num(ref.x)) < 1e-6 && (!ref.type || n.type === ref.type),
      );
      if (!hit) fail(`找不到音符引用：第 ${round(num(ref.beat))} 拍 x=${round(num(ref.x))} ${ref.type ?? ''}`.trim());
      if (!picked.includes(hit)) picked.push(hit);
    }
  } else {
    const from = num(args.fromBeat);
    const to = num(args.toBeat);
    const types = Array.isArray(args.types) && args.types.length ? new Set(args.types) : null;
    for (const n of notes) {
      if (types && !types.has(n.type)) continue;
      const b = num(n.startBeat);
      const e = num(n.endBeat);
      if (b > to + 1e-6 || e < from - 1e-6) continue;
      picked.push(n);
    }
    if (!picked.length) fail(`第 ${round(from)}~${round(to)} 拍之间没有音符`);
  }
  if (picked.length > CAPS.write) fail(`一次最多改 ${CAPS.write} 个音符（收到 ${picked.length} 个）`);

  const ops = [];
  for (const n of picked) {
    const ref = { lineId, beat: round(n.startBeat), x: round(n.positionX), type: n.type };
    if (del) ops.push({ op: 'note.remove', lineId, ref, label: '删除音符', danger: true, note: noteOut(n) });
    else {
      const patch = {};
      if (changes.x !== undefined) {
        const v = num(changes.x);
        if (!Number.isFinite(v)) fail('x 必须是数字');
        if (Math.abs(v) > LIMITS.positionX) fail(`positionX ${round(v, 3)} 超出画面半宽 ±${round(LIMITS.positionX, 3)}（会落在画面之外）`);
        patch.positionX = round(v);
      }
      if (changes.above !== undefined) patch.above = !!changes.above;
      if (changes.speed !== undefined) {
        const v = num(changes.speed);
        if (!Number.isFinite(v) || v <= 0) fail('speed 必须是大于 0 的数字');
        patch.speed = round(v, 4);
      }
      if (changes.type !== undefined) {
        if (!NOTE_TYPES.includes(changes.type)) fail(`音符类型必须是 ${NOTE_TYPES.join(' / ')}`);
        patch.type = changes.type;
      }
      if (changes.beat !== undefined) {
        const v = num(changes.beat);
        if (!Number.isFinite(v) || v < 0) fail('beat 必须是不小于 0 的拍数');
        patch.startBeat = round(v);
      }
      if (changes.endBeat !== undefined) {
        const v = num(changes.endBeat);
        if (!Number.isFinite(v)) fail('endBeat 必须是数字');
        patch.endBeat = round(v);
      }
      const startAfter = patch.startBeat ?? num(n.startBeat);
      const endAfter = patch.endBeat ?? num(n.endBeat);
      const typeAfter = patch.type ?? n.type;
      if (typeAfter === 'hold' && !(endAfter > startAfter)) fail(`Hold 的结束拍必须大于起始拍（${startAfter} → ${endAfter}）`);
      ops.push({ op: 'note.update', lineId, ref, patch, label: '修改音符', note: noteOut(n) });
    }
  }
  return makePlan(ops, { reason: args?.reason ?? '', lineIds: [lineId], notes: true, span: beatSpanOf(picked.flatMap((n) => [num(n.startBeat), num(n.endBeat)])) });
}

function planWriteEvents(chart, args) {
  const lineId = lineIndexOf(chart, args?.lineId);
  if (lineId < 0) fail(`找不到判定线 ${args?.lineId}`);
  const key = String(args?.key ?? '');
  validateEventKey(key);
  const layerIndex = Number.isFinite(num(args?.layerIndex)) ? Math.max(0, Math.round(num(args.layerIndex))) : 0;
  return buildEventPlan({
    chart,
    target: 'line',
    lineId,
    layerIndex,
    key,
    mode: String(args?.mode ?? 'add'),
    fromBeat: args?.fromBeat,
    toBeat: args?.toBeat,
    events: args?.events,
    reason: args?.reason,
  });
}

function planWriteCamera(chart, args) {
  const key = String(args?.key ?? '');
  if (!CAMERA_KEYS.includes(key)) fail(`相机通道必须是 ${CAMERA_KEYS.join(' / ')} 之一（收到 ${key}）`);
  return buildEventPlan({
    chart,
    target: 'camera',
    lineId: null,
    layerIndex: null,
    key,
    mode: String(args?.mode ?? 'add'),
    fromBeat: args?.fromBeat,
    toBeat: args?.toBeat,
    events: args?.events,
    reason: args?.reason,
  });
}

function buildEventPlan({ chart, target, lineId, layerIndex, key, mode, fromBeat, toBeat, events, reason }) {
  if (!['add', 'replace', 'delete'].includes(mode)) fail('mode 只能是 add / replace / delete');
  const line = target === 'line' ? chart?.lines?.[lineId] : null;
  const layers = Array.isArray(line?.layers) ? line.layers : [];
  if (target === 'line' && !layers.length) fail(`判定线 ${lineId} 没有事件层`);
  if (target === 'line' && layers.length <= layerIndex) fail(`判定线 ${lineId} 只有 ${layers.length} 个事件层（layerIndex 从 0 起）`);

  const existing = collectEvents({ chart, lineId, layerIndex: target === 'line' ? layerIndex : null, key, camera: target === 'camera' });
  const needsRange = mode !== 'add';
  const hasRange = Number.isFinite(num(fromBeat)) && Number.isFinite(num(toBeat));
  if (needsRange && !hasRange) fail(`mode=${mode} 必须给 fromBeat 与 toBeat`);
  const from = hasRange ? num(fromBeat) : null;
  const to = hasRange ? num(toBeat) : null;
  if (needsRange && to <= from) fail('toBeat 必须大于 fromBeat');

  if (mode === 'delete') {
    const hit = existing.filter((e) => !(e.endBeat < from - 1e-6 || e.beat > to + 1e-6));
    if (!hit.length) fail(`第 ${round(from)}~${round(to)} 拍之间没有 ${key} 事件`);
    if (hit.length > CAPS.write) fail(`一次最多改 ${CAPS.write} 条事件（收到 ${hit.length} 条）`);
    return makePlan(
      [{ op: 'event.delete', target, lineId, layerIndex, key, fromBeat: round(from), toBeat: round(to), label: `删除 ${key} 事件`, count: hit.length, danger: true }],
      { reason: reason ?? '', lineIds: lineId === null ? [] : [lineId], keys: [key], span: { from: round(from), to: round(to) } },
    );
  }

  const list = Array.isArray(events) ? events : [];
  if (!list.length) fail('events 不能为空');
  if (list.length > CAPS.write) fail(`一次最多写 ${CAPS.write} 条事件（收到 ${list.length} 条）`);
  const normalized = list.map((raw) => {
    const beat = num(raw?.beat);
    if (!Number.isFinite(beat) || beat < 0) fail('事件的 beat 必须是不小于 0 的拍数');
    const endBeat = Number.isFinite(num(raw?.endBeat)) ? num(raw.endBeat) : beat;
    if (endBeat < beat) fail(`事件的 endBeat 不能小于 beat（${beat} → ${endBeat}）`);
    const value = num(raw?.value);
    const endValue = Number.isFinite(num(raw?.endValue)) ? num(raw.endValue) : value;
    validateEventValue(key, value, '事件的 value');
    validateEventValue(key, endValue, '事件的 endValue');
    return {
      startBeat: round(beat),
      endBeat: round(endBeat),
      start: Array.isArray(value) ? value : round(value, 4),
      end: Array.isArray(endValue) ? endValue : round(endValue, 4),
      easing: validateEasing(raw?.easing),
    };
  });

  if (mode === 'add') {
    // 与已有事件重叠时给出明确错误（编辑器里的事件不允许同层同类重叠）
    for (const ev of normalized) {
      const clash = existing.find((e) => ev.startBeat < e.endBeat - 1e-6 && e.beat < ev.endBeat - 1e-6);
      if (clash) fail(`新增事件与已有事件重叠（已有 ${round(clash.beat)}~${round(clash.endBeat)} 拍）`);
    }
    return makePlan(
      [{ op: 'event.add', target, lineId, layerIndex, key, events: normalized, label: `新增 ${key} 事件`, count: normalized.length }],
      { reason: reason ?? '', lineIds: lineId === null ? [] : [lineId], keys: [key], span: beatSpanOf(normalized.flatMap((e) => [e.startBeat, e.endBeat])) },
    );
  }

  // replace：先删区间内同类事件，再写入新的事件（一步撤销）
  const hit = existing.filter((e) => !(e.endBeat < from - 1e-6 || e.beat > to + 1e-6));
  if (hit.length > CAPS.write) fail(`区间内已有 ${hit.length} 条事件，超过单次上限 ${CAPS.write}`);
  return makePlan(
    [
      { op: 'event.replace', target, lineId, layerIndex, key, fromBeat: round(from), toBeat: round(to), events: normalized, label: `替换 ${key} 事件`, count: Math.max(normalized.length, hit.length), danger: true },
    ],
    { reason: reason ?? '', lineIds: lineId === null ? [] : [lineId], keys: [key], span: { from: round(from), to: round(to) } },
  );
}

function planSetMeta(chart, args) {
  const field = String(args?.field ?? '');
  const allowed = ['name', 'composer', 'charter', 'illustrator', 'level', 'id', 'offset', 'speedMultiplier'];
  if (!allowed.includes(field)) fail(`只能改这些字段：${allowed.join(' / ')}（音频与曲绘不归 AI 管）`);
  let value = args?.value;
  if (field === 'offset') {
    value = num(value);
    if (!Number.isFinite(value) || Math.abs(value) > 3600) fail('offset 必须是 -3600 ~ 3600 之间的秒数');
  } else if (field === 'speedMultiplier') {
    value = num(value);
    if (!Number.isFinite(value) || value <= 0 || value > 100) fail('speedMultiplier 必须是 (0, 100] 之间的数字');
  } else {
    value = String(value ?? '').slice(0, 200);
    if (!value) fail(`${field} 不能为空`);
  }
  return makePlan([{ op: 'meta.set', field, value, label: `改元数据 ${field}` }], { reason: args?.reason ?? '', lineIds: [], meta: true });
}

function beatSpanOf(beats) {
  const list = beats.filter((b) => Number.isFinite(b));
  if (!list.length) return null;
  return { from: round(Math.min(...list), 3), to: round(Math.max(...list), 3) };
}

// ───────────────────────────── 入口 ─────────────────────────────

/**
 * 执行一次工具调用。
 * @param {string} name
 * @param {object} args 模型给的参数
 * @param {{chart:object, viewport?:object, lintSummary?:Function}} ctx
 * @returns {{ok:true, result:any, pending?:boolean, plan?:object}}
 * @throws {ToolError} 参数或目标不合法（调用方把 message 作为工具结果回给模型）
 */
export function runTool(name, args, ctx = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'read_chart') {
    const chart = ctx.chart;
    if (!chart?.lines?.length) fail('还没有载入谱面');
    const result = a.lineId === undefined || a.lineId === null ? readOverview(chart, ctx) : readLine(chart, ctx, a);
    return { ok: true, result };
  }
  if (name === 'check_chart') {
    return { ok: true, result: checkChart(ctx.chart, a, ctx) };
  }
  if (!WRITE_TOOLS.has(name)) fail(`未知工具 ${name}`);
  const chart = ctx.chart;
  if (!chart?.lines?.length) fail('还没有载入谱面');
  const plan =
    name === 'add_notes'
      ? planAddNotes(chart, a, ctx)
      : name === 'edit_notes'
        ? planEditNotes(chart, a, ctx)
        : name === 'write_events'
          ? planWriteEvents(chart, a)
          : name === 'write_camera'
            ? planWriteCamera(chart, a)
            : planSetMeta(chart, a);
  return { ok: true, pending: true, plan, result: { ok: true, pending: true, summary: plan.summary, count: plan.count, note: '已登记到待应用改动，尚未写入谱面。' } };
}

/** 计划里的对象数是否超过单批上限 */
export function planWithinLimits(plan) {
  return !plan || (plan.count ?? 0) <= CAPS.plan;
}
