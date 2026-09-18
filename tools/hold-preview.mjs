// Hold 绘制的「软件光栅化预览」：不依赖浏览器，直接把切片结果画进位图并导出 PNG，
// 用于肉眼核对长条几何（头尾帽是否被拉长、HL 光效是否被当成本体、极短 Hold 是否还有本体）。
//
// 对照三列：新算法（普通 Hold） / 新算法（双押 HoldHL） / 旧算法（bug：帽高按源像素当目标像素）
// 运行：node tools/hold-preview.mjs   ->  tools/out/hold-preview.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng } from './png.mjs';
import { computeHoldSlices } from '../src/render/hold-geometry.js';

const OUT_DIR = 'tools/out';
const W = 1200;
const H = 760;
const NOTE_WIDTH = 130; // 目标本体宽度（像素）
const ROWS = [
  { label: '长 Hold（420px）', length: 420, y0: 70 },
  { label: '极短 Hold（60px）', length: 60, y0: 470 },
];
const COLS = [
  { label: '新算法·普通', x: 150, tex: 'hold', mode: 'new' },
  { label: '新算法·双押(HL)', x: 600, tex: 'holdHL', mode: 'new' },
  { label: '旧算法(bug)', x: 1050, tex: 'hold', mode: 'old' },
];

// ---------------------------------------------------------------- 贴图与元数据
const TEX = {
  hold: { ...decodePng(fs.readFileSync('assets/Hold.png')) },
  holdHL: { ...decodePng(fs.readFileSync('assets/HoldHL.png')) },
};
const META = {
  hold: { core: { x: 0, y: 0, w: 989, h: 2000 }, content: { x: 0, y: 0, w: 989, h: 2000 }, capPx: 40 },
  holdHL: { core: { x: 49, y: 49, w: 964, h: 1950 }, content: { x: 9, y: 48, w: 1044, h: 1991 }, capPx: 39 },
};

/** 旧实现（有 bug）：整张贴图当本体，帽高 = 源像素 8% 直接当目标像素 */
function oldSlices(tex, meta, total) {
  const top = 0;
  const bottom = total;
  const cap = Math.min(tex.h * 0.08, total / 2);
  const out = [{ sx: 0, sy: 0, sw: tex.w, sh: cap, dy: top, dh: cap, kind: 'body' }];
  if (total > cap * 2) out.push({ sx: 0, sy: cap, sw: tex.w, sh: tex.h - cap * 2, dy: top + cap, dh: total - cap * 2, kind: 'body' });
  out.push({ sx: 0, sy: tex.h - cap, sw: tex.w, sh: cap, dy: bottom - cap, dh: cap, kind: 'body' });
  void meta;
  return out;
}

// ---------------------------------------------------------------- 画布
const buf = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  buf[i * 4] = 24;
  buf[i * 4 + 1] = 24;
  buf[i * 4 + 2] = 30;
  buf[i * 4 + 3] = 255;
}
const blend = (x, y, r, g, b, a8) => {
  if (x < 0 || y < 0 || x >= W || y >= H || a8 <= 0) return;
  const i = (y * W + x) * 4;
  const a = a8 / 255;
  buf[i] = Math.round(r * a + buf[i] * (1 - a));
  buf[i + 1] = Math.round(g * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(b * a + buf[i + 2] * (1 - a));
};
const fillRect = (x, y, w, h, [r, g, b, a8]) => {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(H, Math.ceil(y + h)); yy++) {
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(W, Math.ceil(x + w)); xx++) blend(xx, yy, r, g, b, a8);
  }
};
const blit = (tex, sx, sy, sw, sh, dx, dy, dw, dh) => {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return;
  for (let y = 0; y < Math.round(dh); y++) {
    const srcY = Math.min(tex.h - 1, Math.max(0, Math.floor(sy + ((y + 0.5) / dh) * sh)));
    for (let x = 0; x < Math.round(dw); x++) {
      const srcX = Math.min(tex.w - 1, Math.max(0, Math.floor(sx + ((x + 0.5) / dw) * sw)));
      const [r, g, b, a] = tex.px(srcX, srcY);
      if (a === 0) continue;
      blend(Math.round(dx) + x, Math.round(dy) + y, r, g, b, a);
    }
  }
};

// ---------------------------------------------------------------- 绘制网格
console.log('Hold 绘制几何对照（本体宽度目标 %dpx）\n', NOTE_WIDTH);
for (const row of ROWS) {
  for (const col of COLS) {
    const tex = TEX[col.tex];
    const meta = META[col.tex];
    const scale = NOTE_WIDTH / (col.mode === 'new' ? meta.core.w : tex.w);
    const slices =
      col.mode === 'new'
        ? computeHoldSlices({ meta, headLocalY: row.y0 + row.length, tailLocalY: row.y0, texW: tex.w, texH: tex.h, scale })
        : oldSlices(tex, meta, row.length);
    const xLeft = col.x - (tex.w * scale) / 2; // 旧算法按整图宽度居中；新算法下面按本体居中
    const xLeftNew = col.x - (meta.core.x + meta.core.w / 2) * scale;
    const x = col.mode === 'new' ? xLeftNew : xLeft;
    const fullW = tex.w * scale;
    for (const s of slices) blit(tex, s.sx, s.sy, s.sw, s.sh, x, row.y0 + s.dy, fullW, s.dh);
    // 参考线：红线 = 长条几何长度的两端（头/尾应处位置）；绿线 = 设定本体宽度
    fillRect(x - 90, row.y0 - 0.5, 180, 1, [255, 90, 90, 160]);
    fillRect(x - 90, row.y0 + row.length - 0.5, 180, 1, [255, 90, 90, 160]);
    fillRect(x + meta.core.x * scale, row.y0 - 6, 0.6, row.length + 12, [90, 255, 140, 110]);
    fillRect(x + (meta.core.x + meta.core.w) * scale, row.y0 - 6, 0.6, row.length + 12, [90, 255, 140, 110]);
    const body = slices.filter((s) => s.kind === 'body');
    const bodyLen = body.reduce((t, s) => t + s.dh, 0);
    const mid = body.reduce((a, c) => (c.dh > a.dh ? c : a), body[0]);
    console.log(
      `${row.label.padEnd(16)} ${col.label.padEnd(14)} 本体 ${body.length} 段 合计 ${bodyLen.toFixed(1)}px  ` +
        `最大段 ${mid.dh.toFixed(1)}px  帽 ${body.filter((s) => s !== mid).map((s) => s.dh.toFixed(1)).join('/') || '—'}px`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------- 导出 PNG
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
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'hold-preview.png'),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`已导出 ${OUT_DIR}/hold-preview.png (${W}x${H})　红线 = 头/尾应处位置，绿线 = 设定本体宽度`);
