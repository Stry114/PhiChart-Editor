/**
 * 投影（投影数学）：画面区域、世界坐标 ↔ 屏幕像素、音符的屏幕变换，以及拾取（点选）。
 * 渲染器只用它来算坐标，制谱器可以直接用它做「鼠标点选音符 / 判定线」与 UI 叠加层，
 * 不必重复实现这套换算（见 docs/项目文档.md 的编辑器数据流）。
 *
 * 约定：
 *  - 世界坐标：x = 画面宽比例、y = 画面高比例，原点在画面中心，y 向上为正（canonical，见 core/units.js）
 *  - 渲染区域：按 16:9 contain 适配（areaW = min(宽, 高 × 16/9)），像素原点在左上
 *  - 音符局部坐标（判定线坐标系内）：dx = positionX × 0.05625 × areaW、dy = Y(t) × 0.6 × areaH
 *  - （伪）3D 扩展：`lineState.z`（画面高比例，正 = 往屏幕内）与 `lineState.theta`（弧度，
 *    正 = 下落面向屏幕内倾）在这里统一折算成「深度 → 缩放 k」，绘制/拾取/判定带共用同一套公式
 *    （`opts.ignore3D = true` 可显式关掉，用于「垂直判定」模式）
 *  - 谱面相机（`opts.camera`，见 core/units.js 的 CAMERA_KEYS）：小孔相机的**位置 / 视角**，
 *    公式 `屏幕 = 中心 + (偏移 − 相机位置) × k`、`k = F / (深度 + F − 相机推拉)`；
 *    相机在默认位置（x=y=z=0、视角缺省 ≈53.13°）时与「没有相机」逐像素一致。
 *    `opts.ignore3D = true`（垂直判定）时相机与 z / 倾斜一起被忽略。
 */
import { angleToFocal, NOTE, PSEUDO3D } from '../core/units.js';

