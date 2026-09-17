/**
 * 投影（投影数学）：画面区域、世界坐标 ↔ 屏幕像素、音符的屏幕变换，以及拾取（点选）。
 * 渲染器只用它来算坐标，未来的制谱器可以直接用它做「鼠标点选音符 / 判定线」与 UI 叠加层，
 * 不必重复实现这套换算（见 docs/05 §8）。
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
    /** 渲染区域实际宽高比（固定 16:9；父子线偏移旋转需要它，见 docs/05 §4.5） */
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
