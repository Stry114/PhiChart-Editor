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

/** 「手指位置」调试标记的半径（画布 CSS 像素） */
const FINGER_RADIUS = 16;

/**
 * 倾斜下落面上的 Hold：一行的**目标屏幕高度**、行数上限、以及行与行之间的**重叠**。
 *
 * 为什么要分段：倾斜面上的投影是透视，整段贴图用一次仿射画不出来 —— 一次仿射只能得到
 * 平行四边形，贴图在长度方向会被「拉直」，远端看起来就不对。逐行分段后每行都很短，
 * 行内的仿射近似就够了（轮廓仍然精确，见 drawTiltedHold）。
 */
const HOLD_TILT_ROW_PX = 18;
const HOLD_TILT_MAX_ROWS = 24;
/**
 * **倾斜长条的分段高度（设备像素）** —— 新画法：段边界取设备 y 的整数倍（见 drawTiltedHoldBands）。
 *
 * 为什么是「设备像素」而不是「局部像素」：一次裁剪 + 一次贴图的边界像素，其抗锯齿覆盖**不是**
 * 相邻两块互补的（真浏览器实测：共享一条斜边时，边界像素覆盖之和只有 ~0.75，每条共享边上都
 * 留下一条暗线；外扩补缝只会把「缝」换成同样明显的「亮带」）。唯一能彻底避免的是让共享边
 * **落在设备像素网格上**：边界水平且 y 为整数时覆盖是 0/1 判定，两块严丝合缝。
 * 所以段高按设备像素定，段的局部 y 由投影反解（见 makeDeviceYInverse）。
 *
 * 4 设备像素是质量与开销的平衡点：段内投影曲率带来的形状/贴图误差是 O(h²)，
 * 4px 段实测在千分之几像素；一条 400px 长的长条约 100 段（旧画法是 24 行 × 3 块 × 2 个三角形）。
 */
const HOLD_TILT_BAND_PX = 4;
/** 段数上限（极端放大 / 很长的长条时按上限把段高放大，避免绘制调用爆炸） */
const HOLD_TILT_MAX_BANDS = 400;
/**
 * **旧画法（逐行两个裁剪三角形）的补缝量**，只在「判定线被旋转」（行的方向在屏幕上不水平，
 * 无法对齐设备像素网格）时使用：
 *
 * 绘制矩形 / 源矩形往邻块「多要」多少屏幕像素 —— 这**只扩绘制用的贴图与源区间，不扩裁剪路径**：
 * Canvas2D 里一次「clip + drawImage」的边界像素会被抗锯齿算两遍（clip 的覆盖 × 贴图自身的边缘
 * 覆盖），两块紧挨着画就会留下缝（背景透出来 → 一条暗线）。把绘制矩形和源区间外扩出去，
 * 贴图自身的边缘就落在裁剪路径之外，覆盖只由 clip 决定。
 *
 * 反过来说：**裁剪路径不能再外扩**（曾经一起外扩来补缝）。两块重叠绘制同一像素时，
 * `source-over` 会把半透明的部分叠加两次 —— HL 贴图本体外那圈光效会亮一档，
 * 表现为长条上一条条横向亮带（拼接处的透明度叠加）。
 */
const HOLD_TILT_SEAM_BLEED_PX = 0.75;

/**
 * 每帧的绘制统计（目前只统计倾斜 Hold）：
 * `holdRowsPlanned` = 按屏幕长度算出的计划行数，`holdRowsDrawn` = 实际画出来的行数
 * （屏幕外的整行跳过），`holdCulled` = 被整行剔除的行数。
 * 供测试与调试量化「动态行数 + 屏幕外剔除」到底省了多少。
 */
