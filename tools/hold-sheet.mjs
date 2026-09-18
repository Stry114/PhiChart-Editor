// 生成「长条样例表」：同一时刻、同一判定线上放不同时长的 Hold（头部都正好落在线上），
// 另外在半数位置放 notesBelow 版本，用于肉眼核对长条的头部/尾部/本体形态与方向。
// 运行：node tools/hold-sheet.mjs  ->  tools/out/hold-sheet.png（+ 生成的合成谱面 json）
import fs from 'node:fs';
import path from 'node:path';
import { renderFrame } from './render-frame.mjs';

const BPM = 60;
const T = 32; // 1 拍 = 32 个时间单位
const HIT_TIME = 4 * T; // 第 4 秒命中（bpm 60 → 1 拍 = 1 秒）

// 时长（秒） -> holdTime（时间单位）
const DURATIONS = [0.1, 0.25, 0.5, 1, 2, 4];
const POSITIONS = [-7, -4.2, -1.4, 1.4, 4.2, 7];

const above = POSITIONS.map((x, i) => ({
  type: 3,
  time: HIT_TIME,
  positionX: x,
  holdTime: Math.round(DURATIONS[i] * T),
  speed: 1,
  floorPosition: HIT_TIME / T, // 由渲染器重算，这里只为结构完整
}));
const below = POSITIONS.map((x, i) => ({
  type: 3,
  time: HIT_TIME + 64, // 放在后面的时刻，避免与 above 重叠
  positionX: x,
  holdTime: Math.round(DURATIONS[i] * T),
  speed: 1,
  floorPosition: (HIT_TIME + 64) / T,
}));

const chart = {
  formatVersion: 3,
  offset: 0,
  judgeLineList: [
    {
      bpm: BPM,
      notesAbove: above,
      notesBelow: below,
      speedEvents: [
        { startTime: 0, endTime: 1000000000, value: 1 }, // 1 Y/s
      ],
      judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
      judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
      judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
    },
  ],
};

fs.mkdirSync('tools/out', { recursive: true });
const chartFile = path.join('tools/out', 'hold-sheet.json');
fs.writeFileSync(chartFile, JSON.stringify(chart), 'utf8');

const out = path.join('tools/out', 'hold-sheet.png');
const res = await renderFrame({ chartFile, timeSec: 4, outFile: out, width: 1280, height: 720 });
console.log(`已导出 ${out}`);
console.log(`  above 行：${DURATIONS.map((d, i) => `${d}s@x${POSITIONS[i]}`).join('  ')}`);
console.log(`  可见长条 ${res.visible.filter((n) => n.type === 'hold').length} 个（含 below 行）`);
for (const h of res.visible.filter((n) => n.type === 'hold')) {
  const lenPx = Math.abs(h.tailY - h.headY) * 0.6 * 720;
  console.log(
    `    x=${h.positionX.toFixed(1)} above=${h.above} dur=${h.durationSec.toFixed(2)}s 长度=${lenPx.toFixed(0)}px ` +
      `headY=${h.headY.toFixed(2)} tailY=${h.tailY.toFixed(2)}`,
  );
}
