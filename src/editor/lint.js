/**
 * 谱面纠错（lint）：把「多半是写错了」的数据挑出来，供左下角「纠错」页列出并跳转。
 *
 * **严重程度的分级标准（只有两条）**：
 *  - `错误`：**理论上会影响渲染或导出** —— 明确非法/负值让渲染器整条跳过或求值失败
 *    （事件负时长会被 `compileEventList` 丢掉、字段非有限、未知音符类型、「保持到结束」后面还有事件、
 *     Hold 负时长会导出非法数据）。
 *  - `警告`：渲染与导出都照常，只是位置/数值超出常规或不符合本意 —— 越界（画面外、超范围取值）、
 *    重叠（按后开始者生效）、零长、未排序、负拍等等。**大量越界其实是作者的手法**（判定线移出画面、
 *    速度 0 停住），所以一律按警告给，不拦也不吓人。
 *
 * 三条设计约束（都是被真实谱面逼出来的）：
 *
 * 1. **不碰 DOM、可分片**：检查逻辑写成生成器，由调用方给时间片驱动（`createLintScan`）。
 *    大谱面（白复生 AT：24 线 / 15.4 万事件；领土战争 AT：24 线 / 8.6 万事件）必须能一边扫一边
 *    继续拖动时间轴 —— 一次扫完会卡住主线程几百毫秒。
 * 2. **按判定线缓存**：每条线算一个「签名」（对该线全部数值做一次廉价哈希）。签名没变的线直接复用
 *    上次结果，因此改一个音符只会重扫那一条线。签名覆盖所有参与判断的数值，不是采样。
 * 3. **阈值按内部规范单位**（`src/core/units.js`），并且**用上面两个真实谱面实测过**：
 *    它们在所有「越界」规则上都是 0 命中 —— 阈值再收紧一点就会开始刷假警告。实测极值：
 *    `|positionX| ≤ 7.49`、`x ∈ [-1.3, 1.3]`、`y ∈ [-2.5, 4.5]`、`|rotate| ≤ 37`、
 *    `alpha ∈ [0, 1]`、`speed ∈ [-1.1, 999]`。
 *
 * 另外两条语义上的取舍（写在 docs/06 §纠错 里）：
 *  - **零长事件是合法的**（RPE 的「瞬时事件」，渲染器专门处理 `t1 <= t0`），所以事件只在
 *    **负时长**（endBeat < startBeat，渲染器会整条跳过）时报错；Hold 音符零长则报「时长 0」。
 *  - **音符重叠只在「同 positionX + 同面（above）」时才算**：同一时刻不同 positionX 的双押是合法的；
 *    正/背面分开判断也是刻意的（避免把双面谱误判成重叠）。
 */

/** 音符重叠：区间判定容差（拍） */
const EPS = 1e-9;
/** 零长音符（Tap / Drag / Flick）撑开成区间的半宽（拍）：否则同一时刻同位置永远判不出重叠 */
const POINT_EPS = 1e-4;
/** 「保持到结束」的哨兵拍值（官方格式用 1e9 之类的值） */
const SENTINEL_BEAT = 1e6;

const NOTE_TYPES = new Set(['tap', 'drag', 'hold', 'flick']);
export const EVENT_KEYS = ['x', 'y', 'rotate', 'alpha', 'speed'];

/** 值越界阈值（内部规范单位，见 src/core/units.js） */
export const LIMITS = {
  /** 音符 positionX：画面半宽（1 X = 0.05625 画面宽）= 8.888…；实测真谱面最大 7.49 */
  positionX: 1 / (2 * 0.05625),
  /** x / y 事件：画面比例单位；实测真谱面 x ≤ 1.3、y ≤ 4.5 */
  xy: 10,
  /** 不透明度上界（下界放宽到 -1：负 alpha 在渲染器里是「隐藏判定线 + 其音符」的编码） */
  alpha: 1,
  /** 旋转（弧度）：实测真谱面 |v| ≤ 37；1000 rad ≈ 159 圈 */
  rotate: 1000,
  /**
   * 速度事件绝对值：**不能**拿 0 当错误 —— 白复生 AT 里有 752 条 speed = 0、1 条 -1.1，
   * 是「判定线停住 / 反向」的正常写法。真谱面实测速度最大 999，所以只拦「大到离谱」的值。
   */
  speed: 10000,
  /** 一次扫描最多保留多少条明细（计数不受影响，只影响列表长度） */
  maxItems: 4000,
};

