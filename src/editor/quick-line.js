/**
 * 快速切线：按住 `Tab` 弹出圆环选线菜单，松开即把该线载入时间轴。
 *
 * 交互（与结构树单击判定线行**完全等价**：清空时间轴后放入该线的音符轨 + 全部事件轨）：
 *  - 按住 `Tab` → 在时间轴区域中央展开圆环，24 条线分两圈（内圈 0–11、外圈 12–23），
 *    方向按钟表排布（0 在正上方、顺时针），与设计稿一致；
 *  - 移动鼠标 → 指针所在的那一格高亮，圆心显示该线的序号 / 名称 / 「松开 Tab 载入」；
 *  - 松开 `Tab` → 载入高亮的那条线并收起重环；指针停在圆心或环外 → 视为取消；
 *  - 谱面超过 24 条线时，滚轮翻页（圆心显示「25–48 / 共 60」）；
 *  - `Esc` / 窗口失焦 → 取消。
 *
 * 几何与判定都走纯函数（`slotAt` / `slotGeometry`），因此可以脱离 DOM 单测。
 */

/** 内 / 外两圈各 12 格，合计 24 条线；超过则分页 */
export const SLOTS_PER_RING = 12;
export const LINES_PER_PAGE = SLOTS_PER_RING * 2;
/** 圆环几何（以「半径比例」表示，便于按容器大小缩放） */
export const RING_GEOMETRY = {
  /** 圆心死区：指针停在这么近的地方视为「没选」 */
  dead: 0.26,
  inner: [0.30, 0.6],
  outer: [0.64, 0.96],
};
/** SVG 画布（viewBox）尺寸：几何计算都用它，实际显示尺寸交给 CSS */
const VB = 400;
const CX = VB / 2;
const CY = VB / 2;
const R = VB / 2;
/** 每格的角半宽（度）：30° 一格留 4° 缝 */
const HALF_WEDGE = 13;

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * 指针位置 → 圆环上的哪一格（纯函数）。
 * @param {number} dx 相对圆心的 x（像素，右为正）
 * @param {number} dy 相对圆心的 y（像素，下为正）
 * @param {number} radius 圆环外半径（像素）
 * @returns {{ring:0|1, hour:number}|null} ring 0 = 内圈、1 = 外圈；hour 0..11（0 在正上方，顺时针）
 */
export function slotAt(dx, dy, radius) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(radius > 0)) return null;
  const r = Math.hypot(dx, dy) / radius;
  if (r < RING_GEOMETRY.dead || r > RING_GEOMETRY.outer[1]) return null;
  // 两圈各自是「环带」：落在带与带之间的缝隙里不算选中
  const inBand = (band) => r >= band[0] && r <= band[1];
  const ring = inBand(RING_GEOMETRY.outer) ? 1 : inBand(RING_GEOMETRY.inner) ? 0 : null;
  if (ring === null) return null;
  // 从正上方开始、顺时针：angle = atan2(dx, -dy)
  const angle = Math.atan2(dx, -dy);
  const hour = ((Math.round(angle / rad(30)) % SLOTS_PER_RING) + SLOTS_PER_RING) % SLOTS_PER_RING;
  return { ring, hour };
}

/** 格 → 线序号（含分页偏移）；超出线数返回 null */
export function lineIndexAt(slot, page = 0, lineCount = 0) {
  if (!slot) return null;
  const index = page * LINES_PER_PAGE + slot.ring * SLOTS_PER_RING + slot.hour;
  return index >= 0 && index < lineCount ? index : null;
}

/** 一格的扇形路径（annular sector） */
function wedgePath(hour, [r0, r1]) {
  const a0 = rad(-90 + hour * 30 - HALF_WEDGE);
  const a1 = rad(-90 + hour * 30 + HALF_WEDGE);
  const p = (r, a) => `${(CX + r * R * Math.cos(a)).toFixed(2)} ${(CY + r * R * Math.sin(a)).toFixed(2)}`;
  return [
    `M ${p(r0, a0)}`,
    `A ${(r1 * R).toFixed(2)} ${(r1 * R).toFixed(2)} 0 0 1 ${p(r1, a1)}`,
    `L ${p(r0, a1)}`,
    `A ${(r0 * R).toFixed(2)} ${(r0 * R).toFixed(2)} 0 0 0 ${p(r0, a0)}`,
    'Z',
  ].join(' ');
}

