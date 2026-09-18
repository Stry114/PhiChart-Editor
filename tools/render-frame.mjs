// 离屏帧渲染器：用软件光栅化回放 Canvas2D 后端的绘制指令，导出 PNG。
// 目的：在没有浏览器的环境里也能「看到」渲染结果，用于复现/定位渲染问题。
//
// 命令行：
//   node tools/render-frame.mjs <chart.json> <时间秒> <输出.png> [--note-width 0.125] [--size 1280x720]
// 作为模块：
//   import { renderFrame } from './render-frame.mjs';
//   await renderFrame({ chartFile, timeSec, outFile });
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng } from './png.mjs';

// ---------------------------------------------------------------- 通用工具
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const invert = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const parseColor = (c) => {
  if (typeof c !== 'string') return [255, 255, 255, 1];
  const t = c.trim();
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  const h = /^#([0-9a-f]{6})$/i.exec(t);
  if (h) return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16), 1];
  return [255, 255, 255, 1];
};

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
};

/**
 * 软件画布：给离屏画布（预着色图集等）提供真实的像素缓冲与最小 2D 能力，
 * 这样 drawImage/globalCompositeOperation='source-in' 等预处理路径在 Node 里也能得到正确像素。
 */
function makeSoftwareCanvas(w, h) {
  const st = { w: Math.max(1, w), h: Math.max(1, h), buf: null, fillStyle: '#000', comp: 'source-over', alpha: 1 };
  const alloc = () => {
    st.buf = Buffer.alloc(st.w * st.h * 4);
  };
  alloc();
  const canvas = { style: {} };
  Object.defineProperty(canvas, 'width', {
    get: () => st.w,
    set: (v) => {
      st.w = Math.max(1, Math.round(v));
      alloc();
    },
  });
  Object.defineProperty(canvas, 'height', {
    get: () => st.h,
    set: (v) => {
      st.h = Math.max(1, Math.round(v));
      alloc();
    },
  });
  const ctx = {
    canvas,
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    rotate() {},
    clearRect() {
      st.buf.fill(0);
    },
    drawImage(img) {
      const px = img?.__pixels;
      if (!px) return;
      for (let y = 0; y < Math.min(px.height, st.h); y++) {
        for (let x = 0; x < Math.min(px.width, st.w); x++) {
          const [r, g, b, a] = px.px(x, y);
          if (!a) continue;
          const i = (y * st.w + x) * 4;
          st.buf[i] = r;
          st.buf[i + 1] = g;
          st.buf[i + 2] = b;
          st.buf[i + 3] = a;
        }
      }
    },
    fillRect(x, y, w2, h2) {
      const [r, g, b, ca] = parseColor(st.fillStyle);
      const a8 = ca * st.alpha;
      if (st.comp === 'source-in') {
        // 预着色：保留原有 alpha（再乘填充色的 alpha），颜色换成填充色
        for (let i = 0; i < st.w * st.h; i++) {
          const o = i * 4;
          st.buf[o] = r;
          st.buf[o + 1] = g;
          st.buf[o + 2] = b;
          st.buf[o + 3] = Math.round(st.buf[o + 3] * a8);
        }
        return;
      }
      for (let yy = Math.max(0, y); yy < Math.min(st.h, y + h2); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(st.w, x + w2); xx++) {
          const o = (yy * st.w + xx) * 4;
          st.buf[o] = r;
          st.buf[o + 1] = g;
          st.buf[o + 2] = b;
          st.buf[o + 3] = Math.round(255 * a8);
        }
      }
    },
    getImageData(_x, _y, gw, gh) {
      return { data: new Uint8ClampedArray(st.buf), width: gw ?? st.w, height: gh ?? st.h };
    },
  };
  Object.defineProperty(ctx, 'canvas', { get: () => canvas });
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => st.fillStyle,
    set: (v) => {
      st.fillStyle = v;
    },
  });
  Object.defineProperty(ctx, 'globalAlpha', {
    get: () => st.alpha,
    set: (v) => {
      st.alpha = v;
    },
  });
  Object.defineProperty(ctx, 'globalCompositeOperation', {
    get: () => st.comp,
    set: (v) => {
      st.comp = v;
    },
  });
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas, '__pixels', {
    get: () => ({
      width: st.w,
      height: st.h,
      px: (x, y) => {
        if (x < 0 || y < 0 || x >= st.w || y >= st.h) return [0, 0, 0, 0];
        const i = (y * st.w + x) * 4;
        return [st.buf[i], st.buf[i + 1], st.buf[i + 2], st.buf[i + 3]];
      },
    }),
  });
  return canvas;
}

