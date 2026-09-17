/**
 * Canvas2D 渲染后端。
 * 坐标换算全部委托给 render/projection.js（与制谱器的点选/叠加层共用同一套公式）。
 * 画面区域按 16:9 contain 适配；音符背面（below）额外旋转 180° 并把 dx 取反（与 lchzh 模拟器一致）。
 */
import { LINE, NOTE } from '../core/units.js';
import { createProjection, pickNote, pickLine } from './projection.js';

const drawOrder = ['hold', 'drag', 'tap', 'flick']; // 参考 sim-phi 的绘制顺序

export function createCanvasRenderer(canvas, textures, options = {}) {
  const ctx = canvas.getContext('2d');
  const opts = {
    noteWidthRatio: NOTE.DEFAULT_WIDTH_RATIO,
    multiHint: true,
    showHitFx: true,
    hitFxScale: 1.5,
    hitFxDuration: NOTE.HIT_DURATION,
    showLines: true,
    showNotes: true,
    backgroundBrightness: 0.4,
    backgroundBlur: 120,
    lineTexture: null, // HTMLImageElement | null（自定义判定线材质）
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
    const width = opts.noteWidthRatio * view.areaW * (note.size || 1);

    if (note.type === 'hold') {
      const head = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio, distY: note.headY ?? note.distY });
      const tail = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio, distY: note.tailY ?? note.headY ?? note.distY });
      const top = Math.min(head.localY, tail.localY);
      const bottom = Math.max(head.localY, tail.localY);
      const total = bottom - top;
      if (total <= 0.5) return;
      const cap = Math.min(tex.height * 0.08, total / 2);
      const x = head.localX - width / 2;
      ctx.save();
      ctx.translate(view.toScreenX(line.worldX), view.toScreenY(line.worldY));
      ctx.rotate(-head.angle);
      ctx.globalAlpha = note.renderAlpha;
      ctx.drawImage(tex, 0, 0, tex.width, cap, x, top, width, cap); // 尾部（贴图上方）
      if (total > cap * 2) {
        ctx.drawImage(tex, 0, cap, tex.width, Math.max(1, tex.height - cap * 2), x, top + cap, width, total - cap * 2);
      }
      ctx.drawImage(tex, 0, tex.height - cap, tex.width, cap, x, bottom - cap, width, cap); // 头部（靠线）
      ctx.restore();
      return;
    }

    const t = view.noteTransform(note, line, { noteWidthRatio: opts.noteWidthRatio });
    const height = (t.width * tex.height) / tex.width;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(-t.angle);
    ctx.globalAlpha = note.renderAlpha;
    ctx.drawImage(tex, -t.width / 2, -height / 2, t.width, height);
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
