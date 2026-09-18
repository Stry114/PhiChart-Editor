// 命中特效预览：合成一个单键谱面，在特效生命周期的不同阶段渲染若干帧。
// 运行：node tools/fx-preview.mjs  ->  tools/out/fx-{05,15,30,45}.png
import fs from 'node:fs';
import path from 'node:path';
import { renderFrame } from './render-frame.mjs';

// 1 拍 = 32 单位；bpm 60 → 1 拍 = 1s。让音符在 t = 3s 命中，且停在判定线附近便于观察。
const chart = {
  formatVersion: 3,
  offset: 0,
  judgeLineList: [
    {
      bpm: 60,
      notesAbove: [{ type: 1, time: 3 * 32, positionX: 0, holdTime: 0, speed: 1, floorPosition: 3 }],
      notesBelow: [],
      speedEvents: [{ startTime: 0, endTime: 1000000000, value: 0.15 }], // 慢速：音符尽量贴近线
      judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
      judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
      judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
    },
  ],
};
fs.mkdirSync('tools/out', { recursive: true });
const chartFile = path.join('tools/out', 'fx-preview.json');
fs.writeFileSync(chartFile, JSON.stringify(chart), 'utf8');

for (const age of [0.05, 0.15, 0.3, 0.45]) {
  await renderFrame({ chartFile, timeSec: 3 + age, outFile: `tools/out/fx-${String(Math.round(age * 100)).padStart(2, '0')}.png`, width: 1280, height: 720 });
  console.log(`已导出 tools/out/fx-${String(Math.round(age * 100)).padStart(2, '0')}.png  （命中后 ${age}s）`);
}
