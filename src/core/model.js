/**
 * 内部统一模型（canonical model）——以 RPE 的概念为主、兼容官方格式：
 *
 *  - 时间：模型层用「拍」（RPE 概念，官方 time/32 转换而来），编译后用「秒」求值。
 *  - 事件：统一为「层数组」+ 事件项 {startBeat,endBeat,start,end,easingFn}；官方只有一层。
 *    RPE 的 x/y 以画面中心为原点、比例为单位；官方 v3 的 0..1 也折算成中心偏移。
 *  - 坐标：note.positionX 用官方 X 单位；纵向距离/速度用官方 Y 单位、Y/s。
 *  - note 类型统一为 tap/drag/hold/flick，抹平两套编号差异（docs/Phigros文档.md 的 RPE 音符编号对照）。
 *  - （伪）3D 扩展事件 z / theta 与谱面相机同理
 *    incline / text / paint / gif 与其它未建模的 RPE 字段原样保留在 line.extendedRaw / line.raw，导出时写回。
 *
 * 见 docs/项目文档.md。
 */
import { compileLayers, buildHeightFn, compileExtended } from './events.js';
import { createTimeline } from './timing.js';
import { asArray, isObj, num } from './sanitize.js';
import { CAMERA_DEFAULTS, CAMERA_KEYS, CAMERA_LINE_ID, EXTENDED_KEYS, EXTENDED_DEFAULTS } from './units.js';

/** 不含任何判定的默认值（见 events.js 说明） */
export const LINE_EVENT_DEFAULTS = { x: 0, y: 0, rotate: 0, alpha: 0, speed: 1 };

/** 五类事件（层数组的键） */
export const EVENT_KEYS = ['x', 'y', 'rotate', 'alpha', 'speed'];
/** 扩展（故事板）事件键：**不分层**，每条线每个键只有一条列表 */
export { EXTENDED_KEYS, EXTENDED_DEFAULTS };

/**
 * 编译**谱面相机**的关键帧（谱面级，没有事件层）。
 * 相机在模型里是 `chart.camera = { x:[事件], y:[...], z:[...], focal:[...] }`
 * （与扩展事件同构：拍值 + 起止值 + 缓动），编译结果放 `chart.cameraRt`。
 * @param {object} chart
 * @param {string[]} [keys] 只重编译这几个通道（缺省 = 全部）
 */
export function refreshCamera(chart, keys = CAMERA_KEYS) {
  if (!isObj(chart)) return false;
  const timeline = createTimeline(asArray(chart.timing?.bpmList), num(chart.timing?.bpmFactor, 1));
  chart.cameraRt ??= {};
  for (const key of asArray(keys)) {
    if (!CAMERA_KEYS.includes(key)) continue;
    chart.cameraRt[key] = compileExtended(asArray(chart.camera?.[key]), key, timeline);
  }
  return true;
}

/**
 * 把一个音符的派生字段（秒 / 时长 / 离判定线高度）从 startBeat / endBeat 算回来。
 * `prepareChart` 与「改完数据后的局部重编译」共用同一份规则，避免两处漂移。
 * @returns {boolean} 时间能否换算（false 表示这条数据该被丢弃）
 */
export function deriveNote(note, rt, timeline) {
  const startBeat = num(note.startBeat, NaN);
  if (!Number.isFinite(startBeat)) return false;
  const timeSec = timeline.beatToSeconds(startBeat);
  if (!Number.isFinite(timeSec)) return false;
  const endSecRaw = timeline.beatToSeconds(num(note.endBeat, startBeat));
  const endSec = Number.isFinite(endSecRaw) ? Math.max(timeSec, endSecRaw) : timeSec;
  note.startBeat = startBeat;
  note.timeSec = timeSec;
  note.endSec = endSec;
  note.durationSec = endSec - timeSec;
  // == 官方 Note.floorPosition；简易谱面（测试桩件）可能没有高度函数，保留原值
  note.height = typeof rt.heightAt === 'function' ? rt.heightAt(timeSec) : note.height;
  return true;
}

/** 重算一条线里所有音符的派生字段（判定线速度一变，所有 height 都要重算） */
export function deriveNotes(line) {
  const rt = line?.rt;
  if (!rt?.timeline) return 0;
  let n = 0;
  for (const note of rt.notes ?? []) {
    if (deriveNote(note, rt, rt.timeline)) n++;
  }
  return n;
}

