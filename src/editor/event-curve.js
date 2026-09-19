/**
 * 事件值曲线图（Event 详情右侧）—— SVG 实现。
 *
 * 为什么改用 SVG 而不是 Canvas：
 *   Canvas 需要自己量尺寸、处理 DPR、在容器尺寸变化时重算；一旦量到的尺寸与 CSS 实际
 *   显示尺寸不一致，画面会被拉伸、手柄也就点不中（之前的问题就出在这）。
 *   SVG 有 viewBox：所有绘制都在固定的逻辑坐标系（360×240）里完成，缩放交给浏览器，
 *   指针坐标只用同一比例换回去 —— 不需要量尺寸、不需要 DPR、不需要 ResizeObserver。
 *
 * 交互：
 *   - 两个手柄：拖动改「起始值 / 结束值」（纵向刻度固定为「该类事件的最小值~最大值」）
 *   - 贝塞尔时额外两个手柄 P1 / P2：它们是曲线的**真实控制点**
 *     （bezierPoints 的 y 按 RPE 定义是「进度 0..1」，画到图上时换算成 取值 = v0 + (v1-v0)*y）
 */
import { el } from './detail-common.js';

const VW = 360; // 逻辑坐标宽
const VH = 240; // 逻辑坐标高
const PAD = { l: 46, r: 16, t: 16, b: 28 };
const SENTINEL_BEAT = 1e6;
const HIT = 18; // 命中半径（逻辑坐标）
const INSET = { w: 132, h: 104, margin: 8 }; // 右上角「单位方格」贝塞尔编辑器尺寸

