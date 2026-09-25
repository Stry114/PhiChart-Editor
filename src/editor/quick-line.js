/**
 * 快速切线：按住 `Tab` 弹出**全屏**圆环选线菜单，松开即把该线载入时间轴。
 *
 * 交互（与结构树单击判定线行**完全等价**：清空时间轴后放入该线的音符轨 + 全部事件轨）：
 *  - 按住 `Tab` → 全屏覆盖层展开圆环，24 条线分两圈（内圈 0–11、外圈 12–23），
 *    方向按钟表排布（0 在正上方、顺时针），与设计稿一致；
 *  - **按「鼠标总位移」判定**（不再看指针落在哪）：以按下 `Tab` 那一刻的指针位置为原点，
 *    往哪个方向拖就选那一格 —— 不需要把指针移到圆环上，拖一点点就够；
 *    位移长度决定圈：近 = 内圈、远 = 外圈（`DRAG_DEAD` / `DRAG_OUTER`）；
 *  - 松开 `Tab` → 载入选中的那条线并收起圆环；总位移小于死区（`Tab` 轻点一下）→ 取消；
 *  - 谱面超过 24 条线时，滚轮翻页（圆心显示「25–48 / 共 60」）；
 *  - `Esc` / 窗口失焦 → 取消。
 *
 * 几何与判定都走纯函数（`slotByDrag` / `ringLayout`），因此可以脱离 DOM 单测。
 */

/** 内 / 外两圈各 12 格，合计 24 条线；超过则分页 */
export const SLOTS_PER_RING = 12;
export const LINES_PER_PAGE = SLOTS_PER_RING * 2;
/**
 * 圆环**绘制**用的环带（半径比例，按实际尺寸缩放）。注意：判定不再用它 ——
 * 命中哪一格由总位移的方向 / 长度决定（见 `slotByDrag`）。
 */
export const RING_GEOMETRY = {
  inner: [0.30, 0.6],
  outer: [0.64, 0.96],
};
/** 位移死区（像素）：总位移小于它视为「没选」—— `Tab` 轻点一下即取消 */
export const DRAG_DEAD = 14;
/** 位移达到它 → 外圈；介于死区与它之间 → 内圈 */
export const DRAG_OUTER = 72;
/** SVG 画布（viewBox）尺寸：几何计算都用它，实际显示尺寸交给 CSS */
const VB = 400;
const CX = VB / 2;
const CY = VB / 2;
const R = VB / 2;
/** 每格的角半宽（度）：30° 一格留 4° 缝 */
const HALF_WEDGE = 13;

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * 鼠标**总位移** → 圆环上的哪一格（纯函数）。
 *
 * 方向决定 12 格（0 在正上方、顺时针，每格 30°）；长度决定圈：近 = 内圈（0–11）、远 = 外圈（12–23）。
 * 与指针的绝对位置无关 —— 指针不必落在圆环上，往那个方向拖就行。
 * @param {number} dx 总位移的 x（像素，右为正）
 * @param {number} dy 总位移的 y（像素，下为正）
 * @returns {{ring:0|1, hour:number, dist:number}|null} 位移小于死区 → null（取消）
 */
