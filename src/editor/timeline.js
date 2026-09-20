/**
 * 时间轴（右下角主工作区）——同时承担「轨道管理」
 *
 * 版式（对齐参考图与最新要求）：
 *  - 横轴以**拍**为单位；刻度密度可调（1 ~ 1/16 拍，分母为整数）
 *  - 轨道高 60px（原 30 的 2 倍）；轨道间隔 2px；组间隔 5px；相邻事件间隔 1px
 *  - 事件块 80% 不透明度、无边框，透出刻度网格；块内画取值趋势线
 *  - 轨道头：配色竖条 + 两行文字（线/层 + 事件名）+ 段数 + 移除按钮；**无可见性按钮**
 *  - 同一事件层的轨道绑定成组：拖动任一条即整组移动，可整组显隐/移除
 *  - 轨道管理就在面板内：顶部一行「全部显隐 / 清空 / 刻度密度」等
 *
 * 性能：
 *  - 限制缩放范围（像素/拍 8 ~ 240）
 *  - 宽度 < 10px 的小事件：降低细节（不画文字/趋势线），相邻的还会**合并成一段**渲染
 *  - 只绘制可见行与可见列
 */
import { icon } from '../ui/icons.js';
import { FALLBACK_X_RANGE, POS_LINE_OPTIONS, DEFAULT_POS_LINES } from './tracks.js';

const ROW_H = 42; // 轨道高（60 的 70%）
const ROW_GAP = 0; // 同一组内不再留行间距
const GROUP_GAP = 5; // 组与组 / 独立轨之间
const CLIP_GAP = 1; // 相邻事件之间
const LOD_PX = 10; // 小事件阈值：低于该宽度合并渲染 / 降低细节
const LABEL_FULL_PX = 150; // 宽度够大才显示完整文案（起止值 + 时长 + 缓动）
const LABEL_SHORT_PX = 88; // 稍窄只显示起止值
const CLIP_ALPHA = 0.4; // 事件块「60% 透明度」= 不透明度 40%
const CLIP_RADIUS = 4; // 事件块圆角（3~5px）
const CLIP_MARGIN = 20; // 视野外仍参与绘制的余量（像素）
const TREND_WIDTH = 2.5; // 趋势线加粗
const ZOOM_MIN = 8;
const ZOOM_MAX = 320; // 放大上限（够看清单个事件即可，太大反而没意义）
const NOTE_COLOR_SIMPLE = { tap: '#4aa8ff', drag: '#4ac3f0', hold: '#22c3f0', flick: '#ff4d6d' };
const NOTES_ROW_BG = '#171717'; // 音符轨底色：比事件轨（画布 #121212）浅一点点
/** Hold 主体：手绘的蓝色圆角长条（不用贴图），只有头部用 tap 贴图 */
const HOLD_BAR_COLOR = '#22c3f0';
/** 音符轨底色较浅，节拍线要相应调亮才看得见 */
const NOTE_ROW_GRID = { label: '#3d3d3d', whole: '#323232', sub: '#282828' };
const ZOOM_STEP = 1.08; // Ctrl+Alt+滚轮 / 触控板捏合的缩放灵敏度（比原来 1.15 更柔和）
const MAX_VISIBLE_BEATS = 32; // 缩放下限：同屏最多 32 拍（再往外拉没有意义）
const EDGE_PX = 30; // 指针拖到左右这个范围内就开始带着时间轴一起滚（刻度尺拖动用）
// 移动工具的贴边自动滚动：进入边缘 AUTO_PAD 像素内开始滚，越靠边越快（px/帧）。
// 幅度刻意压住（最慢约 60px/s，最快约 800px/s），否则一贴边就飞出去没法精确定位。
const AUTO_PAD = 56;
const AUTO_MIN_PX = 1;
const AUTO_MAX_PX = 13;
const INITIAL_VISIBLE_BEATS = 6; // 初始缩放：约 6 拍可见
const LABEL_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];
const TICK_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16]; // 刻度密度：每拍切 1 ~ 16 等分（分母为整数）
const DEFAULT_TICK_DIV = 8; // 默认 1/8 拍
const RULER_H = 26;

const fmtBeat = (b) => (Math.abs(b - Math.round(b)) < 1e-6 ? String(Math.round(b)) : b.toFixed(2));

