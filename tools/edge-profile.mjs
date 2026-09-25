// 分析长条右边界：逐行取「画出来」的最右像素，比较新旧渲染的边界轮廓
import fs from 'node:fs';
import { decodePng } from './png.mjs';

const files = process.argv.slice(2);
const imgs = files.map((f) => decodePng(fs.readFileSync(f)));
const bg = (p) => Math.abs(p[0] - 13) + Math.abs(p[1] - 13) + Math.abs(p[2] - 18) < 24;
const rightEdge = (img, y, x0, x1) => {
  for (let x = x1; x >= x0; x--) {
    if (!bg(img.px(x, y))) return x;
  }
  return -1;
};
console.log('y    ' + files.map((f) => f.split('/').pop().padEnd(18)).join(''));
for (let y = 0; y < 400; y += 4) {
  const cells = imgs.map((img) => String(rightEdge(img, y, 500, 780)).padEnd(18));
  console.log(String(y).padEnd(5) + cells.join(''));
}