export function createRenderStats() {
  return { holdRowsPlanned: 0, holdRowsDrawn: 0, holdCulled: 0 };
}

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
    /** 调试：把每个音符的**判定范围**（判定带，见 projection.judgeBandShape）画出来 */
    showJudgeRange: false,
    /**
     * 判定范围的画法，跟随暂停页里选的判定模式：
     * `'tilt'`（默认，轨道判定：跟着（伪）3D 的楔形）/ `'band'`（垂直判定：2D 那列）/ `'screen'`（全屏，不画）
     */
    judgeRangeMode: 'tilt',
    /** 调试：把玩家的手指位置画成小圆点（位置由调用方通过 draw 的第 3 个参数传入） */
    showFingers: false,
    backgroundBrightness: 0.4,
    backgroundBlur: 120,
    lineTexture: null, // HTMLImageElement | null（自定义判定线材质）
    /** （伪）3D 投影的焦距覆盖（单位：画面高，调试用）；null = 按谱面相机的视角换算（缺省 1 屏高 ≈ 53.13°） */
    zFocalH: null,
    ...options,
  };
  let view = createProjection(1, 1);
  let dpr = 1;
  const stats = createRenderStats();
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
   * 判定线：长度 × scaleX、厚度 × scaleY（扩展事件），颜色按 colorEvents（见 linePaint）；
   * **（伪）3D**：z（Z 轴位移）让线整体缩小并向画面中心靠拢 —— 位置、长度、厚度都乘深度缩放 k
   * （见 projection.js 的深度缩放说明）。scaleX / scaleY 按内置 `line.png` 的口径（1 = 原尺寸）。
   */
  function drawLine(ls, cam) {
    const alpha = Math.max(0, Math.min(1, ls.alpha));
    if (alpha <= 0) return;
    const scaleX = Number.isFinite(ls.scaleX) && ls.scaleX > 0 ? ls.scaleX : 1;
    const scaleY = Number.isFinite(ls.scaleY) && ls.scaleY > 0 ? ls.scaleY : 1;
    const center = view.lineCenter(ls, { focalH: opts.zFocalH, camera: cam });
    const k = center.k;
    const length = LINE.LENGTH_H * view.areaH * scaleX * k;
    const thickness = Math.max(1, LINE.THICKNESS_H * view.areaH * scaleY * k);
    const paint = linePaint(ls);
    ctx.save();
    // 相机 / z 让线整体平移 + 缩放：位置、长度、厚度都乘 k，位置里已含相机平移
    ctx.translate(center.x, center.y);
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

  /**
   * 用一组屏幕点裁剪，并把「绘制矩形 (dx, y0, dw, dh)」里的贴图按三点定标的仿射铺进去。
   * `l0/l1/l2` 是绘制矩形上的三个角，`p0/p1/p2` 是它们的屏幕位置（都精确投影）。
   *
   * 倾斜长条的两种画法都用它：新画法每段调用一次（裁剪四边形 = 段本身，无对角线），
   * 旧画法每行每块调用两次（两个裁剪三角形）。
   */
  function triAffine(tex, pts, l0, p0, l1, p1, l2, p2, sx, sy, sw, sh, dx, y0, dw, dh) {
    const d1x = l1.x - l0.x;
    const d1y = l1.y - l0.y;
    const d2x = l2.x - l0.x;
    const d2y = l2.y - l0.y;
    const det = d1x * d2y - d1y * d2x;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return;
    const e1x = p1.x - p0.x;
    const e1y = p1.y - p0.y;
    const e2x = p2.x - p0.x;
    const e2y = p2.y - p0.y;
    const a = (e1x * d2y - e2x * d1y) / det;
    const b = (e1y * d2y - e2y * d1y) / det;
    const c = (e2x * d1x - e1x * d2x) / det;
    const d = (e2y * d1x - e1y * d2x) / det;
    const e = p0.x - a * l0.x - c * l0.y;
    const f = p0.y - b * l0.x - d * l0.y;
    if (![a, b, c, d, e, f].every(Number.isFinite)) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
    ctx.clip();
    // 画布整体有 dpr 缩放：自定义矩阵要把它带上（坐标都是 CSS 像素）
    ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
    ctx.drawImage(tex, sx, sy, sw, sh, dx, y0, dw, dh);
    ctx.restore();
  }

  /**
   * **倾斜下落面上的长条**：按画法分派。
   *
   * - 判定线**没有旋转**（行的方向在屏幕上水平）且环境支持 `clip` → 走 drawTiltedHoldBands：
   *   段边界对齐设备像素网格，共享边不会留下抗锯齿缝（本轮的修复）。
   * - 判定线**被旋转**（含任意 worldRotate）→ 行的方向在屏幕上倾斜，无法对齐设备网格，
   *   只能走旧画法 drawTiltedHoldRows（会有淡淡的斜向缝，见其注释）。
   * - 没有 `clip` 的环境（测试桩件 / 很老的浏览器）→ 旧画法的单仿射退路。
   */
  function drawTiltedHold(note, line, cam, geo) {
    // 行方向 = 局部 x 轴在屏幕上的方向：angle = worldRotate +（背面 +π），sin 为 0 才是水平的
    const angle = (Number.isFinite(line?.worldRotate) ? line.worldRotate : 0) + (note.above === false ? Math.PI : 0);
    const axisIsHorizontal = Math.abs(Math.sin(angle)) < 1e-6;
    if (axisIsHorizontal && typeof ctx.clip === 'function') drawTiltedHoldBands(note, line, cam, geo);
    else drawTiltedHoldRows(note, line, cam, geo);
  }

  /**
   * 把「设备 y」反解成判定线**局部 y**（倾斜前的纵向像素）。
   *
   * 无判定线旋转时，设备 y 只与局部 y 有关，而且是**分式线性**函数（投影里 k = F/(D₀ − y·sinθ)）：
   *     y_dev(v) = (P + Q·v) / (1 + R·v)
   * 三点定标即可求出 P/Q/R —— 不需要在渲染器里再抄一份投影公式（投影仍是唯一出处），
   * 随后闭式反解。深度被 MIN_DEPTH 夹住时函数会**分段**（分式线性 + 线性两段），
   * 所以这里返回的只是一个**初值**：调用方用割线法补正，必要时退到二分。
   */
  function makeDeviceYInverse(yAt, v0, v1) {
    const y0 = yAt(v0);
    const y1 = yAt(v1);
    const vm = (v0 + v1) / 2;
    const ym = yAt(vm);
    const M = [
      [1, v0, -y0 * v0],
      [1, v1, -y1 * v1],
      [1, vm, -ym * vm],
    ];
    const det3 = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const withCol = (m, col, vals) => m.map((row, i) => row.map((v, j) => (j === col ? vals[i] : v)));
    const rhs = [y0, y1, ym];
    const D = det3(M);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null;
    const P = det3(withCol(M, 0, rhs)) / D;
    const Q = det3(withCol(M, 1, rhs)) / D;
    const R = det3(withCol(M, 2, rhs)) / D;
    if (![P, Q, R].every(Number.isFinite)) return null;
    return {
      yAt,
      /** 闭式反解（分式线性）；分段处由调用方的割线 / 二分兜住 */
      vOf(yDev) {
        const den = Q - yDev * R;
        if (Math.abs(den) < 1e-12) return null;
        const v = (yDev - P) / den;
        return Number.isFinite(v) ? v : null;
      },
    };
  }

  /**
   * 把一片切片的局部 y 范围裁到**映射单调**的那一段。
   *
   * 深度被投影的 MIN_DEPTH 夹住之后，局部 y → 设备 y 会**折返**（背面 + 大倾斜时尤其明显：
   * 实测 θ=-35° 背面时，头部光效那 8 个局部像素被拉到覆盖整个屏幕，画出来是一个大漏斗）。
   * 折返点之后是「相机平面之后」的几何，不该画。这里二分找折点，保留斜率较小（未被夹住）的一侧。
   */
  function monotoneLocalRange(yAt, v0, v1) {
    let lo = Math.min(v0, v1);
    let hi = Math.max(v0, v1);
    if (!(hi - lo > 1e-6)) return [lo, hi];
    const yLo = yAt(lo);
    const yHi = yAt(hi);
    const yMid = yAt((lo + hi) / 2);
    if ((yMid - yLo) * (yHi - yMid) >= 0) return [lo, hi]; // 单调
    let a = lo;
    let b = hi;
    let ya = yLo;
    for (let k = 0; k < 40; k++) {
      const m = (a + b) / 2;
      const ym = yAt(m);
      if ((ym - ya) * (yHi - ym) < 0) b = m;
      else {
        a = m;
        ya = ym;
      }
    }
    const fold = (a + b) / 2;
    const h = Math.max(1e-3, (hi - lo) * 1e-3);
    const before = Math.abs(yAt(fold - h) - yAt(fold - 2 * h)) / h;
    const after = Math.abs(yAt(fold + 2 * h) - yAt(fold + h)) / h;
    return before <= after ? [lo, fold] : [fold, hi];
  }

  /**
   * 「设备 y → 局部 y」求解器：**分式线性初值 + 割线法收敛 + 二分兜底**。
   *
   * 为什么不能只用三点定标：长条可能横跨很长一段局部范围（远端深度被 MIN_DEPTH 夹住），
   * 那时 y_dev(v) 是分段的，全局拟合会偏得离谱（实测会导致大量分段算到屏幕外被误剔除）。
   * 反过来只在切片自己的范围里拟合，再让割线法收敛到 |误差| < 0.02 设备像素，
   * 就既省投影调用又始终精确 —— 相邻切片吸附到同一个设备整数时也因此落在同一个局部 y 上。
   */
  function makeDeviceYSolver(yAt, v0, v1) {
    const inv = makeDeviceYInverse(yAt, v0, v1);
    const lo = Math.min(v0, v1);
    const hi = Math.max(v0, v1);
    const increasing = yAt(hi) >= yAt(lo);
    return (d) => {
      let v = inv ? inv.vOf(d) : null;
      if (v === null || !Number.isFinite(v) || v < lo - 1e-6 || v > hi + 1e-6) {
        // 拟合不可用：先二分定位，再交给割线法
        let a = lo;
        let b = hi;
        for (let k = 0; k < 40; k++) {
          const m = (a + b) / 2;
          const ym = yAt(m);
          if (increasing ? ym < d : ym > d) a = m;
          else b = m;
        }
        v = (a + b) / 2;
      }
      for (let k = 0; k < 6; k++) {
        const err = yAt(v) - d;
        if (Math.abs(err) < 0.02) break;
        const h = Math.max(1e-3, Math.abs(v) * 1e-4);
        const slope = (yAt(v + h) - yAt(v - h)) / (2 * h);
        if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) break;
        v -= err / slope;
      }
      // 兜底：割线没收敛就二分（单调性由 y_dev(v) 的导数符号恒定保证）
      if (Math.abs(yAt(v) - d) > 0.05) {
        let a = lo;
        let b = hi;
        for (let k = 0; k < 40; k++) {
          const m = (a + b) / 2;
          const ym = yAt(m);
          if (increasing ? ym < d : ym > d) a = m;
          else b = m;
        }
        v = (a + b) / 2;
      }
      return Number.isFinite(v) ? v : null;
    };
  }

  /**
   * **倾斜下落面上的长条**：按**设备整数行**分段，每段一次裁剪 + 一次仿射铺贴（一轮一段）。
   *
   * 为什么这样切（对应实测结论，见 tools/render-smoke.mjs 与项目文档 §5.4）：
   *  1. `clip` 的抗锯齿覆盖**不互补**：实测两块共享一条边时，边界像素覆盖之和只与
   *     「这条边离设备像素网格多远」有关 —— 边落在设备 y 整数上时是 255（严丝合缝），
   *     落在 y=200.3 时是 207、落在 y=200.5 时是 191（少 25%），斜边同样如此。
   *     于是每条不在网格上的共享边都是一条暗线；外扩补缝无效（补上「缝」就会换成同样
   *     明显的「亮带」：半透明光效被画两遍）。
   *  2. 所以**所有内部边界都对齐到设备整数 y**：段边界按设备 y 整数倍切；
   *     切片（帽 / 主体 / 光效）的接缝也吸附到最近的整数（吸附量 ≤ 半个设备像素，
   *     内容只是平移了不到 1px，看不出来），吸附后两块共用同一条精确边界。
   *  3. 段内**不再拆三角形**：段很薄（4 设备像素），段内投影曲率误差 O(h²) 可忽略，
   *     一次三点定标仿射 + 一个精确四边形裁剪就够了 —— 没有对角线，也就没有由它带来的缝。
   *  4. 横向也不再拆「本体 / 光效」：无旋转时 k 只随局部 y 变化，段内 k 是常数 →
   *     横向映射严格线性（一片仿射在段内精确），本体的左右边缘天然落在正确位置。
   *
   * 判定线被旋转时（行的方向在屏幕上不水平，无法对齐设备网格）退回旧画法（drawTiltedHoldRows）。
   */
  function drawTiltedHoldBands(note, line, cam, geo) {
    const { tex, meta, scale, xLeft, fullW, head, tail } = geo;
    const viewOpts = { focalH: opts.zFocalH, camera: cam, above: note.above !== false };
    const screenOf = (localX, localY0) => view.lineLocalToScreen(localX, localY0, line, viewOpts);
    const xRight = xLeft + fullW;
    const vHead = head.localY0;
    const vTail = tail.localY0;
    if (!(Math.abs(vTail - vHead) > 1e-3) || !(fullW > 1e-3)) return;
    // 切片（源结构）仍由 hold-geometry.js 统一给出：帽 / 主体 / 光效、以及 1px 的重叠补缝
    const slices = computeHoldSlices({ meta, headLocalY: vHead, tailLocalY: vTail, texW: tex.width, scale });
    if (!slices.length) return;
    // 设备 y（只与局部 y 有关，与 localX 无关 —— 见 drawTiltedHold 的分派条件）
    const yAt = (v) => screenOf(xLeft, v).y * dpr;
    let holdMin = Infinity;
    let holdMax = -Infinity;
    for (const s of slices) {
      holdMin = Math.min(holdMin, s.dy);
      holdMax = Math.max(holdMax, s.dy + s.dh);
    }
    if (!(holdMax - holdMin > 1e-3)) return;
    /**
     * 切片按**几何位置**排序，相邻接缝吸附到**设备整数 y**：两块共用同一个边界（同一个方程
     * 的同一个根），于是既没有抗锯齿缝、也不再需要「重叠 1px 补缝」（重叠对半透明贴图会叠亮）。
     * 长条自身的两端（最远 / 最近的轮廓边）保持精确，不吸附。
     */
    const ordered = [...slices]
      .map((s) => {
        // 先按「映射单调」裁掉折返段（相机平面之后的几何），再用裁过的范围定接缝
        const [lo, hi] = monotoneLocalRange(yAt, s.dy, s.dy + s.dh);
        return { s, lo, hi };
      })
      .filter((e) => e.hi - e.lo > 1e-6)
      .sort((a, b) => a.lo - b.lo);
    if (!ordered.length) return;
    const junctions = [];
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      // 接缝取「两片端点之间」的设备整数：两块共用同一条精确边界，且都落在各自单调段内
      const yA = yAt(a.hi);
      const yB = yAt(b.lo);
      const loY = Math.min(yA, yB);
      const hiY = Math.max(yA, yB);
      const jMin = Math.ceil(loY);
      const jMax = Math.floor(hiY);
      junctions.push(jMin <= jMax ? Math.max(jMin, Math.min(jMax, Math.round((yA + yB) / 2))) : Math.round((yA + yB) / 2));
    }
    // 单调化：极端配置下某个接缝可能被吸附到上一个之前，那会出现空洞。
    // 方向由首尾决定（背面 / 负角度时设备 y 沿几何顺序是**递减**的，不能一律按递增修）
    const devUp = yAt(ordered[ordered.length - 1].hi) >= yAt(ordered[0].lo);
    for (let i = 1; i < junctions.length; i++) {
      if (junctions[i] === null || junctions[i - 1] === null) continue;
      if (devUp ? junctions[i] < junctions[i - 1] : junctions[i] > junctions[i - 1]) {
        junctions[i] = junctions[i - 1];
      }
    }
    const marginDev = 8 * dpr;
    const viewBotDev = view.height * dpr + marginDev;
    ctx.save();
    ctx.globalAlpha = note.renderAlpha;
    for (let si = 0; si < ordered.length; si++) {
      const { s, lo: sLo, hi: sHi } = ordered[si];
      if (!(s.dh > 0.01) || !(s.sh > 0)) continue;
      // 这一片的**设备区间**：左右由相邻接缝（设备整数）界定，两端由长条自己的轮廓界定
      const dTop = si === 0 ? yAt(sLo) : (junctions[si - 1] ?? yAt(sLo));
      const dBot = si === ordered.length - 1 ? yAt(sHi) : (junctions[si] ?? yAt(sHi));
      const dA = Math.min(dTop, dBot);
      const dB = Math.max(dTop, dBot);
      if (!(dB - dA > 0.05)) continue; // 被压到不足 1 个设备像素：由相邻切片覆盖
      /**
       * 先把这一片裁到**屏幕窗口**里再分段：远端深度被 MIN_DEPTH 夹住后，局部到设备的映射会
       * 变得极陡（实测 θ=-35° 时长条远端能拉到屏幕上方两万像素），若先按整段算段数，
       * 段数上限会把段高放大到几十像素 —— 那正是「长条上出现几十像素间距的横线」的来源。
       */
      const clipA = Math.max(dA, -marginDev);
      const clipB = Math.min(dB, viewBotDev);
      stats.holdCulled += Math.max(0, Math.ceil((Math.min(dB, -marginDev) - dA) / HOLD_TILT_BAND_PX));
      stats.holdCulled += Math.max(0, Math.ceil((dB - Math.max(dA, viewBotDev)) / HOLD_TILT_BAND_PX));
      if (!(clipB - clipA > 0.05)) continue; // 整片都在屏外
      let bandDev = HOLD_TILT_BAND_PX;
      const wantBands = Math.ceil((clipB - clipA) / bandDev);
      // 段高必须是**设备像素的整数倍** —— 否则段边界落在设备网格之外，缝又回来了
      if (wantBands > HOLD_TILT_MAX_BANDS) bandDev = Math.max(1, Math.ceil((clipB - clipA) / HOLD_TILT_MAX_BANDS));
      /**
       * 段边界的反解只在**这一片的单调段**里做（括号不外扩）：接缝本身已经取在两片端点之间的
       * 设备整数上，所以每个段边界都落在括号内，两侧切片解出的是同一个根 —— 共享边严格重合。
       */
      const solveV = makeDeviceYSolver(yAt, sLo, sHi);
      const vMin = sLo;
      const vMax = sHi;
      const svOf = (v) => s.sy + (v - s.dy) * (s.sh / s.dh);
      // 段边界：设备 y 的整数倍（相对 0 对齐 —— 相邻两段因此共享同一条精确边界）
      const edges = [clipA];
      let d = Math.ceil((clipA + 1e-6) / bandDev) * bandDev;
      for (; d < clipB - 1e-6; d += bandDev) {
        if (d > clipA + 1e-6) edges.push(d);
      }
      edges.push(clipB);
      stats.holdRowsPlanned += edges.length - 1;
      for (let i = 0; i + 1 < edges.length; i++) {
        const d0 = edges[i];
        const d1 = edges[i + 1];
        if (!(d1 - d0 > 0.05)) continue;
        const vAi = solveV(d0);
        const vBi = solveV(d1);
        if (vAi === null || vBi === null) continue;
        const vA = clamp(vAi, vMin, vMax);
        const vB = clamp(vBi, vMin, vMax);
        const vLo = Math.min(vA, vB);
        const vHi = Math.max(vA, vB);
        if (!(vHi - vLo > 1e-4)) continue;
        const aL = screenOf(xLeft, vLo);
        const aR = screenOf(xRight, vLo);
        const bL = screenOf(xLeft, vHi);
        const bR = screenOf(xRight, vHi);
        // 屏幕外整段剔除（长条常常一多半在画面外）
        const minX = Math.min(aL.x, aR.x, bL.x, bR.x);
        const maxX = Math.max(aL.x, aR.x, bL.x, bR.x);
        const minY = Math.min(aL.y, aR.y, bL.y, bR.y);
        const maxY = Math.max(aL.y, aR.y, bL.y, bR.y);
        if (maxX < -8 || minX > view.width + 8 || maxY < -8 || minY > view.height + 8) {
          stats.holdCulled += 1;
          continue;
        }
        const svLo = svOf(vLo);
        const svHi = svOf(vHi);
        // 一次裁剪（精确四边形）+ 一次三点定标仿射：四个角全部精确投影，贴图整幅横向铺满
        triAffine(
          tex,
          [aL, aR, bR, bL],
          { x: xLeft, y: vLo },
          aL,
          { x: xRight, y: vLo },
          aR,
          { x: xLeft, y: vHi },
          bL,
          0,
          svLo,
          tex.width,
          svHi - svLo,
          xLeft,
          vLo,
          fullW,
          vHi - vLo,
        );
        stats.holdRowsDrawn += 1;
      }
    }
    ctx.restore();
  }

  /**
   * **倾斜下落面上的长条（旧画法）**：沿下落方向逐行投影，每行画成**精确的四边形**（两个裁剪三角形）。
   *
   * 只在「判定线被旋转」（行边界在屏幕上不水平，没法对齐设备像素网格）时使用；
   * 它无法消除共享斜边上的抗锯齿缝（真浏览器实测覆盖之和 ~0.75），见 drawTiltedHoldBands 的说明。
   *
   * 为什么不是「一行一个矩形」，也不是「一行一个三点定标的仿射平行四边形」：
   *  - 矩形只能平移 + 等比缩放，行与行之间的宽度台阶是看得见的锯齿；
   *  - 平行四边形（三点定标 + drawImage）只能对上三个角，第四条边必然偏出去 ——
   *    倾斜面的投影是**透视**，一行矩形的像其实是梯形，第四条边的偏差随行高**线性**增长，
   *    长条越长越明显，同样是肉眼可见的锯齿。
   *
   * 关键事实：判定线局部平面上的一条直线（长条左右两条边、以及贴图的左右边缘）投影后**仍是直线**
   * （实测偏离 ~1e-13px），所以一行的真实形状就是「四个角精确投影出来的四边形」。
   * 于是把每行拆成**两个三角形**：A（左上 / 右上 / 左下）与 B（右上 / 右下 / 左下），
   * 每个三角形用自己那三点定标的仿射铺贴图、再用三角形裁剪 —— 四个角全部精确落位，
   * 贴图的四条边严格落在真实投影边界上（HL 贴图本体外那圈光效因此不会被吃掉）。
   *
   * **拼接缝**：把绘制矩形与源区间往下一行外扩 HOLD_TILT_SEAM_BLEED_PX，让贴图自身的边缘落在
   * 裁剪路径之外；**裁剪路径保持精确**（外扩裁剪会让半透明的光效被画两遍，出现亮带）。
   * 行内第二个三角形沿共用对角线向第一个三角形多要。
   *
   * 行数**按屏幕长度动态定**（18px 一行、上限 24 行）；屏幕外的行**整行剔除**，见 renderer.stats。
   * 没有 `clip` 的环境（测试桩件 / 很老的浏览器）退回单仿射的 `drawImage`：不会缺块，
   * 第四条边允许小偏差。
   */
  function drawTiltedHoldRows(note, line, cam, geo) {
    const { tex, meta, scale, xLeft, fullW, head, tail } = geo;
    const viewOpts = { focalH: opts.zFocalH, camera: cam, above: note.above !== false };
    const screenOf = (localX, localY0) => view.lineLocalToScreen(localX, localY0, line, viewOpts);
    // 先按**倾斜前**的本地坐标切片（切片结构不变），再逐行投影到屏幕
    const slices = computeHoldSlices({
      meta,
      headLocalY: head.localY0,
      tailLocalY: tail.localY0,
      texW: tex.width,
      scale,
    });
    const totalLocal = Math.abs(tail.localY0 - head.localY0);
    if (!(totalLocal > 1e-3) || !(fullW > 1e-3)) return;
    // 行数：按整条长条**在屏幕上的长度**估（两端中点连线的长度），18px 一行、夹在 1..24
    const midX = xLeft + fullW / 2;
    const headMid = screenOf(midX, head.localY0);
    const tailMid = screenOf(midX, tail.localY0);
    const span = Math.hypot(headMid.x - tailMid.x, headMid.y - tailMid.y);
    const wantRows = Math.round(Number.isFinite(span) ? span / HOLD_TILT_ROW_PX : 1) || 1;
    const rowsTotal = Math.max(1, Math.min(HOLD_TILT_MAX_ROWS, wantRows));
    const rowLocalPx = totalLocal / rowsTotal; // 每一行大致占多少本地像素（各切片据此再分）
    const xRight = xLeft + fullW;
    const canClip = typeof ctx.clip === 'function';
    /**
     * 贴图的**横向结构**：HL 贴图（双押 / 多押）在本体（`meta.core`）左右各有一圈 48px 光效。
     *
     * 每一行必须按这些边界拆成若干块**分别投影**：块内「竖直」的源列（本体的左右边缘、
     * 光效的边界）在两个裁剪三角形的仿射下会在共用对角线处折一个角。若本体边缘落在块内部，
     * 这个折角就落在长条实体的边缘上 —— 表现为边缘不整齐的台阶（普通贴图没有左右光效、
     * 本体就是整行，所以看不出来；一开双押换成 HL 贴图就暴露）。
     * 拆到边界上之后，折角只留在贴图内部（颜色 / 透明度连续的地方），看不见。
     */
    const coreMeta = meta?.core ?? {};
    const coreX0 = Math.max(0, Math.min(tex.width, Number.isFinite(coreMeta.x) ? coreMeta.x : 0));
    const coreW = Number.isFinite(coreMeta.w) ? Math.max(0, coreMeta.w) : tex.width;
    const coreX1 = Math.max(coreX0, Math.min(tex.width, coreX0 + coreW));
    const cutX = [...new Set([0, coreX0, coreX1, tex.width])].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i + 1 < cutX.length; i++) {
      const sw = cutX[i + 1] - cutX[i];
      if (!(sw > 0.01)) continue;
      pieces.push({ sx: cutX[i], sw, xa: xLeft + cutX[i] * scale, xb: xLeft + cutX[i + 1] * scale });
    }
    if (!pieces.length) return;
    /**
     * 用一组屏幕点裁剪，并把「绘制矩形 (dx, y0, dw, dh)」里的贴图按三点定标的仿射铺进去。
     * l0/l1/l2 是绘制矩形上的三个角，p0/p1/p2 是它们的屏幕位置（都精确投影）。
     */
    const tri = (pts, l0, p0, l1, p1, l2, p2, sx, sy, sw, sh, dx, y0, dw, dh) =>
      triAffine(tex, pts, l0, p0, l1, p1, l2, p2, sx, sy, sw, sh, dx, y0, dw, dh);
    const bleedSrc = (px) => px / Math.max(1e-6, scale);
    ctx.save();
    ctx.globalAlpha = note.renderAlpha;
    for (const s of slices) {
      if (!(s.dh > 0.01) || !(s.sh > 0)) continue;
      const count = Math.max(1, Math.min(HOLD_TILT_MAX_ROWS, Math.ceil(s.dh / rowLocalPx)));
      stats.holdRowsPlanned += count;
      const rowDest = s.dh / count;
      const rowSrc = s.sh / count;
      for (let i = 0; i < count; i++) {
        const y0 = s.dy + i * rowDest;
        const y1 = y0 + rowDest;
        // 一行的四个角**全部精确投影**（倾斜面上直线投影后还是直线 → 这个四边形就是真实形状）
        const rowTl = screenOf(xLeft, y0);
        const rowTr = screenOf(xRight, y0);
        const rowBl = screenOf(xLeft, y1);
        const rowBr = screenOf(xRight, y1);
        // 屏幕外整行剔除（留一点余量，避免把边缘上的抗锯齿切掉）
        const minX = Math.min(rowTl.x, rowTr.x, rowBl.x, rowBr.x);
        const maxX = Math.max(rowTl.x, rowTr.x, rowBl.x, rowBr.x);
        const minY = Math.min(rowTl.y, rowTr.y, rowBl.y, rowBr.y);
        const maxY = Math.max(rowTl.y, rowTr.y, rowBl.y, rowBr.y);
        if (maxX < -8 || minX > view.width + 8 || maxY < -8 || minY > view.height + 8) {
          stats.holdCulled += 1;
          continue;
        }
        const sy0 = s.sy + i * rowSrc;
        // 绘制矩形 / 源区间往下一行多要一点（贴图自身的边缘落到裁剪路径之外，见常量注释）；
        // 裁剪路径仍用**精确**的四角 —— 相邻两行共享同一条边界，覆盖互补、不会叠加。
        const edgePx = Math.max(1e-3, Math.hypot(rowBl.x - rowTl.x, rowBl.y - rowTl.y));
        const overDest = Math.min(rowDest * 0.5, (HOLD_TILT_SEAM_BLEED_PX * rowDest) / edgePx);
        const overSrc = Math.min(Math.max(0, s.sh - (i + 1) * rowSrc), (overDest / rowDest) * rowSrc);
        const dh = rowDest + overDest;
        const shCover = rowSrc + overSrc;
        let drawn = false;
        for (const pc of pieces) {
          const tl = pc.sx === 0 ? rowTl : screenOf(pc.xa, y0);
          const tr = pc.sx + pc.sw >= tex.width ? rowTr : screenOf(pc.xb, y0);
          const bl = pc.sx === 0 ? rowBl : screenOf(pc.xa, y1);
          const br = pc.sx + pc.sw >= tex.width ? rowBr : screenOf(pc.xb, y1);
          if (!canClip) {
            // 退化路径：单仿射（左上 / 右上 / 左下 三点定标），第四条边允许小偏差。
            // 没有裁剪路径可依靠，这里**不外扩绘制矩形**（相邻块严丝合缝，不会叠加）。
            const w = Math.max(1e-3, pc.xb - pc.xa);
            const a = (tr.x - tl.x) / w;
            const b = (tr.y - tl.y) / w;
            const c = (bl.x - tl.x) / rowDest;
            const d = (bl.y - tl.y) / rowDest;
            if (![a, b, c, d].every(Number.isFinite)) continue;
            const e = tl.x - a * pc.xa - c * y0;
            const f = tl.y - b * pc.xa - d * y0;
            ctx.save();
            ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
            ctx.drawImage(tex, pc.sx, sy0, pc.sw, rowSrc, pc.xa, y0, pc.xb - pc.xa, rowDest);
            ctx.restore();
            drawn = true;
            continue;
          }
          // 横向同向的「多要」：贴图竖直的边缘也落到裁剪路径之外（最外侧没有邻块，不外扩）
          const hbL = pc.sx > 1e-6 ? HOLD_TILT_SEAM_BLEED_PX : 0;
          const hbR = pc.sx + pc.sw < tex.width - 1e-6 ? HOLD_TILT_SEAM_BLEED_PX : 0;
          const dx = pc.xa - hbL;
          const dw = pc.xb - pc.xa + hbL + hbR;
          const sxB = pc.sx - bleedSrc(hbL);
          const swB = pc.sw + bleedSrc(hbL) + bleedSrc(hbR);
          // 两条对角线：挑屏幕上更短的那条当共用边；两个三角形的裁剪都取**精确**四角
          const dA = Math.hypot(br.x - tl.x, br.y - tl.y);
          const dB = Math.hypot(bl.x - tr.x, bl.y - tr.y);
          if (dA <= dB) {
            // 共用边 = 左上 → 右下
            tri([tl, tr, br], { x: pc.xa, y: y0 }, tl, { x: pc.xb, y: y0 }, tr, { x: pc.xb, y: y1 }, br, sxB, sy0, swB, shCover, dx, y0, dw, dh);
            tri([tl, br, bl], { x: pc.xa, y: y0 }, tl, { x: pc.xb, y: y1 }, br, { x: pc.xa, y: y1 }, bl, sxB, sy0, swB, shCover, dx, y0, dw, dh);
          } else {
            // 共用边 = 右上 → 左下
            tri([tl, tr, bl], { x: pc.xa, y: y0 }, tl, { x: pc.xb, y: y0 }, tr, { x: pc.xa, y: y1 }, bl, sxB, sy0, swB, shCover, dx, y0, dw, dh);
            tri([tr, br, bl], { x: pc.xb, y: y0 }, tr, { x: pc.xb, y: y1 }, br, { x: pc.xa, y: y1 }, bl, sxB, sy0, swB, shCover, dx, y0, dw, dh);
          }
          drawn = true;
        }
        if (drawn) stats.holdRowsDrawn += 1;
      }
    }
    ctx.restore();
  }
  function drawNote(note, line, cam) {
    const tex = textureFor(note);
    if (!tex) return;
    const meta = textureMeta(tex);
    // 尺寸由**本体（不透明核心）**决定，而不是整张贴图 —— 否则 HL 贴图的光效会被当成本体，
    // 音符会大一圈、长条两端会被撑长（见 textures.js 的 TEXTURE_TRIM 说明）。
    const width = opts.noteWidthRatio * view.areaW * (note.size || 1);
    const scale = width / meta.core.w;
    const viewOpts = { noteWidthRatio: opts.noteWidthRatio, focalH: opts.zFocalH, camera: cam };

    if (note.type === 'hold') {
      const head = view.noteTransform(note, line, { ...viewOpts, distY: note.headY ?? note.distY });
      const tail = view.noteTransform(note, line, { ...viewOpts, distY: note.tailY ?? note.headY ?? note.distY });
      const total = Math.abs(head.localY - tail.localY);
      if (total <= 0.5) return;
      const xLeft = head.localX - (meta.core.x + meta.core.w / 2) * scale;
      const fullW = tex.width * scale;
      /**
       * **下落面倾斜时的梯形**：倾斜让长条沿下落方向的**深度**连续变化（近端贴线、远端更深），
       * 于是远端应该更窄、并按判定线方向横向偏移 —— 一次性仿射变换画不出来（那是平行四边形），
       * 所以沿下落方向**逐行投影**：每行用自己那一行的深度算 k 与位置，整条长条就成了梯形。
       * `|sinθ|` 近似 0（含 `ignore3D`）时走原来的单次变换路径 —— 与旧版本逐像素一致。
       */
      if (Math.abs(head.sinT) > 1e-6) {
        drawTiltedHold(note, line, cam, { tex, meta, scale, xLeft, fullW, head, tail });
        return;
      }
      // 切片几何由 hold-geometry.js 统一计算（与预览工具/测试共用同一套规则）
      const slices = computeHoldSlices({
        meta,
        headLocalY: head.localY,
        tailLocalY: tail.localY,
        texW: tex.width,
        scale,
      });
      const k = head.depthScale > 0 ? head.depthScale : 1; // （伪）3D：整条长条按透视缩放
      const camPx = view.cameraOffsetPx({ focalH: opts.zFocalH, camera: cam });
      ctx.save();
      // 与 noteTransform 同一套：中心 +（线的世界位置 − 相机位置）× k
      ctx.translate(
        view.cx + ((Number.isFinite(line.worldX) ? line.worldX : 0) * view.areaW - camPx.x) * k,
        view.cy + (-(Number.isFinite(line.worldY) ? line.worldY : 0) * view.areaH - camPx.y) * k,
      );
      ctx.rotate(-head.angle);
      ctx.scale(k, k); // localX / localY 都是 z = 0 空间的量，统一缩放
      ctx.globalAlpha = note.renderAlpha;
      for (const s of slices) ctx.drawImage(tex, s.sx, s.sy, s.sw, s.sh, xLeft, s.dy, fullW, s.dh);
      ctx.restore();
      return;
    }

    const t = view.noteTransform(note, line, viewOpts);
    const rect = computeNoteRect({ meta, texW: tex.width, texH: tex.height, scale });
    const k = t.depthScale > 0 ? t.depthScale : 1;
    const squashY = Number.isFinite(t.squashY) && Math.abs(t.squashY) > 1e-3 ? t.squashY : 1;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(-t.angle);
    // （伪）3D：贴图整体按透视缩小；下落面倾斜时，沿下落方向再压缩 cosθ（斜着看平面的透视缩短）
    ctx.scale(k, k * squashY);
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
    // （伪）3D：命中记录里带着当时的 z 与**相机快照**，落点按同一套投影缩放 / 平移
    //（否则相机在动或 z ≠ 0 时特效会飘到音符外面）
    const localX = hit.offsetX * view.areaW * (hit.above ? 1 : -1);
    const localY = -hit.offsetY * view.areaH;
    const rot = hit.lineRotate * (hit.above ? -1 : 1) + (hit.above ? 0 : Math.PI);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return view.projectLocal(
      hit.lineX,
      hit.lineY,
      localX * cos - localY * sin,
      localX * sin + localY * cos,
      hit.depth ?? 0,
      { focalH: opts.zFocalH, camera: hit.camera },
    );
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
    const size0 = opts.noteWidthRatio * view.areaW * opts.hitFxScale;
    for (const hit of hits) {
      const age = now - hit.time;
      if (age < 0 || age > opts.hitFxDuration) continue;
      const atlas = (hit.perfect ? textures.hitPerfect : textures.hitGood) ?? textures.hit;
      if (!atlas) continue;
      // （伪）3D：特效大小也跟着透视缩放（与音符一致；用命中时刻的相机快照）
      const size = size0 * view.depthScaleAt(hit.depth ?? 0, { focalH: opts.zFocalH, camera: hit.camera });
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
   * 调试叠加层 1：音符的**判定范围**。
   * 判定带 = 以音符在判定线上的落点为中心、沿判定线方向 ±halfWidth 的一条「列」，沿下落方向不限长；
   * 这里就把它画成贯穿画面的半透明竖条（在判定线的局部坐标系里画，所以线旋转时也跟着转）。
   * 颜色按音符类型区分，方便一眼看出「点哪算命中」。
   */
  const RANGE_COLOR = { tap: '10,195,255', drag: '240,237,105', hold: '156,233,255', flick: '254,67,101' };

  /**
   * 调试叠加层 1：音符的**判定范围**（画的就是命中测试实际使用的区域）。
   *  - `opts.judgeRangeMode = 'band'`（垂直判定）：音符那一列的 2D 长条；
   *  - `= 'tilt'`（轨道判定，默认）：跟着（伪）3D 投影的**楔形** —— 越远越窄、并随判定线方向偏移；
   *  - `= 'screen'`（全屏判定）：没有「带」可画，直接不画。
   * 形状由 `projection.judgeBandShape()` 给出（与 `hitJudgeBand()` 同一套几何），
   * 所以「画出来的范围」就是「点哪算命中」。
   */
  function drawJudgeRanges(state) {
    const mode = opts.judgeRangeMode === 'screen' ? 'screen' : opts.judgeRangeMode === 'band' ? 'band' : 'tilt';
    if (mode === 'screen') return;
    for (const note of state.chart.notes) {
      if (!note.visible) continue;
      const line = state.lines[note.lineId];
      if (!line) continue;
      const shape = view.judgeBandShape(note, line, bandOpts({ camera: state.camera, ignore3D: mode === 'band' }));
      const points = shape?.points ?? [];
      if (points.length < 3) continue;
      const rgb = RANGE_COLOR[note.type] ?? '255,255,255';
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb},0.10)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb},0.55)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 调试叠加层 2：玩家手指位置的小圆点（坐标是画布 CSS 像素，与触摸事件一致） */
  function drawFingers(fingers) {
    for (const f of fingers ?? []) {
      const x = Number(f?.x);
      const y = Number(f?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const r = FINGER_RADIUS;
      ctx.save();
      ctx.beginPath?.();
      if (typeof ctx.arc === 'function') {
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        ctx.beginPath?.();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
      } else {
        // 没有 arc 的桩件环境：退化成方块，保证「有没有画」可验证
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect?.(x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();
    }
  }

  /**
   * @param {object} state core/state.js 的状态对象
   * @param {Array} hits 存活的打击特效列表（由 app 维护）
   * @param {{fingers?:{x:number,y:number,id?:any}[]}} [extra] 调试叠加层要用的实时数据
   */
  function draw(state, hits = [], extra = {}) {
    stats.holdRowsPlanned = 0;
    stats.holdRowsDrawn = 0;
    stats.holdCulled = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);

    const bg = ensureBackground();
    if (bg) {
      ctx.drawImage(bg, (view.width - view.areaW) / 2, 0, view.areaW, view.areaH);
    } else {
      ctx.fillStyle = '#0d0d12';
      ctx.fillRect(0, 0, view.width, view.height);
    }

    if (opts.showJudgeRange) drawJudgeRanges(state);

    if (opts.showLines) {
      const order = state.chart.lines
        .map((_, i) => i)
        .sort((a, b) => (state.chart.lines[a].zOrder || 0) - (state.chart.lines[b].zOrder || 0));
      for (const i of order) drawLine(state.lines[i], state.camera);
    }

    if (opts.showNotes) {
      for (const type of drawOrder) {
        for (const note of state.chart.notes) {
          if (note.type !== type || !note.visible) continue;
          drawNote(note, state.lines[note.lineId], state.camera);
        }
      }
    }

    if (opts.showHitFx) drawHitFx(hits, state.time);
    if (opts.showFingers) drawFingers(extra.fingers);
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
    /**
     * 上一帧的绘制统计（倾斜 Hold 的 计划行数 / 实际绘制行数 / 剔除行数）。
     * 测试与「性能自查」用：行数按屏幕长度自适应且封顶，屏幕外的行整行跳过。
     */
    get stats() {
      return stats;
    },
    /** 屏幕像素点选音符 / 判定线（供制谱器使用）：与绘制用同一套投影（含相机与 z / 倾斜） */
    pickNote: (state, px, py, radius = 24) =>
      pickNote(view, state, px, py, radius, { noteWidthRatio: opts.noteWidthRatio, focalH: opts.zFocalH, camera: state?.camera }),
    pickLine: (state, px, py, tolerance = 10) => pickLine(view, state, px, py, tolerance, { focalH: opts.zFocalH, camera: state?.camera }),
    /**
     * 判定带（判定范围）：点在不在音符所在的列里 —— 供真实游玩的判定使用。
     * 沿判定线方向比音符略宽，沿下落方向不限位置（见 docs/Phigros文档.md 的判定带）。
     * `o.ignore3D = true` 时忽略相机 / z / 倾斜（「垂直判定」），否则跟着（伪）3D 投影走（「轨道判定」）。
     */
    judgeBand: (state, note, o = {}) => view.judgeBand(note, state.lines[note.lineId], bandOpts(o, state.camera)),
    hitJudgeBand: (state, note, px, py, o = {}) => view.hitJudgeBand(note, state.lines[note.lineId], px, py, bandOpts(o, state.camera)),
    hitJudgeBandSegment: (state, note, x0, y0, x1, y1, o = {}) =>
      view.hitJudgeBandSegment(note, state.lines[note.lineId], x0, y0, x1, y1, bandOpts(o, state.camera)),
  };

  /**
   * 判定带参数：宽度基准与绘制一致（noteWidthRatio），半宽 = 音符宽 × BAND_HALF_RATIO（两边各 80%）；
   * 相机缺省取当前状态的相机（判定带要跟着画面上的音符走），`ignore3D` 时投影层会把它一并忽略。
   */
  function bandOpts(o = {}, camera = null) {
    return {
      halfRatio: o.halfRatio ?? JUDGE.BAND_HALF_RATIO,
      pad: o.pad ?? JUDGE.BAND_PAD,
      noteWidthRatio: o.noteWidthRatio ?? opts.noteWidthRatio,
      ignore3D: o.ignore3D === true,
      camera: o.camera ?? camera,
      focalH: o.focalH ?? opts.zFocalH,
    };
  }
}
