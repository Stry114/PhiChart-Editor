/**
 * 投影（投影数学）：画面区域、世界坐标 ↔ 屏幕像素、音符的屏幕变换，以及拾取（点选）。
 * 渲染器只用它来算坐标，未来的制谱器可以直接用它做「鼠标点选音符 / 判定线」与 UI 叠加层，
 * 不必重复实现这套换算（见 docs/项目文档.md 的编辑器数据流）。
 *
 * 约定：
 *  - 世界坐标：x = 画面宽比例、y = 画面高比例，原点在画面中心，y 向上为正（canonical，见 core/units.js）
 *  - 渲染区域：按 16:9 contain 适配（areaW = min(宽, 高 × 16/9)），像素原点在左上
 *  - 音符局部坐标（判定线坐标系内）：dx = positionX × 0.05625 × areaW、dy = Y(t) × 0.6 × areaH
 */

export function createProjection(width, height, options = {}) {
  const aspect = options.aspect ?? 16 / 9;
  const areaH = height;
  const areaW = Math.min(width, height * aspect);
  const cx = (width - areaW) / 2 + areaW / 2;
  const cy = areaH / 2;

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
     * @param {object} note 编译后的音符（含 positionX / distY / yOffset / speed / size / above）
     * @param {object} lineState state.lines[i]（含 worldX / worldY / worldRotate）
     * @param {{noteWidthRatio?:number, distY?:number}} [opts] distY 可覆盖（Hold 头/尾分别求值）
     */
    noteTransform(note, lineState, opts = {}) {
      const noteWidthRatio = opts.noteWidthRatio ?? 0.125;
      const distY = opts.distY ?? note.distY ?? 0;
      const dyScale = 0.6 * areaH;
      const localX = note.positionX * 0.05625 * areaW * (note.above ? 1 : -1);
      const offsetPx = (note.yOffset || 0) * note.speed * dyScale * (note.above ? -1 : 1);
      const localY = -distY * dyScale - offsetPx;
      const angle = lineState.worldRotate + (note.above ? 0 : Math.PI);
      const theta = -angle; // 画布为顺时针正
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      return {
        x: projection.toScreenX(lineState.worldX) + localX * cos - localY * sin,
        y: projection.toScreenY(lineState.worldY) + localX * sin + localY * cos,
        angle,
        localX,
        localY,
        width: noteWidthRatio * areaW * (note.size || 1),
        heightFor: (texAspect) => noteWidthRatio * areaW * (note.size || 1) * texAspect,
      };
    },

    /** 判定线两端的屏幕坐标（供 UI 叠加/拾取使用） */
    lineSegment(lineState, lineLengthH = 5.76) {
      const half = (lineLengthH * areaH) / 2;
      const cos = Math.cos(-lineState.worldRotate);
      const sin = Math.sin(-lineState.worldRotate);
      const x0 = projection.toScreenX(lineState.worldX);
      const y0 = projection.toScreenY(lineState.worldY);
      return [
        { x: x0 - half * cos, y: y0 - half * sin },
        { x: x0 + half * cos, y: y0 + half * sin },
      ];
    },

    /**
     * 屏幕点 → **判定线局部坐标**（与 `noteTransform` 的 `localX / localY` 同一坐标系）：
     * x 沿判定线方向（右为正），y 沿判定线法线方向（上/下按画布朝向）。
     * 判定带就是「|localX − 音符的 localX| ≤ 半宽」这条判据。
     */
    toLineLocal(lineState, px, py) {
      const theta = -lineState.worldRotate; // 画布为顺时针正，与 noteTransform 一致
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const dx = px - projection.toScreenX(lineState.worldX);
      const dy = py - projection.toScreenY(lineState.worldY);
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
     * @param {object} note 编译后的音符
     * @param {object} lineState state.lines[i]
     * @param {{noteWidthRatio?:number, distY?:number, halfRatio?:number, pad?:number}} [opts]
     */
    judgeBand(note, lineState, opts = {}) {
      const t = projection.noteTransform(note, lineState, opts);
      const halfRatio = Number.isFinite(opts.halfRatio) ? opts.halfRatio : 0.8;
      const pad = Number.isFinite(opts.pad) ? opts.pad : 0;
      const halfWidth = Math.max(1, t.width * halfRatio + pad);
      // 判定线局部坐标里的列位置（above=false 时 noteTransform 的 localX 被取反了，这里取回来）
      const lineX = note.above === false ? -t.localX : t.localX;
      const theta = -lineState.worldRotate;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const center = {
        x: projection.toScreenX(lineState.worldX) + lineX * cos,
        y: projection.toScreenY(lineState.worldY) + lineX * sin,
      };
      return { ...t, center, halfWidth, lineX, angle: t.angle, localX: t.localX };
    },

    /** 点是否落在音符的判定带里（沿下落方向不限位置） */
    hitJudgeBand(note, lineState, px, py, opts = {}) {
      const band = projection.judgeBand(note, lineState, opts);
      const local = projection.toLineLocal(lineState, px, py);
      return Math.abs(local.x - band.lineX) <= band.halfWidth;
    },

    /**
     * 线段（滑动）是否**经过**音符的判定带：把两个端点都换到局部坐标，
     * 看它们在判定线方向的区间是否与 [lineX ± 半宽] 相交。
     */
    hitJudgeBandSegment(note, lineState, x0, y0, x1, y1, opts = {}) {
      const band = projection.judgeBand(note, lineState, opts);
      const a = projection.toLineLocal(lineState, x0, y0);
      const b = projection.toLineLocal(lineState, x1, y1);
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      return hi >= band.lineX - band.halfWidth && lo <= band.lineX + band.halfWidth;
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

/** 点选判定线：返回最近的线（按像素距离） */
export function pickLine(projection, state, px, py, tolerance = 10) {
  let best = null;
  for (let i = 0; i < state.lines.length; i++) {
    const lineState = state.lines[i];
    if (lineState.alpha <= 0) continue;
    const [a, b] = projection.lineSegment(lineState);
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
