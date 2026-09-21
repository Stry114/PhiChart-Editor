/**
 * 时间轴：拍 <-> 秒。
 * 官方格式：每条判定线自带 bpm（全曲恒定），1 拍 = 32 个 time 单位。
 * RPE：全局 BPMList（可变速）+ 每条线的 bpmfactor（线当前 BPM = 全局 BPM / bpmfactor）。
 * 两者统一为：{ bpmList: [{beat, bpm}], bpmFactor }（docs/Phigros文档.md 的 RPE 的时间（Beat））。
 */

/**
 * @param {{beat:number,bpm:number}[]} bpmList 已按 beat 升序，且第一条的 beat 为 0
 * @param {number} [bpmFactor] RPE 的 bpmfactor（默认 1）
 */
export function createTimeline(bpmList, bpmFactor = 1) {
  const list = (bpmList.length ? bpmList : [{ beat: 0, bpm: 120 }])
    .map((e) => ({ beat: e.beat, bpm: e.bpm / (bpmFactor || 1) }))
    .filter((e) => Number.isFinite(e.bpm) && e.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  if (!list.length) list.push({ beat: 0, bpm: 120 });
  if (list[0].beat > 0) list.unshift({ beat: 0, bpm: list[0].bpm });

  // 段表：第 i 段的起点拍与起点秒
  const segs = [];
  let sec = 0;
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const next = list[i + 1];
    const secPerBeat = 60 / cur.bpm;
    segs.push({ beat: cur.beat, sec, secPerBeat, bpm: cur.bpm });
    if (next) sec += (next.beat - cur.beat) * secPerBeat;
  }

  const first = segs[0];
  const last = segs[segs.length - 1];

  function beatToSeconds(beat) {
    if (!Number.isFinite(beat)) return beat;
    if (beat < first.beat) return first.sec + (beat - first.beat) * first.secPerBeat; // 负拍：按首段外推
    let seg = last;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].beat <= beat) {
        seg = segs[i];
        break;
      }
    }
    return seg.sec + (beat - seg.beat) * seg.secPerBeat;
  }

  function secondsToBeat(sec2) {
    if (sec2 <= first.sec) return first.beat + (sec2 - first.sec) / first.secPerBeat;
    let seg = last;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].sec <= sec2) {
        seg = segs[i];
        break;
      }
    }
    return seg.beat + (sec2 - seg.sec) / seg.secPerBeat;
  }

  /** 该时刻的 BPM（用于官方 hold 长度等换算） */
  function bpmAtBeat(beat) {
    let seg = last;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].beat <= beat) {
        seg = segs[i];
        break;
      }
    }
    return seg.bpm;
  }

  return { beatToSeconds, secondsToBeat, bpmAtBeat, segments: segs, bpmFactor: bpmFactor || 1 };
}

/** 官方格式：time（1/32 拍）-> 拍 */
export const officialTimeToBeat = (time) => time / 32;
/** 官方格式：拍 -> 秒（等价于 time × 1.875 / bpm） */
export const officialBeatToSeconds = (beat, bpm) => (beat * 60) / bpm;

/** RPE：Beat 数组 [整数, 分子, 分母] -> 拍 */
export function rpeBeat(value) {
  if (Array.isArray(value)) {
    const a = Number(value[0]) || 0;
    const b = Number(value[1]) || 0;
    const c = Number(value[2]);
    if (!c || !Number.isFinite(c)) return a;
    return a + b / c;
  }
  return Number(value) || 0;
}