const LETTER = { x: 'X 位移', y: 'Y 位移' };

/** 规则表：id → 名称 / 严重程度 / 说明。UI 直接用这张表分组与着色。 */
export const RULES = {
  'note-overlap': { name: '音符重叠', severity: 'warn', hint: '同一判定线上、positionX 与所在面都相同，且时间区间相交（两个音符都会照常渲染与导出，只是玩法上打不了）' },
  'hold-negative': { name: 'Hold 负时长', severity: 'error', hint: '结束时间早于开始时间' },
  'note-nan': { name: '音符字段非法', severity: 'error', hint: '时间 / positionX 不是有限数值（该音符不会出现在时间轴里）' },
  'note-type': { name: '未知音符类型', severity: 'error', hint: '不是 tap / drag / hold / flick' },
  'event-overlap': { name: '事件重叠', severity: 'warn', hint: '同一线同一事件类型的区间相交 —— 渲染与导出都正常，只是按「后开始的生效」，多半不是本意' },
  'event-duration': { name: '事件负时长', severity: 'error', hint: '结束拍早于开始拍，渲染器会整条跳过这条事件' },
  'event-sentinel': { name: '「保持到结束」不在末位', severity: 'error', hint: '哨兵 endBeat 之后的事件永远不会生效' },
  'event-nan': { name: '事件字段非法', severity: 'error', hint: '时间 / 取值不是有限数值' },
  'move-pair': {
    name: 'X/Y 位移不成对',
    severity: 'error',
    hint:
      '同一事件层里 X 位移与 Y 位移的条数（或逐条起止拍）对不上：RPE 的 xybind 要求每个 XEvent 有等长的 YEvent，官方格式的位移更是只有一个数组（x、y 天生成对）→ 换工具 / 导出时会丢事件或让后续 X、Y 互相错配',
  },
  'note-x-range': { name: 'positionX 超界', severity: 'warn', hint: '超出画面半宽，音符会落在画面之外' },
  'hold-zero': { name: 'Hold 时长为 0', severity: 'warn', hint: '零长 Hold 会退化成单点判定' },
  'note-extra-duration': { name: '非 Hold 带时长', severity: 'warn', hint: 'Tap / Drag / Flick 不该有时长（渲染时被忽略）' },
  'note-speed': { name: '音符速度非法', severity: 'warn', hint: '速度 ≤ 0（该音符不会正常落线）' },
  'note-negative-beat': { name: '音符时间为负', severity: 'warn', hint: '开始时间早于谱面开头' },
  'event-value': { name: '事件值越界', severity: 'warn', hint: '不透明度不在 -1~1、x/y 远超画面、旋转或速度大到离谱（多半是单位写错）' },
  'event-order': { name: '事件未按时间排序', severity: 'warn', hint: '数组没有按 startBeat 升序（RPE 规范要求有序）' },
};

const num = (v) => (Number.isFinite(v) ? v : 0);
/** 数值格式化：整数不带小数点，小数最多 3 位（注意别用「去掉尾随 0」的正则，会把 40 变成 4） */
const fmt = (v) => {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  return String(Math.round(v * 1000) / 1000);
};
export const fmtBeat = (b) => (Math.abs(b - Math.round(b)) < 1e-6 ? String(Math.round(b)) : b.toFixed(2));

