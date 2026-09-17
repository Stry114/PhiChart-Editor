// Decode a PNG (8-bit RGBA/greyscale) and report dominant colors + a few sample pixels.
// usage: node tools/sample-colors.mjs <file.png> [...]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('color type ' + colorType + ' unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  const px = (x, y) => {
    const i = y * stride + x * channels;
    const ga = channels >= 3 ? [out[i], out[i + 1], out[i + 2]] : [out[i], out[i], out[i]];
    const alpha = channels === 4 ? out[i + 3] : channels === 2 ? out[i + 1] : 255;
    return [...ga, alpha];
  };
  return { w, h, channels, px };
}

for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const { w, h, px } = decodePng(buf);
  const hist = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = px(x, y);
    if (a < 200) continue;
    const k = `${r},${g},${b}`;
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const top = [...hist.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
  const hex = (s) => '#' + s.split(',').map((n) => (+n).toString(16).padStart(2, '0')).join('');
  console.log(`${file}  ${w}x${h}`);
  console.log('  主要不透明颜色: ' + top.map(([c, n]) => `${c} (${hex(c)}) x${n}`).join('  |  '));
  console.log('  采样: 中心 ' + JSON.stringify(px(w >> 1, h >> 1)) + '  左侧 ' + JSON.stringify(px(Math.floor(w * 0.2), h >> 1)) + '  顶部中心 ' + JSON.stringify(px(w >> 1, Math.floor(h * 0.05))));
}
