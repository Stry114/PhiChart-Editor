// 调试用：只放一个 hold，方便隔离渲染问题
// 用法：node tools/one-hold.mjs <拍数> <theta> <out.png> [t] [x]
import fs from 'node:fs';
import path from 'node:path';
import { renderFrame } from './render-frame.mjs';

const [beatsArg, thetaArg, out, tArg, xArg] = process.argv.slice(2);
const beats = (n) => [n, 0, 1];
const holdBeats = Number(beatsArg ?? 8);
const theta = Number(thetaArg ?? 35);
const time = Number(tArg ?? 4.2);
const x = Number(xArg ?? 0);
const chart = {
  META: { RPEVersion: 163, offset: 0, name: 'one-hold' },
  BPMList: [{ bpm: 60, startTime: beats(0) }],
  judgeLineList: [
    {
      Name: 'one-hold',
      Texture: 'line.png',
      isCover: 0,
      eventLayers: [
        {
          alphaEvents: [{ startTime: beats(0), endTime: beats(1e6), start: 255, end: 255, easingType: 1 }],
          speedEvents: [{ startTime: beats(0), endTime: beats(1e6), start: 1.5, end: 1.5, easingType: 1 }],
        },
      ],
      extended: { thetaEvents: [{ startTime: beats(0), endTime: beats(1e6), start: theta, end: theta, easingType: 1 }] },
      notes: [
        {
          type: 2,
          above: 1,
          startTime: beats(4),
          endTime: beats(4 + holdBeats),
          positionX: x * 75.9375,
          alpha: 255,
          size: 1,
          speed: 1,
          yOffset: 0,
          visibleTime: 999999,
          isFake: 0,
        },
      ],
    },
  ],
};
fs.mkdirSync('tools/out', { recursive: true });
const chartFile = path.join('tools/out', 'one-hold.json');
fs.writeFileSync(chartFile, JSON.stringify(chart), 'utf8');
const res = await renderFrame({ chartFile, timeSec: time, outFile: out, width: 1280, height: 720 });
const h = res.visible.find((n) => n.type === 'hold');
console.log(`${out}: ${holdBeats} 拍 θ=${theta}° t=${time}s x=${x} → headY=${h?.headY?.toFixed(2)} tailY=${h?.tailY?.toFixed(2)}`);
