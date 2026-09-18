// 离线核对：对 assets/ 下每张贴图跑一遍长条分段自动识别，看它会不会误判。
// 运行：node tools/detect-hold.mjs
import fs from 'node:fs';
import { decodePng } from './png.mjs';
import { detectHoldStructureFromPixels } from '../src/render/textures.js';

const FILES = ['assets/Hold.png', 'assets/HoldHL.png'];
for (const file of FILES) {
  const { w, h, px } = decodePng(fs.readFileSync(file));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  const res = detectHoldStructureFromPixels({ width: w, height: h, data });
  console.log(`\n=== ${file}  ${w}x${h} ===`);
  if (!res) {
    console.log('  识别：无有效台阶 → 使用预设取样（正常）');
    continue;
  }
  console.log(`  台阶数：${res.steps.length}  y=${res.steps.slice(0, 12).join(',')}${res.steps.length > 12 ? ' …' : ''}`);
  console.log(`  内容框：${JSON.stringify(res.content)}`);
  if (res.rejected) {
    console.log('  识别：**被合理性校验否决** → 使用预设取样（这才是正确行为）');
    if (res.segments) console.log(`  （被否决的分段：${JSON.stringify(res.segments)}）`);
  } else {
    console.log(`  识别成功：${JSON.stringify(res.segments)}`);
  }
  const prof = res.profile;
  console.log('  轮廓采样（每 10%）：');
  for (let i = 0; i <= 10; i++) {
    const y = Math.min(h - 1, Math.round((i / 10) * (h - 1)));
    console.log(`    ${String(i * 10).padStart(3)}%  y=${String(y).padStart(4)}  平均A=${prof.alpha[y].toFixed(1).padStart(6)}  宽度=${prof.width[y].toFixed(0)}`);
  }
}
