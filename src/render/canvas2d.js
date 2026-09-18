/**
 * Canvas2D 渲染后端。
 * 坐标换算全部委托给 render/projection.js（与制谱器的点选/叠加层共用同一套公式）。
 * 画面区域按 16:9 contain 适配；音符背面（below）额外旋转 180° 并把 dx 取反（与 lchzh 模拟器一致）。
 */
import { LINE, NOTE } from '../core/units.js';
import { createProjection, pickNote, pickLine } from './projection.js';
import { textureMeta } from './textures.js';
import { computeHoldSlices, computeNoteRect } from './hold-geometry.js';

const drawOrder = ['hold', 'drag', 'tap', 'flick']; // 参考 sim-phi 的绘制顺序

/** 打击特效着色（与 textures.js 里给 hit.png 预着色的颜色一致）——溅射小方块沿用同一颜色 */
const HIT_FX_COLOR = { perfect: [255, 236, 160], good: [180, 225, 255] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 溅射小方块的默认参数（4–8 个、约特效的 1/8 大小、溅射半径 = 1× 特效宽度、持续 42 帧） */
export const HIT_PARTICLES_DEFAULT = {
  enabled: true,
  min: 4,
  max: 8,
  sizeRatio: 1 / 8,
  radiusScale: 1,
  alpha: 0.75,
};

export function createCanvasRenderer(canvas, textures, options = {}) {
  const ctx = canvas.getContext('2d');
  const opts = {
    noteWidthRatio: NOTE.DEFAULT_WIDTH_RATIO,
    multiHint: true,
    showHitFx: true,
    hitFxScale: 1.5,
    hitFxDuration: NOTE.HIT_DURATION,
    /** 命中时的溅射小方块（颜色同特效着色、略半透明、三次缓出） */
    hitParticles: { ...HIT_PARTICLES_DEFAULT },
    showLines: true,
    showNotes: true,
    backgroundBrightness: 0.4,
    backgroundBlur: 120,
    lineTexture: null, // HTMLImageElement | null（自定义判定线材质）
    /**
     * 长条取样预设（仅在贴图**没有**明确分段时生效；有分段则按分段绘制）：
     * gradient（默认，整根渐变，与贴图观感一致）/ tailCap（短灰白尾帽 + 青体）/ uniform（全青）
     */
    holdSample: 'gradient',
    ...options,
  };
  let view = createProjection(1, 1);
  let dpr = 1;
  let bgSource = null;
  let bgCache = { canvas: null, key: '' };

  function resize(cssWidth, cssHeight, devicePixelRatio = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1) {
    dpr = devicePixelRatio;
    view = createProjection(cssWidth, cssHeight, { aspect: 16 / 9 });
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  function setBackground(img) {
    bgSource = img ?? null;
    bgCache = { canvas: null, key: '' };
  }

  function ensureBackground() {
    if (!bgSource) return null;
    const key = `${Math.round(view.areaW)}x${Math.round(view.areaH)}:${opts.backgroundBrightness}:${opts.backgroundBlur}`;
    if (bgCache.key !== key) {
      bgCache.canvas = renderBackground(bgSource, view.areaW, view.areaH);
      bgCache.key = key;
    }
    return bgCache.canvas;
  }

  function renderBackground(img, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d');
    const scale = Math.max(c.width / img.width, c.height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const pad = opts.backgroundBlur;
    g.filter = `blur(${pad}px) brightness(${opts.backgroundBrightness})`;
    g.drawImage(img, (c.width - dw) / 2 - pad, (c.height - dh) / 2 - pad, dw + pad * 2, dh + pad * 2);
    g.filter = 'none';
    return c;
  }

  function drawLine(ls) {
    const alpha = Math.max(0, Math.min(1, ls.alpha));
    if (alpha <= 0) return;
    const length = LINE.LENGTH_H * view.areaH;
    const thickness = Math.max(1, LINE.THICKNESS_H * view.areaH);
    const color = ls.color ?? LINE.COLOR;
    ctx.save();
    ctx.translate(view.toScreenX(ls.worldX), view.toScreenY(ls.worldY));
    ctx.rotate(-ls.worldRotate); // 世界逆时针为正，画布顺时针为正
    ctx.globalAlpha = alpha;
    if (opts.lineTexture) {
      ctx.drawImage(opts.lineTexture, -length / 2, -thickness / 2, length, thickness);
    } else {
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
      ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
    }
    ctx.restore();
  }

  function textureFor(note) {
    const key = opts.multiHint && note.isMulti ? `${note.type}HL` : note.type;
    return textures[key] ?? textures[note.type] ?? null;
  }

  function drawNote(note, line) {
    const tex = textureFor(note);
    if (!tex) return;
    const meta = textureMeta(tex);
    // 尺寸由**本体（不透明核心）**决定，而不是整张贴图 —— 否则 HL 贴图的光效会被当成本体，
    // 音符会大一圈、长条两端会被撑长（见 textures.js 的 TEXTURE_TRIM 说明）。
    const width = opts.noteWidthRatio * view.areaW * (note.size || 1);
    const scale = width / meta.core.w;

    if (note.type === 'hold') {
      const head = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio, distY: note.headY ?? note.distY });
      const tail = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio, distY: note.tailY ?? note.headY ?? note.distY });
      const total = Math.abs(head.localY - tail.localY);
      if (total <= 0.5) return;
      // 切片几何由 hold-geometry.js 统一计算（与预览工具/测试共用同一套规则）
      const slices = computeHoldSlices({
        meta,
        headLocalY: head.localY,
        tailLocalY: tail.localY,
        texW: tex.width,
        scale,
        preset: opts.holdSample,
      });
      // 水平位置：落点偏移（含 positionX 与上下侧符号） + 本体中心对齐
      const xLeft = head.localX - (meta.core.x + meta.core.w / 2) * scale;
      const fullW = tex.width * scale;
      ctx.save();
      ctx.translate(view.toScreenX(line.worldX), view.toScreenY(line.worldY));
      ctx.rotate(-head.angle);
      ctx.globalAlpha = note.renderAlpha;
      for (const s of slices) ctx.drawImage(tex, s.sx, s.sy, s.sw, s.sh, xLeft, s.dy, fullW, s.dh);
      ctx.restore();
      return;
    }

    const t = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio });
    const rect = computeNoteRect({ meta, texW: tex.width, texH: tex.height, scale });
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(-t.angle);
    ctx.globalAlpha = note.renderAlpha;
    // 整张贴图按本体缩放，并让本体中心对齐落点（光效自然溢出到本体之外）
    ctx.drawImage(tex, rect.dx, rect.dy, rect.dw, rect.dh);
    ctx.restore();
  }

  /** 打击特效的溅射小方块：由命中记录派生**稳定**的伪随机量（同一特效每帧结果一致） */
  function hash01(seed, i) {
    const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawHitParticles(hit, age, seed, size) {
    const p = opts.hitParticles;
    if (!p?.enabled) return;
    const u = clamp(age / opts.hitFxDuration, 0, 1);
    // 三次缓出：起始速度很快、末尾很慢（r = R · (1 − (1−u)³)）
    const radius = size * (p.radiusScale ?? 1) * (1 - Math.pow(1 - u, 3));
    const alpha = (p.alpha ?? 0.75) * (1 - u);
    if (alpha <= 0.01) return;
    const count = (p.min ?? 4) + Math.floor(hash01(seed, 0) * ((p.max ?? 8) - (p.min ?? 4) + 1));
    const baseSize = size * (p.sizeRatio ?? 1 / 8);
    const [r, g, b] = hit.perfect ? HIT_FX_COLOR.perfect : HIT_FX_COLOR.good;
    const cx = view.toScreenX(hit.lineX);
    const cy = view.toScreenY(hit.lineY);
    const localX = hit.offsetX * view.areaW * (hit.above ? 1 : -1);
    const localY = -hit.offsetY * view.areaH;
    const rot = hit.lineRotate * (hit.above ? -1 : 1) + (hit.above ? 0 : Math.PI);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    ctx.save();
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    for (let i = 0; i < count; i++) {
      const angle = hash01(seed, i * 4 + 1) * Math.PI * 2;
      const dist = radius * (0.75 + 0.25 * hash01(seed, i * 4 + 2));
      const lx = localX + Math.cos(angle) * dist;
      const ly = localY + Math.sin(angle) * dist;
      // 判定线局部坐标 → 屏幕坐标（线与音符一样可能带旋转/背面翻转）
      const sx = cx + lx * cos - ly * sin;
      const sy = cy + lx * sin + ly * cos;
      const s = baseSize * (0.75 + 0.5 * hash01(seed, i * 4 + 3));
      const spin = hash01(seed, i * 4 + 4) * Math.PI;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(spin);
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawHitFx(hits, now) {
    const framesX = NOTE.HIT_FRAMES_X;
    const framesY = NOTE.HIT_FRAMES_Y;
    const total = framesX * framesY;
    const size = opts.noteWidthRatio * view.areaW * opts.hitFxScale;
    for (const hit of hits) {
      const age = now - hit.time;
      if (age < 0 || age > opts.hitFxDuration) continue;
      const atlas = (hit.perfect ? textures.hitPerfect : textures.hitGood) ?? textures.hit;
      if (!atlas) continue;
      const fw = atlas.width / framesX;
      const fh = atlas.height / framesY;
      const idx = Math.min(total - 1, Math.floor((age / opts.hitFxDuration) * total));
      const sx = (idx % framesX) * fw;
      const sy = Math.floor(idx / framesX) * fh;
      const h = (size * fh) / fw;
      const localX = hit.offsetX * view.areaW * (hit.above ? 1 : -1);
      const localY = -hit.offsetY * view.areaH;
      // 溅射小方块画在特效贴图之下（起始时被特效盖住，随后飞散出去）
      drawHitParticles(hit, age, hit.time * 1000 + hit.lineId, size);
      ctx.save();
      ctx.translate(view.toScreenX(hit.lineX), view.toScreenY(hit.lineY));
      ctx.rotate(-hit.lineRotate);
      if (!hit.above) ctx.rotate(Math.PI);
      ctx.drawImage(atlas, sx, sy, fw, fh, localX - size / 2, localY - h / 2, size, h);
      ctx.restore();
    }
  }

  /**
   * @param {object} state core/state.js 的状态对象
   * @param {Array} hits 存活的打击特效列表（由 app 维护）
   */
  function draw(state, hits = []) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);

    const bg = ensureBackground();
    if (bg) {
      ctx.drawImage(bg, (view.width - view.areaW) / 2, 0, view.areaW, view.areaH);
    } else {
      ctx.fillStyle = '#0d0d12';
      ctx.fillRect(0, 0, view.width, view.height);
    }

    if (opts.showLines) {
      const order = state.chart.lines
        .map((_, i) => i)
        .sort((a, b) => (state.chart.lines[a].zOrder || 0) - (state.chart.lines[b].zOrder || 0));
      for (const i of order) drawLine(state.lines[i]);
    }

    if (opts.showNotes) {
      for (const type of drawOrder) {
        for (const note of state.chart.notes) {
          if (note.type !== type || !note.visible) continue;
          drawNote(note, state.lines[note.lineId]);
        }
      }
    }

    if (opts.showHitFx) drawHitFx(hits, state.time);
  }

  return {
    opts,
    canvas,
    textures,
    resize,
    draw,
    setBackground,
    /** 当前投影（制谱器可用来做点选与叠加层绘制，见 docs/05 §8） */
    get projection() {
      return view;
    },
    get view() {
      return view;
    },
    /** 屏幕像素点选音符 / 判定线（供制谱器使用） */
    pickNote: (state, px, py, radius = 24) => pickNote(view, state, px, py, radius, { noteWidthRatio: opts.noteWidthRatio }),
    pickLine: (state, px, py, tolerance = 10) => pickLine(view, state, px, py, tolerance),
  };
}