let lastCurve = null;
export function getActiveCurve() {
  return lastCurve;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

export function createEventCurve() {
  const wrap = el('div', 'ed-curve');
  const title = el('div', 'ed-curve-title', '事件值曲线');
  const svg = svgEl('svg', {
    class: 'ed-curve-svg',
    viewBox: `0 0 ${VW} ${VH}`,
    // meet：等比缩放并居中，绝不拉伸变形（之前 none 会把图和手柄都拉扁）
    preserveAspectRatio: 'xMidYMid meet',
    xmlns: SVG_NS,
  });
  const legend = el('div', 'ed-curve-legend');
  wrap.append(title, svg, legend);

  const grid = svgEl('g', { class: 'ed-curve-grid' });
  const labels = svgEl('g', { class: 'ed-curve-labels' });
  const guides = svgEl('g', { class: 'ed-curve-guides' });
  const curvePath = svgEl('path', { class: 'ed-curve-path', d: '' });
  const handleLayer = svgEl('g', { class: 'ed-curve-handles' });
  svg.append(grid, labels, guides, curvePath, handleLayer);

  const yLabels = [];
  const xLabels = [];
  for (let i = 0; i <= 4; i++) {
    const gy = PAD.t + ((VH - PAD.t - PAD.b) * i) / 4;
    grid.appendChild(svgEl('line', { x1: PAD.l, y1: gy, x2: VW - PAD.r, y2: gy, class: i === 0 || i === 4 ? 'axis' : 'grid' }));
    const gx = PAD.l + ((VW - PAD.l - PAD.r) * i) / 4;
    grid.appendChild(svgEl('line', { x1: gx, y1: PAD.t, x2: gx, y2: VH - PAD.b, class: i === 0 || i === 4 ? 'axis' : 'grid' }));
    const yt = svgEl('text', { x: PAD.l - 6, y: gy + 4, class: 'ylab', 'text-anchor': 'end' });
    labels.appendChild(yt);
    yLabels.push(yt);
    const xt = svgEl('text', { x: gx, y: VH - PAD.b + 16, class: 'xlab', 'text-anchor': 'middle' });
    labels.appendChild(xt);
    xLabels.push(xt);
  }

  let data = null;
  let range = { min: 0, max: 1 };
  let span = { t0: 0, t1: 1 };
  let dragId = null;
  let hoverId = null;
  let disposed = false;

  const fmt = (v) =>
    Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v - Math.round(v)) < 1e-4 ? String(Math.round(v)) : v.toFixed(3);
  const plotW = () => VW - PAD.l - PAD.r;
  const plotH = () => VH - PAD.t - PAD.b;
  const beatToX = (b) => PAD.l + ((b - span.t0) / Math.max(1e-9, span.t1 - span.t0)) * plotW();
  const valueToY = (v) => PAD.t + plotH() - ((v - range.min) / Math.max(1e-9, range.max - range.min)) * plotH();
  const xToBeat = (x) => span.t0 + ((x - PAD.l) / plotW()) * (span.t1 - span.t0);
  const yToValue = (y) => range.min + ((PAD.t + plotH() - y) / plotH()) * (range.max - range.min);

  /** 单位方格（进度 0..1 × 0..1）在逻辑坐标系里的位置：右上角 */
  function insetRect() {
    return {
      x: PAD.l + plotW() - INSET.w - INSET.margin,
      y: PAD.t + INSET.margin,
      w: INSET.w,
      h: INSET.h,
    };
  }
  const bezToXY = (x1, y1) => {
    const r = insetRect();
    return { x: r.x + Math.max(0, Math.min(1, x1)) * r.w, y: r.y + (1 - Math.max(0, Math.min(1, y1))) * r.h };
  };
  const xyToBez = (p) => {
    const r = insetRect();
    return {
      x: Math.max(0, Math.min(1, (p.x - r.x) / r.w)),
      y: Math.max(0, Math.min(1, 1 - (p.y - r.y) / r.h)),
    };
  };

  /**
   * 贝塞尔控制点**放到主图里**编辑（与两端手柄同图，共 4 个圆点）。
   *
   * 为什么这样是严谨的：RPE 的 bezierPoints 是「进度 0..1 × 进度 0..1」空间的控制点，
   * 而主图的取值轴是「取值 = v0 + (v1-v0)·进度」的线性映射，时间轴同理 —— 两者都是仿射映射，
   * 把控制点按同一映射画到主图上，画出来的就是同一条曲线（贝塞尔在仿射变换下仍是贝塞尔）。
   *
   * 唯一退化情形：起止值相同（v1 == v0）时取值轴塌缩成一点，y 无法反解 —— 这时退回右上角的单位方格子图。
   */
  function bezierMode() {
    const ev = data?.ev;
    if (!Array.isArray(ev?.bezierPoints) || ev.bezierPoints.length !== 4) return 'none';
    const sameValue = Math.abs((ev.end ?? 0) - (ev.start ?? 0)) < 1e-9;
    const noSpan = !(span.t1 - span.t0 > 1e-9);
    return !sameValue && !noSpan ? 'main' : 'inset';
  }

  /** 进度 0..1 → 主图坐标（时间用当前显示窗口，取值用线性映射） */
  const mainXY = (x1, y1) => {
    const ev = data?.ev ?? {};
    const t = span.t0 + Math.max(0, Math.min(1, x1)) * (span.t1 - span.t0);
    const v = (ev.start ?? 0) + ((ev.end ?? 0) - (ev.start ?? 0)) * Math.max(0, Math.min(1, y1));
    return { x: beatToX(t), y: valueToY(v) };
  };
  /** 主图坐标 → 进度 0..1（夹到 0..1：与 RPE 的取值域一致） */
  const mainToBez = (p) => {
    const ev = data?.ev ?? {};
    const dv = (ev.end ?? 0) - (ev.start ?? 0);
    return {
      x: Math.max(0, Math.min(1, (xToBeat(p.x) - span.t0) / Math.max(1e-9, span.t1 - span.t0))),
      y: Math.max(0, Math.min(1, dv === 0 ? 0 : (yToValue(p.y) - (ev.start ?? 0)) / dv)),
    };
  };

  /** 屏幕坐标 → 逻辑坐标（只在指针事件里读一次布局） */
  function toView(e) {
    const rect = svg.getBoundingClientRect?.() ?? { left: 0, top: 0, width: VW, height: VH };
    const w = rect.width || VW;
    const h = rect.height || VH;
    return { x: ((e.clientX ?? 0) - rect.left) * (VW / w), y: ((e.clientY ?? 0) - rect.top) * (VH / h) };
  }

  function handleList() {
    const ev = data?.ev;
    if (!ev) return [];
    // 手柄的绘制位置夹在图内：取值超出固定刻度时贴边显示（仍可拖动，拖回范围内）
    const clampY = (y) => Math.min(PAD.t + plotH(), Math.max(PAD.t, y));
    // 起点在显示窗口之外时（哨兵起点 / 跨度巨大）也贴左边缘显示，否则手柄会跑到图外点不到
    const clampX = (x) => Math.min(PAD.l + plotW(), Math.max(PAD.l, x));
    const out = [
      { id: 'start', label: '起始值', x: clampX(beatToX(ev.startBeat)), y: clampY(valueToY(ev.start)), cls: 'start' },
      { id: 'end', label: '结束值', x: clampX(beatToX(span.t1)), y: clampY(valueToY(ev.end)), cls: 'end' },
    ];
    if (Array.isArray(ev.bezierPoints) && ev.bezierPoints.length === 4) {
      const [x1, y1, x2, y2] = ev.bezierPoints;
      const mode = bezierMode();
      // 主图模式：按仿射映射画在曲线上（超出可见范围时贴边，仍可拖回）
      const at = mode === 'main' ? mainXY : (bx, by) => bezToXY(bx, by);
      const p1 = at(x1, y1);
      const p2 = at(x2, y2);
      out.push({ id: 'p1', label: 'P1', x: clampX(p1.x), y: clampY(p1.y), cls: 'bezier', mode });
      out.push({ id: 'p2', label: 'P2', x: clampX(p2.x), y: clampY(p2.y), cls: 'bezier', mode });
    }
    return out;
  }

  function pick(p) {
    let best = null;
    let bestD = Infinity;
    for (const h of handleList()) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d <= HIT && d < bestD) {
        best = h.id;
        bestD = d;
      }
    }
    if (best) return best;
    for (const h of handleList()) {
      if (Math.abs(h.x - p.x) <= HIT && Math.abs(h.y - p.y) <= HIT * 2) return h.id;
    }
    return null;
  }

  /**
   * 计算时间范围与取值范围。
   * 取值范围**固定为该类事件的最小值~最大值**（data.range，来自整条轨道），
   * 于是拖动或切换事件时刻度都不变，便于横向比较。
   */
  function computeRanges() {
    const ev = data?.ev;
    if (!ev) return;
    const fixed = data?.range;
    if (fixed && Number.isFinite(fixed.min) && Number.isFinite(fixed.max) && fixed.max > fixed.min) {
      const pad = (fixed.max - fixed.min) * 0.05;
      range = { min: fixed.min - pad, max: fixed.max + pad };
    } else {
      let min = Math.min(ev.start ?? 0, ev.end ?? 0);
      let max = Math.max(ev.start ?? 0, ev.end ?? 0);
      if (!(max - min > 1e-9)) {
        const pad2 = Math.max(1, Math.abs(min) * 0.5);
        min -= pad2;
        max += pad2;
      }
      range = { min, max };
    }
    const rawT0 = ev.startBeat;
    const rawT1 = Math.max(rawT0 + 1e-3, ev.endBeat >= SENTINEL_BEAT ? rawT0 + 4 : ev.endBeat);
    // 跨度太大时只显示末端窗口（横轴用相对拍数），否则坐标轴会出现 -31249 这种没意义的数字
    const MAX_WINDOW = 16;
    if (rawT1 - rawT0 > MAX_WINDOW) {
      span = { t0: rawT1 - MAX_WINDOW, t1: rawT1, clamped: true, fullSpan: rawT1 - rawT0, rawT0 };
    } else {
      span = { t0: rawT0, t1: rawT1, clamped: false, fullSpan: rawT1 - rawT0, rawT0 };
    }
  }

  // 贝塞尔控制点用「单位方格」编辑（见 insetRect / bezToXY / xyToBez），
  // 不再按取值映射 —— 那样事件跨度大于该类事件范围时手柄会跑到图外。
  void xToBeat;

  /** 只更新 SVG 属性：不重建容器、不需要像素尺寸 */
  function render() {
    if (!data?.ev || disposed) return;
    computeRanges();
    // 线条颜色 = 该类事件的主题色（由调用方传入）
    if (data.color && svg.style?.setProperty) svg.style.setProperty('--curve-color', data.color);
    const ev = data.ev;

    for (let i = 0; i <= 4; i++) {
      yLabels[i].textContent = fmt(range.max - ((range.max - range.min) * i) / 4);
      const b = span.t1 - ((span.t1 - span.t0) * (4 - i)) / 4;
      xLabels[i].textContent = span.clamped
        ? `${Math.round((b - span.t1) * 100) / 100}`
        : String(Math.round(b * 100) / 100);
    }

    const steps = 80;
    const full = Math.max(1e-9, span.fullSpan);
    const uStart = (span.t0 - span.rawT0) / full;
    const uEnd = (span.t1 - span.rawT0) / full;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const u = uStart + ((uEnd - uStart) * i) / steps;
      let k = u;
      if (ev.easingFn) {
        try {
          k = ev.easingFn(u);
        } catch {
          k = u;
        }
      }
      if (!Number.isFinite(k)) k = u;
      const v = (ev.start ?? 0) + ((ev.end ?? 0) - (ev.start ?? 0)) * k;
      d += `${i === 0 ? 'M' : 'L'}${(PAD.l + (i / steps) * plotW()).toFixed(2)} ${valueToY(v).toFixed(2)}`;
    }
    curvePath.setAttribute('d', d);

    const hs = handleList();
    const byId = Object.fromEntries(hs.map((h) => [h.id, h]));
    while (guides.firstChild) guides.removeChild(guides.firstChild);
    if (byId.p1 && byId.p2 && Array.isArray(ev.bezierPoints) && bezierMode() === 'main') {
      // 主图模式：把终点手柄→P1、起点手柄→P2 连起来，直观看出控制点对曲线的影响
      const sx = byId.start;
      const ex = byId.end;
      // P1 决定起点处的切线、P2 决定终点处的切线：连线要一一对应
      guides.appendChild(svgEl('line', { x1: sx.x, y1: sx.y, x2: byId.p1.x, y2: byId.p1.y, class: 'ed-curve-guide' }));
      guides.appendChild(svgEl('line', { x1: ex.x, y1: ex.y, x2: byId.p2.x, y2: byId.p2.y, class: 'ed-curve-guide' }));
    }
    if (byId.p1 && byId.p2 && Array.isArray(ev.bezierPoints) && bezierMode() === 'inset') {
      // 退化情形（起止值相同）：仍用单位方格编辑
      const r = insetRect();
      guides.appendChild(svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 'ed-curve-inset' }));
      guides.appendChild(
        svgEl('line', { x1: r.x, y1: r.y + r.h, x2: r.x + r.w, y2: r.y, class: 'ed-curve-inset-diag' }),
      );
      const [x1, y1, x2, y2] = ev.bezierPoints;
      const p0 = { x: r.x, y: r.y + r.h };
      const p3 = { x: r.x + r.w, y: r.y };
      const c1 = bezToXY(x1, y1);
      const c2 = bezToXY(x2, y2);
      let dIn = '';
      for (let i = 0; i <= 32; i++) {
        const t = i / 32;
        const mt = 1 - t;
        const bx = mt ** 3 * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * p3.x;
        const by = mt ** 3 * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * p3.y;
        dIn += `${i === 0 ? 'M' : 'L'}${bx.toFixed(2)} ${by.toFixed(2)}`;
      }
      guides.appendChild(svgEl('path', { d: dIn, class: 'ed-curve-inset-curve' }));
      // 控制点连线（P0-P1、P3-P2）
      guides.appendChild(svgEl('line', { x1: p0.x, y1: p0.y, x2: c1.x, y2: c1.y, class: 'ed-curve-guide' }));
      guides.appendChild(svgEl('line', { x1: p3.x, y1: p3.y, x2: c2.x, y2: c2.y, class: 'ed-curve-guide' }));
      // 方格角标（0/1）
      const t0 = svgEl('text', { x: r.x + 3, y: r.y + r.h - 4, class: 'insetlab' });
      t0.textContent = '0';
      const t1 = svgEl('text', { x: r.x + r.w - 8, y: r.y + 12, class: 'insetlab' });
      t1.textContent = '1';
      guides.append(t0, t1);
    }

    while (handleLayer.firstChild) handleLayer.removeChild(handleLayer.firstChild);
    for (const h of hs) {
      const active = h.id === dragId || h.id === hoverId;
      const dot = svgEl('circle', {
        cx: h.x,
        cy: h.y,
        r: active ? 8 : 6,
        class: `ed-curve-handle ${h.cls}${active ? ' active' : ''}`,
      });
      const tip = svgEl('title');
      tip.textContent =
        h.id === 'p1' || h.id === 'p2'
          ? `${h.label}（贝塞尔控制点：拖动改曲线形状）`
          : `${h.label}（拖动改值）`;
      dot.appendChild(tip);
      handleLayer.appendChild(dot);
      if (active) {
        const t = svgEl('text', { x: h.x + 12, y: h.y + 4, class: 'hlab' });
        t.textContent = h.label;
        handleLayer.appendChild(t);
      }
    }

    legend.textContent = `${data.label ?? ''}　起 ${fmt(ev.start)} → 止 ${fmt(ev.end)}　${
      span.clamped ? `全长 ${Math.round(span.fullSpan)} 拍，仅显示末端 ${Math.round(span.t1 - span.t0)} 拍（横轴为相对拍）　绝对拍：` : ''
    }${
      Math.round(ev.startBeat * 1000) / 1000
    } ~ ${Math.round(span.t1 * 1000) / 1000} 拍${Array.isArray(ev.bezierPoints) ? '　（贝塞尔：可拖 P1/P2）' : ''}`;
  }

  function applyDrag(e) {
    const ev = data?.ev;
    if (!ev || !dragId) return;
    const p = toView(e);
    // 刻度固定时，手柄值夹在刻度范围内（拖出图外就看不见了）
    const clampValue = (v) => Math.min(range.max, Math.max(range.min, v));
    if (dragId === 'start') {
      ev.start = clampValue(yToValue(p.y));
      data.onLive?.('start', ev.start);
    } else if (dragId === 'end') {
      ev.end = clampValue(yToValue(p.y));
      data.onLive?.('end', ev.end);
    } else {
      const pts = Array.isArray(ev.bezierPoints) ? [...ev.bezierPoints] : [0.25, 0.1, 0.25, 1];
      // 主图模式用主图反解；退化情形仍用单位方格
      const bez = bezierMode() === 'main' ? mainToBez(p) : xyToBez(p);
      if (dragId === 'p1') {
        pts[0] = bez.x;
        pts[1] = bez.y;
      } else {
        pts[2] = bez.x;
        pts[3] = bez.y;
      }
      ev.bezierPoints = pts;
      ev.easingType = 6;
      data.onLive?.('bezier', null, pts);
    }
    render();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (!data?.ev) return;
    const id = pick(toView(e));
    if (!id) {
      data.onHint?.('把手柄（圆点）上下拖动可改取值；贝塞尔时可拖 P1/P2');
      return;
    }
    dragId = id;
    e.preventDefault?.();
    // 指针捕获失败（例如合成事件、指针已失效）不能影响拖动本身
    try {
      svg.setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：没有捕获也能靠 svg 上的 pointermove 拖动 */
    }
    svg.classList?.add('dragging');
    applyDrag(e);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!data?.ev) return;
    if (dragId) {
      applyDrag(e);
      return;
    }
    const id = pick(toView(e));
    if (id !== hoverId) {
      hoverId = id;
      svg.classList?.toggle?.('over-handle', !!id);
      render();
    }
  });
  const finish = () => {
    if (!dragId) return;
    dragId = null;
    hoverId = null;
    svg.classList?.remove?.('dragging');
    data?.onCommit?.();
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
  svg.addEventListener('pointerleave', () => {
    if (hoverId) {
      hoverId = null;
      render();
    }
  });

  const api = {
    el: wrap,
    svg,
    setData(next) {
      data = next;
      render();
    },
    redraw: render,
    get data() {
      return data;
    },
    handlePositions: () => handleList().map((h) => ({ id: h.id, x: h.x, y: h.y })),
    pickAt: (x, y) => pick({ x, y }),
    /** 逻辑坐标系尺寸（固定，不随容器变化） */
    get size() {
      return { W: VW, H: VH };
    },
    destroy() {
      disposed = true;
      data = null;
      wrap.remove?.();
      if (lastCurve === api) lastCurve = null;
    },
  };
  lastCurve = api;
  return api;
}