/** 某个事件取值是否有问题（按类型判范围）；没问题返回 null */
export function valueIssue(key, v) {
  if (!Number.isFinite(v)) return null; // 非有限由 event-nan 单独报
  if (key === 'alpha' && (v < -LIMITS.alpha || v > LIMITS.alpha)) {
    return `不透明度 ${fmt(v)} 越界（正常 0~1；负值只在渲染器里表示「隐藏判定线」）`;
  }
  if ((key === 'x' || key === 'y') && Math.abs(v) > LIMITS.xy) {
    return `${LETTER[key]} ${fmt(v)} 远超画面范围（单位是画面比例，实测真谱面最大 4.5）`;
  }
  if (key === 'rotate' && Math.abs(v) > LIMITS.rotate) return `旋转 ${fmt(v)} 弧度异常（约 ${Math.round(v / Math.PI)} 圈）`;
  if (key === 'speed' && Math.abs(v) > LIMITS.speed) {
    return `速度 ${fmt(v)} 大到离谱（真谱面实测最大 999；0 与负速度是合法的「停住 / 反向」写法）`;
  }
  return null;
}

// ───────────────────────── 签名（按线缓存用） ─────────────────────────
const NUM_SCALE = 1e5;
const qnum = (v) => (Number.isFinite(v) ? Math.round(v * NUM_SCALE) : 0x7fffffff) | 0;

/**
 * 一条判定线的签名：覆盖该线的音符与全部事件数值。
 * 两个 32 位哈希混成 64 位，碰撞概率可忽略；只要有一个参与判断的数值变了签名就会变。
 */
export function lineSignature(line) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x1000193 | 0;
  const mix = (v) => {
    h1 = Math.imul(h1 ^ v, 16777619);
    h2 = Math.imul(h2 + v + 0x9e3779b9, 2246822519);
  };
  const notes = line?.rt?.notes ?? [];
  mix(notes.length);
  for (const n of notes) {
    if (!n) continue;
    mix(qnum(n.startBeat));
    mix(qnum(n.endBeat));
    mix(qnum(n.positionX));
    mix(n.above ? 1 : 0);
    mix(n.type ? n.type.charCodeAt(0) * 7 + n.type.length : 0);
    mix(qnum(n.speed));
  }
  const layers = line?.layers ?? [];
  mix(layers.length);
  for (const layer of layers) {
    for (const key of EVENT_KEYS) {
      const list = layer?.[key];
      mix(Array.isArray(list) ? list.length : -1);
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e) continue;
        mix(qnum(e.startBeat));
        mix(qnum(e.endBeat));
        mix(qnum(e.start));
        mix(qnum(e.end));
      }
    }
  }
  return `${h1}:${h2}`;
}

// ───────────────────────── 扫描器 ─────────────────────────
const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * 建一次分片扫描。
 *
 * @param {object} chart 已 prepareChart 的谱面模型
 * @param {{axis?:object, cache?:Map<number,{sig:string,items:object[],counts:object,scanned:object}>}} [opts]
 *   axis 用来把「线内拍」换算成时间轴上的拍（多条线 BPM 倍率不同时会不一样）；
 *   cache 是上一次的按线结果，签名相同的线会被整条跳过。
 */
