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
 * 倾斜下落面上的 Hold（分段带状画法）的参数。
 *
 * 为什么分段：倾斜面上的投影是透视，整段贴图用一次仿射画不出来 —— 一次仿射只能得到
 * 平行四边形，贴图在长度方向会被「拉直」。分段后每段用仿射近似透视，段内的形状误差
 * 随段高增长，所以段高按「误差预算」自适应（下面两个常量），贴线一端矮、远端高。
 */
/** 最短段高（CSS 像素）：透视变化最快的贴线一端也不会比它更矮（目标像素 = 它 × dpr） */
const HOLD_TILT_BAND_MIN_CSS = 3;
/**
 * 段内形状误差预算（CSS 像素）：段内仿射 vs 真实透视的最大偏差。它直接决定两件看得见的事：
 * 段与段交界处内容的水平错位（贴图横向结构越锐利越显眼）与第四角缺口的大小。
 * 0.6px 与旧固定 4 设备像素段的水平错位同级 —— 质量不回退，段数还略少。
 */
const HOLD_TILT_BAND_DRIFT_CSS = 0.6;
/**
 * 段高自适应的步进：接受后 +1（贴着预算爬坡）、超预算按比例收缩（保底 −1）。
 * 段高因此平滑跟上曲率变化，段距不规则 —— 肉眼不会把段界读成周期「纹理」。
 */
const HOLD_TILT_BAND_SHRINK = 0.75;
/** 段数上限（极端放大 / 很长的长条时按上限抬高最矮段高，避免绘制调用爆炸） */
const HOLD_TILT_MAX_BANDS = 400;
/**
 * 仿射的**安全膨胀量**（贴图局部像素）：把段内画出的图像沿两组基向量方向多撑一点，
 * 盖住「第四角缺口」与光栅化量化的亚像素缝隙（见 drawHoldBands 的说明）。
 */
const HOLD_TILT_BAND_MARGIN = 0.3;
/**
 * 距离分级基准（CSS 像素）：段离长条贴线端每远这么远，段高误差预算翻一倍。
 * 远端的条更窄（透视）、又在视觉焦点之外，段界错位本就难察觉。
 */
const HOLD_TILT_FAR_PX = 500;
/**
 * 旧画法（逐行单仿射退路）的行高与行数上限 —— 只在环境没有 `clip` 时使用
 * （测试桩件 / 很老的浏览器）：逐行一次三点定标仿射，第四条边允许小偏差，不缺块即可。
 */
const HOLD_TILT_ROW_PX = 18;
const HOLD_TILT_MAX_ROWS = 24;

