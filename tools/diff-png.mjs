// 比较两张 PNG 的像素差异
import fs from 'node:fs';
import { decodePng } from './png.mjs';

const [fa, fb] = process.argv.slice(2);
const a = decodePng(fs.readFileSync(fa));
const b = decodePng(fs.readFileSync(fb));
if (a.w !== b.w || a.h !== b.h) {
  console.log(`尺寸不同：${a.w}x${a.h} vs ${b.w}x${b.h}`);
  process.exit(1);
}
let diff = 0;
let maxd = 0;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
for (let y = 0; y < a.h; y++) {
  for (let x = 0; x < a.w; x++) {
    const pa = a.px(x, y);
    const pb = b.px(x, y);
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa[c] - pb[c]));
    if (d > 2) {
      diff++;
      if (d > maxd) maxd = d;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(`差异像素 ${diff}（最大通道差 ${maxd}）`);
if (diff) console.log(`  差异范围 x ${minX}~${maxX} y ${minY}~${maxY}`);