// ---------------------------------------------------------------- DOM / Image 桩件
const imageCache = new Map();
const HOLD_CALLS = [];
const DUMP_HOLD = !!process.env.DSH_DUMP_HOLD;
const DBG_FILL = !!process.env.DSH_DBG_FILL;
let dbgBudget = Number(process.env.DSH_DBG_PIXELS ?? 0);
function installDomStubs(VW, VH, buffer) {
  const blendPx = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= VW || y >= VH || a <= 0) return;
    const i = (y * VW + x) * 4;
    const al = a / 255;
    buffer[i] = Math.round(r * al + buffer[i] * (1 - al));
    buffer[i + 1] = Math.round(g * al + buffer[i + 1] * (1 - al));
    buffer[i + 2] = Math.round(b * al + buffer[i + 2] * (1 - al));
  };
  const drawRect = (m, x, y, w, h, rgba) => {
    const inv = invert(m);
    if (!inv) return;
    const corners = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const maxX = Math.min(VW - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const maxY = Math.min(VH - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    for (let py = minY; py <= maxY; py++) {
      for (let pxx = minX; pxx <= maxX; pxx++) {
        const [lx, ly] = apply(inv, pxx + 0.5, py + 0.5);
        if (lx < x || lx >= x + w || ly < y || ly >= y + h) continue;
        blendPx(pxx, py, rgba[0], rgba[1], rgba[2], rgba[3]);
      }
    }
  };
  const makeRecordingContext = () => {
    let m = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const saved = [];
    const state = { alpha: 1 };
    const ctx = {
      canvas: { width: VW, height: VH },
      filter: 'none',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000',
      font: '',
      save() {
        stack.push([...m]);
        saved.push({ ...state });
      },
      restore() {
        if (stack.length) m = stack.pop();
        if (saved.length) Object.assign(state, saved.pop());
        ctx.globalAlpha = state.alpha;
      },
      setTransform(a, b, c, d, e, f) {
        m = [a, b, c, d, e, f];
      },
      translate(x, y) {
        m = mul(m, [1, 0, 0, 1, x, y]);
      },
      rotate(r) {
        m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
      },
      scale(x, y) {
        m = mul(m, [x, 0, 0, y, 0, 0]);
      },
      clearRect() {},
      getImageData(_x, _y, gw, gh) {
        // 与浏览器一致：返回最近一次 drawImage 的贴图像素（供长条分段自动识别使用）
        const src = ctx.__lastImage?.__pixels;
        const out = new Uint8ClampedArray(gw * gh * 4);
        if (src) {
          for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
              const [r, g, b, a] = src.px(x, y);
              const i = (y * gw + x) * 4;
              out[i] = r;
              out[i + 1] = g;
              out[i + 2] = b;
              out[i + 3] = a;
            }
          }
        }
        return { data: out, width: gw, height: gh };
      },
      fillRect(x, y, w, h) {
        const [r, g, b, ca] = parseColor(ctx.fillStyle);
        const alpha = 255 * state.alpha * ca;
        if (DBG_FILL) {
          const [scx, scy] = apply(m, x + w / 2, y + h / 2);
          console.log(`  [fill] rgba(${r},${g},${b},${alpha.toFixed(0)}) 尺寸 ${w.toFixed(1)}x${h.toFixed(1)} @(${x.toFixed(1)},${y.toFixed(1)}) 屏幕(${scx.toFixed(1)},${scy.toFixed(1)}) m=[${m.map((v) => v.toFixed(2)).join(',')}]`);
        }
        drawRect(m, x, y, w, h, [r, g, b, alpha]);
      },
      drawImage(img, ...rest) {
        const inv = invert(m);
        const px = img?.__pixels;
        if (!inv || !px) return;
        if (rest.length <= 2) ctx.__lastImage = img;
        let sx = 0, sy = 0, sw = img.width ?? 1, sh = img.height ?? 1, dx, dy, dw, dh;
        if (rest.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = rest;
        else if (rest.length === 4) [dx, dy, dw, dh] = rest;
        else [dx, dy] = rest;
        if (DUMP_HOLD && img.__key && /hold/i.test(img.__key)) {
          HOLD_CALLS.push({ tex: img.__key, sx, sy, sw, sh, dx: +Number(dx).toFixed(1), dy: +Number(dy).toFixed(1), dw: +Number(dw).toFixed(1), dh: +Number(dh).toFixed(1) });
        }
        const corners = [apply(m, dx, dy), apply(m, dx + dw, dy), apply(m, dx, dy + dh), apply(m, dx + dw, dy + dh)];
        const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
        const maxX = Math.min(VW - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
        const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
        const maxY = Math.min(VH - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const [lx, ly] = apply(inv, x + 0.5, y + 0.5);
            if (lx < dx || lx >= dx + dw || ly < dy || ly >= dy + dh) continue;
            // 注意：源坐标要钳制到**贴图**尺寸，而不是切片尺寸（否则 sy>0 的切片会采样到错误行）
            const u = Math.min((img.width ?? 1) - 1, Math.max(0, Math.floor(sx + ((lx - dx) / dw) * sw)));
            const v = Math.min((img.height ?? 1) - 1, Math.max(0, Math.floor(sy + ((ly - dy) / dh) * sh)));
            const [r, g, b, a] = px.px(u, v);
            if (DUMP_HOLD && dbgBudget > 0 && sh > 100) {
              dbgBudget--;
              console.log(
                `  [dbg] ${img.__key} 源(${u},${v}) rgba(${r},${g},${b},${a}) → 目标(${x},${y}) 调用 sy=${sy} sh=${sh} dh=${dh.toFixed(1)}`,
              );
            }
            if (!a) continue;
            blendPx(x, y, r, g, b, a * state.alpha);
          }
        }
      },
      measureText: () => ({ width: 0 }),
      fillText() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      set lineWidth(_v) {},
      set strokeStyle(_v) {},
    };
    return ctx;
  };
  const bufferBlend = blendPx;
  void bufferBlend;

  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeSoftwareCanvas(1, 1) : { style: {} }),
  };
  globalThis.Image = class {
    constructor() {
      this.width = 1;
      this.height = 1;
    }
    set src(url) {
      const file = String(url).replace(/^\.\//, '');
      this.__key = file;
      const cached = imageCache.get(file);
      if (cached) {
        this.width = cached.width;
        this.height = cached.height;
        this.__pixels = cached.__pixels;
      } else if (fs.existsSync(file)) {
        const { w, h, px } = decodePng(fs.readFileSync(file));
        this.width = w;
        this.height = h;
        this.__pixels = { width: w, height: h, px };
        imageCache.set(file, { width: w, height: h, __pixels: this.__pixels });
      }
      setTimeout(() => this.onload?.(), 0);
    }
  };
  return makeRecordingContext();
}

