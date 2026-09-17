/**
 * Canvas2D 渲染后端。
 * 画面区域按 16:9 contain 适配（与官方模拟器一致），世界坐标以画面中心为原点：
 *   screenX = cx + worldX(画面宽比例) × areaW
 *   screenY = cy − worldY(画面高比例) × areaH
 * 音符局部坐标（判定线坐标系内）：
 *   dx = positionX(官方 X) × 0.05625 × areaW
 *   dy = Y(t)(官方 Y) × 0.6 × areaH
 * 背面（below）音符：额外旋转 180° 并把 dx 取反（与 lchzh 模拟器一致）。
 */
import { LINE, NOTE } from '../core/units.js';

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
  const view = { width: 0, height: 0, areaW: 0, areaH: 0, cx: 0, cy: 0, dpr: 1 };
  let bgSource = null;
  let bgCache = { canvas: null, key: '' };

  function resize(cssWidth, cssHeight, dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1) {
    view.dpr = dpr;
    view.width = cssWidth;
    view.height = cssHeight;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const areaH = cssHeight;
    const areaW = Math.min(cssWidth, (cssHeight * 16) / 9);
    view.areaH = areaH;
    view.areaW = areaW;
    view.cx = (cssWidth - areaW) / 2 + areaW / 2;
    view.cy = areaH / 2;
  }

  const toScreenX = (worldXFrac) => view.cx + worldXFrac * view.areaW;
  const toScreenY = (worldYFrac) => view.cy - worldYFrac * view.areaH;

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
    ctx.translate(toScreenX(ls.worldX), toScreenY(ls.worldY));
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
    const dyScale = 0.6 * view.areaH;
    const dx = note.positionX * 0.05625 * view.areaW * (note.above ? 1 : -1);
    const offsetPx = (note.yOffset || 0) * note.speed * dyScale * (note.above ? -1 : 1);

    ctx.save();
    ctx.translate(toScreenX(line.worldX), toScreenY(line.worldY));
    ctx.rotate(-line.worldRotate);
    if (!note.above) ctx.rotate(Math.PI);
    ctx.globalAlpha = note.renderAlpha;

    if (note.type === 'hold') {
      const headY = note.headY ?? note.distY;
      const tailY = note.tailY ?? headY;
      const yHead = -headY * dyScale;
      const yTail = -tailY * dyScale;
      const top = Math.min(yHead, yTail);
      const bottom = Math.max(yHead, yTail);
      const total = bottom - top;
      if (total > 0.5) {
        const cap = Math.min(tex.height * 0.08, total / 2);
        const x = dx - width / 2;
        const t0 = top + offsetPx;
        const t1 = bottom + offsetPx;
        ctx.drawImage(tex, 0, 0, tex.width, cap, x, t0, width, cap); // 尾部（贴图上方）
        if (total > cap * 2) {
          ctx.drawImage(tex, 0, cap, tex.width, Math.max(1, tex.height - cap * 2), x, t0 + cap, width, total - cap * 2);
        }
        ctx.drawImage(tex, 0, tex.height - cap, tex.width, cap, x, t1 - cap, width, cap); // 头部（靠线）
      }
    } else {
      const height = (width * tex.height) / tex.width;
      const x = dx - width / 2;
      const y = -note.distY * dyScale - height / 2 - offsetPx;
      ctx.drawImage(tex, x, y, width, height);
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
      ctx.save();
      ctx.translate(toScreenX(hit.lineX), toScreenY(hit.lineY));
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
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
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

  return { view, opts, resize, draw, setBackground, textures, canvas };
}