export function createLintScan(chart, opts = {}) {
  const axis = opts.axis ?? null;
  const cache = opts.cache ?? null;
  const nextCache = new Map();
  const items = [];
  const counts = Object.create(null);
  const scanned = { notes: 0, events: 0 };
  let truncated = 0;

  const lines = (chart?.lines ?? []).filter(Boolean);
  const secOf = (line, beat) => {
    const tl = line?.rt?.timeline;
    return tl ? tl.beatToSeconds(beat) : beat;
  };
  /**
   * 线内拍 → 时间轴上的拍。多条线 BPM 倍率不同时两者并不相等，所以统一从秒换算。
   * 没有 axis（离线/测试调用）或秒无效时退回线内拍。
   */
  const beatOf = (sec, fallbackBeat) => {
    const fb = Number.isFinite(fallbackBeat) ? fallbackBeat : 0;
    if (!axis || !Number.isFinite(sec)) return fb;
    return axis.toBeat(sec);
  };

  /** 每条线的一个任务（unit 是生成器工厂数组） */
  function makeTask(line) {
    const task = {
      lineId: line?.id ?? 0,
      sig: lineSignature(line),
      units: [],
      gen: null,
      ui: 0,
      localItems: [],
      localCounts: Object.create(null),
      localScanned: { notes: 0, events: 0 },
      done: false,
    };
    const add = (rule, at, text) => {
      task.localCounts[rule] = (task.localCounts[rule] ?? 0) + 1;
      task.localItems.push({ rule, severity: RULES[rule]?.severity ?? 'warn', ...at, text });
    };
    const lineName = () => `${task.lineId + 1} 号线`;

    // ── 音符 ──
    task.units.push(function* () {
      const notes = line?.rt?.notes ?? [];
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        task.localScanned.notes++;
        if (n) {
          const sec = Number.isFinite(n.timeSec) ? n.timeSec : secOf(line, n.startBeat);
          const at = {
            lineId: task.lineId,
            layerIndex: null,
            key: 'notes',
            kind: 'note',
            index: i,
            obj: n,
            sec,
            beat: beatOf(sec, n.startBeat),
            where: lineName(),
          };
          if (!Number.isFinite(n.positionX) || !Number.isFinite(n.startBeat) || !Number.isFinite(n.endBeat)) {
            add('note-nan', at, `时间 / positionX 不是有限数值（startBeat=${n.startBeat}, endBeat=${n.endBeat}, positionX=${n.positionX}）`);
          } else {
            if (!NOTE_TYPES.has(n.type)) add('note-type', at, `未知音符类型 ${String(n.type)}`);
            const ax = Math.abs(n.positionX);
            if (ax > LIMITS.positionX) {
              add('note-x-range', at, `positionX ${fmt(n.positionX)} 超出画面半宽 ±${fmt(LIMITS.positionX)}（会落在画面之外）`);
            }
            const len = n.endBeat - n.startBeat;
            if (n.type === 'hold') {
              if (len < -EPS) add('hold-negative', at, `Hold 结束时间早于开始时间（${fmt(n.startBeat)} → ${fmt(n.endBeat)} 拍）`);
              else if (len <= EPS) add('hold-zero', at, `Hold 时长为 0（${fmt(n.startBeat)} 拍），会退化成单点判定`);
            } else if (len > EPS) {
              add('note-extra-duration', at, `非 Hold 音符带有 ${fmt(len)} 拍时长（渲染时被忽略）`);
            }
            if (Number.isFinite(n.speed) && n.speed <= 0) add('note-speed', at, `音符速度 ${fmt(n.speed)}（应为正数）`);
            if (n.startBeat < -EPS) add('note-negative-beat', at, `开始时间为负（${fmt(n.startBeat)} 拍）`);
          }
        }
        if ((i & 1023) === 0) yield;
      }
    });

    // ── 音符重叠：按 (positionX, above) 分桶后扫描 ──
    task.units.push(function* () {
      const notes = line?.rt?.notes ?? [];
      const buckets = new Map();
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (!n || !Number.isFinite(n.startBeat)) continue;
        const b0 = n.startBeat;
        const b1 = Number.isFinite(n.endBeat) ? Math.max(n.endBeat, b0) : b0;
        const b = b1 - b0 > POINT_EPS ? b1 : b0 + POINT_EPS; // 零长音符撑开成小区间
        const key = `${(Number.isFinite(n.positionX) ? n.positionX : 0).toFixed(3)}|${n.above ? 1 : 0}`;
        let arr = buckets.get(key);
        if (!arr) buckets.set(key, (arr = []));
        arr.push({ n, i, b0, b1: b, x: Number.isFinite(n.positionX) ? n.positionX : 0, above: !!n.above });
      }
      let n = 0;
      for (const arr of buckets.values()) {
        arr.sort((a, b) => a.b0 - b.b0);
        for (let i = 1; i < arr.length; i++) {
          const prev = arr[i - 1];
          const cur = arr[i];
          if (cur.b0 < prev.b1 - EPS) {
            const sec = Number.isFinite(cur.n.timeSec) ? cur.n.timeSec : secOf(line, cur.n.startBeat);
            add(
              'note-overlap',
              {
                lineId: task.lineId,
                layerIndex: null,
                key: 'notes',
                kind: 'note',
                index: cur.i,
                obj: cur.n,
                sec,
                beat: beatOf(sec, cur.n.startBeat),
                where: lineName(),
              },
              `与同一位置的另一个 ${cur.n.type} 重叠（${fmt(cur.n.positionX)} · ${cur.n.above ? '正面' : '背面'} · ${fmtBeat(prev.n.startBeat)}~${fmtBeat(prev.n.endBeat)} 拍）`,
            );
          }
        }
        if ((++n & 7) === 0) yield;
      }
    });

    // ── 事件重叠：同一线同一事件类型跨层合并后扫描（渲染时它们本来就是一条列表） ──
    for (const key of EVENT_KEYS) {
      task.units.push(function* () {
        const all = [];
        (line?.layers ?? []).forEach((layer, li) => {
          const list = layer?.[key];
          if (!Array.isArray(list)) return;
          for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e || !Number.isFinite(e.startBeat) || !Number.isFinite(e.endBeat)) continue;
            all.push({ e, li, i, b0: e.startBeat, b1: Math.max(e.endBeat, e.startBeat) });
          }
        });
        if (all.length < 2) return;
        all.sort((a, b) => a.b0 - b.b0);
        for (let i = 1; i < all.length; i++) {
          const prev = all[i - 1];
          const cur = all[i];
          if (cur.b0 < prev.b1 - EPS) {
            const sec = secOf(line, cur.e.startBeat);
            add(
              'event-overlap',
              {
                lineId: task.lineId,
                layerIndex: cur.li,
                key,
                kind: 'event',
                index: cur.i,
                obj: cur.e,
                sec,
                beat: beatOf(sec, cur.e.startBeat),
                where: `${lineName()} 事件层 ${cur.li + 1}`,
              },
              `${key} 事件与另一条区间相交（层 ${prev.li + 1} 的 ${fmtBeat(prev.e.startBeat)}~${fmtBeat(prev.e.endBeat)} 拍），渲染时按「后开始的生效」`,
            );
          }
          if ((i & 2047) === 0) yield;
        }
      });
    }

    // ── 事件逐条检查（每层每类一个单元） ──
    (line?.layers ?? []).forEach((layer, li) => {
      for (const key of EVENT_KEYS) {
        const list = layer?.[key];
        if (!Array.isArray(list) || !list.length) continue;
        task.units.push(function* () {

          let prevStart = -Infinity;
          let reportedOrder = false;
          for (let i = 0; i < list.length; i++) {
            const e = list[i];
            task.localScanned.events++;
            if (e) {
              const sec = secOf(line, e.startBeat);
              const at = {
                lineId: task.lineId,
                layerIndex: li,
                key,
                kind: 'event',
                index: i,
                obj: e,
                sec,
                beat: beatOf(sec, e.startBeat),
                where: `${lineName()} 事件层 ${li + 1}`,
              };
              if (!Number.isFinite(e.startBeat) || !Number.isFinite(e.endBeat) || !Number.isFinite(e.start) || !Number.isFinite(e.end)) {
                add('event-nan', at, `时间 / 取值不是有限数值（${e.startBeat} → ${e.endBeat}, ${e.start} → ${e.end}）`);
              } else {
                if (e.endBeat < e.startBeat - EPS) {
                  add('event-duration', at, `时长为负（${fmtBeat(e.startBeat)} → ${fmtBeat(e.endBeat)} 拍），渲染器会整条跳过`);
                } else {
                  const issue = valueIssue(key, e.start) ?? valueIssue(key, e.end);
                  if (issue) add('event-value', at, issue);
                }
                if (e.endBeat >= SENTINEL_BEAT && i !== list.length - 1) {
                  add('event-sentinel', at, `「保持到结束」的事件不在末位，它后面的 ${list.length - 1 - i} 条事件永远不会生效`);
                }
              }
              if (Number.isFinite(e.startBeat)) {
                if (e.startBeat < prevStart - EPS && !reportedOrder) {
                  reportedOrder = true;
                  add('event-order', at, `数组未按 startBeat 升序（第 ${i + 1} 条 ${fmtBeat(e.startBeat)} 拍出现在 ${fmtBeat(prevStart)} 拍之后）`);
                }
                if (e.startBeat > prevStart) prevStart = e.startBeat;
              }
            }
            if ((i & 1023) === 0) yield;
          }
        });
      }
    });

    // ── X/Y 位移不成对：同一事件层里 x 与 y 应当逐条对应 ──
    // 依据：RPE 的 xybind「启用时每个 XEvent 必有等长的 YEvent」；官方格式的位移只有一个数组
    // （start/end = x、start2/end2 = y），两者天生成对。所以「两边都有事件却配不上」是本层数据被
    // 单独改过（例如只剪了一侧的位移），换到 RPE / 其他工具或导出时会丢事件、错位。
    // 注意：**某层只做单向位移不报** —— 不绑定时那是合法写法，渲染与导出都正常。
    (line?.layers ?? []).forEach((layer, li) => {
      const xs = Array.isArray(layer?.x) ? layer.x : null;
      const ys = Array.isArray(layer?.y) ? layer.y : null;
      if (!xs?.length || !ys?.length) return;
      task.units.push(function* () {
        const n = Math.min(xs.length, ys.length);
        let bad = 0;
        let first = -1;
        for (let i = 0; i < n; i++) {
          const a = xs[i];
          const b = ys[i];
          const same =
            !!a &&
            !!b &&
            Math.abs(num(a.startBeat) - num(b.startBeat)) < EPS &&
            Math.abs(num(a.endBeat) - num(b.endBeat)) < EPS;
          if (!same) {
            bad++;
            if (first < 0) first = i;
          }
          if ((i & 2047) === 0) yield;
        }
        if (!bad && xs.length === ys.length) return;
        const i = first >= 0 ? first : n; // 条数不同时指到第一条「没有对手」的事件
        const moreX = xs.length > ys.length;
        const ev = moreX ? xs[i] : ys[i];
        const sec = secOf(line, ev?.startBeat ?? 0);
        const bind = chart?.source?.xybind ? '（本谱面声明了 XY 绑定 xybind）' : '';
        const text =
          xs.length === ys.length
            ? `X/Y 位移不成对：第 ${i + 1} 条起起止拍对不上（X ${fmtBeat(num(xs[i]?.startBeat))}~${fmtBeat(num(xs[i]?.endBeat))} 拍 / Y ${fmtBeat(num(ys[i]?.startBeat))}~${fmtBeat(num(ys[i]?.endBeat))} 拍），共 ${bad} 处${bind}`
            : `X/Y 位移不成对：该层 X ${xs.length} 条、Y ${ys.length} 条，第 ${n + 1} 条起 ${moreX ? 'X' : 'Y'} 多出 ${Math.abs(xs.length - ys.length)} 条没有配对${bind}`;
        add('move-pair', {
          lineId: task.lineId,
          layerIndex: li,
          key: moreX ? 'x' : 'y',
          kind: 'event',
          index: i,
          obj: ev ?? null,
          sec,
          beat: beatOf(sec, ev?.startBeat ?? 0),
          where: `${lineName()} 事件层 ${li + 1}`,
        }, text);
      });
    });

    return task;
  }

  const tasks = lines.map(makeTask);
  let ti = 0;
  let active = null;
  let completed = 0;
  let finished = false;

  function merge(entry) {
    for (const [rule, n] of Object.entries(entry.counts)) counts[rule] = (counts[rule] ?? 0) + n;
    scanned.notes += entry.scanned.notes;
    scanned.events += entry.scanned.events;
    for (const item of entry.items) {
      if (items.length >= LIMITS.maxItems) truncated++;
      else items.push(item);
    }
  }

  const order = (it) => (it.severity === 'error' ? 0 : 1);

  function finish() {
    finished = true;
    // 展示顺序：错误优先 → 线号 → 拍 → 规则（确定性，测试与界面都按这个顺序）
    items.sort(
      (a, b) =>
        order(a) - order(b) ||
        a.lineId - b.lineId ||
        (a.beat ?? 0) - (b.beat ?? 0) ||
        (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
    );
    return true;
  }

  return {
    items,
    counts,
    scanned,
    get truncated() {
      return truncated;
    },
    get done() {
      return finished;
    },
    get progress() {
      return { lines: completed, total: tasks.length, items: items.length };
    },

    /** 下一次扫描的缓存（未变动的线原样带过去） */
    get cache() {
      return nextCache;
    },
    /**
     * 推进扫描；返回 true 表示扫完（并已排好序）。
     * @param {number} budgetMs 本片最多占用多少毫秒（Infinity = 一次扫完，测试用）
     */
    step(budgetMs = 8) {
      if (finished) return true;
      const t0 = defaultNow();
      for (;;) {
        if (!active) {
          if (ti >= tasks.length) return finish();
          active = tasks[ti++];
          const hit = cache?.get(active.lineId);
          if (hit && hit.sig === active.sig) {
            nextCache.set(active.lineId, hit); // 没变：连扫都不扫
            merge(hit);
            completed++;
            active = null;
            continue;
          }
        }
        // 注意：必须同时确认没有挂起的生成器 —— 单元在第一条数据处 yield，
        // 只看 ui 会把「正在扫最后一个单元」误判成「整条线扫完了」（曾漏掉每行除首条外的全部 speed 事件）
        if (active.ui >= active.units.length && !active.gen) {
          const entry = {
            sig: active.sig,
            items: active.localItems,
            counts: active.localCounts,
            scanned: active.localScanned,
          };
          nextCache.set(active.lineId, entry);
          merge(entry);
          completed++;
          active = null;
          continue;
        }
        if (!active.gen) active.gen = active.units[active.ui++]();
        const r = active.gen.next();
        if (r.done) {
          active.gen = null;
          continue;
        }
        if (budgetMs !== Infinity && defaultNow() - t0 >= budgetMs) return false;
      }
    },
  };
}

/** 一次扫完（测试 / 手工触发用），返回与 createLintScan 相同的形状 */
export function auditChart(chart, opts = {}) {
  const scan = createLintScan(chart, opts);
  while (!scan.step(Infinity));
  return scan;
}

/** 汇总：错误 / 警告条数与规则分布 */
export function summarize(scan) {
  let error = 0;
  let warn = 0;
  for (const [rule, n] of Object.entries(scan.counts ?? {})) {
    if ((RULES[rule]?.severity ?? 'warn') === 'error') error += n;
    else warn += n;
  }
  return {
    error,
    warn,
    total: error + warn,
    byRule: { ...(scan.counts ?? {}) },
    scanned: { ...(scan.scanned ?? { notes: 0, events: 0 }) },
    truncated: scan.truncated ?? 0,
    lines: scan.progress?.total ?? 0,
  };
}
