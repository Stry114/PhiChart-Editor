// 生成「倾斜下落面样例表」：同一条判定线把下落面倾斜（theta）后，放不同时长的 Hold，
// 用于肉眼核对**梯形长条**：近端贴线、远端更窄并沿线方向偏移，且不管多长都不出现锯齿台阶。
// 另外再导出一张「线转 90°」和一张「z 位移」的对照图。
// 运行：node tools/tilt-sheet.mjs  ->  tools/out/tilt-sheet.png（+ 合成谱面 json）
import fs from 'node:fs';
import path from 'node:path';
import { renderFrame } from './render-frame.mjs';

const BPM = 60;
const THETA = 35; // 下落面倾角（度）
const HIT_BEAT = 4; // 第 4 拍命中（bpm 60 → 1 拍 = 1 秒）

/** 一拍 = 1 秒（bpm 60），所以时长（拍）就是时长（秒） */
const beats = (n) => [n, 0, 1];

/** RPE 的 positionX 单位 → 官方 X 单位（1 X = 0.05625 × 画面宽） */
const RPE_WIDTH = 1350;
const X_RATIO = 0.05625;
const rpeX = (x) => x * RPE_WIDTH * X_RATIO; // 75.9375

/** 一条判定线上的 hold 列表：`[官方 X 位置, 时长（拍）, 是否背面]` */
const HOLDS = [
  [-6, 0.5, false],
  [-2, 2, false],
  [2, 8, false],
  [6, 24, false],
  [-6, 2, true],
  [-2, 8, true],
  [2, 24, true],
  [6, 0.5, true],
];

/**
 * @param {object} p
 * @param {string} p.name
 * @param {number} p.theta 下落面倾角（度）
 * @param {number} [p.rotate] 判定线自身旋转（度）
 * @param {number} [p.z] 判定线的 z（画面高比例）
 * @param {number} [p.hitBeat] 命中拍（决定长条的屏幕位置）
 */
function makeChart({ name, theta, rotate = 0, z = 0, hitBeat = HIT_BEAT }) {
  const notes = HOLDS.map(([positionX, dur, below], i) => ({
    type: 2,
    above: below ? 2 : 1,
    startTime: beats(hitBeat + (below ? 4 : 0)),
    endTime: beats(hitBeat + (below ? 4 : 0) + dur),
    positionX: rpeX(positionX),
    alpha: 255,
    size: 1,
    speed: 1,
    yOffset: 0,
    visibleTime: 999999,
    isFake: 0,
    _i: i,
  }));
  const span = (v) => ({ startTime: beats(0), endTime: beats(1e6), start: v, end: v, easingType: 1 });
  return {
    META: { RPEVersion: 163, offset: 0, name },
    BPMList: [{ bpm: BPM, startTime: beats(0) }],
    judgeLineList: [
      {
        Name: name,
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [
          {
            alphaEvents: [{ ...span(255) }],
            speedEvents: [span(1.5)],
            moveXEvents: [span(0)],
            moveYEvents: [span(0)],
            rotateEvents: [span(rotate)],
          },
        ],
        extended: {
          thetaEvents: [span(theta)],
          moveZEvents: [span(z)],
        },
        notes,
      },
    ],
  };
}

const CASES = [
  { file: 'tilt-sheet.json', out: 'tilt-sheet.png', chart: makeChart({ name: 'tilt', theta: THETA }), time: HIT_BEAT + 0.2 },
  { file: 'tilt-rot.json', out: 'tilt-rot.png', chart: makeChart({ name: 'tilt-rot', theta: THETA, rotate: 90 }), time: HIT_BEAT + 0.2 },
  { file: 'tilt-z.json', out: 'tilt-z.png', chart: makeChart({ name: 'tilt-z', theta: THETA, z: -0.35 }), time: HIT_BEAT + 0.2 },
  { file: 'tilt-flat.json', out: 'tilt-flat.png', chart: makeChart({ name: 'tilt-flat', theta: 0 }), time: HIT_BEAT + 0.2 },
];

fs.mkdirSync('tools/out', { recursive: true });
for (const c of CASES) {
  const chartFile = path.join('tools/out', c.file);
  fs.writeFileSync(chartFile, JSON.stringify(c.chart), 'utf8');
  const out = path.join('tools/out', c.out);
  const res = await renderFrame({ chartFile, timeSec: c.time, outFile: out, width: 1280, height: 720 });
  const holds = res.visible.filter((n) => n.type === 'hold');
  console.log(`${out}  t=${c.time}s  可见长条 ${holds.length}`);
  for (const h of holds.slice(0, 4)) {
    const lenPx = Math.abs(h.tailY - h.headY) * 0.6 * 720;
    console.log(
      `    x=${h.positionX.toFixed(1)} above=${h.above ? 1 : 2} dur=${h.durationSec.toFixed(2)}s 长度=${lenPx.toFixed(0)}px ` +
        `headY=${h.headY.toFixed(2)} tailY=${h.tailY.toFixed(2)}`,
    );
  }
}