/**
 * 局部重编译：把改动过的源数据重新算成派生数据（拖动写回 / 添加 / 剪刀 / 详情面板都用它）。
 *
 * 为什么不能省：渲染与判定用的是**派生**数据 —— 事件要用编译后的 `{t0,t1,v0,v1,f}` 列表求值
 * （`evalEventList`），音符要用 `timeSec / durationSec / height`。只改源对象的拍值，预览是不会动的。
 * 全量 `prepareChart` 在大谱面上要几百毫秒，所以这里只重算受影响的那条线。
 *
 * @param {object} chart
 * @param {number} lineId
 * @param {{keys?:string[], extended?:string[], notes?:boolean}} [opts]
 *        要重编译的事件类型 / 扩展事件键 / 是否重算这条线的音符
 */
export function refreshLine(chart, lineId, opts = {}) {
  // 相机是谱面级的：编辑器给它的轨道用哨兵 lineId（CAMERA_LINE_ID），
  // 于是拖动 / 撤销 / 粘贴这些「按线重编译」的路径原样就能刷新相机。
  if (lineId === CAMERA_LINE_ID) return refreshCamera(chart, opts.keys);
  const line = chart?.lines?.[lineId];
  const rt = line?.rt;
  if (!rt?.timeline) return false;
  const layers = asArray(line.layers).filter((l) => isObj(l));
  // 扩展键可以混在 keys 里一起传（时间轴的写回路径只认「事件键」）：这里自动分流
  const keys = (opts.keys ?? []).filter((k) => EVENT_KEYS.includes(k));
  const extendedKeys = [...new Set([...(opts.extended ?? []), ...(opts.keys ?? []).filter((k) => EXTENDED_KEYS.includes(k))])];
  for (const key of keys) rt[key] = compileLayers(layers, key, rt.timeline);
  if (keys.includes('speed') || !rt.speed) rt.speed = rt.speed ?? compileLayers(layers, 'speed', rt.timeline);
  if (keys.includes('speed') || typeof rt.heightAt !== 'function') {
    rt.heightAt = buildHeightFn(rt.speed ?? []); // 高度函数来自速度事件
    deriveNotes(line); // 速度变了 → 所有音符的 height 都变了
  } else if (opts.notes) {
    deriveNotes(line);
  }
  // 扩展事件（不分层）：只重编译被点名的那几个键
  for (const key of extendedKeys.filter((k) => EXTENDED_KEYS.includes(k))) {
    rt.extended ??= {};
    rt.extended[key] = compileExtended(asArray(line.extended?.[key]), key, rt.timeline);
  }
  return true;
}

/**
 * 音符的时间 / 位置改动后，重算谱面级派生：结束时间、多押标记、`chart.notes` 顺序。
 * 顺序很重要 —— 自动判定用游标顺序扫描 `chart.notes`（见 state.js 的 advanceJudging），
 * 重排后必须调用 state.js 的 `resyncJudgeCursor` 重新定位游标。
 */
export function refreshNotes(chart) {
  if (!chart) return false;
  let endTime = 0;
  let noteCount = 0;
  for (const line of chart.lines ?? []) {
    for (const note of line?.rt?.notes ?? []) {
      if (!Number.isFinite(note.endSec)) continue;
      if (note.endSec > endTime) endTime = note.endSec;
      if (!note.isFake) noteCount++;
    }
  }
  chart.endTime = endTime;
  chart.duration = endTime + 2;
  chart.noteCount = noteCount;
  chart.notes.sort((a, b) => a.timeSec - b.timeSec || a.lineId - b.lineId);
  for (const note of chart.notes) note.isMulti = false;
  // 多押（同一时刻 ≥ 2 个音符）→ 渲染时使用 HL 贴图（docs/Phigros文档.md 的参考实现关键渲染常数）
  let i = 0;
  while (i < chart.notes.length) {
    const key = chart.notes[i].timeSec.toFixed(6);
    let j = i + 1;
    while (j < chart.notes.length && chart.notes[j].timeSec.toFixed(6) === key) j++;
    if (j - i > 1) for (let k = i; k < j; k++) chart.notes[k].isMulti = true;
    i = j;
  }
  return true;
}

/** 同一层里事件重叠时的告警上限（超过则只报计数） */
const OVERLAP_REPORT_LIMIT = 8;