let texturesCache = null;
async function getTextures() {
  if (!texturesCache) {
    const { loadTextures } = await import('../src/render/textures.js');
    texturesCache = await loadTextures('assets/');
  }
  return texturesCache;
}

/**
 * 渲染一帧到 PNG。
 * @param {{chartFile:string, timeSec:number, outFile:string, width?:number, height?:number, noteWidthRatio?:number, multiHint?:boolean, background?:boolean}} opts
 */
export async function renderFrame(opts) {
  const { chartFile, timeSec, outFile } = opts;
  const VW = opts.width ?? 1280;
  const VH = opts.height ?? 720;
  const buffer = Buffer.alloc(VW * VH * 4);
  for (let i = 0; i < VW * VH; i++) {
    buffer[i * 4] = 13;
    buffer[i * 4 + 1] = 13;
    buffer[i * 4 + 2] = 18;
    buffer[i * 4 + 3] = 255;
  }
  const ctx = installDomStubs(VW, VH, buffer);

  const { parseOfficialChart } = await import('../src/core/parse-official.js');
  const { parseRpeChart } = await import('../src/core/parse-rpe.js');
  const { prepareChart, detectFormat } = await import('../src/core/model.js');
  const { createState, evaluate, advanceJudging } = await import('../src/core/state.js');
  const { createCanvasRenderer } = await import('../src/render/canvas2d.js');

  const textures = await getTextures();
  const renderer = createCanvasRenderer({ width: VW, height: VH, style: {}, getContext: () => ctx }, textures);
  renderer.opts.noteWidthRatio = opts.noteWidthRatio ?? 1 / 8;
  if (opts.holdSample) renderer.opts.holdSample = opts.holdSample;
  if (opts.multiHint === false) renderer.opts.multiHint = false;  renderer.resize(VW, VH, 1);

  const raw = JSON.parse(fs.readFileSync(chartFile, 'utf8'));
  const format = detectFormat(raw);
  const chart = prepareChart(format === 'rpe' ? parseRpeChart(raw) : parseOfficialChart(raw));
  const state = createState(chart);
  // 与应用的播放循环一致：每步先求值再判定，保留仍在生命周期内的命中特效
  let hits = [];
  if (opts.judge !== false) {
    const step = 1 / 60;
    const fxDuration = opts.fxDuration ?? 0.5;
    for (let t = 0; t <= timeSec + 1e-9; t += step) {
      const tt = Math.min(t, timeSec);
      evaluate(state, tt);
      for (const hit of advanceJudging(state, tt)) {
        hits.push(hit);
      }
      hits = hits.filter((h) => timeSec - h.time <= fxDuration);
    }
  }
  evaluate(state, timeSec);
  if (DBG_FILL) console.log('  [hits]', JSON.stringify(hits.map((h) => ({ lineId: h.lineId, time: h.time, lineX: h.lineX, lineY: h.lineY, lineRotate: h.lineRotate, offsetX: h.offsetX, offsetY: h.offsetY, above: h.above }))));
  renderer.draw(state, hits);

  writePng(outFile, VW, VH, buffer);
  const visible = chart.notes.filter((n) => n.visible);
  const byType = visible.reduce((a, n) => ((a[n.type] = (a[n.type] ?? 0) + 1), a), {});
  return { format, visible, byType, chart, state, hits };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/render-frame.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const chartFile = args[0];
  const timeSec = Number(args[1] ?? 0);
  const outFile = args[2] ?? 'tools/out/frame.png';
  const size = String(flag('size', '1280x720')).split('x').map(Number);
  const res = await renderFrame({
    chartFile,
    timeSec,
    outFile,
    width: size[0],
    height: size[1],
    noteWidthRatio: Number(flag('note-width', 1 / 8)),
    holdSample: flag('hold-sample', undefined),
    multiHint: !args.includes('--no-multi'),
  });
  if (DUMP_HOLD) {
    console.log('--- 长条绘制调用 (tex sx sy sw sh dx dy dw dh) ---');
    for (const c of HOLD_CALLS) console.log(`  ${JSON.stringify(c)}`);
  }
  console.log(`已导出 ${outFile}  (${size[0]}x${size[1]})  t=${timeSec}s  格式=${res.format}`);
  console.log(`可见音符 ${res.visible.length}：${JSON.stringify(res.byType)}　命中特效 ${res.hits.length} 个`);
  for (const h of res.visible.filter((n) => n.type === 'hold').slice(0, 8)) {
    console.log(
      `  Hold line=${h.lineId} t=${h.timeSec.toFixed(3)} dur=${h.durationSec.toFixed(3)}s ` +
        `headY=${h.headY.toFixed(2)} tailY=${h.tailY.toFixed(2)} 长度=${(Math.abs(h.tailY - h.headY) * 0.6 * size[1]).toFixed(0)}px isMulti=${!!h.isMulti}`,
    );
  }
}