export function slotByDrag(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const dist = Math.hypot(dx, dy);
  if (dist < DRAG_DEAD) return null;
  // 从正上方开始、顺时针：angle = atan2(dx, -dy)
  const angle = Math.atan2(dx, -dy);
  const hour = ((Math.round(angle / rad(30)) % SLOTS_PER_RING) + SLOTS_PER_RING) % SLOTS_PER_RING;
  return { ring: dist >= DRAG_OUTER ? 1 : 0, hour, dist };
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
 * @param {object} [p.host] 覆盖层的挂载点（缺省 = `document.body`；全屏 `position: fixed`，
 *   所以不要挂在被 transform / backdrop-filter 影响的面板里）
 * @param {() => object|null} p.getChart 取当前谱面
 * @param {() => object|null} p.getAxis 取当前拍轴（传给 makeLineTracks）
 * @param {(lineId:number) => boolean} p.onPick 选中某条线（返回是否真的载入）
 * @param {() => number} [p.getLoadedLine] 取「时间轴里当前是哪条线」（-1 = 不是整条线）
 * @param {(msg:string) => void} [p.onStatus] 状态提示
 */
export function createQuickLine({ host, getChart, getAxis, onPick, getLoadedLine, onStatus }) {
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
  const centerHint = el('div', 'ed-ql-center-hint', '向某个方向拖动选线');
  const pageLabel = el('div', 'ed-ql-page', '');
  center.append(centerNum, centerName, centerHint);
  root.append(el('div', 'ed-ql-veil'), svg, center, pageLabel);
  (host ?? globalThis.document.body).appendChild(root);

  let open = false;
  let chart = null;
  let page = 0;
  let hover = null; // { ring, hour, dist, lineIndex }
  let radius = 1;
  let size = 0;
  let centerX = 0;
  let centerY = 0;
  /** 总位移的原点：按下 `Tab` 那一刻的指针位置 */
  let originX = 0;
  let originY = 0;
  /** 已经载入时间轴的那条线（对比轨道 id 得出，用于在环上标出来） */
  let loadedLine = -1;

  const lineCount = () => chart?.lines?.length ?? 0;
  const pageCount = () => Math.max(1, Math.ceil(lineCount() / LINES_PER_PAGE));
  const ringName = (ring) => (ring ? '外圈' : '内圈');

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
      centerHint.textContent =
        next.lineIndex === loadedLine ? '该线已在时间轴中（松开 Tab 重新载入）' : `${ringName(next.ring)} · 松开 Tab 载入该线`;
      root.dataset.line = String(next.lineIndex);
      root.dataset.ring = String(next.ring);
    } else {
      focus.classList.remove('on');
      needle.classList.remove('on');
      centerNum.textContent = open && lineCount() ? '—' : '';
      centerName.textContent = open ? '向某个方向拖动选线' : '';
      centerHint.textContent = open ? '拖远一点选外圈 · 松开 Tab 取消' : '松开 Tab 取消';
      delete root.dataset.line;
      delete root.dataset.ring;
    }
    root.classList.toggle('ring-inner', next?.ring === 0);
    root.classList.toggle('ring-outer', next?.ring === 1);
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
      g.dataset.ring = String(slot.ring);
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
      // 依次淡入（错开一点，播放「展开」的感觉；延迟已按「动画加快 50%」缩放）
      g.style.transitionDelay = `${(slot.ring * SLOTS_PER_RING + slot.hour) * 5}ms`;
      slotLayer.appendChild(g);
    }
    const pages = pageCount();
    pageLabel.textContent = pages > 1 ? `${page * LINES_PER_PAGE + 1}–${Math.min(lineCount(), (page + 1) * LINES_PER_PAGE)} / 共 ${lineCount()} 条线　滚轮翻页` : '';
    pageLabel.classList.toggle('hidden', pages <= 1);
  }

  /** 指针移动 → 高亮：只看**总位移**（相对按下 Tab 时的位置），不看指针落在哪 */
  function moveTo(clientX, clientY) {
    if (!open) return null;
    const dx = (Number(clientX) || 0) - originX;
    const dy = (Number(clientY) || 0) - originY;
    const slot = slotByDrag(dx, dy);
    const index = lineIndexAt(slot, page, lineCount());
    const next = slot && index !== null ? { ...slot, lineIndex: index } : null;
    if (next?.lineIndex !== hover?.lineIndex || next?.ring !== hover?.ring || next?.hour !== hover?.hour) setHover(next);
    return next;
  }

  /**
   * 全屏覆盖层：圆环画在窗口正中央（CSS 用 50% / 50% 定位），直径取窗口短边的 94%。
   * 窗口尺寸缺省按 `layout.js` 的同一套兜底（1280 × 720）。
   * `centerX / centerY / radius` 只用于调试与测试 —— 判定不再依赖它们（见 `slotByDrag`）。
   */
  function refreshGeometry() {
    const winW = Math.max(320, Number(globalThis.innerWidth) || 1280);
    const winH = Math.max(240, Number(globalThis.innerHeight) || 720);
    size = Math.max(160, Math.round(Math.min(winW, winH) * 0.94));
    centerX = winW / 2;
    centerY = winH / 2;
    radius = size / 2;
    root.style.setProperty('--ed-ql-size', `${size}px`);
  }

  /**
   * 展开圆环。
   * @param {{x:number,y:number}|null} [origin] 总位移的原点（按下 Tab 时的指针位置）；
   *   拿不到（纯键盘操作）时退回窗口中心
   */
  function show(origin = null) {
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
    originX = Number.isFinite(origin?.x) ? origin.x : centerX;
    originY = Number.isFinite(origin?.y) ? origin.y : centerY;
    buildSlots();
    setHover(null);
    root.classList.remove('hidden');
    // 先撤掉 open 再下一帧加回来，保证 CSS 过渡真的播放（同一帧增删 class 不会触发动画）
    root.classList.remove('open');
    globalThis.requestAnimationFrame?.(() => {
      if (open) root.classList.add('open');
    });
    onStatus?.('快速切线：向某个方向拖动选线（拖远一点选外圈），松开 Tab 载入');
    return true;
  }

  /** 收起圆环（不载入） */
  function hide(reason = '') {
    if (!open) return false;
    open = false;
    setHover(null); // 清掉高亮与「内圈 / 外圈」的淡化状态
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
    /** 圆心 / 半径 / 位移原点（测试与调试用） */
    get geometry() {
      return { cx: centerX, cy: centerY, radius, size, page, lineCount: lineCount(), origin: { x: originX, y: originY } };
    },
    get hovered() {
      return hover;
    },
    show,
    hide,
    /** 指针移动（窗口坐标）：返回当前高亮的线序号（没有则 null） */
    move: moveTo,
    turnPage,
    commit,
  };
}