/** 某个角度的单位方向（0 在正上方、顺时针） */
const dirAt = (hour, radiusFrac) => [CX + radiusFrac * R * Math.sin(rad(hour * 30)), CY - radiusFrac * R * Math.cos(rad(hour * 30))];

/**
 * 圆环的完整布局（纯函数，便于测试与出图工具复用）：每格给出扇形路径、
 * 序号与线名的文字位置、以及这一格是否真的有线（`filled`）。
 * 文字位置固定在所属环带内（序号偏外、线名偏内），因此不会跑到格子外面去。
 */
export function ringLayout({ page = 0, lineCount = 0 } = {}) {
  const out = [];
  for (const ring of [0, 1]) {
    const band = ring ? RING_GEOMETRY.outer : RING_GEOMETRY.inner;
    const rMid = (band[0] + band[1]) / 2;
    for (let hour = 0; hour < SLOTS_PER_RING; hour++) {
      const index = page * LINES_PER_PAGE + ring * SLOTS_PER_RING + hour;
      out.push({
        ring,
        hour,
        index,
        band,
        filled: index < lineCount,
        wedge: wedgePath(hour, band),
        numAt: dirAt(hour, rMid + 0.05),
        nameAt: dirAt(hour, rMid - 0.1),
      });
    }
  }
  return out;
}

/** 每条线的主题色：按 group 取一个稳定的色相（同一组同色，便于一眼分组） */
function lineHue(index, line) {
  const key = Number.isFinite(line?.group) && line.group > 0 ? line.group : index;
  return (key * 47 + 195) % 360;
}