export function createTimeline({
  heads,
  body,
  canvas,
  onSeek,
  onSelect,
  onTracksChanged,
  onAddRequest,
  onStatus,
  onSelectionChange: onSelectionChangeCb,
  onClipsChanged: onClipsChangedCb,
  noteSprites: initialSprites,
}) {
  const ctx = canvas.getContext('2d');
  let chart = null;
  let axis = null;
  let tracks = [];
  let time = 0;
  let pxPerBeat = 40;
  let scrollBeat = 0;
  let tickDiv = DEFAULT_TICK_DIV; // 默认每拍 8 等分（1/8 拍）
  let dpr = 1;
  let width = 0;
  let height = 0;
  let selectedId = null;
  let currentSeek = onSeek;
  let snapEnabled = true; // 吸附：指针与操作以刻度线为最小单位
  let following = false; // 播放跟随：指针进入可见范围后跟着播放滚动
  let scrollTopPx = 0; // 纵向滚动位置（由 body 的 scrollTop 同步）
  let lastPointerX = null; // 拖动中的指针横坐标（贴边自动滚动用）
  let edgeDir = 0; // -1 向左 / +1 向右 / 0 停止
  let edgeRaf = 0;
  let autoDx = 0; // 移动工具的贴边自动滚动速度（px/帧，负=向左/上）
  let autoDy = 0;
  let autoRaf = 0;
  let layoutRows = [];
  let layoutHeight = 0;
  let noteSprites = initialSprites ?? null; // assets/notes 里的四张圆形贴图
  let redrawCount = 0; // 性能诊断：累计重绘次数
  let lastPlayheadPx = null;
  let posSnap = false; // 横向（positionX）刻度吸附：开关（全局）
  let posLines = DEFAULT_POS_LINES; // 横向刻度线数量（全局，默认 9 线）
  let lastTinyCtrlWheelAt = -1e9; // 最近一次「很小的 Ctrl+滚轮」时刻（用于识别触控板捏合）
  // ── 鼠标工具：选择与拖动 ──
  let tool = 'mouse'; // 'mouse' 点选/框选/拖拽 | 'pan' 平移（鼠标拖动 + 贴边自动滚动；触屏交给原生滚动）
  const selEvents = new Set(); // 选中的事件块 key
  const selNotes = new Set(); // 选中的音符 key
  let hitRects = []; // 每帧绘制时记录的可命中区域（{key,kind,trackId,index,x,y,w,h}）
  let boxSel = null; // 框选矩形 {x0,y0,x1,y1}
  let dragSel = null; // 拖动中的选择：{x,y,dBeat,dPosX,origin: Map, moved}
  const interactionState = { rulerDrag: false, panning: false }; // 供状态查询
  let panDrag = null; // 移动工具下正在平移：{ x, y, left, top }
  let onSelectionChange = null;
  let onClipsChanged = null; // 拖动/编辑改动了 clip 之后回调（左上详情页据此同步）
  let onStatusCb = null;

  // 撑开滚动区的空元素（优先按 id 取，兼容选择器支持不完整的环境）
  const spacer =
    globalThis.document?.getElementById?.('ed-tl-spacer') ?? body?.querySelector?.('.ed-tl-spacer') ?? null;
  const raf = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(() => fn(Date.now()), 16));
  const cancelRaf = globalThis.cancelAnimationFrame ?? ((id) => clearTimeout(id));
  onStatusCb = onStatus ?? null;
  onSelectionChange = onSelectionChangeCb ?? null;
  onClipsChanged = onClipsChangedCb ?? null;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 缩放下限：既不低于 ZOOM_MIN，也要保证同屏不超过 MAX_VISIBLE_BEATS 拍
  const minZoom = () => (width ? Math.max(ZOOM_MIN, width / MAX_VISIBLE_BEATS) : ZOOM_MIN);
  const scrollY = () => scrollTopPx;
  const b2x = (beat) => (beat - scrollBeat) * pxPerBeat;
  const x2b = (x) => scrollBeat + x / pxPerBeat;
  const timeToBeat = (t) => (axis ? axis.toBeat(t) : t);

  /** 行布局：轨高 + 轨道间隔 + 组间隔（DOM 头与画布共用，保证对齐） */
  function relayout() {
    const rows = [];
    let top = 0;
    let prevGroup = null;
    tracks.forEach((track, index) => {
      // 同一条绑定组内的轨道紧贴；换了组、或涉及独立轨道时留 5px
      const bound = !!track.group && track.group === prevGroup;
      const gap = index > 0 && !bound ? GROUP_GAP : 0;
      top += gap;
      const height = Number.isFinite(track.rowHeight) ? track.rowHeight : ROW_H; // 音符轨是宽轨
      rows.push({ track, top, height, gapBefore: gap });
      top += height + ROW_GAP;
      prevGroup = track.group ?? null;
    });
    layoutRows = rows;
    layoutHeight = Math.max(0, top - ROW_GAP);
    return rows;
  }

  // ───────────────────────── 轨道头（含拖动排序） ─────────────────────────
  function renderHeads() {
    if (!heads) return;
    relayout();
    updateSpacer(); // 轨道数量/行高变化后立刻更新滚动区（纵向滚动条与竖向滚轮依赖它）
    heads.innerHTML = '';
    const spacer = document.createElement('div');
    spacer.className = 'ed-tl-head-spacer';
    spacer.style.height = `${RULER_H}px`;
    heads.appendChild(spacer);

    let lastGroup = null;
    const groupCounts = new Map();
    for (const t of tracks) if (t.group) groupCounts.set(t.group, (groupCounts.get(t.group) ?? 0) + 1);

    let prevBottom = 0;
    for (const row of layoutRows) {
      const track = row.track;
      const gapPx = Math.max(0, row.top - prevBottom);
      // 只在「组与组 / 独立轨之间」（间隔比普通轨道间隔大）放一条 1px 分割线：
      // 同一组内的轨道之间不画；线只出现在轨道头列里，居中放在间隔中。
      const isBoundary = gapPx > 0;
      const sepTop = isBoundary ? Math.floor((gapPx - 1) / 2) : 0;
      if (isBoundary) {
        const sep = document.createElement('div');
        sep.className = 'ed-group-sep';
        sep.style.height = '1px';
        sep.style.marginTop = `${sepTop}px`;
        heads.appendChild(sep);
      }
      const el = document.createElement('div');
      el.className = 'ed-track' + (track.id === selectedId ? ' selected' : '');
      el.style.height = `${row.height}px`;
      el.style.marginTop = `${gapPx - sepTop - (isBoundary ? 1 : 0)}px`;
      el.title = `${track.label}\n${track.clips.length} 段\n拖动可调整顺序${track.group ? `（与同层其余轨绑定：${track.groupLabel}）` : ''}`;

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = track.color;
      el.appendChild(chip);

      // 成组提示：整组左侧画一条竖向导轨；每条轨都有，首行额外挂一个「⛓ 组名 ×N」徽标
      if (track.group) {
        const rail = document.createElement('span');
        rail.className = 'ed-group-rail';
        rail.style.background = colorForGroup(track.group);
        el.appendChild(rail);
        if (track.group !== lastGroup) {
          const badge = document.createElement('button');
          badge.className = 'ed-group-badge';
          badge.type = 'button';
          badge.title = `${track.groupLabel}（${groupCounts.get(track.group) ?? 1} 条轨绑定）：右键可整组移除`;
          badge.textContent = `⛓${groupCounts.get(track.group) ?? 1}`;
          badge.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            removeGroup(track.group);
          });
          el.appendChild(badge);
        } else {
          const indent = document.createElement('span');
          indent.className = 'ed-group-indent';
          el.appendChild(indent);
        }
      }
      lastGroup = track.group ?? null;

      // 轨道类型图标（X 位移 / Y 位移 / 旋转 / 不透明度 / 速度 / 音符）
      if (track.icon) {
        const ico = icon(track.icon, { size: 14 });
        ico.classList.add('ed-track-ico');
        if (track.color) ico.style.color = track.color;
        el.appendChild(ico);
      }

      const text = document.createElement('span');
      text.className = 'ed-track-text';
      const l1 = document.createElement('span');
      l1.className = 'l1';
      l1.textContent = track.headTitle ?? track.label;
      const l2 = document.createElement('span');
      l2.className = 'l2';
      l2.textContent = track.headSub ?? '';
      text.append(l1, l2);
      el.appendChild(text);

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(track.clips.length);
      el.appendChild(count);

      // 横向刻度的吸附与密度已改成时间轴工具栏上的全局控件

      // 移除按钮（图标）：**只移除这一条轨**；整组移除在 ⛓ 徽标上（右键）
      const del = document.createElement('button');
      del.className = 'ed-remove';
      del.type = 'button';
      del.title = '移除此轨道';
      del.appendChild(icon('remove', { size: 14 }));
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(track.id);
      });
      el.appendChild(del);

      el.addEventListener('click', () => {
        selectedId = track.id;
        renderHeads();
        redraw();
        onSelect?.(track);
      });
      bindDrag(el, track);
      heads.appendChild(el);
      prevBottom = row.top + row.height;
    }

    // 轨道头下面的空闲区：+ 图标与「在结构树中双击以添加」提示
    const addRow = document.createElement('button');
    addRow.className = 'ed-tl-add';
    addRow.type = 'button';
    addRow.title = '在左下「结构树」里双击事件层或音符，即可把它们加到这里';
    addRow.appendChild(icon('add', { size: 14 }));
    const addText = document.createElement('span');
    addText.textContent = '在结构树中双击以添加';
    addRow.appendChild(addText);
    addRow.addEventListener('click', () => onAddRequest?.());
    heads.appendChild(addRow);
  }

  /**
   * 拖动轨道头调整顺序：整组轨道一起移动。
   * 注意：pointermove/up 挂在 window 上 —— 挂在行元素上时指针一离开该行就收不到事件，
   * 拖动会直接失效。
   */
  function bindDrag(el, track) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target?.closest?.('button, select, input')) return; // 点控件不触发拖动
      const startY = e.clientY;
      const movingIds = new Set(track.group ? tracks.filter((t) => t.group === track.group).map((t) => t.id) : [track.id]);
      let dragging = false;
      let dropIndex = null;
      const target = globalThis;

      const rowsSnapshot = () => layoutRows;
      const indexFromY = (clientY) => {
        const rows = rowsSnapshot();
        const headsTop = heads.getBoundingClientRect?.().top ?? 0;
        const yInContent = clientY - headsTop + (heads.scrollTop ?? 0) - RULER_H;
        for (let i = 0; i < rows.length; i++) {
          if (yInContent < rows[i].top + rows[i].height / 2) return i;
        }
        return rows.length;
      };

      const onMove = (ev) => {
        if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        el.classList.add('dragging-track');
        dropIndex = indexFromY(ev.clientY);
        const nodes = heads.querySelectorAll('.ed-track');
        for (const n of nodes) n.classList.remove('drop-before');
        const node = nodes[Math.min(dropIndex, Math.max(0, nodes.length - 1))];
        node?.classList.add('drop-before');
      };
      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        el.classList.remove('dragging-track');
        for (const n of heads.querySelectorAll('.ed-track')) n.classList.remove('drop-before');
        if (dragging && dropIndex != null) moveTracks(movingIds, dropIndex);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    });
  }

  /** 把一组轨（或单轨）移动到目标行索引处 */
  function moveTracks(movingIds, targetIndex) {
    const moving = tracks.filter((t) => movingIds.has(t.id));
    if (!moving.length) return;
    const rest = tracks.filter((t) => !movingIds.has(t.id));
    // 目标索引按「其余轨」的位置折算：跳过落在被移动轨内部的插入点
    let idx = clamp(targetIndex, 0, layoutRows.length);
    let removedBefore = 0;
    for (let i = 0; i < Math.min(idx, layoutRows.length); i++) if (movingIds.has(layoutRows[i].track.id)) removedBefore++;
    idx = clamp(idx - removedBefore, 0, rest.length);
    tracks = [...rest.slice(0, idx), ...moving, ...rest.slice(idx)];
    renderHeads();
    redraw();
    onTracksChanged?.(tracks);
  }

  function removeGroup(group) {
    tracks = tracks.filter((t) => t.group !== group);
    renderHeads();
    redraw();
    onSelect?.(null);
    onTracksChanged?.(tracks);
  }

  function removeTrack(id) {
    tracks = tracks.filter((t) => t.id !== id);
    renderHeads();
    redraw();
    onSelect?.(null);
    onTracksChanged?.(tracks);
  }

  // ───────────────────────── 画布 ─────────────────────────
  /** 滚动区的总尺寸：横向 = 全曲拍数 × 像素/拍（横向滚动条据此快速切换），纵向 = 标尺 + 轨道总高 */
  function updateSpacer() {
    if (!spacer) return;
    const totalBeats = Math.max(1, axis?.totalBeats ?? 1);
    spacer.style.width = `${Math.round(totalBeats * pxPerBeat)}px`;
    spacer.style.height = `${Math.round(RULER_H + layoutHeight)}px`;
  }

  /** 滚动容器 → 内部状态（原生滚动条拖动、滚轮、代码滚动都走这里） */
  function syncFromScroll() {
    if (!body) return;
    scrollBeat = pxPerBeat > 0 ? Math.max(0, body.scrollLeft) / pxPerBeat : 0;
    scrollTopPx = Math.max(0, body.scrollTop ?? 0);
    if (heads) heads.scrollTop = scrollTopPx;
    redraw();
  }

  let lastCanvasW = 0;
  let lastCanvasH = 0;
  function resize() {
    if (!body || !canvas) return;
    dpr = globalThis.devicePixelRatio || 1;
    // clientWidth/Height 已经排除滚动条，画布不会被滚动条压住
    const w = Math.max(1, Math.round(body.clientWidth ?? 800));
    const h = Math.max(1, Math.round(body.clientHeight ?? 300));
    // 尺寸没变就跳过：否则「改画布尺寸 → 内容变化 → 滚动条出现 → 尺寸变化」会反复触发
    if (w === lastCanvasW && h === lastCanvasH && canvas.width) return;
    lastCanvasW = w;
    lastCanvasH = h;
    width = w;
    height = h;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    updateSpacer();
    redraw();
  }

  function labelStep() {
    for (const step of LABEL_STEPS) if (step * pxPerBeat >= 56) return step;
    return LABEL_STEPS[LABEL_STEPS.length - 1];
  }

  function withAlpha(hex, a) {
    const h = String(hex).replace('#', '');
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }

  function lighten(hex, k) {
    const h = String(hex).replace('#', '');
    const mix = (c) => Math.round(c + (255 - c) * k);
    return `rgb(${mix(parseInt(h.slice(0, 2), 16))},${mix(parseInt(h.slice(2, 4), 16))},${mix(parseInt(h.slice(4, 6), 16))})`;
  }

  /** 组成员轨的竖向导轨颜色：按组名哈希取一个稳定的灰阶，便于区分不同组 */
  function colorForGroup(group) {
    let h = 0;
    for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) & 0xffff;
    const v = 90 + (h % 5) * 22; // 90 ~ 178
    return `rgb(${v},${v},${v})`;
  }

  /** 事件块内的趋势线（小事件会跳过 → 降低细节） */
  /**
   * 事件块里的趋势线。
   * u（0..1）是「在整个事件内的位置」，因此横坐标必须回到事件自身坐标系算：
   *   px = clipX0 + u * clipW
   * 若直接写成 x + u * w，事件左/右被视野裁掉时就会整体错位（此前就是这个问题）。
   */
  function drawTrend(clip, x, y, w, h, range, color, u0 = 0, u1 = 1, clipX0 = x, clipW = w) {
    if (!(w > LOD_PX && h > 4)) return;
    const span = Math.max(1e-9, range.max - range.min);
    const yOf = (v) => {
      const k = Number.isFinite(v) ? (v - range.min) / span : 0.5;
      return y + h - clamp(k, 0, 1) * h;
    };
    const steps = Math.max(2, Math.min(48, Math.round(w / 8)));
    ctx.strokeStyle = color;
    ctx.lineWidth = TREND_WIDTH; // 加粗趋势线
    ctx.beginPath();
    const from = Math.min(u0, u1);
    const to = Math.max(u0, u1);
    const xMin = Math.min(x, x + w);
    const xMax = Math.max(x, x + w);
    for (let i = 0; i <= steps; i++) {
      const u = from + ((to - from) * i) / steps;
      let k = u;
      if (clip.easingFn) {
        try {
          k = clip.easingFn(u);
        } catch {
          k = u;
        }
      }
      if (!Number.isFinite(k)) k = u;
      const v = (clip.v0 ?? 0) + ((clip.v1 ?? 0) - (clip.v0 ?? 0)) * k;
      let px = clipX0 + u * clipW; // 用事件自身坐标系换算，再夹到可见区间内
      px = Math.min(xMax, Math.max(xMin, px));
      const py = yOf(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  /**
   * 音符轨（宽轨）：横向是时间，纵向按 positionX 分布；
   * 用 assets/notes 里的圆形贴图，Hold 额外画出时长条。
   */
  function drawNotesRow(row, rowTop) {
    const { track } = row;
    const pad = 10;
    const usable = Math.max(4, row.height - pad * 2);
    const xr = track.xRange ?? { min: -FALLBACK_X_RANGE, max: FALLBACK_X_RANGE };
    const span = Math.max(1e-6, xr.max - xr.min);
    const yOf = (x) => rowTop + pad + usable - ((x - xr.min) / span) * usable; // positionX 越大越靠上
    const spriteSize = Math.max(11, Math.min(26, Math.round(row.height * 0.13)));
    const half = spriteSize / 2;
    const noteCount = track.clips.length;
    const simple = noteCount > 400 && pxPerBeat < 24; // 太多音符且太小：只画小色点

    // 底色比事件轨浅一点点，便于区分；底色会盖住节拍线，所以补画一遍竖向节拍线
    ctx.fillStyle = NOTES_ROW_BG;
    ctx.fillRect(0, rowTop, width, row.height);
    redrawBeatLines(rowTop, rowTop + row.height, NOTE_ROW_GRID);

    // 横向刻度线（positionX 轴）：按「线数」在整个取值范围内均匀分布
    // 颜色固定（吸附开关只影响行为，不改外观）
    const lines = Number.isFinite(posLines) && posLines >= 2 ? Math.round(posLines) : DEFAULT_POS_LINES;
    for (let k = 0; k < lines; k++) {
      const px = xr.min + ((xr.max - xr.min) * k) / (lines - 1);
      const y = Math.round(yOf(px)) + 0.5;
      if (y < rowTop + 1 || y > rowTop + row.height - 1) continue;
      ctx.strokeStyle = '#2f2f2f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    track.clips.forEach((clip, index) => {
      const x = b2x(clip.b0);
      if (x < -40 || x > width + 40) return;
      const y = yOf(clip.positionX ?? 0);
      // Hold：主体 = 手绘蓝色圆角长条（圆头圆尾），头部再叠 tap 正圆贴图
      if (clip.type === 'hold' && clip.b1 > clip.b0) {
        const x1 = b2x(clip.b1);
        const w = Math.max(3, x1 - x);
        const barH = Math.max(6, Math.round(spriteSize * 0.62));
        const r = barH / 2;
        ctx.fillStyle = HOLD_BAR_COLOR;
        ctx.beginPath();
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x + w - r, y - r);
        ctx.arc(x + w - r, y, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(x + r, y + r);
        ctx.arc(x + r, y, r, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();
      }
      const noteKey = clipKey(track, index);
      const noteSelected = selNotes.has(noteKey);
      if (simple) {
        ctx.fillStyle = NOTE_COLOR_SIMPLE[clip.type] ?? '#8bd0ff';
        ctx.fillRect(x - 1, y - 1, 2, 2);
        // 选中：外边缘高亮框（比音符本身大一圈）
        if (noteSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x - 5, y - 5, 10, 10);
        }
        hitRects.push({ key: noteKey, kind: 'notes', trackId: track.id, index, x: x - 7, y: y - 7, w: 14, h: 14 });
        return;
      }
      // Hold 的头部用 tap 贴图（正圆）
      const spriteType = clip.type === 'hold' ? 'tap' : clip.type;
      const img = noteSprites?.[spriteType];
      if (img && img.width) {
        ctx.globalAlpha = clip.isFake ? 0.45 : 1;
        ctx.drawImage(img, x - half, y - half, spriteSize, spriteSize);
        ctx.globalAlpha = 1;
      } else {
        // 贴图没加载出来时的兜底：画个圆
        ctx.fillStyle = NOTE_COLOR_SIMPLE[clip.type] ?? '#8bd0ff';
        ctx.beginPath();
        ctx.arc(x, y, half * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
      // 选中：音符外边缘高亮框
      if (noteSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - half - 3, y - half - 3, spriteSize + 6, spriteSize + 6);
      }
      hitRects.push({
        key: noteKey,
        kind: 'notes',
        trackId: track.id,
        index,
        x: x - half - 4,
        y: y - half - 4,
        w: spriteSize + 8,
        h: spriteSize + 8,
      });
    });
  }

  /** 圆角矩形路径（事件块用） */
  function roundRectPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  /** 画一条竖向节拍线（colors 为 null 时用默认色阶） */
  function redrawBeatLine(x, isLabel, isWhole, y0, y1, colors) {
    const c = colors ?? { label: '#333333', whole: '#2a2a2a', sub: '#242424' };
    ctx.strokeStyle = isLabel ? c.label : isWhole ? c.whole : c.sub;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }

  /** 在指定纵向范围内重画所有可见的竖向节拍线（音符轨底色覆盖后要用） */
  function redrawBeatLines(y0, y1, colors) {
    const sub = TICK_DIVISORS.includes(tickDiv) ? tickDiv : 4;
    const subSpacing = pxPerBeat / sub;
    if (subSpacing < 4) return;
    const step2 = labelStep();
    const bStart = Math.floor(scrollBeat * sub) / sub;
    const bEnd = x2b(width);
    for (let i = Math.ceil(bStart * sub); i <= bEnd * sub; i++) {
      const beat = i / sub;
      const x = Math.round(b2x(beat)) + 0.5;
      if (x < -2 || x > width + 2) continue;
      const isWhole = Math.abs(beat - Math.round(beat)) < 1e-6;
      const isLabel = isWhole && Math.abs(beat % step2) < 1e-6;
      redrawBeatLine(x, isLabel, isWhole, y0, y1, colors);
    }
  }

  /** 事件块的结束拍（至少一点点宽，避免零宽矩形） */
  const nextEndBeat = (clip) => Math.max(clip.b1, clip.b0 + 1e-4);

  function redraw() {
    if (!ctx || !canvas) return;
    redrawCount++;
    if (layoutRows.length !== tracks.length) relayout(); // 兜底：轨道增删后布局可能还没重算
    hitRects = [];
    ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, width, height);

    // ── 刻度尺 ──
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, RULER_H);
    ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';

    const step = labelStep();
    const sub = TICK_DIVISORS.includes(tickDiv) ? tickDiv : 4;
    const subSpacing = pxPerBeat / sub;
    const showSub = subSpacing >= 4; // 太密就不画细刻度（否则一片糊、看着像没生效）
    const bStart = Math.floor(scrollBeat * sub) / sub;
    const bEnd = x2b(width);
    for (let i = Math.ceil(bStart * sub); i <= bEnd * sub; i++) {
      const beat = i / sub;
      if (!showSub && Math.abs(beat - Math.round(beat)) > 1e-6) continue;
      const x = Math.round(b2x(beat)) + 0.5;
      if (x < -2 || x > width + 2) continue;
      const isWhole = Math.abs(beat - Math.round(beat)) < 1e-6;
      const isLabel = isWhole && Math.abs(beat % step) < 1e-6;
      // 刻度线颜色：细刻度也要看得见（之前 1/16 时几乎不可见）
      ctx.strokeStyle = isLabel ? '#5c5c5c' : isWhole ? '#454545' : '#343434';
      ctx.beginPath();
      ctx.moveTo(x, isLabel ? 4 : isWhole ? 12 : 17);
      ctx.lineTo(x, RULER_H - 1);
      ctx.stroke();
      redrawBeatLine(x, isLabel, isWhole, RULER_H, height, null);
      if (isLabel) {
        ctx.fillStyle = '#c9c9c9';
        ctx.fillText(fmtBeat(beat), x + 4, 9);
      }
    }

    // ── 轨道与事件块 ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, width, height - RULER_H);
    ctx.clip();
    const sy = scrollY();
    for (const row of layoutRows) {
      const rowTop = RULER_H + row.top - sy;
      const rowBottom = rowTop + row.height;
      if (rowBottom < RULER_H || rowTop > height) continue;

      if (row.track.id === selectedId) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(0, rowTop, width, row.height);
      }

      if (row.track.kind === 'notes') {
        drawNotesRow(row, rowTop);
        continue;
      }

      const range = row.track.range ?? { min: 0, max: 1 };
      const light = lighten(row.track.color, 0.45);
      const boxH = row.height; // 铺满整条事件轨
      const boxY = rowTop;
      const fill = withAlpha(row.track.color, CLIP_ALPHA); // 80% 透明度（能透出刻度）
      ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

      const clips = row.track.clips;
      let i = 0;
      while (i < clips.length) {
        const clip = clips[i];
        const cx0 = b2x(clip.b0);
        const rawW = b2x(Math.max(clip.b1, clip.b0 + 1e-4)) - cx0;
        const isSmall = rawW < LOD_PX;

        if (isSmall) {
          // 小事件：把相邻的一串合并成一个矩形（不画文字与趋势线）→ 降低渲染开销
          let j = i + 1;
          let runEnd = nextEndBeat(clip);
          while (j < clips.length) {
            const next = clips[j];
            const nextX = b2x(next.b0);
            const nextW = b2x(nextEndBeat(next)) - nextX;
            if (nextW >= LOD_PX) break; // 下一个是大事件，不并入
            if (nextX - b2x(runEnd) > 1.5) break; // 与当前段相隔太远，不并入
            runEnd = Math.max(nextEndBeat(next), runEnd);
            j++;
          }
          const x0 = b2x(clip.b0);
          const x1 = b2x(runEnd);
          if (x1 > -CLIP_MARGIN && x0 < width + CLIP_MARGIN) {
            const clampedX = Math.max(-CLIP_MARGIN, x0);
            const w = Math.max(2, Math.min(x1, width + CLIP_MARGIN) - clampedX);
            const runW = Math.max(1, w - CLIP_GAP);
            const anySelected = clips.slice(i, j).some((c, k) => selEvents.has(clipKey(row.track, i + k)));
            ctx.fillStyle = fill;
            roundRectPath(clampedX + CLIP_GAP / 2, boxY, runW, boxH, CLIP_RADIUS);
            ctx.fill();
            if (anySelected) {
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 1.5;
              roundRectPath(clampedX + CLIP_GAP / 2 + 1.5, boxY + 1.5, Math.max(1, runW - 3), Math.max(1, boxH - 3), Math.max(0, CLIP_RADIUS - 1));
              ctx.stroke();
            }
            clips.slice(i, j).forEach((c, k) =>
              hitRects.push({
                key: clipKey(row.track, i + k),
                kind: 'events',
                trackId: row.track.id,
                index: i + k,
                x: clampedX + CLIP_GAP / 2,
                y: boxY,
                w: runW,
                h: boxH,
              }),
            );
          }
          i = j;
          continue;
        }

        // 大事件：正常渲染（含 1px 间隔、文字、趋势线）
        // 注意：事件可能有一部分在视野左侧（横向滚动后很常见），此时矩形宽度必须
        // 用「真实可见区间」算，否则会用原始宽度画出去，与后面的事件重叠。
        const endX = b2x(nextEndBeat(clip));
        if (cx0 > width || endX < -CLIP_MARGIN) {
          i++;
          continue;
        }
        const x = Math.max(-CLIP_MARGIN, cx0);
        const xEnd = Math.min(endX, width + CLIP_MARGIN);
        const w = xEnd - x;
        if (w <= 0) {
          i++;
          continue;
        }
        const uw = Math.max(1, w - CLIP_GAP);
        const clipKeyStr = clipKey(row.track, i);
        ctx.fillStyle = fill;
        roundRectPath(x + CLIP_GAP / 2, boxY, uw, boxH, CLIP_RADIUS);
        ctx.fill();
        // 选中：内边缘高亮框（贴着事件块内侧画一圈）
        if (selEvents.has(clipKeyStr)) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          roundRectPath(x + CLIP_GAP / 2 + 1.5, boxY + 1.5, Math.max(1, uw - 3), Math.max(1, boxH - 3), Math.max(0, CLIP_RADIUS - 1));
          ctx.stroke();
        }
        hitRects.push({
          key: clipKeyStr,
          kind: 'events',
          trackId: row.track.id,
          index: i,
          x: x + CLIP_GAP / 2,
          y: boxY,
          w: uw,
          h: boxH,
        });
        if (clip.v0 !== undefined) {
          // 趋势线只画可见的那一段（u0..u1 是可见区间在事件内的归一化位置）
          const u0 = rawW > 1e-9 ? (x - cx0) / rawW : 0;
          const u1 = rawW > 1e-9 ? (x + w - cx0) / rawW : 1;
          const trendTop = boxY + 20; // 上面留给文字标注
          const trendH = Math.max(6, boxH - 26);
          drawTrend(clip, x + CLIP_GAP / 2, trendTop, uw, trendH, range, light, u0, u1, cx0, rawW);
        }
        // 文案分两级：够宽才写全（起止值 + 时长 + 缓动），稍窄只写起止值，再窄就不写（避免挤成一团）
        if (w >= LABEL_SHORT_PX) {
          const full = clip.text ?? '';
          const short = full.split(',')[0];
          const text = w >= LABEL_FULL_PX ? full : short;
          const maxChars = Math.floor((w - 10) / 6.1);
          if (maxChars >= 4) {
            ctx.fillStyle = '#f2f2f2';
            // 文字标注靠上显示
            ctx.fillText(text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text, x + 6, rowTop + 13);
          }
        }
        i++;
      }
    }
    ctx.restore();

    if (!tracks.length) {
      ctx.fillStyle = '#6d6d6d';
      ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('还没有轨道：在左下「结构树」里双击「事件层」可整组导入（导入后绑定）', 12, RULER_H + 22);
    }

    // ── 框选矩形 ──
    if (boxSel) {
      const bx = Math.min(boxSel.x0, boxSel.x1);
      const by = Math.min(boxSel.y0, boxSel.y1);
      const bw = Math.abs(boxSel.x1 - boxSel.x0);
      const bh = Math.abs(boxSel.y1 - boxSel.y0);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    }

    // ── 指针 ──
    const px = Math.round(b2x(timeToBeat(time))) + 0.5;
    if (px >= -1 && px <= width + 1) {
      ctx.strokeStyle = '#ff5f5f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.fillStyle = '#ff5f5f';
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 11);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** 按横坐标定位指针（吸附开启时只能落在刻度线上） */
  function seekFromX(x) {
    if (!axis) return;
    const beat = snapEnabled ? snapBeat(x2b(x)) : x2b(x);
    const t = Math.max(0, axis.toSec(beat));
    setTime(t);
    currentSeek?.(t);
  }

  function seekFromEvent(e) {
    if (!body || !axis) return;
    const rect = body.getBoundingClientRect?.() ?? { left: 0 };
    seekFromX((e.clientX ?? 0) - (rect.left ?? 0));
  }

  /**
   * 贴边自动滚动：指针拖到左/右端后继续拖，时间轴会跟着往那个方向滚，
   * 指针同时继续按当前横坐标定位（所以指针会一直停在边缘处）。
   */
  function updateEdgeScroll(x) {
    if (!body || x == null) return;
    const dir = x < EDGE_PX ? -1 : x > width - EDGE_PX ? 1 : 0;
    edgeDir = dir;
    if (!dir) {
      if (edgeRaf) {
        cancelRaf(edgeRaf);
        edgeRaf = 0;
      }
      return;
    }
    if (edgeRaf) return;
    const step = () => {
      if (!edgeDir) {
        edgeRaf = 0;
        return;
      }
      const before = scrollBeat;
      setScroll(scrollBeat + (edgeDir * width * 0.06) / pxPerBeat, true);
      if (lastPointerX != null) seekFromX(lastPointerX);
      // 已经滚到头就不再空转
      if (Math.abs(scrollBeat - before) < 1e-9) {
        edgeRaf = 0;
        return;
      }
      edgeRaf = raf(step);
    };
    edgeRaf = raf(step);
  }

  /**
   * 移动工具的贴边自动滚动：鼠标进入时间轴四边 AUTO_PAD 像素内就朝那个方向滚，
   * 速度按「离边多近」渐进（1 → 13 px/帧），松手/移开立刻停。
   */
  function updateAutoScroll(x, y) {
    if (!body || x == null || y == null) return;
    const ramp = (dist) => {
      if (dist > AUTO_PAD) return 0;
      const k = 1 - Math.max(0, dist) / AUTO_PAD;
      return AUTO_MIN_PX + (AUTO_MAX_PX - AUTO_MIN_PX) * k * k;
    };
    autoDx = x < AUTO_PAD ? -ramp(x) : x > width - AUTO_PAD ? ramp(width - x) : 0;
    autoDy = y < AUTO_PAD ? -ramp(y) : y > height - AUTO_PAD ? ramp(height - y) : 0;
    if (!autoDx && !autoDy) {
      stopAutoScroll();
      return;
    }
    if (autoRaf) return;
    const step = () => {
      if (!autoDx && !autoDy) {
        autoRaf = 0;
        return;
      }
      // 容器尺寸可能量不到（无头/桩件环境）：量不到就不限制边界
      const maxLeft = Number.isFinite(spacer?.offsetWidth) ? Math.max(0, spacer.offsetWidth - width) : Infinity;
      const maxTop = Number.isFinite(spacer?.offsetHeight) ? Math.max(0, spacer.offsetHeight - height) : Infinity;
      const left = Math.min(maxLeft, Math.max(0, (body.scrollLeft ?? 0) + autoDx));
      const top = Math.min(maxTop, Math.max(0, (body.scrollTop ?? 0) + autoDy));
      if (left === (body.scrollLeft ?? 0) && top === (body.scrollTop ?? 0)) {
        autoRaf = 0; // 滚到头了，别空转
        return;
      }
      body.scrollLeft = left;
      body.scrollTop = top;
      syncFromScroll();
      autoRaf = raf(step);
    };
    autoRaf = raf(step);
  }

  function stopAutoScroll() {
    autoDx = 0;
    autoDy = 0;
    if (autoRaf) {
      cancelRaf(autoRaf);
      autoRaf = 0;
    }
  }

  function stopEdgeScroll() {
    edgeDir = 0;
    stopAutoScroll();
    lastPointerX = null;
    if (edgeRaf) {
      cancelRaf(edgeRaf);
      edgeRaf = 0;
    }
  }

  const clipKey = (track, index) => `${track.id}#${index}`;

  /** 命中测试：返回指针下最上层的可选中对象 */
  function hitTest(x, y) {
    for (let i = hitRects.length - 1; i >= 0; i--) {
      const r = hitRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  const isSelected = (r) => (r.kind === 'notes' ? selNotes.has(r.key) : selEvents.has(r.key));

  function selectionCount() {
    return selEvents.size + selNotes.size;
  }

  function notifySelection() {
    onSelectionChange?.({ events: [...selEvents], notes: [...selNotes], count: selectionCount() });
  }

  function clearSelection() {
    selEvents.clear();
    selNotes.clear();
    notifySelection();
  }

  function selectOnly(r) {
    clearSelection();
    (r.kind === 'notes' ? selNotes : selEvents).add(r.key);
    notifySelection();
  }

  function toggleSelection(r) {
    const set = r.kind === 'notes' ? selNotes : selEvents;
    if (set.has(r.key)) set.delete(r.key);
    else set.add(r.key);
    notifySelection();
  }

  /** 找到 key 对应的 clip 对象 */
  function findClip(trackId, index) {
    const track = tracks.find((t) => t.id === trackId);
    return track ? { track, clip: track.clips[index] } : null;
  }

  /** 框选：选中与矩形相交的所有事件/音符 */
  function selectInBox(box) {
    const x0 = Math.min(box.x0, box.x1);
    const x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1);
    const y1 = Math.max(box.y0, box.y1);
    let hit = 0;
    for (const r of hitRects) {
      if (r.x + r.w < x0 || r.x > x1 || r.y + r.h < y0 || r.y > y1) continue;
      (r.kind === 'notes' ? selNotes : selEvents).add(r.key);
      hit++;
    }
    notifySelection();
    return hit;
  }

  // ── 鼠标工具：拖动选中的对象 ──
  function startClipDrag(x, y) {
    const origin = new Map();
    for (const r of hitRects) {
      if (!isSelected(r)) continue;
      const found = findClip(r.trackId, r.index);
      if (!found?.clip) continue;
      origin.set(r.key, {
        kind: r.kind,
        trackId: r.trackId,
        index: r.index,
        b0: found.clip.b0,
        b1: found.clip.b1,
        positionX: found.clip.positionX,
      });
    }
    dragSel = origin.size ? { x, y, dBeat: 0, dPosX: 0, origin, moved: false } : null;
  }

  function updateClipDrag(x, y) {
    if (!dragSel) return false;
    let dBeat = x2b(x) - x2b(dragSel.x);
    if (snapEnabled) dBeat = snapBeat(dBeat);
    for (const o of dragSel.origin.values()) {
      const found = findClip(o.trackId, o.index);
      if (!found?.clip) continue;
      const len = o.b1 - o.b0;
      const b0 = Math.max(0, o.b0 + dBeat);
      found.clip.b0 = b0;
      found.clip.b1 = b0 + len;
      if (o.kind === 'notes' && Number.isFinite(o.positionX)) {
        const track = found.track;
        const pad = 10;
        const usable = Math.max(4, (Number.isFinite(track.rowHeight) ? track.rowHeight : 42) - pad * 2);
        const xr = track.xRange ?? { min: -FALLBACK_X_RANGE, max: FALLBACK_X_RANGE };
        const span = Math.max(1e-6, xr.max - xr.min);
        let nextX = o.positionX + (dragSel.y - y) * (span / usable); // 往上拖 → positionX 变大
        if (posSnap) nextX = snapPositionXValue(nextX, xr);
        found.clip.positionX = Math.min(xr.max, Math.max(xr.min, nextX));
      }
    }
    dragSel.dBeat = dBeat;
    dragSel.moved = true;
    redraw();
    return true;
  }

  /**
   * 把 positionX 吸附到最近的横向刻度线。
   * 必须是本地函数：拖动逻辑在返回对象的 API 定义之前就要用到它
   * （之前误写成调用 API 上的 snapPositionX，导致开启横向吸附后一拖就抛 ReferenceError）。
   */
  function snapPositionXValue(x, range) {
    if (!posSnap) return x;
    const xr =
      range ?? tracks.find((t) => t.kind === 'notes')?.xRange ?? { min: -FALLBACK_X_RANGE, max: FALLBACK_X_RANGE };
    const lines = Number.isFinite(posLines) && posLines >= 2 ? Math.round(posLines) : DEFAULT_POS_LINES;
    const span = Math.max(1e-9, xr.max - xr.min);
    const k = Math.round(((x - xr.min) / span) * (lines - 1));
    return xr.min + (span * Math.min(lines - 1, Math.max(0, k))) / (lines - 1);
  }

  /** 按当前刻度密度取整（吸附用） */
  function snapBeat(beat) {
    const div = TICK_DIVISORS.includes(tickDiv) ? tickDiv : 4;
    return Math.round(beat * div) / div;
  }

  if (body) {
    // 刻度尺上按下 = 拖动指针；轨道区按下 = 鼠标工具（选择 / 框选 / 拖动）
    const localPos = (e) => {
      const rect = body.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      return { x: (e.clientX ?? 0) - (rect.left ?? 0), y: (e.clientY ?? 0) - (rect.top ?? 0) };
    };
    const inGutter = (p) => p.x > (body.clientWidth ?? width) || p.y > (body.clientHeight ?? height);

    body.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const p = localPos(e);
      if (inGutter(p)) return; // 点在滚动条上：交给原生滚动条
      try {
        body.setPointerCapture?.(e.pointerId); // 合成事件/失效指针会抛 InvalidPointerId，不能因此中断拖动
      } catch {
        /* 忽略 */
      }

      if (p.y < RULER_H) {
        // 刻度尺：拖动指针（并支持贴边自动滚动）
        interactionState.rulerDrag = true;
        lastPointerX = p.x;
        seekFromX(p.x);
        updateEdgeScroll(p.x);
        return;
      }
      if (tool === 'pan') {
        // 触屏：不接管，交给浏览器原生的单指滚动（touch-action: pan-x pan-y）
        if (e.pointerType === 'touch') return;
        panDrag = { x: p.x, y: p.y, left: body.scrollLeft ?? 0, top: body.scrollTop ?? 0 };
        interactionState.panning = true;
        body.classList?.add('panning');
        stopEdgeScroll();
        return;
      }
      if (tool !== 'mouse') return;

      const hit = hitTest(p.x, p.y);
      if (hit) {
        const already = isSelected(hit);
        if (e.ctrlKey || e.metaKey) toggleSelection(hit);
        else if (!already) selectOnly(hit);
        // 命中已选中对象（或刚选中）→ 开始拖动
        startClipDrag(p.x, p.y);
      } else {
        if (!e.ctrlKey && !e.metaKey) clearSelection();
        boxSel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      redraw();
    });

    body.addEventListener('pointermove', (e) => {
      const p = localPos(e);
      if (panDrag) {
        body.scrollLeft = Math.max(0, panDrag.left - (p.x - panDrag.x));
        body.scrollTop = Math.max(0, panDrag.top - (p.y - panDrag.y));
        syncFromScroll(); // 拖滚动容器 → 同步内部状态并重绘
        return;
      }
      if (tool === 'pan') {
        // 移动工具：鼠标靠近边缘就自动滚动（不按下也能滚，幅度随距离渐进）
        updateAutoScroll(p.x, p.y);
        return;
      }
      if (interactionState.rulerDrag) {
        lastPointerX = p.x;
        seekFromX(p.x);
        updateEdgeScroll(p.x);
        return;
      }
      if (dragSel) {
        updateClipDrag(p.x, p.y);
        return;
      }
      if (boxSel) {
        boxSel.x1 = p.x;
        boxSel.y1 = p.y;
        redraw();
        return;
      }
      // 悬停光标提示
      if (tool === 'pan') {
        body.style.cursor = '';
        return;
      }
      if (tool === 'mouse' && !inGutter(p) && p.y >= RULER_H) {
        const hover = hitTest(p.x, p.y);
        body.style.cursor = hover ? 'move' : 'crosshair';
      }
    });

    const stop = () => {
      if (panDrag) {
        panDrag = null;
        interactionState.panning = false;
        body.classList?.remove('panning');
        stopEdgeScroll();
        return;
      }
      if (interactionState.rulerDrag) {
        interactionState.rulerDrag = false;
        stopEdgeScroll();
        return;
      }
      if (boxSel) {
        const box = boxSel;
        boxSel = null;
        const hit = selectInBox(box);
        onStatusCb?.(hit ? `框选：选中 ${hit} 个对象` : '框选：没有选中对象');
        redraw();
      }
      if (dragSel) {
        const moved = dragSel.moved;
        const dBeat = dragSel.dBeat;
        dragSel = null;
        if (moved) {
          onStatusCb?.(
            `已移动 ${selectionCount()} 个对象：时间 ${dBeat >= 0 ? '+' : ''}${dBeat.toFixed(4)} 拍（改动先落在时间轴上，写回谱面在后续阶段）`,
          );
          redraw();
          onClipsChanged?.(); // 让左上「Note 详情 / Event 详情」立即刷新
        }
      }
    };
    body.addEventListener('pointerup', stop);
    body.addEventListener('pointercancel', stop);

    // 原生滚动条：拖动/滚动后同步到内部状态
    body.addEventListener('scroll', syncFromScroll);
    body.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // 手势（Ctrl+滚轮 与 直接滚轮 的作用已按需求对调）：
        //   直接滚轮 / Shift+滚轮 / 双指横滑 → 横向滚动时间轴
        //   Ctrl + 滚轮                     → 纵向滚动轨道
        //   Ctrl + Alt + 滚轮 / 触控板捏合   → 缩放
        // 捏合也被浏览器报成 ctrlKey + wheel，但它是「短时间内连续且很小的 delta」，
        // 用这一点把它和 Ctrl+滚轮区分开（否则 Ctrl+滚轮会被误判成捏合）。
        const ctrlOnly = (e.ctrlKey || e.metaKey) && !e.altKey;
        const t = Number.isFinite(e.timeStamp) ? e.timeStamp : Date.now();
        const tiny = Math.abs(e.deltaY) < 3;
        const looksLikePinch = ctrlOnly && tiny && t - lastTinyCtrlWheelAt < 120;
        if (ctrlOnly && tiny) lastTinyCtrlWheelAt = t;
        if (looksLikePinch || ((e.ctrlKey || e.metaKey) && e.altKey)) {
          const rect = body.getBoundingClientRect?.() ?? { left: 0 };
          const anchor = x2b((e.clientX ?? 0) - (rect.left ?? 0));
          setZoom(pxPerBeat * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), anchor);
          return;
        }
        // 纵向滚动：Ctrl + 滚轮
        if (ctrlOnly) {
          if (body) {
            body.scrollTop = Math.max(0, (body.scrollTop ?? 0) + e.deltaY);
            syncFromScroll();
          }
          return;
        }
        // 横向滚动：直接滚轮 / Shift+滚轮 / 触控板双指横滑
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setScroll(scrollBeat + delta / pxPerBeat, true); // 用户主动滚动 → 取消播放跟随
      },
      { passive: false },
    );
  }
  heads?.addEventListener('scroll', redraw);

  function setTime(t) {
    time = Math.max(0, t);
    lastPlayheadPx = Math.round(b2x(timeToBeat(time))); // 记录指针像素位置，供 syncTime 去重
    redraw();
  }

  function setZoom(px, anchorBeat) {
    const next = clamp(px, minZoom(), ZOOM_MAX); // 限制缩放范围（性能 + 同屏最多 32 拍）
    const anchor = anchorBeat ?? x2b(width / 2);
    const ratio = next / pxPerBeat;
    pxPerBeat = next;
    scrollBeat = Math.max(0, anchor - (anchor - scrollBeat) * ratio);
    updateSpacer();
    if (body) body.scrollLeft = scrollBeat * pxPerBeat;
    redraw();
    return pxPerBeat;
  }

  function setScroll(beat, userInitiated = false) {
    const b = Math.max(0, beat);
    if (body) body.scrollLeft = b * pxPerBeat; // 交给滚动容器（横向滚动条随之移动）
    scrollBeat = b;
    if (userInitiated) following = false; // 用户自己滚动了 → 取消跟随
    redraw();
    return scrollBeat;
  }

  /** 纵向滚动（像素） */
  function setVerticalScroll(px) {
    if (!body) return scrollTopPx;
    body.scrollTop = Math.max(0, px);
    syncFromScroll();
    return scrollTopPx;
  }

  /** 让某个拍号进入视野（键入跳转、快捷键跳转都调用它） */
  function ensureBeatVisible(beat, { center = true } = {}) {
    if (!width) return scrollBeat;
    const visible = width / pxPerBeat;
    const target = center ? beat - visible / 2 : beat - visible * 0.15;
    setScroll(Math.max(0, target));
    return scrollBeat;
  }

  /** 初始/快速缩放：让「n 拍」正好占满可见宽度 */
  function setVisibleBeats(n, atBeat = 0) {
    const beats = Math.max(0.25, Math.min(MAX_VISIBLE_BEATS, n));
    pxPerBeat = clamp(width / beats, minZoom(), ZOOM_MAX);
    updateSpacer();
    scrollBeat = 0;
    if (body) body.scrollLeft = 0;
    setScroll(atBeat * pxPerBeat, false);
    redraw();
    return pxPerBeat;
  }

  function fit() {
    const total = Math.max(1, axis?.totalBeats ?? 1);
    pxPerBeat = clamp((width - 8) / total, minZoom(), ZOOM_MAX);
    updateSpacer();
    setScroll(0);
    return pxPerBeat;
  }

  /** 载入谱面后的初始视图：约 4 拍可见 */
  function resetView() {
    setVisibleBeats(INITIAL_VISIBLE_BEATS, 0);
    return { pxPerBeat, visibleBeats: width / pxPerBeat };
  }

  if (globalThis.ResizeObserver && body) new ResizeObserver(() => resize()).observe(body);
  globalThis.addEventListener?.('resize', () => resize());

  return {
    resize,
    redraw,
    renderHeads,
    setChart(nextChart, nextAxis) {
      chart = nextChart;
      axis = nextAxis ?? null;
      scrollBeat = 0;
      resize();
    },
    setTracks(next) {
      tracks = next;
      selectedId = null;
      renderHeads();
      updateSpacer();
      scrollTopPx = Math.min(scrollTopPx, Math.max(0, RULER_H + layoutHeight - height));
      if (body) body.scrollTop = scrollTopPx;
      redraw();
    },
    addTrack(track) {
      if (tracks.some((t) => t.id === track.id)) return false;
      tracks = [...tracks, track];
      renderHeads();
      redraw();
      onTracksChanged?.(tracks);
      return true;
    },
    addTracks(list) {
      const existing = new Set(tracks.map((t) => t.id));
      const added = list.filter((t) => !existing.has(t.id));
      if (added.length) {
        tracks = [...tracks, ...added];
        renderHeads();
        redraw();
        onTracksChanged?.(tracks);
      }
      return added.length;
    },
    removeTrack,
    removeGroup,
    clear() {
      tracks = [];
      selectedId = null;
      renderHeads();
      redraw();
      onTracksChanged?.(tracks);
    },
    get tracks() {
      return tracks;
    },
    /** 当前工具：'mouse' 点选/框选/拖拽 | 'pan' 平移 */
    get tool() {
      return tool;
    },
    setTool(name) {
      const next = name === 'pan' ? 'pan' : 'mouse';
      if (next === tool) return tool;
      tool = next;
      stopAutoScroll();
      if (body) {
        body.style.cursor = '';
        // .tool-pan 决定触屏行为：鼠标工具 = touch-action:none（锁滚动，交给框选/拖拽）
        body.classList?.toggle('tool-pan', tool === 'pan');
      }
      return tool;
    },
    /** 选择状态：{events, notes, count} */
    get selection() {
      return { events: [...selEvents], notes: [...selNotes], count: selectionCount() };
    },
    get selectedCount() {
      return selectionCount();
    },
    /** 每帧绘制时记录的可命中区域（供调试/测试用） */
    get hitRects() {
      return hitRects;
    },
    /** 当前交互状态（调试/测试用） */
    /** 性能诊断：重绘次数等 */
    get stats() {
      return { redraws: redrawCount, tracks: tracks.length };
    },
    get interaction() {
      return { tool, panning: interactionState.panning, rulerDrag: interactionState.rulerDrag, dragging: !!dragSel, boxing: !!boxSel, selected: selectionCount() };
    },
    clearSelection,
    /** 按 key（trackId#index）直接设置选中的音符（测试/全选用） */
    selectNotes(keys) {
      selNotes.clear();
      for (const k of keys) selNotes.add(k);
      notifySelection();
      redraw();
      return selNotes.size;
    },
    /** 按 key 直接设置选中的事件（测试/批量操作用） */
    selectEvents(keys) {
      selEvents.clear();
      for (const k of keys) selEvents.add(k);
      notifySelection();
      redraw();
      return selEvents.size;
    },
    /** 选中某条音符轨上的全部音符 */
    selectAllNotesInTrack(trackId) {
      selNotes.clear();
      for (const r of hitRects) if (r.kind === 'notes' && r.trackId === trackId) selNotes.add(r.key);
      notifySelection();
      redraw();
      return selNotes.size;
    },
    /** 传入音符贴图（{tap,drag,hold,flick}：HTMLImageElement） */
    setNoteSprites(sprites) {
      noteSprites = sprites ?? null;
      redraw();
      return noteSprites;
    },
    get pxPerBeat() {
      return pxPerBeat;
    },
    get scrollBeat() {
      return scrollBeat;
    },
    /** 当前指针所在的拍 */
    get currentBeat() {
      return timeToBeat(time);
    },
    /** 按拍跳转（吸附开启时按刻度取整） */
    seekToBeat(beat) {
      const b = snapEnabled ? snapBeat(beat) : beat;
      setTime(Math.max(0, axis ? axis.toSec(b) : b));
      currentSeek?.(time);
      return time;
    },
    get snap() {
      return snapEnabled;
    },
    /** 横向（positionX）刻度吸附 */
    get posSnap() {
      return posSnap;
    },
    setPosSnap(on) {
      posSnap = !!on;
      redraw();
      return posSnap;
    },
    /** 把 positionX 吸附到最近的横向刻度线（对外 API，复用本地实现） */
    snapPositionX(x, range) {
      return snapPositionXValue(x, range);
    },
    /** 横向刻度线数量（全局；所有音符轨共用） */
    get posLines() {
      return posLines;
    },
    setPosLines(count) {
      if (!POS_LINE_OPTIONS.includes(Number(count))) return false;
      posLines = Number(count);
      redraw();
      return true;
    },
    setSnap(on) {
      snapEnabled = !!on;
      return snapEnabled;
    },
    get rowHeight() {
      return ROW_H;
    },
    get layoutHeight() {
      return layoutHeight;
    },
    get tickDiv() {
      return tickDiv;
    },
    setTickDiv(n) {
      tickDiv = TICK_DIVISORS.includes(Number(n)) ? Number(n) : DEFAULT_TICK_DIV;
      redraw();
      return tickDiv;
    },
    setZoom,
    setScroll,
    setVerticalScroll,
    ensureBeatVisible,
    setVisibleBeats,
    resetView,
    fit,
    get scrollTop() {
      return scrollTopPx;
    },
    get visibleBeats() {
      return width && pxPerBeat ? width / pxPerBeat : 0;
    },
    setTime,
    get time() {
      return time;
    },
    /**
     * 播放时同步指针。follow = true 时：
     *  - 指针进入可见范围后开始「跟随」，随后一直随播放滚动（把指针保持在左侧 15% 处）
     *  - 用户自己横向滚动（滚轮/触控板/滚动条）会立即取消跟随，不再强行拉回
     */
    syncTime(t, follow = false) {
      // 播放时每帧都会走到这里：如果指针的像素位置没变，就没必要重绘整个时间轴
      const px = Math.round(b2x(timeToBeat(t)));
      if (px === lastPlayheadPx && !follow) {
        time = Math.max(0, t);
        return;
      }
      lastPlayheadPx = px;
      setTime(t);
      if (!follow || !width) return;
      const x = b2x(timeToBeat(time));
      if (!following) {
        if (x >= 0 && x <= width) following = true; // 指针在可见范围内 → 开始跟随
        else return;
      }
      if (x > width * 0.85 || x < 0) setScroll(scrollBeat + (x - width * 0.15) / pxPerBeat);
    },
    get following() {
      return following;
    },
    setFollowing(on) {
      following = !!on;
      return following;
    },
    onSeek(fn) {
      currentSeek = fn;
    },
    moveTracks,
    rulerHeight: RULER_H,
  };
}
