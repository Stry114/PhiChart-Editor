/**
 * 内部统一模型（canonical model）——以 RPE 的概念为主、兼容官方格式：
 *
 *  - 时间：模型层用「拍」（RPE 概念，官方 time/32 转换而来），编译后用「秒」求值。
 *  - 事件：统一为「层数组」+ 事件项 {startBeat,endBeat,start,end,easingFn}；官方只有一层。
 *    RPE 的 x/y 以画面中心为原点、比例为单位；官方 v3 的 0..1 也折算成中心偏移。
 *  - 坐标：note.positionX 用官方 X 单位；纵向距离/速度用官方 Y 单位、Y/s。
 *  - note 类型统一为 tap/drag/hold/flick，抹平两套编号差异（docs/02 §8）。
 *  - 官方扩展（自定义贴图、扩展事件等）RPE 侧字段原样保留在 line.extended / line.raw，v1 不渲染。
 *
 * 见 docs/05-渲染器实现.md。
 */
import { compileLayers, buildHeightFn } from './events.js';
import { createTimeline } from './timing.js';

/** 不含任何判定的默认值（见 events.js 说明） */
export const LINE_EVENT_DEFAULTS = { x: 0, y: 0, rotate: 0, alpha: 0, speed: 1 };

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
    noteCount: 0, // 物量：非假音符数量
    endTime: 0, // 谱面最后一个音符的结束时刻（秒）
    warnings: [],
    ...partial,
  };
}

/** 识别谱面格式 */
export function detectFormat(json) {
  if (Array.isArray(json?.judgeLineList)) {
    if (json.META || json.BPMList) return 'rpe';
    if (typeof json.formatVersion === 'number') return 'official';
  }
  if (json?.META && Array.isArray(json?.judgeLineList)) return 'rpe';
  return 'unknown';
}

/**
 * 编译：为每条线建立时间轴、编译事件、计算高度函数与音符时间。
 * 编译后 line.rt / chart.notes 可用，state.js 直接消费。
 */
export function prepareChart(chart) {
  chart.notes = [];
  let endTime = 0;
  let noteCount = 0;

  chart.lines.forEach((line, index) => {
    const timeline = createTimeline(line.bpmList ?? chart.timing.bpmList, line.bpmFactor ?? 1);
    const layers = line.layers ?? [];

    const rt = {
      timeline,
      x: compileLayers(layers, 'x', timeline),
      y: compileLayers(layers, 'y', timeline),
      rotate: compileLayers(layers, 'rotate', timeline),
      alpha: compileLayers(layers, 'alpha', timeline),
      speed: compileLayers(layers, 'speed', timeline),
      notes: [],
      heightAt: null,
    };
    rt.heightAt = buildHeightFn(rt.speed);

    const notes = [...(line.notes ?? [])].sort((a, b) => a.startBeat - b.startBeat);
    for (const note of notes) {
      const timeSec = timeline.beatToSeconds(note.startBeat);
      const endSec = timeline.beatToSeconds(note.endBeat ?? note.startBeat);
      const duration = Math.max(0, endSec - timeSec);
      const compiled = {
        ...note,
        lineId: index,
        timeSec,
        endSec,
        durationSec: duration,
        height: rt.heightAt(timeSec), // == 官方 Note.floorPosition
        judged: false,
        judgement: null,
        hitFxTime: -1,
      };
      rt.notes.push(compiled);
      chart.notes.push(compiled);
      if (!compiled.isFake) noteCount++;
      if (endSec > endTime) endTime = endSec;
      if (timeSec > endTime) endTime = timeSec;
    }
    line.rt = rt;
  });

  chart.notes.sort((a, b) => a.timeSec - b.timeSec || a.lineId - b.lineId);
  // 多押（同一时刻 ≥ 2 个音符）→ 渲染时使用 HL 贴图（docs/03 §8）
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
  return chart;
}