export function createChart(partial) {
  return {
    format: 'unknown',
    source: {},
    meta: {
      name: '',
      composer: '',
      charter: '',
      illustrator: '',
      level: '',
      id: '',
      song: '',
      background: '',
      offset: 0, // 秒；音乐时间 = 谱面时间 + offset
    },
    lines: [],
    notes: [], // 扁平列表（编译后填充）
    /** 谱面相机：**关键帧事件的容器**（`{ x:[事件], y:[...], z:[...], focal:[...] }`，
     *  缺省为空 = 默认视图；缺省值见 units.js 的 CAMERA_DEFAULTS） */
    camera: isObj(partial?.camera) ? partial.camera : {},
    noteCount: 0, // 物量：非假音符数量
    endTime: 0, // 谱面最后一个音符的结束时刻（秒）
    warnings: [],
    dropped: { lines: 0, notes: 0, events: 0 }, // 被丢弃的脏数据条数
    ...partial,
  };
}

/**
 * 自有项目格式（内部格式）的识别标记。**定义放在这里**是为了避免循环依赖：
 * `project.js` 依赖 `model.js`（要用 createChart），所以标记与识别函数由 model.js 提供。
 * 序列化 / 反序列化实现见 `src/core/project.js`。
 */
export const PROJECT_FORMAT = 'phichart-project';
export const PROJECT_VERSION = 1;
export const isProject = (json) => isObj(json) && (json.format === PROJECT_FORMAT || json.phichartProject === PROJECT_FORMAT);

/**
 * 识别谱面格式（尽量宽容：字段类型不对时也交给对应解析器去报告问题，而不是直接判为「无法识别」）
 *  - 有 format: "phichart-project" → project（本编辑器的内部项目文件）
 *  - 有 META / BPMList → RPE
 *  - 有 formatVersion（数字或数字字符串）→ official
 *  - judgeLineList 是数组 → official（缺 formatVersion 的官方谱）
 */
export function detectFormat(json) {
  if (!isObj(json)) return 'unknown';
  if (isProject(json)) return 'project';
  if (json.META !== undefined || json.BPMList !== undefined) return 'rpe';
  if (typeof json.formatVersion === 'number') return 'official';
  if (typeof json.formatVersion === 'string' && json.formatVersion.trim() !== '' && Number.isFinite(Number(json.formatVersion))) {
    return 'official';
  }
  if (Array.isArray(json.judgeLineList)) return 'official';
  return 'unknown';
}

/**
 * 编译：为每条线建立时间轴、编译事件、计算高度函数与音符时间。
 *
 * 健壮性（docs/项目文档.md 的健壮性策略）：任何一条脏数据都只会被丢弃/取缺省值并记一条告警，不会抛出异常。
 * 只有「传进来的不是解析后的模型」这种调用错误才会抛错。
 *
 * @param {object} chart **解析后的**谱面模型（parseOfficialChart / parseRpeChart 的返回值）
 * @param {{warn?:Function, diagnostics?:object}} [options]
 */
