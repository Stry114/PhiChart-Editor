/**
 * Canvas2D 渲染后端。
 * 坐标换算全部委托给 render/projection.js（与制谱器的点选/叠加层共用同一套公式）。
 * 画面区域按 16:9 contain 适配；音符背面（below）额外旋转 180° 并把 dx 取反（与 lchzh 模拟器一致）。
 */
import { LINE, NOTE, JUDGE } from '../core/units.js';
import { createProjection, pickNote, pickLine } from './projection.js';
import { textureMeta, makeBackground } from './textures.js';
import { computeHoldSlices, computeNoteRect } from './hold-geometry.js';

const drawOrder = ['hold', 'drag', 'tap', 'flick']; // 参考 sim-phi 的绘制顺序

/** 打击特效着色（与 textures.js 里给 hit.png 预着色的颜色一致）——溅射小方块沿用同一颜色 */
const HIT_FX_COLOR = { perfect: [255, 236, 160], good: [180, 225, 255] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 溅射小方块的默认参数（4–8 个、尺寸统一 = 特效宽 × 1/8 × 0.75、溅射半径 = 1× 特效宽度、持续 42 帧） */
export const HIT_PARTICLES_DEFAULT = {
  enabled: true,
  min: 4,
  max: 8,
  sizeRatio: 1 / 8,
  sizeFactor: 0.75, // 统一尺寸（原随机区间的下限）
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

  /**
   * 背景：cover 铺满 + 模糊 + 压暗。
   * 实现放在 `textures.js` 的 `makeBackground` —— 那里对**没有 `ctx.filter` 的浏览器
   * （iOS Safari）**做了「缩小再放大」的近似模糊，并把压暗改成不依赖 filter 的黑色叠加层，
   * 否则 iPhone/iPad 上模糊与压暗会一起失效。
   */
  function renderBackground(img, w, h) {
    return makeBackground(img, w, h, { blur: opts.backgroundBlur, brightness: opts.backgroundBrightness });
  }

  /** 颜色 → CSS rgb 串（扩展事件的颜色是 0–255 整数） */
  function cssColor(c) {
    const v = Array.isArray(c) ? c : [255, 255, 255];
    return `rgb(${clamp(Math.round(Number(v[0]) || 0), 0, 255)},${clamp(Math.round(Number(v[1]) || 0), 0, 255)},${clamp(Math.round(Number(v[2]) || 0), 0, 255)})`;
  }

  /**
   * 判定线的填充样式。
   *  - 没有 color 事件：判定线自身的颜色（全 Perfect 金 / 全连蓝 / 白）——纯色。
   *  - 有 color 事件：**完全按事件颜色**着色（不再与判定色相乘）。若当前线段两端颜色不同，
   *    额外返回首尾两色，由调用方画成线性渐变 —— 颜色事件本身就是「两端颜色插值」，
   *    用渐变画等于把这段插值直接画出来（长线段尤其明显）。
   */
  function linePaint(ls) {
    const ext = Array.isArray(ls.extColor) && ls.extColor.length >= 3 ? ls.extColor : null;
    if (!ls.useExtColor || !ext) {
      const base = ls.color ?? LINE.COLOR;
      return { from: base, to: base, gradient: false };
    }
    const end = Array.isArray(ls.extColorEnd) && ls.extColorEnd.length >= 3 ? ls.extColorEnd : ext;
    return { from: ext, to: end, gradient: ext[0] !== end[0] || ext[1] !== end[1] || ext[2] !== end[2] };
  }

  /** 线段填充样式（有渐变时用线性渐变；环境不支持渐变则退回纯色） */
  function lineFill(paint, length) {
    if (!paint.gradient || typeof ctx.createLinearGradient !== 'function') return cssColor(paint.from);
    const g = ctx.createLinearGradient(-length / 2, 0, length / 2, 0);
    if (!g || typeof g.addColorStop !== 'function') return cssColor(paint.from);
    g.addColorStop(0, cssColor(paint.from));
    g.addColorStop(1, cssColor(paint.to));
    return g;
  }

  /**
   * 判定线：长度 × scaleX、厚度 × scaleY（扩展事件），颜色按 colorEvents（见 linePaint）。
   * scaleX / scaleY 按内置 `line.png` 的口径（1 = 原尺寸，见 docs/Phigros文档.md 的 RPE 扩展（故事板）事件）。
   */
  function drawLine(ls) {
    const alpha = Math.max(0, Math.min(1, ls.alpha));
    if (alpha <= 0) return;
    const scaleX = Number.isFinite(ls.scaleX) && ls.scaleX > 0 ? ls.scaleX : 1;
    const scaleY = Number.isFinite(ls.scaleY) && ls.scaleY > 0 ? ls.scaleY : 1;
    const length = LINE.LENGTH_H * view.areaH * scaleX;
    const thickness = Math.max(1, LINE.THICKNESS_H * view.areaH * scaleY);
    const paint = linePaint(ls);
    ctx.save();
    ctx.translate(view.toScreenX(ls.worldX), view.toScreenY(ls.worldY));
    ctx.rotate(-ls.worldRotate); // 世界逆时针为正，画布顺时针为正
    ctx.globalAlpha = alpha;
    if (opts.lineTexture) {
      ctx.drawImage(opts.lineTexture, -length / 2, -thickness / 2, length, thickness);
      // 自带贴图的线也要能着色：贴图是白色描边，用 multiply 叠一层颜色即可
      if (ls.useExtColor) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = lineFill(paint, length);
        ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      ctx.fillStyle = lineFill(paint, length);
      ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
    }
    ctx.restore();
  }

  function textureFor(note) {
    // Bad 判定（真实游玩）：Tap 换成整体着色的暗红贴图（docs/Phigros文档.md 的参考实现关键渲染常数）
    if (note.badStyle && note.type === 'tap' && textures.tapBad) return textures.tapBad;
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

  /**
   * 命中点在屏幕上的位置（与音符落点一致：判定线局部坐标 → 屏幕坐标，含背面翻转）。
   * 注意：这里只用来算**位置**；特效本身不随判定线旋转（见 drawHitFx 与 drawHitParticles）。
   */
  function hitScreenPos(hit) {
    const cx = view.toScreenX(hit.lineX);
    const cy = view.toScreenY(hit.lineY);
    const localX = hit.offsetX * view.areaW * (hit.above ? 1 : -1);
    const localY = -hit.offsetY * view.areaH;
    const rot = hit.lineRotate * (hit.above ? -1 : 1) + (hit.above ? 0 : Math.PI);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return { x: cx + localX * cos - localY * sin, y: cy + localX * sin + localY * cos };
  }

  /** 溅射小方块：位置在屏幕空间呈放射状，方形始终与屏幕轴对齐（不随线旋转、也不随溅射方向旋转） */
  function drawHitParticles(hit, age, seed, size, center) {
    const p = opts.hitParticles;
    if (!p?.enabled) return;
    const u = clamp(age / opts.hitFxDuration, 0, 1);
    // 三次缓出：起始速度很快、末尾很慢（r = R · (1 − (1−u)³)）
    const radius = size * (p.radiusScale ?? 1) * (1 - Math.pow(1 - u, 3));
    const alpha = (p.alpha ?? 0.75) * (1 - u);
    if (alpha <= 0.01) return;
    const count = (p.min ?? 4) + Math.floor(hash01(seed, 0) * ((p.max ?? 8) - (p.min ?? 4) + 1));
    // 尺寸统一（不随机）：取原先随机区间的下限（0.75 × 特效宽的 1/8）
    const s = size * (p.sizeRatio ?? 1 / 8) * (p.sizeFactor ?? 0.75);
    const [r, g, b] = hit.perfect ? HIT_FX_COLOR.perfect : HIT_FX_COLOR.good;
    ctx.save();
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    for (let i = 0; i < count; i++) {
      const angle = hash01(seed, i * 4 + 1) * Math.PI * 2;
      const dist = radius * (0.75 + 0.25 * hash01(seed, i * 4 + 2));
      ctx.fillRect(center.x + Math.cos(angle) * dist - s / 2, center.y + Math.sin(angle) * dist - s / 2, s, s);
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
      const center = hitScreenPos(hit);
      // 溅射小方块画在特效贴图之下（起始时被特效盖住，随后飞散出去）
      drawHitParticles(hit, age, hit.time * 1000 + hit.lineId, size, center);
      ctx.save();
      // 特效位置跟随音符落点，但**方向恒为正**：不随判定线旋转、背面音符也不翻转
      ctx.drawImage(atlas, sx, sy, fw, fh, center.x - size / 2, center.y - h / 2, size, h);
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
    /** 当前投影（制谱器可用来做点选与叠加层绘制，见 docs/项目文档.md 的编辑器数据流） */
    get projection() {
      return view;
    },
    get view() {
      return view;
    },
    /** 屏幕像素点选音符 / 判定线（供制谱器使用） */
    pickNote: (state, px, py, radius = 24) => pickNote(view, state, px, py, radius, { noteWidthRatio: opts.noteWidthRatio }),
    pickLine: (state, px, py, tolerance = 10) => pickLine(view, state, px, py, tolerance),
    /**
     * 判定带（默认判定范围）：点在不在音符所在的列里 —— 供真实游玩的判定使用。
     * 沿判定线方向比音符略宽，沿下落方向不限位置（见 docs/Phigros文档.md 的判定带）。
     */
    judgeBand: (state, note, o = {}) => view.judgeBand(note, state.lines[note.lineId], bandOpts(o)),
    hitJudgeBand: (state, note, px, py, o = {}) => view.hitJudgeBand(note, state.lines[note.lineId], px, py, bandOpts(o)),
    hitJudgeBandSegment: (state, note, x0, y0, x1, y1, o = {}) => view.hitJudgeBandSegment(note, state.lines[note.lineId], x0, y0, x1, y1, bandOpts(o)),
  };

  /** 判定带参数：宽度基准与绘制一致（noteWidthRatio），默认「比音符略宽」 */
  function bandOpts(o = {}) {
    return {
      scale: o.scale ?? JUDGE.BAND_SCALE,
      pad: o.pad ?? JUDGE.BAND_PAD,
      noteWidthRatio: o.noteWidthRatio ?? opts.noteWidthRatio,
    };
  }
}
