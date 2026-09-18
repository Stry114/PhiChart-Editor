// 逐行分析 Hold 贴图的纵向结构：平均 alpha / 平均颜色 / 内容宽度，找出「帽」与「可拉伸体」的分界。
// 运行：node tools/measure-hold-structure.mjs
import fs from 'node:fs';
import { decodePng } from './png.mjs';

for (const file of ['assets/Hold.png', 'assets/HoldHL.png']) {
  const { w, h, px } = decodePng(fs.readFileSync(file));
  console.log(`\n=== ${file}  ${w}x${h} ===`);
  console.log('   行%     平均A   平均R,G,B     内容宽   宽/最大');
  const maxW = (() => {
    let m = 0;
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = 0; x < w; x++) if (px(x, y)[3] >= 8) c++;
      if (c > m) m = c;
    }
    return m;
  })();
  let prev = null;
  for (let i = 0; i <= 40; i++) {
    const y = Math.min(h - 1, Math.round((i / 40) * (h - 1)));
    let a = 0, r = 0, g = 0, b = 0, cw = 0;
    for (let x = 0; x < w; x++) {
      const [pr, pg, pb, pa] = px(x, y);
      a += pa;
      r += pr;
      g += pg;
      b += pb;
      if (pa >= 8) cw++;
    }
    const row = {
      pct: (i / 40) * 100,
      y,
      a: a / w,
      r: r / w,
      g: g / w,
      b: b / w,
      cw,
    };
    const step = prev && (Math.abs(row.a - prev.a) > 3 || Math.abs(row.cw - prev.cw) > 12) ? '  <- 变化' : '';
    console.log(
      `  ${row.pct.toFixed(1).padStart(5)}%  y=${String(y).padStart(4)}  ${row.a.toFixed(1).padStart(6)}  ` +
        `${row.r.toFixed(0).padStart(3)},${row.g.toFixed(0).padStart(3)},${row.b.toFixed(0).padStart(3)}  ` +
        `${String(cw).padStart(6)}  ${(cw / maxW).toFixed(3)}${step}`,
    );
    prev = row;
  }
}