export function createProjection(width, height, options = {}) {
  const aspect = options.aspect ?? 16 / 9;
  const areaH = height;
  const areaW = Math.min(width, height * aspect);
  const cx = (width - areaW) / 2 + areaW / 2;
  const cy = areaH / 2;

  /**
   * 焦距（像素）：**由谱面相机的「视角」换算**（`F = 1/(2·tan(θ/2))` 屏高，角度越大越「广角」、
   * 透视越强）；没有相机状态时用渲染器的 `opts.focalH` 覆盖，最后落在默认 1 屏高（≈53.13°）。
   * 焦距本身不再是一个相机通道 —— 界面上只暴露视角，避免「焦距」这种不好估的量。
   */
  function focalPxOf(opts) {
    const c = opts?.camera;
    if (Number.isFinite(c?.angle) && c.angle > 0) return angleToFocal(c.angle) * areaH;
    const f = Number.isFinite(opts?.focalH) && opts.focalH > 0 ? opts.focalH : PSEUDO3D.FOCAL_H;
    return f * areaH;
  }

  /**
   * 相机状态（单位：像素，屏幕坐标）：
   *  - `sx / sy`：相机位置（sy 向下为正，所以相机「往上移」是负的）；
   *  - `zPx`：沿光轴的推拉（正 = 往屏幕内）；
   *  - `F`：焦距。
   * `opts.ignore3D = true`（垂直判定）或没有相机时，横向位置与推拉都按 0 处理。
   */
  function cameraOf(opts) {
    const c = opts?.ignore3D === true ? null : opts?.camera;
    return {
      sx: (Number.isFinite(c?.x) ? c.x : 0) * areaW,
      sy: -(Number.isFinite(c?.y) ? c.y : 0) * areaH,
      zPx: (Number.isFinite(c?.z) ? c.z : 0) * areaH,
      F: focalPxOf(opts),
    };
  }

  /**
   * （伪）3D 的透视缩放：k = F / (深度 + F − 相机推拉)。
   * 深度与焦距都以画面高为单位（这里都换成像素）；深度 + F 是「点离相机的距离」，
   * 相机推进（z 通道为正）→ 距离变小 → k 变大（整体放大、透视更强）。
   * 距离逼近 0 之前夹住，避免除零 / 画面翻转（视觉上早就没意义了）。
   */
  function depthScale(depthPx, cam) {
    const min = cam.F * PSEUDO3D.MIN_DEPTH_RATIO;
    const depth = Number.isFinite(depthPx) ? depthPx : 0;
    return cam.F / Math.max(depth + cam.F - cam.zPx, min);
  }

  /** 判定线的（伪）3D：{ k, depthPx, cam }（位置 / 长度 / 厚度都乘 k） */
  function lineDepth(lineState, opts = {}) {
    const cam = cameraOf(opts);
    const use3D = opts.ignore3D !== true;
    const depthPx = use3D && Number.isFinite(lineState?.z) ? lineState.z * areaH : 0;
    return { k: depthScale(depthPx, cam), depthPx, cam };
  }

  const projection = {
    width,
    height,
    areaW,
    areaH,
    cx,
    cy,
    /** 渲染区域实际宽高比（固定 16:9；父子线偏移旋转需要它，见 docs/项目文档.md 的编辑器实现要点） */
    aspect: areaW / areaH,

    toScreenX: (worldXFrac) => cx + worldXFrac * areaW,
    toScreenY: (worldYFrac) => cy - worldYFrac * areaH,
    toWorldX: (px) => (px - cx) / areaW,
    toWorldY: (py) => (cy - py) / areaH,

    /**
     * 音符在屏幕上的位置与旋转（绘制与拾取共用同一套公式，避免两处漂移）。
     *
     * **（伪）3D**：`lineState.z`（画面高比例，正 = 往屏幕内）与 `lineState.theta`（弧度，正 = 下落面向
     * 屏幕内倾）在这里统一生效 —— 小孔投影 `k = F/(F + z)`，屏幕坐标 = 画面中心 + (偏移 × k)：
     *  - 线的 z 让整条线（含它上面的音符）缩小并向画面中心靠拢；
     *  - theta 绕**判定线长轴**旋转下落面：离线的距离 d（屏幕上方为正）分成 `d·cosθ`（屏幕上）与
     *    `d·sinθ`（深度，屏幕上方的一侧往屏幕内走），于是远处的音符会**同时横向偏移 + 缩小**；
     *  - 返回的 `localX / localY` 都是**投影后**的局部像素偏移（Hold 的头/尾几何直接用它），
     *    `localY0` 是**倾斜前**的偏移（Hold 逐行投影的梯形用），`squashY = cosθ` 供贴图按透视压扁
     *    （音符贴图在屏幕上沿下落方向缩短）、`sinT` 是倾斜角正弦。
     *
     * z = 0 且 theta = 0 时 k = 1、cosθ = 1，与旧公式逐像素一致（相机在默认位置时也一样）。
     *
     * @param {object} note 编译后的音符（含 positionX / distY / yOffset / speed / size / above）
     * @param {object} lineState state.lines[i]（含 worldX / worldY / worldRotate / z / theta）
     * @param {{noteWidthRatio?:number, distY?:number, focalH?:number, camera?:object, ignore3D?:boolean}} [opts]
     *        distY 可覆盖（Hold 头/尾分别求值）；camera = `state.camera`（谱面相机）
     */
    noteTransform(note, lineState, opts = {}) {
      const noteWidthRatio = opts.noteWidthRatio ?? 0.125;
      const distY = opts.distY ?? note.distY ?? 0;
      const dyScale = 0.6 * areaH;
      const localX0 = note.positionX * 0.05625 * areaW * (note.above ? 1 : -1);
      const offsetPx = (note.yOffset || 0) * note.speed * dyScale * (note.above ? -1 : 1);
      const localY0 = -distY * dyScale - offsetPx;
      const angle = lineState.worldRotate + (note.above ? 0 : Math.PI);
      const thetaRot = -angle; // 画布为顺时针正
      const cos = Math.cos(thetaRot);
      const sin = Math.sin(thetaRot);

      // （伪）3D：深度 = 线的 z + 倾斜带来的深度分量（「屏幕上方」为远端）
      const use3D = opts.ignore3D !== true;
      const theta = use3D && Number.isFinite(lineState.theta) ? lineState.theta : 0;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const localYt = localY0 * cosT;
      const cam = cameraOf(opts);
      const depthPx = use3D ? (Number.isFinite(lineState.z) ? lineState.z : 0) * areaH + -localY0 * sinT : 0;
      const k = depthScale(depthPx, cam);

      // 相机位置要从偏移里先减掉（相机往右 → 画面整体往左），再乘透视缩放
      const cxOff = lineState.worldX * areaW + localX0 * cos - localYt * sin - cam.sx;
      const cyOff = -lineState.worldY * areaH + localX0 * sin + localYt * cos - cam.sy;
      return {
        x: cx + cxOff * k,
        y: cy + cyOff * k,
        angle,
        localX: localX0,
        localY: localYt,
        /**
         * **倾斜前**的局部 y（屏幕向下为正，`localY = localY0 × cosθ`）。
         * 长条（Hold）要按「沿下落方向逐行投影」画成梯形时用它作为参数：某一行在倾斜前的
         * 距离 `y0` 决定它的深度 `z + (−y0)·sinθ`，于是远端更窄、并按线方向横向偏移。
         */
        localY0,
        /** 透视缩放：绘制音符 / 判定线尺寸时乘它（`width` 等仍是 z = 0 空间的尺寸） */
        depthScale: k,
        /** 贴图沿下落方向的压缩（下落面倾斜的透视缩短） */
        squashY: cosT,
        /** 倾斜角的正弦（逐行投影算深度用；`ignore3D` 时为 0） */
        sinT,
        width: noteWidthRatio * areaW * (note.size || 1),
        heightFor: (texAspect) => noteWidthRatio * areaW * (note.size || 1) * texAspect,
      };
    },

    /** 判定线两端的屏幕坐标（供 UI 叠加/拾取使用）：同样乘上（伪）3D 的深度缩放 */
    lineSegment(lineState, lineLengthH = 5.76, opts = {}) {
      const center = projection.lineCenter(lineState, opts);
      const half = ((lineLengthH * areaH) / 2) * center.k;
      const cos = Math.cos(-lineState.worldRotate);
      const sin = Math.sin(-lineState.worldRotate);
      return [
        { x: center.x - half * cos, y: center.y - half * sin },
        { x: center.x + half * cos, y: center.y + half * sin },
      ];
    },

    /**
     * 判定线**原点**的屏幕位置与透视缩放 `{ x, y, k }`（绘制判定线用：
     * 位置 / 长度 / 厚度都乘 k，相机的横向平移在这里一并生效）。
     */
    lineCenter(lineState, opts = {}) {
      const { k, cam } = lineDepth(lineState, opts);
      return {
        x: cx + ((Number.isFinite(lineState?.worldX) ? lineState.worldX : 0) * areaW - cam.sx) * k,
        y: cy + (-(Number.isFinite(lineState?.worldY) ? lineState.worldY : 0) * areaH - cam.sy) * k,
        k,
      };
    },

    /** 判定线的（伪）3D 深度缩放（绘制线时位置 / 长度 / 厚度都乘它） */
    lineDepthScale: (lineState, opts = {}) => lineDepth(lineState, opts).k,

    /**
     * 相机位置的屏幕像素偏移 `{ x, y }`（y 向下为正）—— 投影时先从偏移里减掉它：
     * `屏幕 = 中心 + (偏移 − 相机位置) × k`。绘制判定线 / Hold 这类「自己算平移」的地方用它。
     */
    cameraOffsetPx: (opts = {}) => {
      const cam = cameraOf(opts);
      return { x: cam.sx, y: cam.sy };
    },

    /** 按 z（画面高比例）取深度缩放：判定特效之类「只记得 z」的地方用它 */
    depthScaleAt: (z, opts = {}) => depthScale((Number.isFinite(z) ? z : 0) * areaH, cameraOf(opts)),

    /**
     * 由「判定线上的落点（画面比例）+ 局部像素偏移 + 深度」求屏幕坐标。
     * 与 `noteTransform` 用完全同一个公式（中心 + (偏移 − 相机位置) × k）——
     * 打击特效在命中时记下 z 与相机快照，之后用它稳稳地贴在音符落点上。
     */
    projectLocal(worldX, worldY, localPxX, localPxY, zFrac, opts = {}) {
      const cam = cameraOf(opts);
      const k = depthScale((Number.isFinite(zFrac) ? zFrac : 0) * areaH, cam);
      return {
        x: cx + ((Number.isFinite(worldX) ? worldX : 0) * areaW + localPxX - cam.sx) * k,
        y: cy + (-(Number.isFinite(worldY) ? worldY : 0) * areaH + localPxY - cam.sy) * k,
        k,
      };
    },

    /**
     * 屏幕点 → **判定线局部坐标**（与 `noteTransform` 的 `localX / localY` 同一坐标系，
     * 且已除以深度缩放，即「z = 0 空间」）：x 沿判定线方向（右为正），y 沿判定线法线方向。
     * 判定带就是「|localX − 音符的 localX| ≤ 半宽」这条判据。
     */
    toLineLocal(lineState, px, py, opts = {}) {
      const rot = -lineState.worldRotate; // 画布为顺时针正，与 noteTransform 一致
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const center = projection.lineCenter(lineState, opts);
      const k = center.k > 0 ? center.k : 1;
      const dx = (px - center.x) / k;
      const dy = (py - center.y) / k;
      return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
    },

    /**
     * 音符的**判定带**：以音符在判定线上的落点为中心、沿判定线方向半宽
     * `音符宽度 × halfRatio`（默认 0.8：两边各 80% 音符宽，总宽 = 音符宽的 160%），
     * 沿下落方向不限长度 —— 只有落在带内的
     * 点击 / 经过带内的滑动才算命中这个 note（见 docs/Phigros文档.md 的判定带）。
     *
     * ⚠️ 判定带看的是**判定线局部坐标里音符的 x**（`positionX × 0.05625 × areaW`），
     * **与 `above` 无关**：背面音符（`above=false`）只是从判定线另一侧落下来、贴图旋转 180°，
     * 它所在的「列」与同 `positionX` 的正面音符是同一列。
     * （`noteTransform()` 为了绘制会把 `localX` 取反、把角度 +π，不能直接拿来当判定带的中心，
     * 否则背面音符的判定带会跑到镜像位置 —— 表现就是「点它没反应 / 点别处却判上了」。）
     *
     * **（伪）3D 与判定模式**（见 docs/Phigros文档.md 的判定范围）：
     *  - `opts.ignore3D = true` → 忽略相机与 z / theta（「垂直判定」：判定带始终是 2D 的那条列）；
     *  - 默认 → 跟着投影走（「轨道判定」：音符被相机 / z / 倾斜画到哪里，判定带就在哪里）。
     *  两种模式都只比较**沿判定线方向的局部坐标**（`localX`，单位像素）：屏幕点由
     *  `toLineChart()` 解析地换算回谱面局部坐标（倾斜面也精确），所以「带子画在哪」与
     *  「点哪算命中」永远是同一套几何（`judgeBandShape()` 画的就是它）。
     *
     * @param {object} note 编译后的音符
     * @param {object} lineState state.lines[i]
     * @param {{noteWidthRatio?:number, distY?:number, halfRatio?:number, pad?:number, ignore3D?:boolean, focalH?:number, camera?:object}} [opts]
     */
    judgeBand(note, lineState, opts = {}) {
      const t = projection.noteTransform(note, lineState, opts);
      const halfRatio = Number.isFinite(opts.halfRatio) ? opts.halfRatio : 0.8;
      const pad = Number.isFinite(opts.pad) ? opts.pad : 0;
      const k = t.depthScale > 0 ? t.depthScale : 1;
      // 半宽在「z = 0 空间」里算（t.width 也是 z = 0 空间的尺寸），命中测试同样回到这个空间比较
      const halfWidth = Math.max(1, t.width * halfRatio + pad);
      // 判定线局部坐标里的列位置（above=false 时 noteTransform 的 localX 被取反了，这里取回来）
      const lineX = note.above === false ? -t.localX : t.localX;
      const rot = -lineState.worldRotate;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const cam = cameraOf(opts);
      const center = {
        x: cx + ((Number.isFinite(lineState.worldX) ? lineState.worldX : 0) * areaW + lineX * cos - cam.sx) * k,
        y: cy + (-(Number.isFinite(lineState.worldY) ? lineState.worldY : 0) * areaH + lineX * sin - cam.sy) * k,
      };
      return { ...t, center, halfWidth, lineX, angle: t.angle, localX: t.localX };
    },

    /**
     * 屏幕点 → **判定线局部（谱面）坐标**：`{ localX, localY0, k, distY }`。
     * 正向投影是 `noteTransform()`；这里是它的**解析逆**（倾斜面 / z / 相机都精确）：
     *
     *   正向：屏幕偏移 = R(α)·(A + localX, B + localYt)·k，k = F / (D₀ − localY0·sinθ)
     *   逆向：先把屏幕偏移按 −α 转回判定线方向得到 (u, v)，再解出
     *         `localY0 = (v·D₀ − F·B) / (v·sinθ + F·cosθ)`、`localX = u/k − A`
     *
     * 于是「轨道判定」能把手指位置准确换算回倾斜面上，再和音符的列比较 ——
     * `judgeBandShape()` 画出来的楔形就是「换算回去落在列内」的点，两者严格一致。
     * `opts.ignore3D = true`（垂直判定）时忽略深度：`localX` 就是 2D 那条列。
     *
     * @returns {{localX:number, localY0:number, k:number, distY:number}}
     *          `localX` 是**判定线局部**的横向像素（与 `judgeBand().localX` 同一坐标系）；
     *          `distY` 是纯几何的沿下落方向距离（Y 单位，不含音符自身的 yOffset / speed）。
     */
    toLineChart(note, lineState, px, py, opts = {}) {
      const cam = cameraOf(opts);
      const F = cam.F;
      const use3D = opts.ignore3D !== true;
      const zH = use3D && Number.isFinite(lineState?.z) ? lineState.z * areaH : 0;
      const D0 = zH + F - cam.zPx; // localY0 = 0 处「点离相机」的距离
      const theta = use3D && Number.isFinite(lineState?.theta) ? lineState.theta : 0;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const angle = (Number.isFinite(lineState?.worldRotate) ? lineState.worldRotate : 0) + (note?.above === false ? Math.PI : 0);
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const dx = px - cx;
      const dy = py - cy;
      const u = dx * cos + dy * sin; // 判定线长轴方向（局部 x）
      const v = -dx * sin + dy * cos; // 下落方向（局部 y，屏幕向下为正）
      const A = (Number.isFinite(lineState?.worldX) ? lineState.worldX : 0) * areaW - cam.sx;
      const B = -(Number.isFinite(lineState?.worldY) ? lineState.worldY : 0) * areaH - cam.sy;
      // 线的世界锚点也要转到判定线局部方向（否则判定线旋转时逆变换不精确）
      const a0 = A * cos + B * sin;
      const b0 = -A * sin + B * cos;
      let localY0 = 0;
      if (use3D && Math.abs(cosT) > 1e-6) {
        // v·(D₀ − localY0·sinθ) = F·(b0 + localY0·cosθ)  →  解出 localY0
        const denom = v * sinT + F * cosT;
        localY0 = Math.abs(denom) > 1e-9 ? (v * D0 - F * b0) / denom : 0;
        if (!Number.isFinite(localY0)) localY0 = 0;
      }
      const k = F / Math.max(D0 - localY0 * sinT, F * PSEUDO3D.MIN_DEPTH_RATIO);
      const localX = u / k - a0;
      return {
        localX: Number.isFinite(localX) ? localX : 0,
        localY0,
        k,
        distY: -localY0 / (0.6 * areaH),
      };
    },

    /**
     * **判定线局部坐标 → 屏幕**：`localX` 是线内横向像素（相对判定线中心）、`localY0` 是
     * **倾斜前**的纵向像素（屏幕向下为正）。返回 `{ x, y, k }`；与 `noteTransform()` 同一套公式，
     * 只是允许任取局部点 —— Hold 的四角仿射、判定范围轮廓都用它。
     */
    lineLocalToScreen(localX, localY0, lineState, opts = {}) {
      const cam = cameraOf(opts);
      const F = cam.F;
      const use3D = opts.ignore3D !== true;
      const zH = use3D && Number.isFinite(lineState?.z) ? lineState.z * areaH : 0;
      const theta = use3D && Number.isFinite(lineState?.theta) ? lineState.theta : 0;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const angle = (Number.isFinite(lineState?.worldRotate) ? lineState.worldRotate : 0) + (opts.above === false ? Math.PI : 0);
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const A = (Number.isFinite(lineState?.worldX) ? lineState.worldX : 0) * areaW - cam.sx;
      const B = -(Number.isFinite(lineState?.worldY) ? lineState.worldY : 0) * areaH - cam.sy;
      const localYt = localY0 * cosT;
      const k = F / Math.max(zH + F - cam.zPx - localY0 * sinT, F * PSEUDO3D.MIN_DEPTH_RATIO);
      return {
        x: cx + (A + localX * cos - localYt * sin) * k,
        y: cy + (B + localX * sin + localYt * cos) * k,
        k,
      };
    },
    /**
     * 判定范围的**屏幕轮廓**（调试叠加层用；与 `hitJudgeBand()` 是同一个判定区域）：
     *  - 垂直判定（`ignore3D`）：音符那一列的 2D 长条（恒定宽度）；
     *  - 轨道判定：沿倾斜下落面采样出来的**楔形** —— 越远越窄、并随判定线方向偏移，
     *    所以叠加层一眼就能看出「判定范围跟着下落面倾斜」。
     * @returns {{points:{x:number,y:number}[], near:number, far:number, band:object}}
     *          `points` 是屏幕坐标的多边形（左边界由近到远、再右边界由远到近）；`near` / `far` 是两端宽度
     */
    judgeBandShape(note, lineState, opts = {}) {
      const band = projection.judgeBand(note, lineState, opts);
      const dyScale = 0.6 * areaH;
      const use3D = opts.ignore3D !== true;
      const theta = use3D && Number.isFinite(lineState?.theta) ? lineState.theta : 0;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const zH = use3D && Number.isFinite(lineState?.z) ? lineState.z * areaH : 0;
      const cam = cameraOf(opts);
      const F = cam.F;
      const D0 = zH + F - cam.zPx;
      const angle = (Number.isFinite(lineState?.worldRotate) ? lineState.worldRotate : 0) + (note?.above === false ? Math.PI : 0);
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const A = (Number.isFinite(lineState?.worldX) ? lineState.worldX : 0) * areaW - cam.sx;
      const B = -(Number.isFinite(lineState?.worldY) ? lineState.worldY : 0) * areaH - cam.sy;
      const column = band.localX; // 判定线局部坐标里的列（背面音符为负）
      const half = band.halfWidth;
      /** 局部点（localX，沿下落方向 dY 个 Y 单位）→ 屏幕 */
      const project = (localX, dY) => projection.lineLocalToScreen(localX, -dY * dyScale, lineState, { ...opts, above: note?.above });
      // 采样范围：判定线下方 1.5 Y 到最远可见 3.3333 Y（覆盖整个下落范围）
      const dFrom = -1.5;
      const dTo = NOTE.MAX_VISIBLE_Y;
      const steps = Math.abs(sinT) > 1e-6 ? 12 : 1;
      const left = [];
      const right = [];
      for (let i = 0; i <= steps; i++) {
        const d = dFrom + ((dTo - dFrom) * i) / steps;
        left.push(project(column - half, d));
        right.push(project(column + half, d));
      }
      const points = [...left, ...right.slice().reverse()];
      const widthAt = (i) => Math.hypot(left[i].x - right[i].x, left[i].y - right[i].y);
      return { points, near: widthAt(0), far: widthAt(steps), band };
    },

    /**
     * 判定带在屏幕上的半宽（像素，已含（伪）3D 缩放）—— 给叠加层画带子用。
     */
    judgeBandHalfWidthPx(band) {
      return band.halfWidth * (band.depthScale > 0 ? band.depthScale : 1);
    },

    /** 点是否落在音符的判定带里（沿下落方向不限位置） */
    hitJudgeBand(note, lineState, px, py, opts = {}) {
      const band = projection.judgeBand(note, lineState, opts);
      const local = projection.toLineChart(note, lineState, px, py, opts);
      return Math.abs(local.localX - band.localX) <= band.halfWidth;
    },

    /**
     * 线段（滑动）是否**经过**音符的判定带：两个端点都换算成判定线局部坐标，
     * 看它们在判定线方向的区间是否与 [列 ± 半宽] 相交。
     */
    hitJudgeBandSegment(note, lineState, x0, y0, x1, y1, opts = {}) {
      const band = projection.judgeBand(note, lineState, opts);
      const a = projection.toLineChart(note, lineState, x0, y0, opts).localX - band.localX;
      const b = projection.toLineChart(note, lineState, x1, y1, opts).localX - band.localX;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return hi >= -band.halfWidth && lo <= band.halfWidth;
    },
  };
  return projection;
}

const dist2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** 点选音符：返回半径内最近的可见音符（制谱器用；渲染器不依赖它） */
export function pickNote(projection, state, px, py, radius = 24, opts = {}) {
  let best = null;
  for (const note of state.chart.notes) {
    if (!note.visible) continue;
    const t = projection.noteTransform(note, state.lines[note.lineId], opts);
    const d = dist2(t.x, t.y, px, py);
    if (d <= radius && (!best || d < best.distance)) best = { note, ...t, distance: d };
  }
  return best;
}

/** 点选判定线：返回最近的线（按像素距离）；lines 的（伪）3D 位置由 lineSegment 一起算 */
export function pickLine(projection, state, px, py, tolerance = 10, opts = {}) {
  let best = null;
  for (let i = 0; i < state.lines.length; i++) {
    const lineState = state.lines[i];
    if (lineState.alpha <= 0) continue;
    const [a, b] = projection.lineSegment(lineState, 5.76, opts);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = dist2(px, py, a.x + t * dx, a.y + t * dy);
    if (d <= tolerance && (!best || d < best.distance)) best = { index: i, line: state.chart.lines[i], distance: d };
  }
  return best;
}
