// Measure the on-screen footprint of notes in a rendered screenshot, to anchor the
// renderer's note-width constant. Usage: node tools/measure-notes.mjs <image.png>
import fs from 'node:fs';
import { decodePng } from './png.mjs';

const file = process.argv[2];
const { w, h, px } = decodePng(fs.readFileSync(file));
console.log(`${file}  ${w}x${h}`);

// Group pixels by hue family and report the bounding boxes of the connected bands.
const families = {
  tap: ([r, g, b]) => b > 180 && b > r + 60 && g > 120 && g < 235,
  flick: ([r, g, b]) => r > 200 && g < 120 && b > 60 && b < 160,
  drag: ([r, g, b]) => r > 200 && g > 200 && b < 160,
  line: ([r, g, b]) => r > 200 && g > 200 && b > 120 && Math.abs(r - g) < 40 && Math.abs(g - b) < 90,
};
for (const [name, test] of Object.entries(families)) {
  const rows = new Map(); // y -> [minX, maxX, count]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      if (a < 200 || !test([r, g, b])) continue;
      const e = rows.get(y);
      if (e) { e[0] = Math.min(e[0], x); e[1] = Math.max(e[1], x); e[2]++; }
      else rows.set(y, [x, x, 1]);
    }
  }
  if (!rows.size) { console.log(`  ${name}: none`); continue; }
  // vertical bands (contiguous runs of rows with matches)
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const bands = [];
  let cur = null;
  for (const y of ys) {
    if (cur && y === cur.y1 + 1) { cur.y1 = y; cur.rows.push(y); }
    else { cur = { y0: y, y1: y, rows: [y] }; bands.push(cur); }
  }
  console.log(`  ${name}: ${bands.length} 个纵向色带`);
  for (const band of bands.slice(0, 8)) {
    const widths = band.rows.map((y) => rows.get(y)[1] - rows.get(y)[0] + 1);
    const width = Math.max(...widths);
    const height = band.y1 - band.y0 + 1;
    const yMid = band.rows[Math.floor(band.rows.length / 2)];
    const [x0, x1] = rows.get(yMid);
    console.log(
      `    y=${band.y0}..${band.y1} (高 ${height}px = ${(height / h * 100).toFixed(2)}% H)  ` +
      `宽 ${width}px = ${(width / w * 100).toFixed(2)}% W   x=${x0}..${x1}`
    );
  }
}