/**
 * 每帧的绘制统计（目前只统计倾斜 Hold）：
 * `holdRowsPlanned` = 计划分段数，`holdRowsDrawn` = 实际画出来的段数
 * （窗口外的整段跳过），`holdCulled` = 被整段剔除的段数。
 * 供测试与调试量化「自适应段高 + 窗口外剔除」到底省了多少。
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
     * **低性能模式**（播放器暂停页可开关）：把倾斜长条的段高误差预算放宽数倍，
     * 分段绘制调用减少 3~4 倍 —— 段界的内容错位仍是亚像素~2px 级，远端还有距离分级兜底，
     * 换取弱设备（iPad Safari 等）上的流畅。默认关。
     */
    holdLowPerf: false,
    /**
     * 判定范围的画法，跟随暂停页里选的判定模式：
     * `'tilt'`（默认，轨道判定：跟着（伪）3D 的楔形）/ `'band'`（垂直判定：2D 那列）/ `'screen'`（全屏，不画）
     */
    judgeRangeMode: 'tilt',
    /** 调试：把玩家的手指位置画成小圆点（位置由调用方通过 draw 的第 3 个参数传入） */
    showFingers: false,
    /**
     * **制谱器**：高亮正在编辑的那条判定线（时间轴的活跃轨属于哪条线）。
     * 传 `lineId`（数字）即生效：该线换成醒目的描边色，**其余线降到 `dimOthers` 的透明度**，
     * 便于在几十条线里一眼找到当前在编辑哪条。保持原有绘制顺序（**不置顶**），
     * 只换颜色 + 压暗其他线，所以不会改变画面遮挡关系。默认 null（关闭）。
     */
    highlightLineId: null,
    /** 高亮时其他线的不透明度（1 = 不压暗；太小会让画面显得空） */
    dimOthers: 0.25,
    /** 高亮线的描边色（与事件块的主题色系一致） */
    highlightColor: '#6B85FF',
    /**
     * 判定线的**最低渲染不透明度**（0~1）。制谱器用它保证：即使线的事件把 alpha 降到 0，
     * 用户也看得见线在哪（0.2 = 20%）。播放器保持 0（该透明就透明）。
     */
    minLineAlpha: 0,
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
   * 背景：cover 铺满 + 毛玻璃遮罩（模糊 + 压暗）。
   * 实现放在 `textures.js` 的 `makeBackground` —— 那里**不依赖 `ctx.filter`**：
   * WebKit 会把 filter 存下来却不生效，靠 filter 的模糊在 iOS / iPadOS / macOS 上会静默消失
   * （实测 WebKit 26.6 挂上 filter 后中间灰阶像素数为 0，Chromium 同一用例为 1020）。
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
  /**
   * 画一条判定线。
   *
   * 制谱器高亮（`opts.highlightLineId`）：命中的那条线**加一圈醒目的描边**，
   * 其余线整体压暗到 `dimOthers` —— 这样在几十条线里一眼就能找到正在编辑的那条，
   * 同时**不改变绘制顺序**（高亮线不置顶），画面的遮挡关系与播放器里看到的一致。
   */
  function drawLine(ls, cam, lineId = -1) {
    const hl = opts.highlightLineId;
    const isHot = hl !== null && hl !== undefined && lineId === hl;
    const dimmed = hl !== null && hl !== undefined && !isHot;
    // minLineAlpha：制谱器里完全透明的线也按最低不透明度画出来（用户要能看见线在哪）
    const alpha = Math.max(opts.minLineAlpha ?? 0, Math.max(0, Math.min(1, ls.alpha)) * (dimmed ? opts.dimOthers : 1));
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
    // 高亮描边：画在线体**外侧**（线段本身加粗一半、不盖住线体），并在两端各点一个端点标记，
    // 这样线很细 / 贴图很淡时也能看清是哪条。
    if (isHot) {
      const pad = Math.max(1.5, thickness * 0.35);
      ctx.globalAlpha = Math.min(1, alpha + 0.35);
      ctx.strokeStyle = opts.highlightColor;
      ctx.lineWidth = Math.max(1.5, thickness * 0.22);
      ctx.strokeRect(-length / 2 - pad, -thickness / 2 - pad, length + pad * 2, thickness + pad * 2);
      const capR = Math.max(2, thickness * 0.9);
      ctx.fillStyle = opts.highlightColor;
      for (const cx of [-length / 2, length / 2]) {
        ctx.beginPath();
        ctx.arc(cx, 0, capR, 0, Math.PI * 2);
        ctx.fill();
      }
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
  /**
   * **倾斜下落面上的长条**：按判定线是否旋转分派（两种都走「分段带状」画法）。
   *
   * - 判定线**没有旋转**（行的方向在屏幕上水平）→ 直接画在主画布上，段边界吸附
   *   **设备像素整数 y**：共享边两侧的抗锯齿覆盖是 0/1 判定，段与段之间无缝
   *   （真浏览器实测：共享边落在设备 y 整数上覆盖 255，落在 200.5 时只有 191）。
   * - 判定线**被旋转**（含任意 worldRotate / 背面）→ 段边界在屏幕上是斜线，没法对齐设备网格；
   *   旧画法为此每行拆两个裁剪三角形 + 外扩补缝，斜向缝与梯形台阶始终压不干净。
   *   现在改为把长条画进**离屏画布**：在「线轴水平」的坐标系里分段（离屏自己的像素网格
   *   同样能对齐整数），再整体旋转贴回主画布（一次 drawImage）—— 斜缝、台阶、补缝亮带一起消失。
   * - 没有 `clip` 的环境（测试桩件 / 很老的浏览器）→ 逐行单仿射退路（不缺块即可）。
   */
  function drawTiltedHold(note, line, cam, geo) {
    if (typeof ctx.clip !== 'function') {
      drawTiltedHoldFallback(note, line, cam, geo);
      return;
    }
    // 行方向 = 局部 x 轴在屏幕上的方向：angle = worldRotate +（背面 +π）
    const angle = (Number.isFinite(line?.worldRotate) ? line.worldRotate : 0) + (note.above === false ? Math.PI : 0);
    const project = view.lineProjector(line, { focalH: opts.zFocalH, camera: cam, above: note.above !== false });
    // 横向错位 = 条宽 × |sin(angle)|：小于半个像素的「旋转」在视觉上不存在（很多谱的 rotate
    // 事件只是从 0 缓动出发、前期转角 microscopic），直接走主画布分段 —— 省掉整套离屏开销。
    if (Math.abs(Math.sin(angle)) * geo.fullW < 0.5) {
      drawHoldBands(
        ctx,
        project,
        (p) => ({ x: p.x * dpr, y: p.y * dpr }),
        dpr,
        { x0: -8 * dpr, y0: -8 * dpr, x1: (view.width + 8) * dpr, y1: (view.height + 8) * dpr },
        note,
        geo,
        note.renderAlpha,
        null,
        opts.holdLowPerf ? 4 : 1,
      );
    } else {
      drawTiltedHoldRotated(note, line, cam, geo, angle, project, opts.holdLowPerf ? 2.5 : 1);
    }
  }

  /** 复用的离屏画布（旋转长条先画进来再整体贴回）；尺寸变化时重置，否则只清屏 */
  let holdLayer = null;
  function holdLayerCanvas(w, h) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (!holdLayer) holdLayer = document.createElement('canvas');
    const cw = Math.max(1, Math.min(4096, Math.ceil(w)));
    const ch = Math.max(1, Math.min(4096, Math.ceil(h)));
    if (holdLayer.width !== cw || holdLayer.height !== ch) {
      holdLayer.width = cw;
      holdLayer.height = ch;
    } else {
      holdLayer.getContext('2d').clearRect(0, 0, cw, ch);
    }
    return holdLayer;
  }

  /**
   * **判定线被旋转时的倾斜长条**：离屏分段 + 整体旋转贴回。
   *
   * 把屏幕坐标绕长条头部中心旋转 −angle，得到「线轴水平」的坐标系：在这套坐标系里
   * 设备 y 同样只与局部 y 有关（代数上 localX 项正好消掉），分段带状的全部结论照用 ——
   * 段边界对齐**离屏画布**的像素网格，画好后一次旋转 drawImage 贴回主画布。
   * 离屏范围 = 长条四角 ∩ 视口（各自转到线轴水平系后取包围盒），所以离屏只有
   * 长条露出的那一小块，多花的只是长条像素面积的一次额外合成。
   */
  function drawTiltedHoldRotated(note, line, cam, geo, angle, projectScreen, budgetScale = 1) {
    const { xLeft, fullW, head, tail } = geo;
    const xRight = xLeft + fullW;
    const anchor = projectScreen(xLeft + fullW / 2, head.localY0);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    // frame：屏幕 CSS → 线轴水平系（判定线长轴 = frame x、下落方向 = frame y）
    const frame = (p) => {
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      return { x: dx * cosA - dy * sinA, y: dx * sinA + dy * cosA };
    };
    const project = (lx, v) => frame(projectScreen(lx, v));
    const corners = [
      project(xLeft, head.localY0),
      project(xRight, head.localY0),
      project(xRight, tail.localY0),
      project(xLeft, tail.localY0),
    ];
    const viewCorners = [
      frame({ x: 0, y: 0 }),
      frame({ x: view.width, y: 0 }),
      frame({ x: 0, y: view.height }),
      frame({ x: view.width, y: view.height }),
    ];
    const margin = 8;
    const x0 = Math.max(Math.min(...corners.map((p) => p.x)), Math.min(...viewCorners.map((p) => p.x))) - margin;
    const x1 = Math.min(Math.max(...corners.map((p) => p.x)), Math.max(...viewCorners.map((p) => p.x))) + margin;
    const y0 = Math.max(Math.min(...corners.map((p) => p.y)), Math.min(...viewCorners.map((p) => p.y))) - margin;
    const y1 = Math.min(Math.max(...corners.map((p) => p.y)), Math.max(...viewCorners.map((p) => p.y))) + margin;
    if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) return;
    const layer = holdLayerCanvas((x1 - x0) * dpr, (y1 - y0) * dpr);
    const lctx = layer && layer.getContext('2d');
    // 离屏上下文能力不足（简化画布桩件 / 老浏览器）→ 退回逐行单仿射
    if (!lctx || typeof lctx.clip !== 'function' || typeof lctx.beginPath !== 'function' || typeof lctx.setTransform !== 'function') {
      drawTiltedHoldFallback(note, line, cam, geo);
      return;
    }
    // 离屏里落在**真实视口之外**的段不必真画（视口 AABB 的四角在旋转系里是屏外的）：
    // 段的包围盒（frame 系的轴对齐矩形）与「旋转后的视口矩形」做 SAT 相交测试，4 条轴任何
    // 一条分离即整段剔除 —— 旋转 45° 附近能省掉近一半的绘制调用。
    // 注意坐标空间：drawHoldBands 的剔除用「离屏像素」，这里把视口矩形也换到同一空间
    // （frame CSS → 减包围盒原点 → ×dpr），否则包围盒原点会把整片段错判成屏外。
    const vc = {
      x: (frame({ x: view.width / 2, y: view.height / 2 }).x - x0) * dpr,
      y: (frame({ x: view.width / 2, y: view.height / 2 }).y - y0) * dpr,
    };
    const halfW = (view.width / 2 + margin) * dpr;
    const halfH = (view.height / 2 + margin) * dpr;
    const ux = cosA;
    const uy = sinA;
    const vx = -sinA;
    const vy = cosA;
    const screenCull = {
      offscreen(minX, minY, maxX, maxY) {
        // 轴 x / 轴 y：视口投影半径 = 两半宽在该轴上的绝对投影之和
        let r = halfW * Math.abs(ux) + halfH * Math.abs(vx);
        if (vc.x + r < minX || vc.x - r > maxX) return true;
        r = halfW * Math.abs(uy) + halfH * Math.abs(vy);
        if (vc.y + r < minY || vc.y - r > maxY) return true;
        // 轴 u / 轴 v：段的四角投影区间 vs 视口中心 ± 半宽
        const cornersU = [minX * ux + minY * uy, maxX * ux + minY * uy, minX * ux + maxY * uy, maxX * ux + maxY * uy];
        const cu = vc.x * ux + vc.y * uy;
        if (Math.max(...cornersU) < cu - halfW || Math.min(...cornersU) > cu + halfW) return true;
        const cornersV = [minX * vx + minY * vy, maxX * vx + minY * vy, minX * vx + maxY * vy, maxX * vx + maxY * vy];
        const cv = vc.x * vx + vc.y * vy;
        if (Math.max(...cornersV) < cv - halfH || Math.min(...cornersV) > cv + halfH) return true;
        return false;
      },
    };
    drawHoldBands(
      lctx,
      project,
      (p) => ({ x: (p.x - x0) * dpr, y: (p.y - y0) * dpr }),
      dpr,
      { x0: 0, y0: 0, x1: layer.width, y1: layer.height },
      note,
      geo,
      1,
      screenCull,
      1.7 * budgetScale,
    );
    // 贴回主画布：frame → 屏幕。layer 的像素 (0,0) 对应 frame 的 (x0, y0)。
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = note.renderAlpha;
    ctx.translate(anchor.x, anchor.y);
    ctx.rotate(-angle);
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  /**
   * 分段带状绘制核心（主画布 / 离屏共用）。
   *
   * `target` 目标 2D 上下文；`project(localX, localY0)` 线局部 → 屏幕 CSS；
   * `px(p)` 屏幕 CSS → 目标画布像素；`bounds` 目标像素里的绘制窗口；`alpha` 本条长条的不透明度
   * （离屏路径传 1，旋转贴回时再乘 renderAlpha —— 与直接画等价，避免透明度被乘两次）。
   *
   * 段的三条不变量（对应实测结论，见项目文档 §5.4）：
   *  1. 所有内部段边界取**目标像素整数 y**：共享边两侧覆盖 0/1、严丝合缝；
   *     长条自身两端（轮廓）与绘制窗口边缘保持精确值（窗口边在屏外 ±8px，无所谓）。
   *  2. 每段 = 一次裁剪（四个角都精确投影的四边形）+ 一次三点定标仿射。仿射只能对上三个角，
   *     第四个角差 O(段高) —— 把仿射的两组基向量按「第四角缺口」**微量膨胀**，让画出的图像
   *     完整盖住精确四边形：缺口不再露出背景（长条边缘不再有锯齿状缺口），代价是段内内容
   *     被拉伸 ≤ 预算（亚像素，不可见）。
   *  3. 段高按形状误差预算自适应（贴线端矮、远端高）：同样的预算下绘制调用更少，
   *     且段距不规则 —— 肉眼不会把段界读成周期「纹理」。
   */
  function drawHoldBands(target, project, px, dprEff, bounds, note, geo, alpha, screenCull, budgetScale = 1) {
    // 距离分级：预算随「段离长条贴线一端的目标像素距离」放宽 —— 贴线端（视觉焦点、条最宽）
    // 保持精细，远端条又窄又靠边，段界错位本就不显眼，段高可以放宽数倍。
    // 超长 hold 的可见跨度大，这一项 alone 就能把分段数省下一半，近端质量不变。
    const farPx = HOLD_TILT_FAR_PX * dprEff;
    const { tex, meta, scale, xLeft, fullW, head, tail } = geo;
    const xRight = xLeft + fullW;
    const vHead = head.localY0;
    const vTail = tail.localY0;
    if (!(Math.abs(vTail - vHead) > 1e-3) || !(fullW > 1e-3)) return;
    // 切片（源结构）由 hold-geometry.js 统一给出：帽 / 主体 / 光效
    const slices = computeHoldSlices({ meta, headLocalY: vHead, tailLocalY: vTail, texW: tex.width, scale });
    if (!slices.length) return;
    // 目标像素 y（只与局部 y 有关，与 localX 无关 —— 分派条件保证；旋转线是「线轴水平系」的 y）
    const yAt = (v) => px(project(xLeft, v)).y;
    let holdMin = Infinity;
    let holdMax = -Infinity;
    for (const s of slices) {
      holdMin = Math.min(holdMin, s.dy);
      holdMax = Math.max(holdMax, s.dy + s.dh);
    }
    if (!(holdMax - holdMin > 1e-3)) return;
    /**
     * 切片按几何位置排序，相邻接缝吸附到目标像素整数 y：两片共用同一条精确边界
     * （同一个方程的同一个根），既没有抗锯齿缝、也不需要「重叠 1px 补缝」
     * （重叠对半透明贴图会叠亮）。长条自身的两端保持精确，不吸附。
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
      // 接缝取「两片端点之间」的目标像素整数：两块共用同一条精确边界，且都落在各自单调段内
      const yA = yAt(ordered[i].hi);
      const yB = yAt(ordered[i + 1].lo);
      const loY = Math.min(yA, yB);
      const hiY = Math.max(yA, yB);
      const jMin = Math.ceil(loY);
      const jMax = Math.floor(hiY);
      junctions.push(jMin <= jMax ? Math.max(jMin, Math.min(jMax, Math.round((yA + yB) / 2))) : Math.round((yA + yB) / 2));
    }
    // 单调化：极端配置下某个接缝可能被吸附到上一个之前，那会出现空洞。
    // 方向由首尾决定（背面 / 负角度时设备 y 沿几何顺序是递减的，不能一律按递增修）
    const devUp = yAt(ordered[ordered.length - 1].hi) >= yAt(ordered[0].lo);
    for (let i = 1; i < junctions.length; i++) {
      if (devUp ? junctions[i] < junctions[i - 1] : junctions[i] > junctions[i - 1]) {
        junctions[i] = junctions[i - 1];
      }
    }
    const minBand = Math.max(1, Math.round(HOLD_TILT_BAND_MIN_CSS * dprEff));
    const driftBudget = HOLD_TILT_BAND_DRIFT_CSS * budgetScale * dprEff;
    const yHeadDev = yAt(vHead); // 贴线一端的目标像素 y（距离分级基准）
    let bandsUsed = 0;
    target.save();
    target.globalAlpha = alpha;
    for (let si = 0; si < ordered.length; si++) {
      const { s, lo: sLo, hi: sHi } = ordered[si];
      if (!(s.dh > 0.01) || !(s.sh > 0)) continue;
      // 这一片的目标像素区间：两端由相邻接缝（整数）或长条自己的轮廓界定
      const dTop = si === 0 ? yAt(sLo) : (junctions[si - 1] ?? yAt(sLo));
      const dBot = si === ordered.length - 1 ? yAt(sHi) : (junctions[si] ?? yAt(sHi));
      const dA = Math.min(dTop, dBot);
      const dB = Math.max(dTop, dBot);
      if (!(dB - dA > 0.05)) continue; // 被压到不足 1 个目标像素：由相邻切片覆盖
      /**
       * 先把这一片裁到**绘制窗口**里再分段：远端深度被 MIN_DEPTH 夹住后，局部到设备的映射会
       * 变得极陡（实测 θ=-35° 时长条远端能拉到屏幕上方两万像素），若先按整段算段数，
       * 段数上限会把段高放大到几十像素 —— 那正是「长条上出现几十像素间距的横线」的来源。
       */
      const clipA = Math.max(dA, bounds.y0);
      const clipB = Math.min(dB, bounds.y1);
      stats.holdCulled += Math.max(0, Math.ceil((Math.min(dB, bounds.y0) - dA) / minBand));
      stats.holdCulled += Math.max(0, Math.ceil((dB - Math.max(dA, bounds.y1)) / minBand));
      if (!(clipB - clipA > 0.05)) continue; // 整片都在窗口外
      const solveV = makeDeviceYSolver(yAt, sLo, sHi);
      const svOf = (v) => s.sy + (v - s.dy) * (s.sh / s.dh);
      // 相邻两段共享边：每条边只解一次（闭式初值 + 割线收敛），结果缓存在边的目标像素值上
      const solveCache = new Map();
      const solve = (d) => {
        if (!solveCache.has(d)) solveCache.set(d, solveV(d));
        return solveCache.get(d);
      };
      // 段数上限：这一片按剩余配额摊（超限时抬高最矮段高）
      const capLeft = Math.max(1, HOLD_TILT_MAX_BANDS - bandsUsed);
      const minH = Math.max(minBand, Math.ceil((clipB - clipA) / capLeft));
      // 段高控制器：lo = 已接受的最大段高、hi = 已拒绝的最小段高，二分逼近预算边界。
      // 收敛后段高稳定在边界上（比「拒绝就猛缩」少很多无谓的重试，段距也更有序）。
      let lo = minH;
      let hi = Infinity;
      let h = minH;
      let d0 = clipA;
      const base = Math.round(clipA); // 第一段的底边从整数起算，之后每条内部边界都是整数
      while (d0 < clipB - 0.05) {
        // 收缩循环：测量段内形状误差，超预算就改矮重试；到最矮段高为止（预算到头也接受）
        let attempt = null;
        let hTry = Math.max(1, Math.min(h, Math.floor(clipB - d0))); // 整数段高 → 内部边界保持整数
        for (let guard = 0; guard < 24 && !attempt; guard++) {
          let d1 = (d0 === clipA ? base : d0) + hTry;
          if (clipB - d1 < minH * 0.5) d1 = clipB; // 尾段：别留下不足半段的碎段
          d1 = Math.min(Math.max(d1, Math.floor(d0) + 1), clipB); // 保证前进，防死循环
          const v0 = solve(d0);
          const v1 = solve(d1);
          if (v0 === null || v1 === null || !(Math.abs(v1 - v0) > 1e-6)) {
            attempt = { d1, v0: null, v1: null }; // 求解失败：跳过这一段（安全网，正常不会发生）
            break;
          }
          const AL = px(project(xLeft, v0));
          const AR = px(project(xRight, v0));
          const BL = px(project(xLeft, v1));
          const BR = px(project(xRight, v1));
          // 仿射（目标像素）：基向量 u（贴图横向）/ w（纵向），三点定标（顶边 + 左下角）
          const ux = (AR.x - AL.x) / (xRight - xLeft);
          const uy = (AR.y - AL.y) / (xRight - xLeft);
          const wx = (BL.x - AL.x) / (v1 - v0);
          const wy = (BL.y - AL.y) / (v1 - v0);
          const cross = ux * wy - uy * wx;
          // 第四角缺口 δ = BR − 仿射(xRight, v1)，分解到 u / w 方向（局部像素单位）
          const dxB = BR.x - (AL.x + ux * (xRight - xLeft) + wx * (v1 - v0));
          const dyB = BR.y - (AL.y + uy * (xRight - xLeft) + wy * (v1 - v0));
          const alphaU = cross ? (dxB * wy - dyB * wx) / cross : 0;
          const alphaV = cross ? (ux * dyB - uy * dxB) / cross : 0;
          const driftU = Math.abs(alphaU) * Math.hypot(ux, uy);
          const driftV = Math.abs(alphaV) * Math.hypot(wx, wy);
          const budget = driftBudget * (1 + Math.abs((d0 + d1) / 2 - yHeadDev) / farPx);
          // 左边缘中点的垂度（透视 vs 直线的偏差，O(段高²) 的那一项）
          const vMid = (v0 + v1) / 2;
          const sag = Math.abs(yAt(vMid) - (AL.y + BL.y) / 2);
          if (driftU <= budget && driftV <= budget && sag <= budget) {
            attempt = { d1, v0, v1, AL, AR, BL, BR, ux, uy, wx, wy, alphaU, alphaV };
            lo = Math.max(lo, hTry);
            h = hi === Infinity ? hTry + 1 : Math.max(minH, Math.ceil((lo + hi) / 2));
          } else if (hTry > minH) {
            hi = Math.min(hi, hTry);
            // 收缩必须严格前进（保底 −1）：曲率沿长度变化，同一高度在别处可能超预算，
            // 若 lo==hi 时原地重试同一高度会耗尽守卫次数，留下一段缺口。
            hTry = Math.max(minH, Math.min(hTry - 1, Math.floor((lo + hi) / 2)));
          } else {
            attempt = { d1, v0, v1, AL, AR, BL, BR, ux, uy, wx, wy, alphaU, alphaV };
          }
        }
        if (!attempt) break; // 兜底：极端数值下停止分段（不会缺整片 —— 上限远大于实际需要）
        if (attempt.v0 !== null) {
          const { d1, v0, v1, AL, AR, BL, BR, ux, uy, wx, wy, alphaU, alphaV } = attempt;
          stats.holdRowsPlanned += 1;
          // 屏幕外整段剔除
          const minX = Math.min(AL.x, AR.x, BL.x, BR.x);
          const maxX = Math.max(AL.x, AR.x, BL.x, BR.x);
          const minY = Math.min(AL.y, AR.y, BL.y, BR.y);
          const maxY = Math.max(AL.y, AR.y, BL.y, BR.y);
          if (maxX < bounds.x0 - 1 || minX > bounds.x1 + 1 || maxY < bounds.y0 - 1 || minY > bounds.y1 + 1) {
            stats.holdCulled += 1;
          } else if (screenCull && screenCull.offscreen(minX, minY, maxX, maxY)) {
            stats.holdCulled += 1; // 段落在真实视口之外（离屏路径：视口 AABB 的四角余量）
          } else {
            // 基向量按缺口微量膨胀：画出的图像完整盖住精确四边形，缺口不再露背景
            const growU = 1 + (Math.max(0, alphaU) + HOLD_TILT_BAND_MARGIN) / (xRight - xLeft);
            const growW = 1 + (Math.max(0, alphaV) + HOLD_TILT_BAND_MARGIN) / (v1 - v0);
            const a = ux * growU;
            const b = uy * growU;
            const c = wx * growW;
            const dd = wy * growW;
            const e = AL.x - a * xLeft - c * v0;
            const f = AL.y - b * xLeft - dd * v0;
            target.save();
            // 目标像素坐标系：裁剪四边形直接落在目标像素网格上（整数边覆盖 0/1 的前提）
            target.setTransform(1, 0, 0, 1, 0, 0);
            target.beginPath();
            target.moveTo(AL.x, AL.y);
            target.lineTo(AR.x, AR.y);
            target.lineTo(BR.x, BR.y);
            target.lineTo(BL.x, BL.y);
            target.closePath();
            target.clip();
            target.setTransform(a, b, c, dd, e, f);
            target.drawImage(tex, 0, svOf(v0), tex.width, Math.max(1e-3, svOf(v1) - svOf(v0)), xLeft, v0, fullW, v1 - v0);
            target.restore();
            stats.holdRowsDrawn += 1;
          }
        }
        bandsUsed += 1;
        d0 = attempt.d1;
      }
    }
    target.restore();
  }

  /**
   * **倾斜长条的退路**：环境没有 `clip`（测试桩件 / 很老的浏览器）时逐行单仿射。
   *
   * 每行一次三点定标仿射（左上 / 右上 / 左下），第四条边允许小偏差；没有裁剪路径可依靠，
   * 不外扩绘制矩形（相邻行严丝合缝，不会叠加）。行数按屏幕长度动态定，屏幕外的整行剔除。
   */
  function drawTiltedHoldFallback(note, line, cam, geo) {
    const { tex, meta, scale, xLeft, fullW, head, tail } = geo;
    const viewOpts = { focalH: opts.zFocalH, camera: cam, above: note.above !== false };
    const project = view.lineProjector(line, viewOpts);
    const screenOf = (lx, v) => project(lx, v);
    const slices = computeHoldSlices({
      meta,
      headLocalY: head.localY0,
      tailLocalY: tail.localY0,
      texW: tex.width,
      scale,
    });
    const totalLocal = Math.abs(tail.localY0 - head.localY0);
    if (!(totalLocal > 1e-3) || !(fullW > 1e-3)) return;
    const midX = xLeft + fullW / 2;
    const headMid = screenOf(midX, head.localY0);
    const tailMid = screenOf(midX, tail.localY0);
    const span = Math.hypot(headMid.x - tailMid.x, headMid.y - tailMid.y);
    const wantRows = Math.round(Number.isFinite(span) ? span / HOLD_TILT_ROW_PX : 1) || 1;
    const rowsTotal = Math.max(1, Math.min(HOLD_TILT_MAX_ROWS, wantRows));
    const rowLocalPx = totalLocal / rowsTotal;
    const xRight = xLeft + fullW;
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
        const rowTl = screenOf(xLeft, y0);
        const rowTr = screenOf(xRight, y0);
        const rowBl = screenOf(xLeft, y1);
        // 屏幕外整行剔除
        const minX = Math.min(rowTl.x, rowTr.x, rowBl.x);
        const maxX = Math.max(rowTl.x, rowTr.x, rowBl.x);
        const minY = Math.min(rowTl.y, rowTr.y, rowBl.y);
        const maxY = Math.max(rowTl.y, rowTr.y, rowBl.y);
        if (maxX < -8 || minX > view.width + 8 || maxY < -8 || minY > view.height + 8) {
          stats.holdCulled += 1;
          continue;
        }
        const sy0 = s.sy + i * rowSrc;
        const w = Math.max(1e-3, xRight - xLeft);
        const a = (rowTr.x - rowTl.x) / w;
        const b = (rowTr.y - rowTl.y) / w;
        const c = (rowBl.x - rowTl.x) / rowDest;
        const d = (rowBl.y - rowTl.y) / rowDest;
        if (![a, b, c, d].every(Number.isFinite)) continue;
        const e = rowTl.x - a * xLeft - c * y0;
        const f = rowTl.y - b * xLeft - d * y0;
        ctx.save();
        ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
        ctx.drawImage(tex, 0, sy0, tex.width, rowSrc, xLeft, y0, fullW, rowDest);
        ctx.restore();
        stats.holdRowsDrawn += 1;
      }
    }
    ctx.restore();
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
      // 把线号传给 drawLine：制谱器高亮要知道「这是第几条线」（state.lines 里没有 id 字段）
      for (const i of order) drawLine(state.lines[i], state.camera, i);
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
