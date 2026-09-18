// Hold 取样方案对照：同一位置、同一长度，用不同的「帽/体」取样方式绘制，导出对照图。
// 运行：node tools/hold-variants.mjs  ->  tools/out/hold-variants.png
// 列顺序：A 现方案(帽40px源) / B 帽10% / C 帽10%+体只取青色段 / D 体用纯色
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng } from './png.mjs';

const W = 1500;
const H = 620;
const NOTE_WIDTH = 150;
const LEN = 330; // 长条长度（像素）
const TOP = 90;
const XS = [150, 420, 690, 960, 1230];

const tex = decodePng(fs.readFileSync('assets/Hold.png'));
const core = { x: 0, y: 0, w: 989, h: 2000 };
const content = { x: 0, y: 0, w: 989, h: 2000 };

const buf = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  buf[i * 4] = 22;
  buf[i * 4 + 1] = 22;
  buf[i * 4 + 2] = 28;
  buf[i * 4 + 3] = 255;
}
const blend = (x, y, r, g, b, a8) => {
  if (x < 0 || y < 0 || x >= W || y >= H || a8 <= 0) return;
  const i = (y * W + x) * 4;
  if (ADDITIVE) {
    const a = a8 / 255;
    buf[i] = Math.min(255, Math.round(buf[i] + r * a));
    buf[i + 1] = Math.min(255, Math.round(buf[i + 1] + g * a));
    buf[i + 2] = Math.min(255, Math.round(buf[i + 2] + b * a));
    return;
  }
  const a = a8 / 255;
  buf[i] = Math.round(r * a + buf[i] * (1 - a));
  buf[i + 1] = Math.round(g * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(b * a + buf[i + 2] * (1 - a));
};
let ADDITIVE = false;
const fillRect = (x, y, w, h, [r, g, b, a8]) => {
  for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++) {
    for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) blend(xx, yy, r, g, b, a8);
  }
};
const blit = (sx, sy, sw, sh, dx, dy, dw, dh) => {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return;
  for (let y = 0; y < Math.round(dh); y++) {
    const srcY = Math.min(tex.h - 1, Math.max(0, Math.floor(sy + ((y + 0.5) / dh) * sh)));
    for (let x = 0; x < Math.round(dw); x++) {
      const srcX = Math.min(tex.w - 1, Math.max(0, Math.floor(sx + ((x + 0.5) / dw) * sw)));
      const [r, g, b, a] = tex.px(srcX, srcY);
      if (!a) continue;
      blend(Math.round(dx) + x, Math.round(dy) + y, r, g, b, a);
    }
  }
};
/** 取源区间某行的平均颜色（用于 D 方案的纯色体） */
const avgColor = (y0, y1, x0, x1) => {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = y0; y <= y1; y += 7) {
    for (let x = x0; x <= x1; x += 7) {
      const [pr, pg, pb, pa] = tex.px(x, y);
      r += pr; g += pg; b += pb; a += pa; n++;
    }
  }
  return [r / n, g / n, b / n, a / n];
};

const scale = NOTE_WIDTH / core.w;
const xLeftOf = (cx) => cx - (core.x + core.w / 2) * scale;
const fullW = tex.w * scale;
const drawBody = (cx, { capTopPx, capBottomPx, bodyFromPct, bodyToPct, solid, capFromPct }) => {
  const x = xLeftOf(cx);
  const top = TOP;
  const bottom = TOP + LEN;
  const capTop = capTopPx * scale;
  const capBottom = capBottomPx * scale;
  // 尾帽（capFromPct 给出时，尾帽也从偏青的段取样，避免顶部出现发灰的一段）
  const capSrcY = capFromPct != null ? core.h * capFromPct : 0;
  blit(0, core.y + capSrcY, tex.w, capTopPx, x, top, fullW, capTop);
  // 头帽
  blit(0, core.y + core.h - capBottomPx, tex.w, capBottomPx, x, bottom - capBottom, fullW, capBottom);
  // 中段
  const midTop = top + capTop;
  const midBottom = bottom - capBottom;
  if (solid) {
    const [r, g, b, a] = solid;
    fillRect(x + core.x * scale, midTop, core.w * scale, midBottom - midTop, [r, g, b, a]);
  } else {
    const y0 = Math.round(core.h * bodyFromPct);
    const y1 = Math.round(core.h * bodyToPct);
    blit(0, core.y + y0, tex.w, y1 - y0, x, midTop, fullW, midBottom - midTop);
  }
  // 参考线：红 = 长条两端；绿 = 设定宽度
  fillRect(cx - 95, top - 0.5, 190, 1, [255, 90, 90, 150]);
  fillRect(cx - 95, bottom - 0.5, 190, 1, [255, 90, 90, 150]);
  fillRect(x + core.x * scale, top - 8, 0.7, LEN + 16, [90, 255, 140, 110]);
  fillRect(x + (core.x + core.w) * scale, top - 8, 0.7, LEN + 16, [90, 255, 140, 110]);
};

// A：现方案（帽 40 源像素 = 2%，体为整段渐变）—— 尾部发灰发白
drawBody(XS[0], { capTopPx: 40, capBottomPx: 40, bodyFromPct: 0.02, bodyToPct: 0.98 });
// B：帽 10%（保留一小段灰白尾帽）+ 体 = 青色段
drawBody(XS[1], { capTopPx: 200, capBottomPx: 200, bodyFromPct: 0.55, bodyToPct: 0.98 });
// C：完全不出现灰白段：尾帽也取青色段，体 = 青色段
drawBody(XS[2], { capTopPx: 200, capBottomPx: 200, bodyFromPct: 0.6, bodyToPct: 0.98, capFromPct: 0.6 });
// D：体用纯色（取 55%..98% 段平均色）+ 灰白尾帽
drawBody(XS[3], { capTopPx: 200, capBottomPx: 200, solid: avgColor(1150, 1960, 60, 930) });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
const rows = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  rows[y * (W * 4 + 1)] = 0;
  buf.copy(rows, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
fs.mkdirSync('tools/out', { recursive: true });
const out = path.join('tools/out', 'hold-variants.png');
fs.writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`已导出 ${out}（长条长度 ${LEN}px，宽度 ${NOTE_WIDTH}px，红线=两端，绿线=宽度）`);
console.log(`  A(左1) 现方案：帽 40px 源(≈6px 目标)，体 = 整段渐变`);
console.log(`  B(左2) 帽 200px 源(≈30px 目标)，体 = 10%..90% 渐变段`);
console.log(`  C(左3) 帽 200px 源，体只取 55%..98%（青色段）`);
console.log(`  D(左4) 帽 200px 源，体用纯色 ${avgColor(1100, 1960, 60, 930).slice(0, 3).map((v) => Math.round(v)).join(',')} / alpha ${Math.round(avgColor(1100, 1960, 60, 930)[3])}`);