/** 创建 SVG 元素（命名空间在部分桩件环境里缺失，做个兜底） */
function svgEl(tag, attrs = {}) {
  const ns = globalThis.document?.createElementNS?.bind(globalThis.document);
  const node = ns ? ns('http://www.w3.org/2000/svg', tag) : globalThis.document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const el = (tag, cls, text) => {
  const node = globalThis.document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * @param {object} p
 * @param {object} p.host 承载圆环的容器（时间轴面板；缺省时挂到 body）
 * @param {() => object|null} p.getChart 取当前谱面
 * @param {() => object|null} p.getAxis 取当前拍轴（传给 makeLineTracks）
 * @param {(lineId:number) => boolean} p.onPick 选中某条线（返回是否真的载入）
 * @param {() => number} [p.getLoadedLine] 取「时间轴里当前是哪条线」（-1 = 不是整条线）
 * @param {object} [p.anchor] 用来算圆心与半径的元素（缺省 = host）
 * @param {(msg:string) => void} [p.onStatus] 状态提示
 */
export function createQuickLine({ host, anchor, getChart, getAxis, onPick, getLoadedLine, onStatus }) {
  void getAxis; // 载入由 onPick 负责（它内部走结构树同一套 makeLineTracks）
  const root = el('div', 'ed-quick-line hidden');
  const svg = svgEl('svg', { class: 'ed-ql-svg', viewBox: `0 0 ${VB} ${VB}` });
  const slotLayer = svgEl('g', { class: 'ed-ql-slots' });
  const focus = svgEl('path', { class: 'ed-ql-focus' });
  const needle = svgEl('line', { class: 'ed-ql-needle', x1: CX, y1: CY, x2: CX, y2: CY });
  svg.append(slotLayer, focus, needle);
  const center = el('div', 'ed-ql-center');
  const centerNum = el('div', 'ed-ql-center-num', '');
  const centerName = el('div', 'ed-ql-center-name', '');
  const centerHint = el('div', 'ed-ql-center-hint', '移动鼠标选择线路');
  const pageLabel = el('div', 'ed-ql-page', '');
  center.append(centerNum, centerName, centerHint);
  root.append(el('div', 'ed-ql-veil'), svg, center, pageLabel);
  (host ?? globalThis.document.body).appendChild(root);

  let open = false;
  let chart = null;
  let page = 0;
  let hover = null; // { ring, hour, lineIndex }
  let radius = 1;
  let centerX = 0;
  let centerY = 0;
  /** 已经载入时间轴的那条线（对比轨道 id 得出，用于在环上标出来） */
  let loadedLine = -1;

  const lineCount = () => chart?.lines?.length ?? 0;
  const pageCount = () => Math.max(1, Math.ceil(lineCount() / LINES_PER_PAGE));

  function setHover(next) {
    hover = next;
    const line = next && chart ? chart.lines[next.lineIndex] : null;
    if (next && line) {
      const geo = next.ring === 1 ? RING_GEOMETRY.outer : RING_GEOMETRY.inner;
      focus.setAttribute('d', wedgePath(next.hour, geo));
      focus.classList.add('on');
      const [tx, ty] = dirAt(next.hour, (geo[0] + geo[1]) / 2);
      needle.setAttribute('x2', tx.toFixed(2));
      needle.setAttribute('y2', ty.toFixed(2));
      needle.classList.add('on');
      centerNum.textContent = String(next.lineIndex);
      centerName.textContent = `${next.lineIndex + 1} 号线 · ${line.name || `Line ${next.lineIndex}`}`;
      centerHint.textContent = next.lineIndex === loadedLine ? '该线已在时间轴中（松开 Tab 重新载入）' : '松开 Tab 载入该线';
      root.dataset.line = String(next.lineIndex);
    } else {
      focus.classList.remove('on');
      needle.classList.remove('on');
      centerNum.textContent = open && lineCount() ? '—' : '';
      centerName.textContent = open ? '移动鼠标到某个数字' : '';
      centerHint.textContent = '松开 Tab 取消';
      delete root.dataset.line;
    }
    root.classList.toggle('has-hover', !!next);
  }

  function buildSlots() {
    slotLayer.textContent = '';
    const slots = ringLayout({ page, lineCount: lineCount() });
    for (const slot of slots) {
      const { index, filled } = slot;
      const line = chart?.lines?.[index] ?? null;
      const g = svgEl('g', { class: `ed-ql-slot${filled && line ? '' : ' empty'}${index === loadedLine ? ' loaded' : ''}` });
      g.dataset.line = String(index);
      const wedge = svgEl('path', { class: 'ed-ql-wedge', d: slot.wedge });
      // 每格给一点「这组线」的颜色（SVG 呈现属性用逗号形式的 hsla，兼容性最好）
      if (line) wedge.setAttribute('stroke', `hsla(${lineHue(index, line)}, 70%, 65%, 0.45)`);
      g.appendChild(wedge);
      const num = svgEl('text', { class: 'ed-ql-num', x: slot.numAt[0].toFixed(2), y: slot.numAt[1].toFixed(2) });
      num.textContent = String(index);
      g.appendChild(num);
      if (line) {
        const name = svgEl('text', { class: 'ed-ql-name', x: slot.nameAt[0].toFixed(2), y: slot.nameAt[1].toFixed(2) });
        name.textContent = String(line.name || `Line ${index}`).slice(0, 8);
        g.appendChild(name);
      }
      // 依次淡入（错开一点，播放「展开」的感觉）
      g.style.transitionDelay = `${(slot.ring * SLOTS_PER_RING + slot.hour) * 8}ms`;
      slotLayer.appendChild(g);
    }
    const pages = pageCount();
    pageLabel.textContent = pages > 1 ? `${page * LINES_PER_PAGE + 1}–${Math.min(lineCount(), (page + 1) * LINES_PER_PAGE)} / 共 ${lineCount()} 条线　滚轮翻页` : '';
    pageLabel.classList.toggle('hidden', pages <= 1);
  }

  /** 指针位置 → 高亮（clientX/clientY 是窗口坐标） */
  function moveTo(clientX, clientY) {
    if (!open) return null;
    const slot = slotAt(clientX - centerX, clientY - centerY, radius);
    const index = lineIndexAt(slot, page, lineCount());
    const next = slot && index !== null ? { ...slot, lineIndex: index } : null;
    if (next?.lineIndex !== hover?.lineIndex || next?.ring !== hover?.ring || next?.hour !== hover?.hour) setHover(next);
    return next;
  }

  function refreshGeometry() {
    const node = anchor ?? host;
    const box = node?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    const hostBox = host?.getBoundingClientRect?.() ?? box;
    const size = Math.max(160, Math.min(box.width || 160, box.height || 160));
    // 命中判定用**窗口坐标**（指针事件给的是 clientX/clientY）
    centerX = (box.left || 0) + (box.width || 0) / 2;
    centerY = (box.top || 0) + (box.height || 0) / 2;
    // 半径 = 可用尺寸的一半：viewBox 里外圈画到 0.96 × 200 / 400 = 0.48 × CSS 尺寸 = 0.96 × radius
    radius = size / 2;
    // 圆环与圆心是覆盖层（覆盖整个面板）的子元素 → 位置要换算成**相对面板**的坐标
    root.style.setProperty('--ed-ql-size', `${Math.round(size)}px`);
    root.style.setProperty('--ed-ql-left', `${Math.round(centerX - (hostBox.left || 0))}px`);
    root.style.setProperty('--ed-ql-top', `${Math.round(centerY - (hostBox.top || 0))}px`);
  }

  /** 展开圆环 */
  function show() {
    if (open) return false;
    chart = getChart?.() ?? null;
    if (!chart?.lines?.length) {
      onStatus?.('快速切线：还没有载入谱面');
      return false;
    }
    open = true;
    page = 0;
    loadedLine = getLoadedLine?.() ?? -1;
    refreshGeometry();
    buildSlots();
    setHover(null);
    root.classList.remove('hidden');
    // 先撤掉 open 再下一帧加回来，保证 CSS 过渡真的播放（同一帧增删 class 不会触发动画）
    root.classList.remove('open');
    globalThis.requestAnimationFrame?.(() => {
      if (open) root.classList.add('open');
    });
    onStatus?.('快速切线：移动鼠标选线，松开 Tab 载入');
    return true;
  }

  /** 收起圆环（不载入） */
  function hide(reason = '') {
    if (!open) return false;
    open = false;
    hover = null;
    root.classList.remove('open');
    root.classList.add('hidden');
    if (reason) onStatus?.(reason);
    return true;
  }

  /** 滚轮翻页（只有超过 24 条线时才有意义） */
  function turnPage(delta) {
    if (!open || pageCount() <= 1) return false;
    const next = (page + (delta > 0 ? 1 : -1) + pageCount()) % pageCount();
    if (next === page) return false;
    page = next;
    buildSlots();
    setHover(null);
    onStatus?.(`快速切线：第 ${page + 1} / ${pageCount()} 页`);
    return true;
  }

  /** 松开 Tab：载入高亮的那条线；没有高亮则取消 */
  function commit() {
    if (!open) return null;
    const target = hover?.lineIndex ?? null;
    const line = target !== null ? chart?.lines?.[target] : null;
    hide();
    if (target === null || !line) {
      onStatus?.('快速切线：已取消');
      return null;
    }
    const ok = onPick?.(target) !== false;
    onStatus?.(`快速切线：已载入 ${target + 1} 号线${ok ? '' : '（已在时间轴中）'}`);
    return target;
  }

  return {
    el: root,
    get isOpen() {
      return open;
    },
    /** 圆心 / 半径（测试与调试用） */
    get geometry() {
      return { cx: centerX, cy: centerY, radius, page, lineCount: lineCount() };
    },
    get hovered() {
      return hover;
    },
    show,
    hide,
    /** 指针移动：返回当前高亮的线序号（没有则 null） */
    move: moveTo,
    turnPage,
    commit,
  };
}
