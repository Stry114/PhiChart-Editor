// 裁剪并放大 PNG 的某个区域（用于放大观察渲染细节）
// 用法：node tools/crop-png.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodePng } from './png.mjs';

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
const writePng = (file, w, h, buf) => {
  const stride = w * 4;
  const rows = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0;
    buf.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]),
  );
};

const [inFile, outFile, xs, ys, ws, hs, ss] = process.argv.slice(2);
const x0 = Number(xs);
const y0 = Number(ys);
const w = Number(ws);
const h = Number(hs);
const scale = Number(ss ?? 1);
const img = decodePng(fs.readFileSync(inFile));
const outW = Math.round(w * scale);
const outH = Math.round(h * scale);
const out = Buffer.alloc(outW * outH * 4);
for (let y = 0; y < outH; y++) {
  for (let x = 0; x < outW; x++) {
    const sx = Math.min(img.w - 1, Math.max(0, x0 + Math.floor(x / scale)));
    const sy = Math.min(img.h - 1, Math.max(0, y0 + Math.floor(y / scale)));
    const [r, g, b] = img.px(sx, sy);
    const di = (y * outW + x) * 4;
    out[di] = r;
    out[di + 1] = g;
    out[di + 2] = b;
    out[di + 3] = 255;
  }
}
writePng(outFile, outW, outH, out);
console.log(`已导出 ${outFile}（${x0},${y0} ${w}x${h} ×${scale}）`);