export function prepareChart(chart, options = {}) {
  if (!chart || !Array.isArray(chart.lines)) {
    throw new Error(
      'prepareChart 需要「解析后的谱面模型」（含 lines 数组）。原始谱面 JSON 请先经 parseOfficialChart / parseRpeChart 解析（见 docs/项目文档.md 的架构）。',
    );
  }
  const ownWarn = (msg) => {
    chart.warnings ??= [];
    chart.warnings.push(msg);
    options.diagnostics?.warn?.(msg);
  };
  const warn = options.warn ?? ownWarn;

  chart.notes = [];
  chart.dropped ??= { lines: 0, notes: 0, events: 0 };
  let endTime = 0;
  let noteCount = 0;
  let badNotes = 0;
  let overlaps = 0;

  chart.lines.forEach((line, index) => {
    if (!isObj(line)) {
      warn(`判定线 ${index} 不是对象，已丢弃`);
      chart.dropped.lines++;
      chart.lines[index] = null;
      return;
    }
    const timeline = createTimeline(asArray(line.bpmList).length ? line.bpmList : chart.timing?.bpmList ?? [], num(line.bpmFactor, 1));
    const layers = asArray(line.layers).filter((l) => isObj(l));

    const rt = {
      timeline,
      x: compileLayers(layers, 'x', timeline),
      y: compileLayers(layers, 'y', timeline),
      rotate: compileLayers(layers, 'rotate', timeline),
      alpha: compileLayers(layers, 'alpha', timeline),
      speed: compileLayers(layers, 'speed', timeline),
      // 扩展事件（不分层）：每条线每个键一份编译结果
      extended: Object.fromEntries(
        EXTENDED_KEYS.map((key) => [key, compileExtended(asArray(line.extended?.[key]), key, timeline)]),
      ),
      notes: [],
      heightAt: null,
    };
    rt.heightAt = buildHeightFn(rt.speed);

    // 事件连续性检查：同一层同一键里出现重叠区间（含零长事件互相压制）时给出告警
    for (const key of ['x', 'y', 'rotate', 'alpha', 'speed']) {
      const evs = [];
      for (const layer of layers) {
        for (const e of asArray(layer[key])) {
          if (!isObj(e)) continue;
          const t0 = timeline.beatToSeconds(num(e.startBeat, 0));
          const t1 = timeline.beatToSeconds(num(e.endBeat, num(e.startBeat, 0)));
          if (Number.isFinite(t0) && Number.isFinite(t1)) evs.push({ t0, t1 });
        }
      }
      evs.sort((a, b) => a.t0 - b.t0);
      let reported = 0;
      for (let i = 1; i < evs.length; i++) {
        if (evs[i].t0 < evs[i - 1].t1 - 1e-9) {
          overlaps++;
          if (reported < OVERLAP_REPORT_LIMIT) {
            reported++;
            warn(`判定线 ${index} 的 ${key} 事件存在重叠区间（t=${evs[i].t0.toFixed(3)}s 处），按「后开始的事件生效」处理`);
          }
        }
      }
    }

    const notes = asArray(line.notes).filter((note, ni) => {
      if (!isObj(note)) {
        warn(`判定线 ${index} 的第 ${ni} 个音符不是对象，已丢弃`);
        badNotes++;
        return false;
      }
      return true;
    });
    notes.sort((a, b) => num(a.startBeat, 0) - num(b.startBeat, 0));
    for (const note of notes) {
      const startBeat = num(note.startBeat, NaN);
      if (!Number.isFinite(startBeat)) {
        warn(`判定线 ${index} 存在缺少/非法时间（startBeat）的音符，已丢弃`);
        badNotes++;
        continue;
      }
      const compiled = {
        ...note,
        src: note, // 回引到源（层里的）音符对象：编辑器改参数时同时写回这里
        lineId: index,
        startBeat,
        judged: false,
        judgement: null,
        hitFxTime: -1,
      };
      // 派生字段（秒 / 时长 / 高度）统一走 deriveNote：与「改动后的局部重编译」共用一份规则
      if (!deriveNote(compiled, rt, timeline)) {
        warn(`判定线 ${index} 存在无法换算成时间（${String(note.startBeat)} 拍）的音符，已丢弃`);
        badNotes++;
        continue;
      }
      rt.notes.push(compiled);
      chart.notes.push(compiled);
      if (!compiled.isFake) noteCount++;
      if (compiled.endSec > endTime) endTime = compiled.endSec;
    }
    line.rt = rt;
  });

  // 丢弃的判定线：保持数组长度与 id 对应（渲染/求值会跳过 null）
  chart.dropped.notes += badNotes;
  chart.notes.sort((a, b) => a.timeSec - b.timeSec || a.lineId - b.lineId);
  // 谱面相机：谱面级的关键帧（和 BPMList 一样按拍给值），编译后每帧求值（见 state.js 的 evaluate）
  refreshCamera(chart);
  // 多押（同一时刻 ≥ 2 个音符）→ 渲染时使用 HL 贴图（docs/Phigros文档.md 的参考实现关键渲染常数）
  let i = 0;
  while (i < chart.notes.length) {
    const key = chart.notes[i].timeSec.toFixed(6);
    let j = i + 1;
    while (j < chart.notes.length && chart.notes[j].timeSec.toFixed(6) === key) j++;
    if (j - i > 1) for (let k = i; k < j; k++) chart.notes[k].isMulti = true;
    i = j;
  }
  chart.noteCount = noteCount;
  chart.endTime = endTime;
  chart.duration = endTime + 2;
  if (overlaps) warn(`共发现 ${overlaps} 处事件区间重叠（可能来自不规范谱面，已按后开始者生效）`);
  return chart;
}
