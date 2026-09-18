// 探针：打印 PNG 中某一列（或若干点）的像素颜色，用于核对渲染结果的实际颜色。
// 用法：node tools/probe-frame.mjs <png> <x> <y0> <y1> [step]
import fs from 'node:fs';
import { decodePng } from './png.mjs';

const [file, xs, ys0, ys1, steps = '4'] = process.argv.slice(2);
const { w, h, px } = decodePng(fs.readFileSync(file));
const x = Number(xs);
const step = Number(steps);
console.log(`${file} ${w}x${h}  列 x=${x}`);
for (let y = Number(ys0); y <= Number(ys1); y += step) {
  if (y < 0 || y >= h) continue;
  const [r, g, b, a] = px(x, y);
  const mark = a === 0 ? '透明' : '';
  console.log(`  y=${String(y).padStart(4)}  rgb(${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)}) a=${String(a).padStart(3)} ${mark}`);
}
