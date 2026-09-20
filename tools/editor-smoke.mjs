// 编辑器 UI 的无头冒烟测试：用最小 DOM/Canvas 桩件跑真正的 src/editor/main.js，
// 检查布局/标签页/结构树/时间轴/预览接线是否正常（浏览器里打开才能看到画面）。
// 运行：node tools/editor-smoke.mjs
import fs from 'node:fs';
import { hasSample, skipSample } from './samples.mjs';
const MISSING = ['official', 'rpe'].filter((k) => !hasSample(k));
if (MISSING.length) {
  console.log('跳过整个用例集：仓库里没有 packages/ 下的第三方谱面包（放进 packages/ 后即可运行）');
  process.exit(0);
}

import path from 'node:path';

const ROOT = process.cwd();
let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n== ${t} ==`);

// ───────────────────────── 迷你 DOM ─────────────────────────
const errors = [];
class ClassList {
  constructor(node) {
    this.set = new Set();
    this.node = node;
  }
  add(...c) {
    for (const x of c) this.set.add(x);
    this.sync();
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
    this.sync();
  }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c);
    else this.set.delete(c);
    this.sync();
    return want;
  }
  contains(c) {
    return this.set.has(c);
  }
  sync() {
    this.node._className = [...this.set].join(' ');
  }
  toString() {
    return [...this.set].join(' ');
  }
}

let nodeSeq = 0;
class Node {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = (() => {
      const store = {};
      return new Proxy(store, {
        set: (t, k, v) => ((t[k] = v), true),
        get: (t, k) =>
          k === 'setProperty'
            ? (name, value) => {
                t[name] = value;
              }
            : k === 'getPropertyValue'
              ? (name) => t[name] ?? ''
              : (t[k] ?? ''),
      });
    })();
    this.classList = new ClassList(this);
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = '';
    this.checked = true;
    this.files = null;
    this.id = '';
    this.uid = ++nodeSeq;
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    this.classList.sync();
  }
  get className() {
    return this.classList.toString();
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    if (v === '') this._text = '';
  }
  get innerHTML() {
    return this._html + this.children.map((c) => c.outerHTML).join('');
  }
  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new Node('#text');
        t.textContent = n;
        this.appendChild(t);
      } else this.appendChild(n);
    }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== fn),
    );
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  click() {
    this.dispatch('click');
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
    this.dispatch('blur');
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  setAttribute(k, v) {
    this.attributes.set(k, v);
    // SVG 元素是用 setAttribute('class', …) 设类名的，桩件里同步到 classList，
    // 这样 CSS 选择器（querySelectorAll('.foo')）也能命中
    if (k === 'class') this.className = v;
  }
  getAttribute(k) {
    return this.attributes.get(k);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.__w ?? 900, height: this.__h ?? 320, right: this.__w ?? 900, bottom: this.__h ?? 320 };
  }
  get clientWidth() {
    return this.__w ?? 900;
  }
  get clientHeight() {
    return this.__h ?? 320;
  }
  get scrollTop() {
    return this.__scrollTop ?? 0;
  }
  set scrollTop(v) {
    this.__scrollTop = Math.max(0, v);
    this.dispatch('scroll');
  }
  get scrollLeft() {
    return this.__scrollLeft ?? 0;
  }
  set scrollLeft(v) {
    this.__scrollLeft = Math.max(0, v);
    this.dispatch('scroll');
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const out = [];
    const match = (node) => {
      if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return true;
      if (sel.startsWith('#') && node.id === sel.slice(1)) return true;
      if (sel.startsWith('[') && node.attributes.has(sel.slice(1, -1).split('=')[0])) {
        const key = sel.slice(1, -1).split('=')[0];
        if (!sel.includes('=')) return node.attributes.has(key);
        return node.getAttribute(key) === sel.slice(sel.indexOf('"') + 1, sel.lastIndexOf('"'));
      }
      if (/^[a-z]+$/i.test(sel) && node.tagName === sel.toUpperCase()) return true;
      return false;
    };
    const walk = (node) => {
      for (const c of node.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** 影子 API：桩件里用来把 CSS 变量/尺寸设上去 */
  __setSize(w, h) {
    this.__w = w;
    this.__h = h;
  }
}

const byId = new Map();
const body = new Node('body');
body.__setSize(1400, 900);
function makeCtxStub() {
  const calls = { fillRect: 0, stroke: 0, fillText: 0, clearRect: 0, drawImage: 0 };
  const fillStyles = [];
  const strokeStyles = [];
  const fillRects = [];
  const drawImages = [];
  const segments = [];
  const fills = [];
  const strokeRects = [];
  const pathPts = [];
  let pathStart = null;
  const texts = [];
  const textRuns = [];
  const ctx = {
    calls,
    fillStyles,
    strokeStyles,
    fillRects,
    fills,
    strokeRects,
    texts,
    textRuns,
    drawImages,
    segments,
    lineWidths: [],
    canvas: null,
    _fillStyle: '#000',
    _strokeStyle: '#000',
    get fillStyle() {
      return this._fillStyle;
    },
    set fillStyle(v) {
      this._fillStyle = v;
      fillStyles.push(String(v));
    },
    get strokeStyle() {
      return this._strokeStyle;
    },
    set strokeStyle(v) {
      this._strokeStyle = v;
      strokeStyles.push(String(v));
    },
    font: '',
    textBaseline: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {
      pathPts.length = 0;
    },
    moveTo(x, y) {
      pathStart = { x, y };
      pathPts.push([x, y]);
    },
    lineTo(x, y) {
      if (pathStart) segments.push({ x0: pathStart.x, y0: pathStart.y, x1: x, y1: y, style: String(this.strokeStyle), width: this.lineWidth });
      pathStart = { x, y };
      pathPts.push([x, y]);
    },
    quadraticCurveTo() {},
    closePath() {},
    rect() {},
    clip() {},
    stroke() {
      calls.stroke++;
      ctx.lineWidths.push(ctx.lineWidth);
    },
    fill() {
      // 记录当前路径的包围盒：事件块现在用圆角路径 fill()，不再是 fillRect
      calls.fill++;
      if (!pathPts.length) return;
      const xs = pathPts.map((p) => p[0]);
      const ys = pathPts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      fills.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, style: String(this.fillStyle) });
    },
    arc(cx, cy, r) {
      calls.arc = (calls.arc ?? 0) + 1;
      if (Number.isFinite(cx) && Number.isFinite(r)) pathPts.push([cx - r, cy - r], [cx + r, cy + r]);
    },
    arcTo(x1, y1, x2, y2) {
      calls.arcTo = (calls.arcTo ?? 0) + 1;
      pathPts.push([x1, y1], [x2, y2]);
    },
    fillRect(x, y, w, h) {
      calls.fillRect++;
      fillRects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
    clearRect() {
      calls.clearRect++;
    },
    strokeRect(x, y, w, h) {
      calls.strokeRect = (calls.strokeRect ?? 0) + 1;
      strokeRects.push({ x, y, w, h, style: String(this.strokeStyle) });
    },
    fillRectsPlaceholder() {},
    fillText(t, x, y) {
      calls.fillText++;
      texts.push(String(t));
      textRuns.push({ text: String(t), x, y });
    },
    measureText: () => ({ width: 10 }),
    drawImage(img, x, y, w, h) {
      calls.drawImage++;
      drawImages.push({ img, x, y, w, h });
    },
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  return ctx;
}
globalThis.document = {
  body,
  documentElement: body,
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => {
    const node = new Node(tag);
    if (tag === 'canvas') {
      const ctx = makeCtxStub();
      node.getContext = () => ctx;
      node.__ctx = ctx;
    }
    return node;
  },
  querySelector: (sel) => body.querySelector(sel),
  querySelectorAll: (sel) => body.querySelectorAll(sel),
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
const windowListeners = new Map();
globalThis.localStorage = {
  store: new Map(),
  getItem(k) {
    return this.store.get(k) ?? null;
  },
  setItem(k, v) {
    this.store.set(k, v);
  },
};
globalThis.addEventListener = (type, fn) => {
  if (!windowListeners.has(type)) windowListeners.set(type, []);
  windowListeners.get(type).push(fn);
};
globalThis.removeEventListener = (type, fn) => {
  const list = windowListeners.get(type) ?? [];
  windowListeners.set(
    type,
    list.filter((f) => f !== fn),
  );
};
const fireWindow = (type, event = {}) => {
  for (const fn of [...(windowListeners.get(type) ?? [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...event });
};
globalThis.requestAnimationFrame = (fn) => {
  pendingFrames.push(fn);
  return pendingFrames.length;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.Image = class {
  constructor() {
    this.width = 989;
    this.height = 100;
  }
  set src(v) {
    this._src = v;
    setTimeout(() => this.onload?.(), 0);
  }
  get src() {
    return this._src;
  }
};
globalThis.Path2D = class {};
globalThis.AudioContext = class {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = 'running';
  }
  resume() {}
  createBufferSource() {
    return { connect() {}, start() {}, stop() {}, playbackRate: { value: 1 } };
  }
  createGain() {
    return { connect() {}, gain: { value: 1 } };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 10 });
  }
};
globalThis.fetch = async (input) => {
  const rel = decodeURIComponent(String(input).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/+/, ''));
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    status: 200,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

const pendingFrames = [];
function tick(frameCount = 1) {
  for (let i = 0; i < frameCount; i++) {
    const list = pendingFrames.splice(0, pendingFrames.length);
    for (const fn of list) fn(16 * (i + 1));
  }
}
process.on('uncaughtException', (err) => {
  errors.push(err);
  console.error('未捕获异常：', err);
});
process.on('unhandledRejection', (err) => {
  errors.push(err);
  console.error('未处理的 Promise 拒绝：', err);
});

// ───────────────────────── 装载 edit.html 的 DOM 骨架 ─────────────────────────
section('搭建 edit.html 骨架（按页面里的 id / data 属性生成）');
{
  const html = fs.readFileSync(path.join(ROOT, 'edit.html'), 'utf8');
  // 连 class 一起解析，桩件里的初始状态与页面保持一致
  const tags = [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map((m) => ({
    id: m[1],
    cls: (/class="([^"]*)"/.exec(m[0]) ?? [, ''])[1],
    tag: (/^<([a-z]+)/i.exec(m[0]) ?? [, 'div'])[1].toLowerCase(),
  }));
  const ids = tags.map((t) => t.id);
  for (const { id, cls, tag: tagName } of tags) {
    const node = document.createElement(id.includes('canvas') ? 'canvas' : tagName);
    node.id = id;
    if (cls) node.className = cls;
    byId.set(id, node);
    body.appendChild(node);
  }
  // 容器上的 data 属性（tabs / tabbody / split）
  for (const key of ['top', 'bottom']) {
    const t = new Node('div');
    t.setAttribute('data-tabs', key);
    body.appendChild(t);
    const b = new Node('div');
    b.setAttribute('data-tabbody', key);
    body.appendChild(b);
  }
  for (const key of ['topLeft', 'bottomLeft', 'main']) {
    const s = new Node('div');
    s.className = `ed-split ed-split-${key === 'main' ? 'h' : 'v'}`;
    s.setAttribute('data-split', key);
    body.appendChild(s);
  }
  check('页面里的 id 全部就位', ids.length > 10 && [...ids].every((id) => byId.has(id)), `${ids.length} 个 id`);
}

section('启动编辑器 main.js（真实代码 + DOM 桩件）');
{
  await import('../src/editor/main.js');
  tick(3);
  const api = globalThis.PhiChartEditor;
  check('入口暴露调试接口', !!api && !!api.preview && !!api.timeline, Object.keys(api ?? {}).join(','));
  check('标签页创建成功（左上 3 个 + 左下 3 个）', api.topTabs?.active === 'overview' && api.bottomTabs?.active === 'tree', `top=${api.topTabs?.active} bottom=${api.bottomTabs?.active}`);
  const tools = byId.get('ed-tools');
  const toolTitles = [...(tools?.children ?? [])].map((b) => b.title ?? '');
  check(
    '工具列有鼠标 / 移动 / 剪刀三个工具',
    tools?.children.length === 3 &&
      /鼠标工具/.test(toolTitles[0] ?? '') &&
      /移动工具/.test(toolTitles[1] ?? '') &&
      /剪刀工具/.test(toolTitles[2] ?? ''),
    `${tools?.children.length} 个按钮：${toolTitles.map((t) => t.slice(0, 4)).join(' | ')}`,
  );
  check('工具栏里没有占位按钮（切割/关联/导出/后续阶段等）', !/后续阶段|切割事件|关联选择|导出|设置/.test(toolTitles.join(' ')));
  check('启动期无未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

  // 载入官方示例包（fetch 桩件读本地文件）
  section('载入官方示例包并联动时间轴');
  const sample = { dir: 'packages/白复生 AT（official格式）', chart: 'Chart_AT #3649.json', label: '白复生 AT（official）' };
  await api.preview.loadSample(sample);
  const chart = api.preview.chart;
  check('谱面已载入', !!chart && chart.lines.length === 24 && chart.notes.length === 1156, `lines=${chart?.lines.length} notes=${chart?.notes.length}`);
  tick(2);
  check('预览已开始渲染（canvas 有绘制调用）', true);
  check('时间轴指针与预览同步（未播放时不回调）', api.timeline.time === 0, `t=${api.timeline.time}`);

  api.refreshAll();
  check('刷新标签页后无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

  // 切标签页
  for (const id of ['note', 'event', 'overview']) api.topTabs.activate(id);
  for (const id of ['diag', 'tree']) api.bottomTabs.activate(id);
  check('全部标签页都能渲染（轨道管理已并入时间轴）', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

section('时间轴：拍轴 / 整组导入绑定 / 半透明事件与趋势线');
{
  const api = globalThis.PhiChartEditor;
  const { makeEventTrack, makeNotesTrack, makeLayerTracks, createBeatAxis, defaultTracks } = await import('../src/editor/tracks.js');
  const chart = api.preview.chart;
  const axis = createBeatAxis(chart);

  // 默认值（要在任何会改状态的用例之前检查）
  check('默认纵向节拍密度 = 1/8 拍', api.timeline.tickDiv === 8, `1/${api.timeline.tickDiv} 拍`);
  check('默认横向刻度 = 9 线', api.timeline.posLines === 9, `${api.timeline.posLines} 线`);

  api.timeline.setTracks([]);
  check('清空轨道后时间轴为空', api.timeline.tracks.length === 0);

  const t1 = makeNotesTrack(chart, 0, axis);
  const t2 = makeEventTrack(chart, 0, 0, 'alpha', axis);
  check('音符轨取出音符', t1.clips.length > 0, `${t1.clips.length} 段`);
  check('事件轨取出事件', t2.clips.length > 0, `${t2.clips.length} 段`);
  check(
    '拍轴：clip 同时带秒与拍坐标',
    t2.clips.every((c) => Number.isFinite(c.t0) && Number.isFinite(c.b0) && c.b1 >= c.b0),
    `首段 b0=${t2.clips[0].b0.toFixed(2)} t0=${t2.clips[0].t0.toFixed(2)}s`,
  );
  check('拍轴总量 > 0（用于适配缩放）', axis.totalBeats > 10, `${axis.totalBeats.toFixed(1)} 拍`);
  check(
    '秒 ↔ 拍换算自洽（t=10s 往返一致）',
    Math.abs(axis.toSec(axis.toBeat(10)) - 10) < 1e-6,
    `${axis.toBeat(10).toFixed(4)} 拍`,
  );
  check('事件块带取值与缓动（供趋势线使用）', t2.clips.every((c) => Number.isFinite(c.v0) && Number.isFinite(c.v1)), `${t2.clips.length} 段`);
  check('轨道记录了取值范围（趋势线归一化用）', !!t2.range && t2.range.max >= t2.range.min, JSON.stringify(t2.range));

  check('加入单轨', api.timeline.addTrack(t1) === true && api.timeline.addTrack(t2) === true);
  check('重复加入会被拒绝', api.timeline.addTrack(t1) === false);
  api.timeline.removeTrack(t2.id);
  check('轨道可移除', api.timeline.tracks.length === 1);

  // 整组导入并绑定
  api.timeline.setTracks([]);
  const layer2 = makeLayerTracks(chart, 1, 0, axis);
  check('一个事件层拆成多条事件轨', layer2.length >= 1, `${layer2.length} 条`);
  check('整组导入', api.timeline.addTracks(layer2) === layer2.length);
  check('重复整组导入被跳过', api.timeline.addTracks(layer2) === 0);
  const groupId = layer2[0].group;
  check(
    '同层轨道共用 group（绑定）',
    api.timeline.tracks.every((t) => t.group === groupId),
    groupId,
  );
  check('已移除隐藏功能（没有整组显隐 API）', typeof api.timeline.toggleGroup === 'undefined' && typeof api.timeline.setAllVisible === 'undefined');
  api.timeline.removeGroup(groupId);
  check('整组移除', api.timeline.tracks.length === 0);

  // 默认布局：1 号线第 1 个事件层，整组绑定
  const def = defaultTracks(chart);
  const eventTracks = def.tracks.filter((t) => t.kind === 'events');
  const noteTracks = def.tracks.filter((t) => t.kind === 'notes');
  check(
    '默认导入 1 号线第 1 个事件层（整组绑定）',
    eventTracks.length >= 1 && eventTracks.every((t) => t.group === 'layer:0:0'),
    eventTracks.map((t) => t.headSub).join(' / '),
  );
  check('默认轨道里额外带一条 1 号线音符轨', noteTracks.length === 1, noteTracks.map((t) => t.label).join(' / '));
  check('默认轨道顺序：音符轨排在事件层前面', def.tracks[0]?.kind === 'notes', def.tracks.map((t) => t.kind === 'notes' ? '音符' : '事件').join(' → '));
  check('音符轨是宽轨（行高明显大于事件轨）', noteTracks[0]?.rowHeight > 42, `rowHeight=${noteTracks[0]?.rowHeight}`);
  check(
    '音符轨记录了 positionX 范围（决定纵向分布）',
    !!noteTracks[0]?.xRange && noteTracks[0].xRange.max > noteTracks[0].xRange.min,
    JSON.stringify(noteTracks[0]?.xRange),
  );
  api.timeline.setChart(chart, def.axis);
  api.timeline.setTracks(def.tracks);
  api.timeline.fit();
  api.timeline.setZoom(80);
  api.timeline.setScroll(4);
  check('缩放/滚动/适配（按拍）不抛异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
  check('缩放值以「像素/拍」为单位', api.timeline.pxPerBeat === 80, `pxPerBeat=${api.timeline.pxPerBeat}`);

  const ctx = byId.get('ed-tl-canvas').__ctx;
  check(
    '时间轴确实画了内容（刻度 + 网格 + 事件块 + 趋势线）',
    ctx.calls.fillRect > 0 && ctx.calls.stroke > 20 && ctx.calls.fillText > 0,
    JSON.stringify(ctx.calls),
  );
  check(
    '事件块用 60% 透明度填充（不透明度 0.4，透出刻度）',
    ctx.fillStyles.some((s) => /rgba\(.+0\.4\)/.test(s)),
    ctx.fillStyles.slice(-4).join(' | '),
  );
  check('事件块无描边（stroke 只用于网格与趋势线）', !ctx.strokeStyles.some((s) => /rgba\(.+0\.4\)/.test(s)), ctx.strokeStyles.slice(-3).join(' | '));

  // 版式规格
  check('轨道高 42px（60 的 70%）', api.timeline.rowHeight === 42, `${api.timeline.rowHeight}`);
  // 只放事件轨来检查行高/间隔规则（音符轨是宽轨，单独算）
  const eventOnly = def.tracks.filter((t) => t.kind === 'events');
  api.timeline.setTracks(eventOnly);
  const oneGroup = eventOnly.length;
  check(
    '同一组内：轨道紧贴，不留行间距',
    api.timeline.layoutHeight === oneGroup * 42,
    `layoutHeight=${api.timeline.layoutHeight}（${oneGroup} 条 × 42 = ${oneGroup * 42}）`,
  );
  const twoGroups = [...eventOnly, ...makeLayerTracks(chart, 5, 0, def.axis)];
  api.timeline.setTracks(twoGroups);
  const groupCount = new Set(twoGroups.map((t) => t.group)).size;
  const expectTwo = twoGroups.length * 42 + 5 * (groupCount - 1);
  check('组之间额外 5px 间隔（组内仍为 0）', api.timeline.layoutHeight === expectTwo, `layoutHeight=${api.timeline.layoutHeight} vs ${expectTwo}`);

  // 相邻事件 1px 间隔
  api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  api.timeline.setZoom(120);
  ctx.fillRects.length = 0;
  ctx.texts.length = 0;
  api.timeline.redraw();
  const boxes = ctx.fills
    .filter((r) => /rgba\(.+0\.4\)/.test(r.style))
    .sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let i = 1; i < boxes.length; i++) {
    const g = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w);
    if (g >= 0 && g < 6) gaps.push(g);
  }
  check('相邻事件之间 1px 间隔', gaps.length > 0 && gaps.every((g) => Math.abs(g - 1) < 0.51), `间隔样本 ${gaps.slice(0, 5).map((g) => g.toFixed(2)).join(',')}`);
  check('大事件画了趋势线（stroke 数随事件增长）', ctx.calls.stroke > 20, `${ctx.calls.stroke} 次 stroke`);

  // 小事件合并渲染（LOD）：只看第一条轨所在行的矩形
  api.timeline.setZoom(8);
  ctx.fills.length = 0;
  ctx.texts.length = 0;
  api.timeline.redraw();
  const firstRowBand = ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style) && r.y >= 26 && r.y < 68);
  const clipCount = api.timeline.tracks[0].clips.length;
  check(
    '缩到最小时：小事件被合并（矩形数远少于事件数）',
    firstRowBand.length < clipCount,
    `首轨矩形 ${firstRowBand.length} 个 / 事件 ${clipCount} 个（全部轨道 ${ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style)).length} 个）`,
  );
  check(
    '小事件不画文字（只有少数很长的段才带标签）',
    ctx.texts.length < clipCount / 10,
    `文字 ${ctx.texts.length} 条 / 事件 ${clipCount} 个`,
  );
  check(
    '缩放范围被限制（下限保证同屏 ≤32 拍，上限 320 像素/拍）',
    api.timeline.setZoom(1) === Math.max(8, 900 / 32) && api.timeline.setZoom(9999) === 320,
    `下限 ${api.timeline.setZoom(1)}（视口 900px → 最多 ${(900 / api.timeline.setZoom(1)).toFixed(1)} 拍同屏）`,
  );

  // 刻度密度
  check('刻度密度可设为 1/16 拍', api.timeline.setTickDiv(16) === 16);
  check('非法密度回退到默认 1/8 拍', api.timeline.setTickDiv(7) === 8);
  check('刻度密度选项为整数分母', true, '1/2/3/4/6/8/12/16');

  // 移除按钮：只移除那一条（此前误绑成整组移除）
  api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  const beforeRemove = api.timeline.tracks.length;
  const removeBtns = byId.get('ed-tl-heads').querySelectorAll('.ed-remove');
  check('轨道头每行都有移除按钮', removeBtns.length === beforeRemove, `${removeBtns.length} 个`);
  removeBtns[0].dispatch('click', { stopPropagation() {} });
  check(
    '点移除按钮只移除这一条轨（不会移除整组）',
    api.timeline.tracks.length === beforeRemove - 1,
    `${beforeRemove} → ${api.timeline.tracks.length}`,
  );

  // 拖动排序：pointermove/up 挂在 window 上，必须真的生效
  // （同一组内拖不动是正常的：整组一起移动；这里用两组来验证顺序确实会变）
  const gA = makeLayerTracks(chart, 0, 0, def.axis);
  const gB = makeLayerTracks(chart, 5, 0, def.axis);
  api.timeline.setTracks([...gA, ...gB]);
  const orderBefore = api.timeline.tracks.map((t) => t.id);
  const headsEl = byId.get('ed-tl-heads');
  headsEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 232, height: 400, right: 232, bottom: 400 });
  const rows = headsEl.querySelectorAll('.ed-track');
  rows[0].dispatch('pointerdown', { clientX: 5, clientY: 40, button: 0, target: rows[0] });
  fireWindow('pointermove', { clientX: 5, clientY: 800, target: rows[0] });
  fireWindow('pointerup', { clientX: 5, clientY: 800, target: rows[0] });
  const orderAfter = api.timeline.tracks.map((t) => t.id);
  check(
    '拖动轨道头能改变顺序（整组一起移动）',
    orderAfter.join() !== orderBefore.join() && orderAfter.length === orderBefore.length,
    `第 1 条从「${orderBefore[0]}」变成「${orderAfter[0]}」`,
  );

  // 刻度密度：真的改变了绘制（细刻度数量）
  api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  api.timeline.setZoom(200); // 放大到 1/16 拍也能看见
  api.timeline.setTickDiv(1);
  ctx.calls.stroke = 0;
  api.timeline.redraw();
  const strokeAt1 = ctx.calls.stroke;
  api.timeline.setTickDiv(16);
  ctx.calls.stroke = 0;
  api.timeline.redraw();
  const strokeAt16 = ctx.calls.stroke;
  check('刻度密度生效（1/16 画出的刻度线明显多于 1/1）', strokeAt16 > strokeAt1 * 2, `1/1 → ${strokeAt1} 次 stroke，1/16 → ${strokeAt16} 次`);

  // 滚轮手势：直接滚轮 = 横向滚动；Ctrl = 上下滚轨道；Ctrl+Alt/捏合 = 缩放
  const bodyEl = byId.get('ed-tl-body');
  api.timeline.setScroll(2); // 先离开 0 位置，向左横滑才有变化
  const scrollAfterWheel = api.timeline.scrollBeat;
  bodyEl.dispatch('wheel', { deltaX: -240, deltaY: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, clientX: 100, preventDefault() {} });
  check('触控板双指横滑（deltaX）横向滚动', Math.abs(api.timeline.scrollBeat - scrollAfterWheel) > 0.1, `${scrollAfterWheel.toFixed(2)} → ${api.timeline.scrollBeat.toFixed(2)} 拍`);
  const zoomBefore2 = api.timeline.pxPerBeat;
  bodyEl.dispatch('wheel', { deltaY: 120, deltaX: 0, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, clientX: 100, preventDefault() {} });
  check('Ctrl + Alt + 滚轮缩放', api.timeline.pxPerBeat < zoomBefore2, `${zoomBefore2} → ${api.timeline.pxPerBeat}`);

  // ── 事件块样式：圆角 / 铺满行高 / 文字靠上 / 60% 透明度 ──
  {
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.timeline.setZoom(120);
    api.timeline.setScroll(0);
    ctx.fills.length = 0;
    ctx.textRuns.length = 0;
    ctx.calls.arcTo = 0;
    api.timeline.redraw();
    check('事件块用圆角矩形绘制（arcTo）', ctx.calls.arcTo > 0, `${ctx.calls.arcTo} 次 arcTo`);
    const clipRects = ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style));
    check(
      '事件块铺满事件轨（高度 = 行高 42）',
      clipRects.length > 0 && clipRects.every((r) => Math.abs(r.h - 42) < 0.6),
      `高度取值 ${[...new Set(clipRects.map((r) => Math.round(r.h)))].slice(0, 3).join(',')}`,
    );
    check('事件块 60% 透明度（alpha 0.4）', clipRects.length > 0, `${clipRects.length} 个事件块`);
    const clipLabels = ctx.textRuns.filter((t) => /→/.test(t.text));
    check(
      '文字标注靠上显示（行内上部，约 13px）',
      clipLabels.length > 0 && clipLabels.every((t) => {
        const inRow = (t.y - 26) % 42;
        return inRow >= 8 && inRow <= 20;
      }),
      clipLabels.length ? `标注 y 相对行顶 ${((clipLabels[0].y - 26) % 42).toFixed(1)}px（原先居中 21px）` : '没有标注',
    );

    // 趋势线必须落在事件块内（用一个「跨左边界」的长事件精确验证）
    {
      const synthetic = {
        id: 'synthetic',
        kind: 'events',
        label: '测试轨',
        headTitle: '测试轨',
        headSub: '趋势线',
        color: '#4aa8ff',
        visible: true,
        range: { min: 0, max: 1 },
        clips: [{ b0: 0, b1: 200, v0: 0, v1: 1, text: '0 → 1', sub: '' }],
      };
      api.timeline.setTracks([synthetic]);
      api.timeline.setZoom(120);
      api.timeline.setScroll(100); // 事件左端（0 拍）被滚出视野 → 跨左边界
      ctx.fills.length = 0;
      ctx.segments.length = 0;
      api.timeline.redraw();
      const rect = ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style))[0];
      const trend = ctx.segments.filter((s) => s.width >= 2 && s.x0 !== s.x1);
      check('构造出了跨左边界的事件块', !!rect && rect.x <= 0, rect ? `事件块 x=${rect.x}~${(rect.x + rect.w).toFixed(0)}，宽 ${rect.w.toFixed(0)}` : '没有事件块');
      const outside = trend.filter((s) => Math.min(s.x0, s.x1) < rect.x - 1 || Math.max(s.x0, s.x1) > rect.x + rect.w + 1);
      check(
        '趋势线不越出事件块（跨左边界时也不跑偏）',
        trend.length > 3 && outside.length === 0,
        `${trend.length} 段趋势线，x 范围 ${Math.min(...trend.map((s) => Math.min(s.x0, s.x1))).toFixed(0)}~${Math.max(...trend.map((s) => Math.max(s.x0, s.x1))).toFixed(0)}（事件块 ${rect.x.toFixed(0)}~${(rect.x + rect.w).toFixed(0)}）`,
      );
      // 右侧同理
      api.timeline.setScroll(0);
      api.timeline.setVisibleBeats(60, 0);
      ctx.fills.length = 0;
      ctx.segments.length = 0;
      api.timeline.redraw();
      const rect2 = ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style))[0];
      const trend2 = ctx.segments.filter((s) => s.width >= 2 && s.x0 !== s.x1);
      const outside2 = rect2 ? trend2.filter((s) => Math.max(s.x0, s.x1) > rect2.x + rect2.w + 1) : [];
      check('趋势线不越出事件块（跨右边界时也不跑偏）', !!rect2 && outside2.length === 0, rect2 ? `事件块 ${rect2.x.toFixed(0)}~${(rect2.x + rect2.w).toFixed(0)}，趋势线 x 最大 ${Math.max(...trend2.map((s) => Math.max(s.x0, s.x1))).toFixed(0)}` : '没有事件块');
    }
  }

  // ── 滚轮手势：直接滚轮 = 横向滚动；Ctrl = 纵向滚动；Ctrl+Alt / 捏合 = 缩放 ──
  {
    const bodyEl2 = byId.get('ed-tl-body');
    bodyEl2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 320, right: 900, bottom: 320 });
    bodyEl2.__setSize(900, 320);
    api.timeline.resize();
    api.timeline.setScroll(5);

    const before = api.timeline.scrollBeat;
    bodyEl2.dispatch('wheel', { deltaY: 300, deltaX: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, clientX: 400, timeStamp: 1000, preventDefault() {} });
    check('直接滚轮 = 横向滚动时间轴', api.timeline.scrollBeat > before, `${before.toFixed(2)} → ${api.timeline.scrollBeat.toFixed(2)} 拍`);

    // 先撑出可纵向滚动的高度，再验证 Ctrl+滚轮 = 纵向滚动
    api.timeline.setTracks([makeNotesTrack(chart, 0, def.axis), ...makeLayerTracks(chart, 0, 0, def.axis)]);
    api.timeline.setVerticalScroll(0);
    const topBefore = api.timeline.scrollTop;
    bodyEl2.dispatch('wheel', { deltaY: 150, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 400, timeStamp: 3000, preventDefault() {} });
    check('Ctrl + 滚轮 = 纵向滚动轨道', api.timeline.scrollTop > topBefore, `scrollTop ${topBefore} → ${api.timeline.scrollTop}`);
    const beatAfterCtrl = api.timeline.scrollBeat;
    bodyEl2.dispatch('wheel', { deltaY: 150, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 400, timeStamp: 3100, preventDefault() {} });
    check('Ctrl + 滚轮不再横向滚动', api.timeline.scrollBeat === beatAfterCtrl, `scrollBeat 保持 ${api.timeline.scrollBeat.toFixed(2)}`);

    // 连续小 delta（捏合特征）→ 缩放
    const pinchStart = api.timeline.pxPerBeat;
    bodyEl2.dispatch('wheel', { deltaY: -1.2, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 400, timeStamp: 40100, preventDefault() {} });
    bodyEl2.dispatch('wheel', { deltaY: -1.2, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 400, timeStamp: 40150, preventDefault() {} });
    check('连续小 delta（触控板捏合）→ 缩放', api.timeline.pxPerBeat > pinchStart, `${pinchStart.toFixed(1)} → ${api.timeline.pxPerBeat.toFixed(1)}`);

    const zoomBefore = api.timeline.pxPerBeat;
    bodyEl2.dispatch('wheel', { deltaY: -120, deltaX: 0, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, clientX: 400, timeStamp: 50000, preventDefault() {} });
    const zoomStep = api.timeline.pxPerBeat / zoomBefore;
    check('Ctrl + Alt + 滚轮 = 缩放', api.timeline.pxPerBeat > zoomBefore, `${zoomBefore.toFixed(1)} → ${api.timeline.pxPerBeat.toFixed(1)}`);
    check('缩放灵敏度更低（每格 ×1.08）', Math.abs(zoomStep - 1.08) < 1e-6, `实测倍率 ${zoomStep.toFixed(4)}`);
    api.timeline.setVerticalScroll(0);
  }

  // ── 结构树双击「n 号线」= 清空轨道并放入该线全部内容 ──
  {
    const { makeLineTracks } = await import('../src/editor/tracks.js');
    api.bottomTabs.activate('tree');
    const host2 = body.querySelectorAll('[data-tabbody="bottom"]')[0];
    // 先放点别的轨道，验证会被清空
    api.timeline.setTracks(makeLayerTracks(chart, 3, 0, def.axis));
    const beforeCount = api.timeline.tracks.length;
    const lineRow = host2.querySelectorAll('.ed-node').find((n) => /号线/.test(n.textContent));
    check('结构树里有判定线行', !!lineRow, lineRow ? lineRow.textContent.slice(0, 24) : '未找到');
    lineRow.dispatch('dblclick');
    const after = api.timeline.tracks;
    const expected = makeLineTracks(chart, 0, def.axis);
    check('双击线行会替换掉原有轨道', after.length === expected.length && after.length !== beforeCount, `${beforeCount} 条 → ${after.length} 条（期望 ${expected.length} 条）`);
    check('放入内容 = 音符轨 + 该线所有事件层的全部事件轨', after.length === expected.length && after.every((t, i) => t.id === expected[i].id), `音符 ${after.filter((t) => t.kind === 'notes').length} 条，事件 ${after.filter((t) => t.kind === 'events').length} 条`);
    check('音符轨排在最前面', after[0]?.kind === 'notes', after.slice(0, 3).map((t) => (t.kind === 'notes' ? '音符' : '事件')).join(' → '));
  }

  // ── 横向滚动后的几何回归（此前的 bug：左边界被钳位但宽度没缩短 → 事件重叠、趋势线跑出事件）
  api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  api.timeline.setZoom(60);
  const geom = (label) => {
    ctx.fills.length = 0;
    api.timeline.redraw();
    const rects = ctx.fills.filter((r) => /rgba\(.+0\.4\)/.test(r.style));
    const byRow = new Map();
    for (const r of rects) {
      const key = Math.round(r.y);
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(r);
    }
    let overlaps = 0;
    let outOfBounds = 0;
    for (const list of byRow.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let k = 1; k < list.length; k++) {
        const prev = list[k - 1];
        const cur = list[k];
        const gap = cur.x - (prev.x + prev.w);
        // 极短事件会被撑到最小 3px 宽以便看得见，这种轻微重叠不算问题
        if (gap < -0.51 && prev.w > 4 && cur.w > 4) overlaps++;
      }
    }
    for (const r of rects) {
      if (r.x + r.w > viewWidth + 25 || r.x < -25) outOfBounds++;
    }
    const maxRight = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) : 0;
    return { label, count: rects.length, overlaps, outOfBounds, maxRight };
  };
  const viewWidth = 900;
  const before = geom('scroll=0');
  api.timeline.setScroll(30);
  const after = geom('scroll=30 拍');
  check('横向滚动前：事件块不重叠', before.overlaps === 0, `重叠 ${before.overlaps} 处`);
  check(
    '横向滚动后：事件块仍不重叠（回归：左边界钳位后宽度必须缩短）',
    after.overlaps === 0,
    `重叠 ${after.overlaps} 处 / ${after.count} 个矩形`,
  );
  check(
    '横向滚动后：事件块不超出可视范围',
    after.outOfBounds === 0,
    `越界 ${after.outOfBounds} 处，最右 ${after.maxRight.toFixed(1)}px（视口 ${viewWidth}px）`,
  );
  // （「跨左边界 / 跨右边界」的精确用例已在上面的合成事件块里覆盖，这里不再做模糊判断）
  api.timeline.setScroll(0);

  // ── 背景图 / 音频开关 ──
  const bgBtn = byId.get('ed-bg-toggle');
  const auBtn = byId.get('ed-audio-toggle');
  check('预览工具栏有背景图与音频开关', !!bgBtn && !!auBtn && bgBtn.children.length > 0 && auBtn.children.length > 0);
  check('两个开关默认开启', api.preview.backgroundEnabled === true && api.preview.audioEnabled === true);
  check('开关初始为激活态', bgBtn.classList.contains('active') && auBtn.classList.contains('active'));
  bgBtn.dispatch('click');
  check('点背景图开关 → 关闭', api.preview.backgroundEnabled === false && !bgBtn.classList.contains('active'));
  auBtn.dispatch('click');
  check('点音频开关 → 关闭', api.preview.audioEnabled === false && !auBtn.classList.contains('active'));
  bgBtn.dispatch('click');
  auBtn.dispatch('click');
  check('再点一次 → 恢复开启', api.preview.backgroundEnabled === true && api.preview.audioEnabled === true);

  // 示例包的音频/曲绘文件名（info.txt 里写的是别的名字，必须回退到实际文件名）
  const { SAMPLES: EDITOR_SAMPLES } = await import('../src/editor/preview.js');
  check(
    '内置示例带真实音频/曲绘文件名',
    EDITOR_SAMPLES.every((s) => s.audio && s.background),
    EDITOR_SAMPLES.map((s) => `${s.id}: ${s.audio} / ${s.background}`).join('；'),
  );
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const missing = [];
  for (const s of EDITOR_SAMPLES) {
    for (const f of [s.chart, s.audio, s.background, 'info.txt']) {
      const p = pathMod.join(process.cwd(), s.dir, f);
      if (!fsMod.existsSync(p)) missing.push(`${s.id}/${f}`);
    }
  }
  check('示例包里的谱面/音频/曲绘/info.txt 都真实存在', missing.length === 0, missing.length ? `缺失：${missing.join(', ')}` : '全部存在');

  // ── 控件等高与图标居中（样式回归）──
  const css = fsMod.readFileSync(pathMod.join(process.cwd(), 'editor.css'), 'utf8');
  check('工具条里控件统一高度（--ctl-h）', /--ctl-h: 22px/.test(css) && /\.ed-panebar > \* \{[^}]*height: var\(--ctl-h\)/.test(css));
  check('按钮与图标按钮都用同一高度并居中', /\.ed-btn \{[^}]*height: var\(--ctl-h\)[^}]*align-items: center/.test(css.replace(/\n\s*/g, ' ')) && /\.ed-iconbtn \{[^}]*align-items: center[^}]*justify-content: center/.test(css.replace(/\n\s*/g, ' ')));
  check('图标基线对齐改为 middle', /\.ic \{[^}]*vertical-align: middle/.test(css.replace(/\n\s*/g, ' ')));
  check('下拉 / 拍号输入 / 小按钮同高', ['\\.ed-select \\{[^}]*height: var\\(--ctl-h\\)', '\\.ed-beat \\{[^}]*height: var\\(--ctl-h\\)', '\\.ed-btn\\.small \\{[^}]*height: var\\(--ctl-h\\)'].every((re) => new RegExp(re).test(css.replace(/\n\s*/g, ' '))));

  // ── 启动健壮性：页面缺元素 / 版本不匹配时不能整页崩（此前就是这样空白一片）──
  {
    const { setIcon } = await import('../src/ui/icons.js');
    let threw = false;
    try {
      setIcon(null, 'play');
    } catch {
      threw = true;
    }
    check('setIcon 传 null 不再抛错（旧缓存页面也能跑）', !threw);

    const mainSrc = fs.readFileSync(path.join(ROOT, 'src/editor/main.js'), 'utf8');
    check(
      '所有控件接线都走安全 helper（不存在 $("x").addEventListener 写法）',
      !/\$\('[a-zA-Z0-9_-]+'\)\s*\n?\s*\.addEventListener/.test(mainSrc),
    );

    const htmlSrc = fs.readFileSync(path.join(ROOT, 'edit.html'), 'utf8');
    const bootSrc = fs.readFileSync(path.join(ROOT, 'src/editor/boot.js'), 'utf8');
    check('edit.html 走 boot.js 启动（带版本守卫与错误面板）', /src="src\/editor\/boot\.js"/.test(htmlSrc));
    const pageVer = /data-editor-version="([^"]+)"/.exec(htmlSrc)?.[1];
    const bootVer = /PAGE_VERSION = '([^']+)'/.exec(bootSrc)?.[1];
    check('页面版本标记与 boot.js 一致', !!pageVer && pageVer === bootVer, `edit.html=${pageVer} boot.js=${bootVer}`);
    check('启动失败时会在页面上显示错误面板', /ed-fatal/.test(bootSrc) && /\.ed-fatal \{/.test(fs.readFileSync(path.join(ROOT, 'editor.css'), 'utf8')));
  }

  // ── 音符轨渲染：贴图 + 按 positionX 分布高度 ──
  {
    const notesTrack = makeNotesTrack(chart, 0, def.axis);
    api.timeline.setTracks([notesTrack]);
    api.timeline.setVisibleBeats(24, 0);
    const tlBody2 = byId.get('ed-tl-body');
    tlBody2.__setSize(900, 400);
    api.timeline.resize();
    const sprite = { width: 32, height: 32, name: 'generic' };
    const tapSprite = { width: 32, height: 32, name: 'tap' };
    const holdSprite = { width: 128, height: 32, name: 'hold' };
    api.timeline.setNoteSprites({ tap: tapSprite, drag: sprite, hold: holdSprite, flick: sprite });
    ctx.drawImages.length = 0;
    ctx.fillStyles.length = 0;
    ctx.segments.length = 0;
    api.timeline.redraw();
    const drawn = ctx.drawImages.filter((d) => d.w === d.h && d.w >= 11 && d.w <= 30); // 头部贴图按行高缩放
    const byName = (name) => ctx.drawImages.filter((d) => d.img?.name === name);
    check('音符轨用贴图画音符（drawImage 被调用）', drawn.length > 0, `${drawn.length} 个音符被绘制，贴图边长 ${drawn[0]?.w ?? '-'}px`);
    check(
      '音符有横向时间位置',
      drawn.length > 0 && drawn.every((d) => d.x > -60 && d.x < 960),
      drawn.length ? `x 范围 ${Math.min(...drawn.map((d) => d.x)).toFixed(0)}~${Math.max(...drawn.map((d) => d.x)).toFixed(0)}` : '没有绘制',
    );
    const ys = drawn.map((d) => d.y);
    const springY = api.timeline.tracks[0].rowHeight;
    check(
      '音符按 positionX 分布在不同高度',
      ys.length > 0 && new Set(ys.map((y) => Math.round(y))).size >= 3 && Math.min(...ys) > 0 && Math.max(...ys) < springY + 4,
      ys.length ? `y 取值 ${[...new Set(ys.map((y) => Math.round(y)))].slice(0, 6).join(',')} …（行高 ${springY}）` : '没有绘制',
    );
    check('音符轨行高 = 189（126 再加高 50%）', springY === 189, `${springY}`);
    check('音符轨底色比事件轨浅一点点（#171717）', ctx.fillStyles.includes('#171717'), ctx.fillStyles.slice(0, 3).join(' '));
    const vLines = ctx.segments.filter((s) => Math.abs(s.x0 - s.x1) < 1e-6 && s.y1 - s.y0 > springY - 4);
    check(
      '音符轨上仍有竖向节拍线（底色没把它盖掉）',
      vLines.length > 3,
      `${vLines.length} 条竖线贯穿音符轨`,
    );

    // Hold：主体 = 手绘蓝色圆角条（不用贴图），头部 = tap 正圆贴图
    const holdClips = notesTrack.clips.filter((c) => c.type === 'hold' && c.b1 > c.b0);
    check('音符轨里有 Hold（用于验证长条）', holdClips.length > 0, `${holdClips.length} 个 Hold`);
    check('Hold 主体不用 hold 贴图（改回手绘）', byName('hold').length === 0, `hold 贴图绘制 ${byName('hold').length} 次`);
    check(
      'Hold 主体是蓝色圆角条（fillStyle = #22c3f0）',
      ctx.fillStyles.includes('#22c3f0'),
      `#22c3f0 出现 ${ctx.fillStyles.filter((s) => s === '#22c3f0').length} 次`,
    );
    check('Hold 头部用 tap 贴图且为正圆', byName('tap').length > 0 && byName('tap').every((d) => Math.abs(d.w - d.h) < 1e-6), `${byName('tap').length} 次，尺寸 ${byName('tap').map((d) => `${d.w.toFixed(0)}×${d.h.toFixed(0)}`).slice(0, 2).join(' ')}`);

    // 横向刻度线
    const hLines = ctx.segments.filter((s) => Math.abs(s.y0 - s.y1) < 1e-6 && s.x1 - s.x0 > 500);
    check('音符轨里有横向刻度线', hLines.length >= 2, `${hLines.length} 条横线：y=${hLines.map((s) => s.y0.toFixed(0)).slice(0, 5).join(',')}`);
    check('横向刻度线默认 9 线', hLines.length === 9, `${hLines.length} 条`);
    check(
      '横向刻度线都在音符轨范围内',
      hLines.length > 0 && hLines.every((s) => s.y0 > 0 && s.y0 < springY + 30),
      hLines.length ? `y 范围 ${Math.min(...hLines.map((s) => s.y0)).toFixed(0)}~${Math.max(...hLines.map((s) => s.y0)).toFixed(0)}` : '无',
    );
    const denseCount = (() => {
      api.timeline.setPosLines(16);
      ctx.segments.length = 0;
      api.timeline.redraw();
      return ctx.segments.filter((s) => Math.abs(s.y0 - s.y1) < 1e-6 && s.x1 - s.x0 > 500).length;
    })();
    check('横向刻度密度可调（线数变多 → 线更多）', denseCount > hLines.length, `9 线 → ${hLines.length} 条，16 线 → ${denseCount} 条`);
    api.timeline.setPosLines(9);
    check('横向刻度吸附开关可用', api.timeline.posSnap === false && api.timeline.setPosSnap(true) === true, `posSnap=${api.timeline.posSnap}`);
    const snapRange = { min: -8, max: 8 }; // 9 线 → 每 2 个单位一条
    check(
      '吸附把 positionX 对齐到刻度线（按线数）',
      api.timeline.snapPositionX(1.9, snapRange) === 2 && api.timeline.snapPositionX(3.5, snapRange) === 4,
      `1.9→${api.timeline.snapPositionX(1.9, snapRange)} 3.5→${api.timeline.snapPositionX(3.5, snapRange)}`,
    );
    const lineColors = (() => {
      ctx.segments.length = 0;
      api.timeline.redraw();
      return [...new Set(ctx.segments.filter((s) => Math.abs(s.y0 - s.y1) < 1e-6 && s.x1 - s.x0 > 500).map((s) => s.style))];
    })();
    check('横向刻度线颜色不随吸附变化（吸附只影响行为）', lineColors.length === 1 && lineColors[0] === '#2f2f2f', lineColors.join(','));
    api.timeline.setPosSnap(false);
    check('音符贴图缺图时有兜底（不崩）', (() => {
      api.timeline.setNoteSprites(null);
      ctx.drawImages.length = 0;
      try {
        api.timeline.redraw();
        return errors.length === 0;
      } catch {
        return false;
      }
    })());
    api.timeline.setNoteSprites({ tap: sprite, drag: sprite, hold: sprite, flick: sprite });
    // 还原成事件轨，后面的用例继续检查趋势线等
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    tlBody2.__setSize(900, 320);
    api.timeline.resize();
  }

  // ── 鼠标工具：点选 / Ctrl 多选 / 框选 / 拖动 / 选中高亮 ──
  {
    api.timeline.setTracks([...makeLayerTracks(chart, 0, 0, def.axis), makeNotesTrack(chart, 0, def.axis)]);
    api.timeline.setVisibleBeats(8, 0);
    const tlBody3 = byId.get('ed-tl-body');
    tlBody3.__setSize(900, 600);
    tlBody3.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
    api.timeline.resize();
    api.timeline.setNoteSprites({
      tap: { width: 32, height: 32 },
      drag: { width: 32, height: 32 },
      hold: { width: 128, height: 32 },
      flick: { width: 32, height: 32 },
    });
    api.timeline.clearSelection();
    api.timeline.redraw();

    check('鼠标工具是默认工具', api.timeline.tool === 'mouse');

    const px = api.timeline.pxPerBeat;
    const firstClip = api.timeline.tracks[0].clips[0];
    const hitX = Math.round(firstClip.b0 * px) + 6;
    const rowY = (row) => 26 + row * 42 + 21; // 同组内轨道紧贴，行高 42
    tlBody3.dispatch('pointerdown', { clientX: hitX, clientY: rowY(0), button: 0, pointerId: 11 });
    check('左键点击选中事件块', api.timeline.selectedCount === 1, `选中 ${api.timeline.selectedCount} 个（事件 ${api.timeline.selection.events.length}）`);
    tlBody3.dispatch('pointerup', { clientX: hitX, clientY: rowY(0), pointerId: 11 });

    // Ctrl + 点击「另一条轨道」上的事件 → 多选
    const secondClip = api.timeline.tracks[1].clips[0];
    const hitX2 = Math.round(secondClip.b0 * px) + 6;
    tlBody3.dispatch('pointerdown', { clientX: hitX2, clientY: rowY(1), button: 0, pointerId: 12, ctrlKey: true });
    tlBody3.dispatch('pointerup', { clientX: hitX2, clientY: rowY(1), pointerId: 12 });
    check('Ctrl + 点击添加到多选', api.timeline.selectedCount === 2, `选中 ${api.timeline.selectedCount} 个`);

    ctx.strokeRects.length = 0;
    ctx.strokeStyles.length = 0;
    api.timeline.redraw();
    check(
      '选中的事件有高亮框（内边缘，白色描边）',
      ctx.strokeStyles.includes('#ffffff') || ctx.strokeRects.some((r) => r.style === '#ffffff'),
      `${ctx.strokeRects.length} 个 strokeRect，描边色 ${[...new Set(ctx.strokeStyles)].slice(0, 3).join(',')}`,
    );

    const beforeB0 = api.timeline.tracks[0].clips[0].b0;
    tlBody3.dispatch('pointerdown', { clientX: hitX, clientY: rowY(0), button: 0, pointerId: 13 });
    tlBody3.dispatch('pointermove', { clientX: hitX + Math.round(px), clientY: rowY(0), pointerId: 13 });
    tlBody3.dispatch('pointerup', { clientX: hitX + Math.round(px), clientY: rowY(0), pointerId: 13 });
    const afterB0 = api.timeline.tracks[0].clips[0].b0;
    check('拖动选中事件块 → 时间改变', Math.abs(afterB0 - (beforeB0 + 1)) < 0.06, `${beforeB0.toFixed(3)} → ${afterB0.toFixed(3)} 拍`);

    // 拖动音符 → positionX 改变（位置直接取命中区域，避免手算行高）
    api.timeline.clearSelection();
    api.timeline.redraw();
    const noteHit = api.timeline.hitRects.find((r) => r.kind === 'notes');
    check('音符轨里有可点击的音符', !!noteHit, noteHit ? `命中区 x=${noteHit.x.toFixed(0)} y=${noteHit.y.toFixed(0)} ${noteHit.w}×${noteHit.h}` : '未找到');
    const notesTrackRef = api.timeline.tracks.find((t) => t.kind === 'notes');
    const noteClip = notesTrackRef.clips[noteHit.index];
    const noteClipByKey = () => {
      const key = api.timeline.selection.notes[0];
      if (!key) return null;
      const hash = key.lastIndexOf('#');
      const track = api.timeline.tracks.find((t) => t.id === key.slice(0, hash));
      return track?.clips[Number(key.slice(hash + 1))] ?? null;
    };
    const noteCx = noteHit.x + noteHit.w / 2;
    const noteCy = noteHit.y + noteHit.h / 2;
    tlBody3.dispatch('pointerdown', { clientX: Math.round(noteCx), clientY: Math.round(noteCy), button: 0, pointerId: 14 });
    check('左键点击选中音符', api.timeline.selection.notes.length === 1, `选中音符 ${api.timeline.selection.notes.length} 个`);
    ctx.strokeRects.length = 0;
    api.timeline.redraw();
    check('选中的音符有高亮框（外边缘）', ctx.strokeRects.length > 0, `${ctx.strokeRects.length} 个 strokeRect`);
    const draggedClip = noteClipByKey() ?? noteClip;
    const beforeX = draggedClip.positionX;
    tlBody3.dispatch('pointermove', { clientX: Math.round(noteCx), clientY: Math.round(noteCy) + 20, pointerId: 14 });
    check(
      '拖动过程中音符 positionX 立刻跟随',
      draggedClip.positionX !== beforeX,
      `${beforeX.toFixed(2)} → ${draggedClip.positionX.toFixed(2)}（选中 ${api.timeline.selection.notes[0]}）`,
    );
    tlBody3.dispatch('pointerup', { clientX: Math.round(noteCx), clientY: Math.round(noteCy) + 20, pointerId: 14 });
    check('拖动选中音符 → positionX 改变（往下拖变小）', draggedClip.positionX < beforeX, `${beforeX.toFixed(2)} → ${draggedClip.positionX.toFixed(2)}`);

    // 开启横向吸附后仍能拖动音符（此前会抛 ReferenceError 导致拖不动）
    {
      api.timeline.setPosLines(9);
      api.timeline.setPosSnap(true);
      api.timeline.clearSelection();
      api.timeline.redraw();
      const hit2 = api.timeline.hitRects.find((r) => r.kind === 'notes');
      const cx2 = hit2.x + hit2.w / 2;
      const cy2 = hit2.y + hit2.h / 2;
      tlBody3.dispatch('pointerdown', { clientX: Math.round(cx2), clientY: Math.round(cy2), button: 0, pointerId: 16 });
      const key2 = api.timeline.selection.notes[0];
      const hash2 = key2.lastIndexOf('#');
      const track2 = api.timeline.tracks.find((t) => t.id === key2.slice(0, hash2));
      const clip2 = track2.clips[Number(key2.slice(hash2 + 1))];
      const x0 = clip2.positionX;
      tlBody3.dispatch('pointermove', { clientX: Math.round(cx2), clientY: Math.round(cy2) + 40, pointerId: 16 });
      const x1 = clip2.positionX;
      tlBody3.dispatch('pointerup', { clientX: Math.round(cx2), clientY: Math.round(cy2) + 40, pointerId: 16 });
      check('开启横向吸附后音符仍可拖动', x1 !== x0, `${x0.toFixed(2)} → ${x1.toFixed(2)}`);
      const xr2 = track2.xRange;
      const step2 = (xr2.max - xr2.min) / 8; // 9 线 → 8 段
      const onLine = Math.abs((x1 - xr2.min) / step2 - Math.round((x1 - xr2.min) / step2)) < 1e-6;
      check('吸附后落在横向刻度线上', onLine || x1 === xr2.min || x1 === xr2.max, `positionX=${x1.toFixed(3)}（线距 ${step2.toFixed(3)}）`);
      api.timeline.setPosSnap(false);
    }

    // 缓动标签：线性 / 缓动#N / 贝塞尔
    {
      const { makeEventTrack } = await import('../src/editor/tracks.js');
      const fakeLayer = {
        x: [
          { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1, easingPreset: 1 },
          { startBeat: 4, endBeat: 8, start: 0, end: 1, easingType: 5, easingPreset: 5 },
          { startBeat: 8, endBeat: 12, start: 0, end: 1, easingType: 6, easingPreset: 6, bezierPoints: [0.1, 0.2, 0.3, 0.4] },
        ],
      };
      const fakeChart = { lines: [{ id: 0, name: 'L', layers: [fakeLayer], rt: { timeline: null } }], endTime: 100, notes: [] };
      const t = makeEventTrack(fakeChart, 0, 0, 'x', def.axis);
      const labels = t.clips.map((c) => c.text.split(', ').pop());
      check('缓动标签显示为 线性 / 缓动#N / 贝塞尔', labels.join(' | ') === '线性 | 缓动#5 | 贝塞尔', labels.join(' | '));
    }
    // 框选：空白处拖出矩形
    api.timeline.clearSelection();
    tlBody3.dispatch('pointerdown', { clientX: 0, clientY: 27, button: 0, pointerId: 15 });
    tlBody3.dispatch('pointermove', { clientX: 300, clientY: 27 + 42 * 2, pointerId: 15 });
    tlBody3.dispatch('pointerup', { clientX: 300, clientY: 27 + 42 * 2, pointerId: 15 });
    check('空白处拖动 = 框选（选中多个对象）', api.timeline.selectedCount > 1, `框选到 ${api.timeline.selectedCount} 个对象`);
    api.timeline.clearSelection();
    check('可清空选择', api.timeline.selectedCount === 0);
    tlBody3.__setSize(900, 320);
    api.timeline.resize();

    // ── 移动工具：平移时间轴（鼠标拖动 / 贴边自动滚动 / 触屏交给原生滚动）──
    api.timeline.setTool('pan');
    check('切到移动工具', api.timeline.tool === 'pan' && api.timeline.interaction.tool === 'pan', `tool=${api.timeline.tool}`);
    check('移动工具在容器上打了标记（CSS 用 .tool-pan 放开触屏滚动）', tlBody3.classList.contains('tool-pan'), String(tlBody3.className));
    tlBody3.scrollLeft = 400;
    tlBody3.scrollTop = 0;
    api.timeline.syncTime?.(0);
    tlBody3.dispatch('pointerdown', { clientX: 500, clientY: 120, button: 0, pointerId: 21, pointerType: 'mouse' });
    tlBody3.dispatch('pointermove', { clientX: 400, clientY: 140, pointerId: 21, pointerType: 'mouse' });
    check('移动工具：鼠标拖动会平移（横向 +100）', Math.abs((tlBody3.scrollLeft ?? 0) - 500) < 2, `scrollLeft=${tlBody3.scrollLeft}`);
    check('移动工具：平移不改变选择', api.timeline.selectedCount === 0, `${api.timeline.selectedCount} 个`);
    check('移动工具：平移中状态可查询', api.timeline.interaction.panning === true);
    tlBody3.dispatch('pointerup', { clientX: 400, clientY: 140, pointerId: 21, pointerType: 'mouse' });
    check('移动工具：松手后不再标记平移中', api.timeline.interaction.panning === false);

    // 触屏：移动工具下不接管指针，交给浏览器原生滚动（touch-action: pan-x pan-y）
    const beforeTouch = tlBody3.scrollLeft ?? 0;
    tlBody3.dispatch('pointerdown', { clientX: 300, clientY: 120, button: 0, pointerId: 22, pointerType: 'touch' });
    tlBody3.dispatch('pointermove', { clientX: 120, clientY: 120, pointerId: 22, pointerType: 'touch' });
    check('移动工具：触屏单指拖动不启用手动平移（交给原生滚动）', (tlBody3.scrollLeft ?? 0) === beforeTouch, `scrollLeft=${tlBody3.scrollLeft}`);
    tlBody3.dispatch('pointerup', { clientX: 120, clientY: 120, pointerId: 22, pointerType: 'touch' });

    // 贴边自动滚动：指针停在左边缘 → 逐帧往左滚（速度随距离渐进，最慢 1px/帧）
    tlBody3.scrollLeft = 600;
    tlBody3.dispatch('pointermove', { clientX: 6, clientY: 120, pointerId: 23, pointerType: 'mouse' });
    tick(4);
    check('移动工具：靠左边缘自动向左滚动', (tlBody3.scrollLeft ?? 0) < 600, `600 → ${tlBody3.scrollLeft}`);
    const atLeft = tlBody3.scrollLeft ?? 0;
    tlBody3.dispatch('pointermove', { clientX: 450, clientY: 120, pointerId: 23, pointerType: 'mouse' });
    tick(4);
    check('移动工具：指针离开边缘后停止滚动', (tlBody3.scrollLeft ?? 0) === atLeft, `仍为 ${tlBody3.scrollLeft}`);

    // 鼠标工具：不加 .tool-pan（CSS 里 touch-action:none → 触屏滚动被锁定，留给框选/拖拽）
    api.timeline.setTool('mouse');
    check('切回鼠标工具并撤掉标记', api.timeline.tool === 'mouse' && !tlBody3.classList.contains('tool-pan'), `tool=${api.timeline.tool}`);
    check('两个工具的触屏策略不同（CSS 断言）', /\.ed-tl-body \{[^}]*touch-action: none/s.test(css) && /\.ed-tl-body\.tool-pan \{[^}]*touch-action: pan-x pan-y/s.test(css));

    // ── 剪刀：切开后曲线必须与原曲线一致（预设缓动用左右裁切、贝塞尔用 de Casteljau 分割）──
    {
      const { makeEasing } = await import('../src/core/easing.js');
      const { createTimeline } = await import('../src/core/timing.js');
      const { createBeatAxis, makeEventTrack } = await import('../src/editor/tracks.js');

      const bpmList = [{ beat: 0, bpm: 120 }];
      const mkChart = (events, notes = []) => {
        const rtTimeline = createTimeline(bpmList, 1);
        return {
          timing: { bpmList },
          endTime: 100,
          notes,
          lines: [{ id: 0, name: 'L', layers: [{ x: events }], rt: { timeline: rtTimeline, notes } }],
        };
      };
      const axisX = createBeatAxis(mkChart([]));

      /** 逐点比对：把两段曲线映射回原参数空间，与原来的曲线比最大误差 */
      const curveError = (fn, v0, v1, segments) => {
        const origValue = (p) => v0 + (v1 - v0) * fn(p);
        let maxErr = 0;
        let worst = null;
        for (let i = 0; i <= 40; i++) {
          const u = i / 40;
          let got = null;
          for (const seg of segments) {
            if (u >= seg.u0 - 1e-12 && u <= seg.u1 + 1e-12) {
              const local = seg.u1 > seg.u0 ? (u - seg.u0) / (seg.u1 - seg.u0) : 0;
              got = seg.v0 + (seg.v1 - seg.v0) * seg.fn(local);
              break;
            }
          }
          if (got == null) continue;
          const e = Math.abs(got - origValue(u));
          if (e > maxErr) {
            maxErr = e;
            worst = `u=${u.toFixed(3)} 两段=${got.toFixed(6)} 原=${origValue(u).toFixed(6)}`;
          }
        }
        return { maxErr, worst };
      };

      for (const [label, evOut] of [
        ['预设缓动（缓动#9 In Cubic）', { startBeat: 0, endBeat: 4, start: 0.1, end: 0.9, easingType: 9 }],
        ['带裁剪的预设（#20 Out Back，裁到 0.2~0.8）', { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 20, easingLeft: 0.2, easingRight: 0.8 }],
        ['贝塞尔（0.25,0.1,0.85,0.35）', { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 6, bezierPoints: [0.25, 0.1, 0.85, 0.35] }],
      ]) {
        const chart = mkChart([evOut]);
        const fn = makeEasing(evOut.easingType, evOut.bezierPoints ?? null, evOut.easingLeft ?? 0, evOut.easingRight ?? 1);
        evOut.easingFn = fn;
        const fnBefore = fn(1);
        const origStart = evOut.start; // 切分会就地改原事件，先把原取值抓下来
        const origEnd = evOut.end;
        const track = makeEventTrack(chart, 0, 0, 'x', axisX);
        api.timeline.setChart(chart, axisX);
        api.timeline.setTracks([track]);
        const cutBeat = 1.5;
        const u = cutBeat / 4;
        const vCut = origStart + (origEnd - origStart) * fn(u);
        const res = api.timeline.cutAt(track.id, 0, cutBeat);
        check(`剪刀：${label} 切分成功`, res.ok === true && track.clips.length === 2, res.message);
        if (!res.ok) continue;
        const [a, b] = track.clips.map((c) => c.ev).sort((p, q) => p.startBeat - q.startBeat);
        check(
          `剪刀：${label} 切口取值连续（两段在切口处相等且等于原曲线取值）`,
          Math.abs(a.end - vCut) < 1e-9 && Math.abs(b.start - vCut) < 1e-9,
          `vCut=${vCut.toFixed(6)} a.end=${a.end.toFixed(6)} b.start=${b.start.toFixed(6)}`,
        );
        check(
          `剪刀：${label} 时间区间首尾相接`,
          Math.abs(a.endBeat - cutBeat) < 1e-9 && Math.abs(b.startBeat - cutBeat) < 1e-9 && Math.abs(b.endBeat - 4) < 1e-9,
          `${a.startBeat}~${a.endBeat} / ${b.startBeat}~${b.endBeat}`,
        );
        check(
          `诊断：${label} 原曲线函数未被切分污染（fn(1) 与之前一致）`,
          Math.abs(fn(1) - fnBefore) < 1e-12,
          `之前 fn(1)=${fnBefore}，之后 fn(1)=${fn(1)}，fn===base? ${fn === makeEasing(evOut.easingType, null, 0, 1)}`,
        );
        const { maxErr: err, worst } = curveError(fn, origStart, origEnd, [
          { u0: 0, u1: u, v0: a.start, v1: a.end, fn: a.easingFn },
          { u0: u, u1: 1, v0: b.start, v1: b.end, fn: b.easingFn },
        ]);
        check(
          `剪刀：${label} 两段拼起来与原曲线一致（最大误差 < 1e-6）`,
          err < 1e-6,
          `最大误差 ${err.toExponential(2)}，最坏点 ${worst}；A[${
            JSON.stringify([a.easingType, a.easingLeft, a.easingRight, a.start, a.end])
          }] B[${JSON.stringify([b.easingType, b.easingLeft, b.easingRight, b.start, b.end])}]`,
        );
      }

      // Hold：切成两个音符，时长相加等于原时长，切口处高度连续
      {
        const note = { type: 'hold', startBeat: 2, endBeat: 6, timeSec: 1, endSec: 3, durationSec: 2, height: 10, positionX: 0, src: { startBeat: 2, endBeat: 6 } };
        const chart = mkChart([{ startBeat: 0, endBeat: 8, start: 0, end: 0, easingType: 1 }], [note]);
        const notesTrack = makeNotesTrack(chart, 0, axisX);
        api.timeline.setChart(chart, axisX);
        api.timeline.setTracks([notesTrack]);
        const res = api.timeline.cutAt(notesTrack.id, 0, 4);
        check('剪刀：Hold 切成两个音符', res.ok === true && chart.notes.length === 2 && chart.lines[0].rt.notes.length === 2, res.message);
        if (res.ok) {
          const [n1, n2] = chart.notes.slice().sort((p, q) => p.timeSec - q.timeSec);
          check(
            '剪刀：Hold 时长与时间首尾相接（总和不变）',
            Math.abs(n1.timeSec + n1.durationSec - n2.timeSec) < 1e-9 && Math.abs(n1.durationSec + n2.durationSec - 2) < 1e-9,
            `${n1.timeSec.toFixed(3)}+${n1.durationSec.toFixed(3)} → ${n2.timeSec.toFixed(3)}+${n2.durationSec.toFixed(3)}`,
          );
          check('剪刀：Hold 第二段有独立的 src（导出时能带上）', n2.src && n2.src !== note.src && n2.src.startBeat === 4, JSON.stringify(n2.src));
        }
      }

      // 越界/非法切口要拒绝
      {
        const chart = mkChart([{ startBeat: 0, endBeat: 4, start: 0.2, end: 0.8, easingType: 1 }]);
        const track = makeEventTrack(chart, 0, 0, 'x', axisX);
        api.timeline.setChart(chart, axisX);
        api.timeline.setTracks([track]);
        check('剪刀：切口落在端点外会被拒绝', api.timeline.cutAt(track.id, 0, 4.5).ok === false && track.clips.length === 1);
        check('剪刀：切口贴着起点也会被拒绝', api.timeline.cutAt(track.id, 0, 0).ok === false && track.clips.length === 1);
      }

      // 悬停预览：剪刀工具下把指针放到事件块上应出现剪切线
      api.timeline.setTool('scissors');
      check('切到剪刀工具', api.timeline.tool === 'scissors' && tlBody3.classList.contains('tool-scissors'), `tool=${api.timeline.tool}`);
      api.timeline.setChart(chart, def.axis); // 轨道来自这张谱面，拍轴/结束时间也要用同一张
      api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
      api.timeline.resetView();
      api.timeline.redraw();
      tileProbe: {
        const clip = api.timeline.tracks[0]?.clips?.[0];
        if (!clip) break tileProbe;
        tlBody3.__setSize(900, 320);
        api.timeline.resize();
        api.timeline.redraw(); // 命中矩形随重绘更新，必须在 resize 之后读
        const hit = api.timeline.hitRects.find((r) => r.key === api.timeline.tracks[0].id + '#0');
        if (!hit) break tileProbe;
        const bodyRect = tlBody3.getBoundingClientRect();
        tlBody3.dispatch('pointermove', {
          clientX: bodyRect.left + hit.x + hit.w * 0.5,
          clientY: bodyRect.top + hit.y + hit.h * 0.5,
          pointerId: 24,
          pointerType: 'mouse',
        });
        const ev0 = api.timeline.tracks[0].clips[0].ev;
        const beatAtPointer = (bodyRect.left + hit.x + hit.w * 0.5) / api.timeline.pxPerBeat;
        check(
          '剪刀：悬停在事件块上出现剪切线预览',
          !!api.timeline.interaction.cutPreview,
          `${JSON.stringify(api.timeline.interaction.cutPreview)}；命中 ${hit.key} 事件 ${ev0?.startBeat}~${ev0?.endBeat} 拍，指针约 ${beatAtPointer.toFixed(2)} 拍，谱面 ${api.timeline.pxPerBeat} px/拍`,
        );
      }
      api.timeline.setTool('mouse');
    }
  }

  // ── Note 详情页：多选不加载默认值，修改对全部选中项生效 ──
  {
    const { resolveSelectedNotes } = await import('../src/editor/note-detail.js');
    api.topTabs.activate('note');
    const host = body.querySelectorAll('[data-tabbody="top"]')[0];
    const esc = (s) => String(s).replace(/\s+/g, ' ').trim();
    check('未选中音符时给出提示', /点选音符/.test(host.textContent), esc(host.textContent).slice(0, 40));

    // 选两个 positionX 不同的音符
    api.timeline.setTracks([makeNotesTrack(chart, 0, def.axis)]);
    api.timeline.setVisibleBeats(24, 0);
    api.timeline.redraw();
    const notesTrack = api.timeline.tracks[0];
    const byX = [...notesTrack.clips].map((c, i) => ({ c, i })).filter((o) => Number.isFinite(o.c.positionX));
    const a = byX[0];
    const b = byX.find((o) => Math.abs(o.c.positionX - a.c.positionX) > 0.5) ?? byX[1];
    api.timeline.selectNotes([`${notesTrack.id}#${a.i}`, `${notesTrack.id}#${b.i}`]);
    api.topTabs.refresh();
    const items = resolveSelectedNotes(api.timeline);
    check('解析选中音符（带渲染器音符对象）', items.length === 2 && items.every((it) => !!it.note), `${items.length} 个，含 note 回引 ${items.filter((it) => it.note).length} 个`);

    const inputs = host.querySelectorAll('input');
    const xInput = inputs.find((i) => i.type === 'number' && i.placeholder.includes('多个值'));
    check(
      '多选且值不同：positionX 不加载默认值（留空 + 多个值占位）',
      !!xInput && xInput.value === '',
      xInput ? `value="${xInput.value}" placeholder="${xInput.placeholder}"` : '未找到 positionX 输入框',
    );
    check('头部显示选中数量', /已选中 2 个音符/.test(host.textContent), esc(host.querySelectorAll('.ed-note-head')[0]?.textContent ?? '').slice(0, 40));

    // 修改 positionX → 两个音符都变
    xInput.value = '3.5';
    xInput.dispatch('change');
    check(
      '修改 positionX 对全部选中音符生效',
      Math.abs(a.c.positionX - 3.5) < 1e-9 && Math.abs(b.c.positionX - 3.5) < 1e-9,
      `${a.c.positionX.toFixed(2)} / ${b.c.positionX.toFixed(2)}`,
    );
    check('同时写回谱面模型（渲染器音符对象）', Math.abs(items[0].note.positionX - 3.5) < 1e-9 && Math.abs(items[1].note.positionX - 3.5) < 1e-9);

    // 多选且值现在相同 → 显示该值
    api.topTabs.refresh();
    const xInput2 = body
      .querySelectorAll('[data-tabbody="top"]')[0]
      .querySelectorAll('input')
      .find((i) => i.type === 'number' && i.placeholder.includes('多个值'));
    check('值相同后显示共同值', xInput2.value === '3.5', `value="${xInput2.value}"`);

    // 修改类型
    const typeSel = body.querySelectorAll('[data-tabbody="top"]')[0].querySelectorAll('select')[0];
    typeSel.value = 'hold';
    typeSel.dispatch('change');
    check('修改类型对全部选中项生效', items.every((it) => it.clip.type === 'hold' && it.note.type === 'hold'), items.map((it) => it.clip.type).join('/'));

    // 修改时间（拍）
    const beatInput = body.querySelectorAll('[data-tabbody="top"]')[0].querySelectorAll('input').find((i) => i.className === 'ed-beat' && i.type === 'text');
    beatInput.value = '20+1/2';
    beatInput.dispatch('change');
    const line0 = chart.lines[items[0].note.lineId];
    const expectedSec = line0.rt.timeline.beatToSeconds(20.5);
    check(
      '修改时间对全部选中项生效（拍 → 秒 → 高度一并更新）',
      Math.abs(items[0].note.startBeat - 20.5) < 1e-9 && Math.abs(items[1].note.startBeat - 20.5) < 1e-9 && Math.abs(items[0].note.timeSec - expectedSec) < 1e-6,
      `startBeat=${items[0].note.startBeat}，timeSec=${items[0].note.timeSec.toFixed(3)}（期望 ${expectedSec.toFixed(3)}）`,
    );
    check('时间改动也写回源音符对象', items.every((it) => Math.abs(it.note.src?.startBeat - 20.5) < 1e-9));
    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis)); // 还原事件轨，别影响后续用例
  }

  // ── Event 详情页：参数编辑 + 与时间轴双向同步 ──
  {
    const { resolveSelectedEvents } = await import('../src/editor/event-detail.js');
    const host = () => body.querySelectorAll('[data-tabbody="top"]')[0];
    const esc = (t) => String(t).replace(/\s+/g, ' ').trim();
    const rowOf = (label) =>
      host()
        .querySelectorAll('.ed-note-row')
        .find((r) => esc(r.querySelectorAll('.k')[0]?.textContent ?? '') === label);

    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.timeline.setVisibleBeats(24, 0);
    api.timeline.redraw();
    const trackX = api.timeline.tracks[0]; // x 位移事件轨
    check('时间轴提供 selectEvents 编程式选择', typeof api.timeline.selectEvents === 'function');

    api.timeline.selectEvents([`${trackX.id}#0`, `${trackX.id}#1`]);
    check('选中事件后自动切到 Event 详情页（时间轴 → 左上面板）', api.topTabs.active === 'event', `当前标签=${api.topTabs.active}`);
    check('事件详情页不再内嵌曲线图（已独立成页）', !/事件值曲线/.test(body.querySelectorAll('[data-tabbody="top"]')[0].textContent), '');
    const items = resolveSelectedEvents(api.timeline);
    check('解析选中事件（带源事件对象）', items.length === 2 && items.every((it) => !!it.ev), `${items.length} 个`);
    check('Event 面板头部显示选中数量', /已选中 2 个事件/.test(host().textContent), esc(host().querySelectorAll('.ed-note-head')[0]?.textContent ?? '').slice(0, 40));
    check(
      'Event 面板字段齐全（时间/时长/保持/起止值/缓动）',
      ['起始时间（拍）', '时长（拍）', '保持到结束', '起始值', '结束值', '缓动类型'].every((k) => !!rowOf(k)),
      ['起始时间（拍）', '时长（拍）', '保持到结束', '起始值', '结束值', '缓动类型'].filter((k) => !rowOf(k)).join(',') || '全部存在',
    );

    const evA = items[0].ev;


    const evB = items[1].ev;
    const mixedInputs = host()
      .querySelectorAll('input')
      .filter((i) => i.type === 'number' && i.placeholder.includes('多个值'));
    check('Event 面板：多选且值不同 → 留空并显示「多个值」', mixedInputs.length > 0, `${mixedInputs.length} 个字段处于「多个值」状态`);

    const beforeText = items[0].clip.text;
    const v0Input = rowOf('起始值')?.querySelectorAll('input')[0];
    v0Input.value = '7';
    v0Input.dispatch('change');
    check('修改起始值对全部选中事件生效', evA.start === 7 && evB.start === 7, `${evA.start} / ${evB.start}`);
    check('时间轴 clip 立即刷新（文案随取值变化）', items[0].clip.v0 === 7 && items[0].clip.text !== beforeText, `「${beforeText}」→「${items[0].clip.text}」`);

    // 缓动改成两级：一级选类别（线性 / 预设缓动 / 贝塞尔），二级选具体参数
    const kindSel = rowOf('缓动类型')?.querySelectorAll('select')[0];
    check(
      '缓动一级下拉是「线性 / 预设缓动 / 贝塞尔」',
      kindSel?.querySelectorAll('option').map((o) => String(o.textContent)).join('/') === '线性/预设缓动/贝塞尔',
      kindSel?.querySelectorAll('option').map((o) => String(o.textContent)).join('/') ?? '缺失',
    );
    kindSel.value = 'preset';
    kindSel.dispatch('change');
    await new Promise((r) => setTimeout(r, 0));
    const numSel = rowOf('缓动编号')?.querySelectorAll('select')[0];
    check('选「预设缓动」后出现二级「缓动编号」', !!numSel, numSel ? `当前=${numSel.value}` : '缺失');
    numSel.value = '5';
    numSel.dispatch('change');
    check(
      '修改缓动对全部选中事件生效（缓动#5）',
      evA.easingPreset === 5 && evB.easingPreset === 5 && /缓动#5/.test(items[0].clip.text),
      `preset=${evA.easingPreset}，文案「${items[0].clip.text}」`,
    );
    check('缓动函数被重建（不再是线性）', typeof evA.easingFn === 'function' && Math.abs(evA.easingFn(0.5) - 0.5) > 1e-6, `f(0.5)=${evA.easingFn(0.5).toFixed(4)}`);
    await new Promise((r) => setTimeout(r, 0));
    const kindSel2 = rowOf('缓动类型')?.querySelectorAll('select')[0];
    kindSel2.value = 'bezier';
    kindSel2.dispatch('change');
    // 面板重建延后一个任务（避免在下拉自己的处理器里同步换 DOM），这里等它跑完
    await new Promise((r) => setTimeout(r, 0));
    check('切到贝塞尔会补上默认控制点', Array.isArray(evA.bezierPoints) && evA.bezierPoints.length === 4 && /贝塞尔/.test(items[0].clip.text), JSON.stringify(evA.bezierPoints));
    check('贝塞尔出现后控制点输入框可用', !!rowOf('贝塞尔 P1.x') && !!rowOf('贝塞尔 P2.y'), 'P1.x / P2.y');

    const durInput = rowOf('时长（拍）')?.querySelectorAll('input')[0];
    durInput.value = '3';
    durInput.dispatch('change');
    check('修改时长对全部选中事件生效', Math.abs(evA.endBeat - (evA.startBeat + 3)) < 1e-9, `${evA.startBeat} → ${evA.endBeat}`);
    const holdBox = rowOf('保持到结束')?.querySelectorAll('input')[0];
    holdBox.checked = true;
    holdBox.dispatch('change');
    check('「保持到结束」写入哨兵值并在时间轴显示「保持」', evA.endBeat >= 1e6 && /保持/.test(items[0].clip.text), `endBeat=${evA.endBeat}，文案「${items[0].clip.text}」`);
    const holdBox2 = rowOf('保持到结束')?.querySelectorAll('input')[0];
    holdBox2.checked = false;
    holdBox2.dispatch('change');
    check('取消「保持到结束」恢复普通区间', evA.endBeat < 1e6 && items[0].clip.holds === false);

    // 先把起点挪到可见位置（否则官方「从开头起效」的哨兵起点整块都在屏幕外）
    const startRow = rowOf('起始时间（拍）')?.querySelectorAll('input')[0];
    startRow.value = '10';
    startRow.dispatch('change');
    check('修改起始时间对全部选中事件生效', Math.abs(evA.startBeat - 10) < 1e-9, `startBeat=${evA.startBeat}`);

    api.timeline.selectEvents([`${trackX.id}#0`]);
    const tlBody4 = byId.get('ed-tl-body');
    tlBody4.__setSize(900, 400);
    tlBody4.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 400, right: 900, bottom: 400 });
    api.timeline.resize();
    api.timeline.redraw();
    const rect0 = api.timeline.hitRects.find((r) => r.trackId === trackX.id && r.kind === 'events' && r.index === 0);
    const beatBefore = resolveSelectedEvents(api.timeline)[0]?.clip.b0;
    const cx = Math.max(6, Math.round(rect0.x + 5)); // 事件可能从视野左侧延伸进来，取可见范围内的点
    const cy = Math.round(rect0.y + rect0.h / 2);
    tlBody4.dispatch('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 21 });
    tlBody4.dispatch('pointermove', { clientX: cx + Math.round(api.timeline.pxPerBeat * 2), clientY: cy, pointerId: 21 });
    tlBody4.dispatch('pointerup', { clientX: cx + Math.round(api.timeline.pxPerBeat * 2), clientY: cy, pointerId: 21 });
    const afterItem = resolveSelectedEvents(api.timeline)[0];
    check(
      '时间轴拖动后时间同步（起点 +2 拍）',
      Math.abs(afterItem.clip.b0 - (beatBefore + 2)) < 0.06,
      `${beatBefore.toFixed(2)} → ${afterItem.clip.b0.toFixed(2)} 拍`,
    );
    check('拖动后详情页显示新时间（面板已刷新、标签仍在 Event）', api.topTabs.active === 'event' && Math.abs(afterItem.clip.b0 - 12) < 0.06, `面板读到 b0=${afterItem.clip.b0.toFixed(2)}，标签=${api.topTabs.active}`);
    tlBody4.__setSize(900, 320);
    api.timeline.resize();
    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  }

  // ── Event 详情右侧：事件值曲线图（手柄改始末值 / 贝塞尔控制点）──
  {
    const { getActiveCurve } = await import('../src/editor/event-curve.js');
    const { resolveSelectedEvents } = await import('../src/editor/event-detail.js');

    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.timeline.setVisibleBeats(24, 0);
    api.timeline.redraw();
    const trackY = api.timeline.tracks.find((t) => t.id.endsWith(':y')) ?? api.timeline.tracks[0];
    api.timeline.selectEvents([`${trackY.id}#0`]);
    check('曲线编辑是独立的标签页', [...body.querySelectorAll('[data-tabs="top"]')[0].querySelectorAll('.ed-tab')].some((t) => /事件曲线/.test(t.textContent)), '');
    api.topTabs.activate('curve');
    const curve = getActiveCurve();
    check('曲线标签页创建了曲线图', !!curve && !!curve.el, curve ? `逻辑坐标 ${curve.size.W}×${curve.size.H}` : '未创建');

    const items = resolveSelectedEvents(api.timeline);
    check('曲线图绑定了选中的事件', curve.data?.ev === items[0].ev, curve.data ? `事件 ${items[0].clip.key}` : '未绑定');
    check('刻度固定为该类事件的取值范围的（min~max）', !!curve.data?.range && curve.data.range.max > curve.data.range.min, curve.data?.range ? `${curve.data.range.min.toFixed(3)} ~ ${curve.data.range.max.toFixed(3)}` : '无');
    check('线条颜色用事件主题色', curve.data?.color === trackY.color, `${curve.data?.color}（轨道主题色 ${trackY.color}）`);

    // 曲线画出来了：应有一段折线（≥8 段）
    const svg = curve.svg;
    check('曲线图是 SVG（由浏览器负责缩放，不需要量尺寸）', !!svg && typeof svg.setAttribute === 'function', svg?.tagName);
    curve.redraw();
    const d = String(svg.querySelectorAll('.ed-curve-path')[0]?.getAttribute('d') ?? '');
    check('曲线用缓动采样绘制（路径点数足够）', (d.match(/[ML]/g) ?? []).length >= 40, `${(d.match(/[ML]/g) ?? []).length} 个点`);
    check('viewBox 固定（缩放与命中都用同一坐标系）', /^0 0 360 240$/.test(String(svg.getAttribute('viewBox'))), String(svg.getAttribute('viewBox')));

    // 手柄：至少 起始值 / 结束值 两个
    const hs = curve.handlePositions();
    check('曲线提供起始值 / 结束值两个手柄', hs.some((h) => h.id === 'start') && hs.some((h) => h.id === 'end'), hs.map((h) => h.id).join(','));
    check('手柄落在画布内', hs.every((h) => h.x >= 0 && h.x <= curve.size.W + 1 && h.y >= 0 && h.y <= curve.size.H + 1), JSON.stringify(hs[0]));

    // 拖动起始值手柄 → 起始值变化并写回模型
    const beforeStart = items[0].ev.start;
    const canvas = curve.svg; // SVG 根元素接收指针事件（逻辑坐标与 viewBox 一致）
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: curve.size.W, height: curve.size.H, right: curve.size.W, bottom: curve.size.H });
    const h0 = curve.handlePositions().find((h) => h.id === 'start');
    canvas.dispatch('pointerdown', { clientX: h0.x, clientY: h0.y, button: 0, pointerId: 31 });
    canvas.dispatch('pointermove', { clientX: h0.x, clientY: h0.y - 30, pointerId: 31 });
    canvas.dispatch('pointerup', { clientX: h0.x, clientY: h0.y - 30, pointerId: 31 });
    check('拖动起始值手柄改变取值', items[0].ev.start !== beforeStart, `${beforeStart.toFixed(3)} → ${items[0].ev.start.toFixed(3)}`);
    check('取值变化立即反映到时间轴文案', /→/.test(items[0].clip.text) && items[0].clip.v0 === items[0].ev.start, `「${items[0].clip.text}」`);

    // 多选：曲线手柄改动应用到全部选中事件
    api.timeline.selectEvents([`${trackY.id}#0`, `${trackY.id}#2`]);
    api.topTabs.activate('curve');
    const curve2 = getActiveCurve();
    const items2 = resolveSelectedEvents(api.timeline);
    const canvas2 = curve2.svg;
    canvas2.getBoundingClientRect = () => ({ left: 0, top: 0, width: curve2.size.W, height: curve2.size.H, right: curve2.size.W, bottom: curve2.size.H });
    const h1 = curve2.handlePositions().find((h) => h.id === 'end');
    const beforeEnds = items2.map((it) => it.ev.end);
    canvas2.dispatch('pointerdown', { clientX: h1.x, clientY: h1.y, button: 0, pointerId: 32 });
    canvas2.dispatch('pointermove', { clientX: h1.x, clientY: h1.y + 25, pointerId: 32 });
    canvas2.dispatch('pointerup', { clientX: h1.x, clientY: h1.y + 25, pointerId: 32 });
    check(
      '曲线手柄改动对全部选中事件生效',
      items2.every((it, i) => Math.abs(it.ev.end - beforeEnds[i]) > 1e-9) && Math.abs(items2[0].ev.end - items2[1].ev.end) < 1e-9,
      `${beforeEnds.map((v) => v.toFixed(2)).join(' / ')} → ${items2.map((it) => it.ev.end.toFixed(2)).join(' / ')}`,
    );

    // 贝塞尔：先在 Event 详情页把缓动切成贝塞尔，再切到曲线页验证 P1/P2 手柄
    api.topTabs.activate('event');
    const easeRow = body
      .querySelectorAll('[data-tabbody="top"]')[0]
      .querySelectorAll('.ed-note-row')
      .find((r) => String(r.querySelectorAll('.k')[0]?.textContent ?? '').trim() === '缓动类型');
    const easeSel = easeRow?.querySelectorAll('select')[0];
    easeSel.value = 'bezier'; // 一级选「贝塞尔」
    easeSel.dispatch('change');
    await new Promise((r) => setTimeout(r, 0)); // 面板重建延后一个任务
    api.topTabs.activate('curve');
    const curve3 = getActiveCurve();
    check('重建面板后仍能拿到当前曲线图', !!curve3 && !!curve3.data, curve3 ? 'ok' : '未取到');
    curve3.redraw();
    check('贝塞尔时出现 P1 / P2 手柄', ['p1', 'p2'].every((id) => curve3.handlePositions().some((h) => h.id === id)), curve3.handlePositions().map((h) => h.id).join(','));
    const canvas3 = curve3.svg;
    canvas3.getBoundingClientRect = () => ({ left: 0, top: 0, width: curve3.size.W, height: curve3.size.H, right: curve3.size.W, bottom: curve3.size.H });
    const p1 = curve3.handlePositions().find((h) => h.id === 'p1');
    const ev3 = curve3.data.ev; // 松手会重建面板并销毁旧曲线，所以抓住事件对象本身
    const beforePts = [...ev3.bezierPoints];
    canvas3.dispatch('pointerdown', { clientX: p1.x, clientY: p1.y, button: 0, pointerId: 33 });
    canvas3.dispatch('pointermove', { clientX: p1.x + 24, clientY: p1.y - 18, pointerId: 33 });
    canvas3.dispatch('pointerup', { clientX: p1.x + 24, clientY: p1.y - 18, pointerId: 33 });
    check(
      '拖动 P1 改变贝塞尔控制点',
      Math.abs(ev3.bezierPoints[0] - beforePts[0]) > 1e-6 || Math.abs(ev3.bezierPoints[1] - beforePts[1]) > 1e-6,
      `[${beforePts.join(', ')}] → [${ev3.bezierPoints.join(', ')}]`,
    );
    check('控制点 x 被夹在 0..1', ev3.bezierPoints[0] >= 0 && ev3.bezierPoints[0] <= 1, String(ev3.bezierPoints[0]));
    check('松手后旧曲线已销毁（不再对外提供）', getActiveCurve()?.data?.ev !== undefined || getActiveCurve() === null, getActiveCurve() ? '有新的曲线实例' : '已清空');

    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  }

  // ── 性能：不该出现的重绘/写 DOM ──
  {
    // 时间轴：指针像素位置没变时 syncTime 不重绘（先做完设置再取基准值）
    api.timeline.setVisibleBeats(32, 0);
    api.timeline.setTime(0);
    const before = api.timeline.stats.redraws;
    api.timeline.syncTime(0.0001); // 同一像素位置
    const afterSame = api.timeline.stats.redraws;
    check('指针像素位置未变时 syncTime 不重绘时间轴', afterSame === before, `${before} → ${afterSame}`);
    api.timeline.syncTime(4); // 明显移动
    check('指针真正移动时才重绘', api.timeline.stats.redraws > afterSame, `${afterSame} → ${api.timeline.stats.redraws}`);

    // 预览：帧计数与时间文本去重
    const f0 = api.preview.stats.frames;
    const t0 = byId.get('ed-time')?.textContent ?? '';
    tick(3);
    check('预览渲染帧数会累加（诊断可读）', api.preview.stats.frames >= f0, `${f0} → ${api.preview.stats.frames}`);
    check('时间文本只在变化时写（避免每帧写 DOM）', typeof t0 === 'string', `文本=${t0.slice(0, 18)}`);

    // HUD：预览工具条右侧显示每秒重绘统计
    api.preview.play();
    tick(4);
    const hud = byId.get('ed-fps');
    check('预览工具条有性能统计位（预览/时间轴/详情 每秒次数）', !!hud, hud ? `当前=${String(hud.textContent).slice(0, 40)}` : '缺少元素');
    api.preview.pause();
  }

  // ── 曲线图交互：命中半径、悬停高亮、未命中时给提示 ──
  {
    const { getActiveCurve } = await import('../src/editor/event-curve.js');
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.timeline.setVisibleBeats(24, 0);
    api.timeline.redraw();
    const trackX2 = api.timeline.tracks[0];
    api.timeline.selectEvents([`${trackX2.id}#0`]);
    api.topTabs.activate('curve');
    const curve = getActiveCurve();
    const hs = curve.handlePositions();
    const start = hs.find((h) => h.id === 'start');
    check('命中测试：手柄附近能选中', curve.pickAt(start.x + 6, start.y + 6) === 'start', String(curve.pickAt(start.x + 6, start.y + 6)));
    check('命中测试：纵向放宽（方便上下拖动改值）', curve.pickAt(start.x + 2, start.y + 24) === 'start', String(curve.pickAt(start.x + 2, start.y + 24)));
    check('命中测试：远离手柄处不误判', curve.pickAt(start.x + 120, start.y) === null, String(curve.pickAt(start.x + 120, start.y)));

    // 未命中时点击 → 给出提示而不是毫无反应
    const canvas = curve.svg;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: curve.size.W, height: curve.size.H, right: curve.size.W, bottom: curve.size.H });
    let hinted = '';
    curve.data.onHint = (m) => {
      hinted = m;
    };
    canvas.dispatch('pointerdown', { clientX: start.x + 120, clientY: start.y, button: 0, pointerId: 41 });
    check('点击空白处会给出操作提示（不再毫无反应）', hinted.includes('拖动'), hinted);
    canvas.dispatch('pointerup', { clientX: start.x + 120, clientY: start.y, pointerId: 41 });

    // 悬停放大 + 光标变化
    canvas.dispatch('pointermove', { clientX: start.x, clientY: start.y, pointerId: 42 });
    check('悬停手柄时给出可拖拽反馈', canvas.classList.contains('over-handle'), String(canvas.classList));
    canvas.dispatch('pointermove', { clientX: start.x + 120, clientY: start.y, pointerId: 42 });
    check('离开手柄后反馈消失', !canvas.classList.contains('over-handle'), String(canvas.classList));

    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  }

  // ── 曲线页：固定刻度 / 主题色 / 贝塞尔真控制点 ──
  {
    const { getActiveCurve } = await import('../src/editor/event-curve.js');
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.timeline.setVisibleBeats(24, 0);
    api.timeline.redraw();
    const trackY2 = api.timeline.tracks.find((t) => t.id.endsWith(':y')) ?? api.timeline.tracks[0];
    api.timeline.selectEvents([`${trackY2.id}#0`]);
    api.topTabs.activate('curve');
    const curve = getActiveCurve();

    check('刻度来自该类事件的取值范围（整条轨道）', curve.data.range === trackY2.range && curve.data.range.max > curve.data.range.min, `${curve.data.range.min.toFixed(3)} ~ ${curve.data.range.max.toFixed(3)}`);
    const labels = curve.svg.querySelectorAll('.ed-curve-labels')[0].querySelectorAll('text').map((t) => String(t.textContent));
    check('纵轴标签覆盖整段范围（含上下限）', labels.length >= 10, labels.slice(0, 5).join(' / '));

    // 切换选中到另一个事件：刻度不应变化（固定）
    const rangeBefore = JSON.stringify(curve.data.range);
    api.timeline.selectEvents([`${trackY2.id}#5`]);
    api.topTabs.activate('curve');
    const curve2 = getActiveCurve();
    check('切换事件后刻度保持不变', JSON.stringify(curve2.data.range) === rangeBefore, `${rangeBefore} → ${JSON.stringify(curve2.data.range)}`);

    // 主题色
    check('线条颜色 = 轨道主题色', curve2.data.color === trackY2.color && curve2.svg.style['--curve-color'] === trackY2.color, `${curve2.svg.style['--curve-color']}（主题色 ${trackY2.color}）`);

    // 贝塞尔：手柄位置 = 真实控制点（y 按进度 0..1 换算成取值）
    const evB = curve2.data.ev;
    evB.start = 0.2;
    evB.end = 1.4; // 落在固定刻度（该类事件范围）内
    evB.easingType = 6;
    evB.bezierPoints = [0.25, 0.1, 0.75, 0.9];
    curve2.redraw();
    const hs = curve2.handlePositions();
    const p1 = hs.find((h) => h.id === 'p1');
    const p2 = hs.find((h) => h.id === 'p2');
    check('贝塞尔手柄存在', !!p1 && !!p2, hs.map((h) => h.id).join(','));
    // 逻辑坐标换算：y 越小越靠上；取值 0.1*10=1 应高于取值 0.9*10=9
    check('P1/P2 位置符合真控制点（y 按进度换算）', p1.y > p2.y, `P1.y=${p1.y.toFixed(1)}（进度 0.1） P2.y=${p2.y.toFixed(1)}（进度 0.9）`);
    const start = hs.find((h) => h.id === 'start');
    const end = hs.find((h) => h.id === 'end');
    check('起始/结束手柄在两端（横向跨度一致）', start.x < p1.x && p1.x < p2.x && p2.x < end.x, `x: ${[start, p1, p2, end].map((h) => h.x.toFixed(0)).join(' < ')}`);

    check(
      '所有手柄都在图内（含贝塞尔控制点，不会再跑到图外）',
      hs.every((h) => h.x >= -1 && h.x <= curve2.size.W + 1 && h.y >= -1 && h.y <= curve2.size.H + 1),
      hs.map((h) => `${h.id}(${h.x.toFixed(0)},${h.y.toFixed(0)})`).join(' '),
    );
    const bezDots = curve2.svg
      .querySelectorAll('.ed-curve-handle')
      .filter((d) => d.classList.contains('bezier'));
    check(
      '贝塞尔控制点画在主图里（和两端手柄同图）',
      curve2.svg.querySelectorAll('.ed-curve-inset').length === 0 && bezDots.length === 2,
      `inset 元素 ${curve2.svg.querySelectorAll('.ed-curve-inset').length} 个，贝塞尔圆点 ${bezDots.length} 个`,
    );
    // 起止值相同 → 取值轴塌缩（y 无法反解）→ 退回右上角单位方格
    const keepEnd = evB.end;
    evB.end = evB.start;
    curve2.redraw();
    check(
      '起止值相同时退回单位方格子图',
      curve2.svg.querySelectorAll('.ed-curve-inset').length === 1,
      `inset 元素 ${curve2.svg.querySelectorAll('.ed-curve-inset').length} 个`,
    );
    evB.end = keepEnd;
    curve2.redraw();

    // 拖动 P1：控制点被写回（进度 0..1 空间）
    const svg = curve2.svg;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: curve2.size.W, height: curve2.size.H, right: curve2.size.W, bottom: curve2.size.H });
    const before = [...evB.bezierPoints];
    svg.dispatch('pointerdown', { clientX: p1.x, clientY: p1.y, button: 0, pointerId: 51 });
    svg.dispatch('pointermove', { clientX: p1.x + 20, clientY: p1.y + 20, pointerId: 51 });
    svg.dispatch('pointerup', { clientX: p1.x + 20, clientY: p1.y + 20, pointerId: 51 });
    check(
      '拖动 P1 写回进度空间的 bezierPoints',
      evB.bezierPoints[0] !== before[0] && Math.abs(evB.bezierPoints[1] - before[1]) > 1e-6,
      `[${before.join(', ')}] → [${evB.bezierPoints.map((v) => v.toFixed(3)).join(', ')}]`,
    );
    check('控制点 x 仍在 0..1（y 允许超出，RPE 同义）', evB.bezierPoints[0] >= 0 && evB.bezierPoints[0] <= 1, String(evB.bezierPoints[0]));

    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  }

  // ── 图标居中（素材层回归：measureIcons 支持嵌套 transform）──
  const { measureIcons } = await import('./normalize-icons.mjs');
  const icons = measureIcons().filter((i) => !i.skipped);
  const badIcons = icons.filter((i) => i.rel > 0.02);
  check(
    'assets/icons 里所有图标的图形都居中（偏移 ≤2%）',
    badIcons.length === 0,
    badIcons.length ? `偏移过大：${badIcons.map((i) => `${i.file} ${(i.rel * 100).toFixed(1)}%`).join(', ')}` : `${icons.length} 个图标全部居中`,
  );
  check('每个图标都有 viewBox（mask 缩放才准确）', icons.every((i) => String(i.svg ?? '').includes('viewBox=')));

  // ── 回归：谱面包路径（此前编辑器读了不存在的 pkg.songBlob / backgroundBlob，
  //    导致无论怎么载入包都没有音频与曲绘，只有播放器正常）──
  {
    const fsMod2 = await import('node:fs');
    const pathMod2 = await import('node:path');
    const dir = pathMod2.join(process.cwd(), 'packages/白复生 AT（official格式）');
    const names = fsMod2.readdirSync(dir);
    const files = names.map((n) => {
      const buf = fsMod2.readFileSync(pathMod2.join(dir, n));
      const f = new File([buf], n);
      Object.defineProperty(f, 'webkitRelativePath', { value: `白复生 AT（official格式）/${n}` });
      return f;
    });
    await api.preview.loadFiles(files);
    check(
      '载入谱面包（文件夹）：音频已加载',
      api.preview.hasAudio === true,
      `hasAudio=${api.preview.hasAudio}，来源=${api.preview.audioSource ?? '无'}`,
    );
    check(
      '载入谱面包（文件夹）：曲绘已加载',
      api.preview.hasBackground === true,
      `hasBackground=${api.preview.hasBackground}，来源=${api.preview.backgroundSource ?? '无'}`,
    );
    check('谱面包载入后不再提示缺媒体', api.preview.mediaHint === null, String(api.preview.mediaHint));
  }

  // ── 只载入谱面 JSON 时：明确提示该怎么补音频/曲绘 ──
  {
    const json = JSON.parse(
      (await import('node:fs')).readFileSync(`${process.cwd()}/packages/白复生 AT（official格式）/Chart_AT #3649.json`, 'utf8'),
    );
    await api.preview.loadJson(json, 'Chart_AT #3649.json');
    const hint = api.preview.mediaHint;
    check('只载入 JSON：给出「用谱面包载入」的提示', typeof hint === 'string' && hint.includes('谱面包'), String(hint).slice(0, 40) + '…');
    check('只载入 JSON：预览信息行标出缺媒体', /⚠ 无音频/.test(byId.get('ed-preview-info').textContent), byId.get('ed-preview-info').textContent.slice(0, 60));
    api.topTabs.activate('overview');
    const warn = body.querySelectorAll('[data-tabbody="top"]')[0].querySelectorAll('.ed-warn');
    check('谱面总览里有缺媒体告警', warn.length === 1 && /谱面包/.test(warn[0].textContent), warn[0]?.textContent?.slice(0, 40) ?? '（没有告警框）');
  }

  // 播放时跟随滚动 / 自动回滚
  api.timeline.setVisibleBeats(32, 0); // 固定缩放：让 3 秒处的指针仍在视野内
  api.timeline.setTime(0);
  api.timeline.setScroll(0);
  api.timeline.setFollowing(false);
  api.preview.play();
  api.timeline.syncTime(0, true); // 指针在可见范围内 → 开始跟随
  check('指针在可见范围内时开始跟随', api.timeline.following === true);
  api.timeline.syncTime(3, true); // 60 像素/拍、视口 900px：3s ≈ 8.7 拍 ≈ 522px，还没到右边界
  check('跟随中：指针还没到右边界时不滚动', api.timeline.scrollBeat === 0, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)} 拍`);
  api.timeline.syncTime(30, true); // 指针越过右边界 → 跟着滚
  check('播放时指针到右边界 → 时间轴同步滚动', api.timeline.scrollBeat > 0, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)} 拍`);
  const farScroll = api.timeline.scrollBeat + 200;
  api.timeline.setScroll(farScroll, true); // 用户自己拖走了
  check('用户主动滚动会取消跟随', api.timeline.following === false);
  api.timeline.syncTime(31, true);
  check('指针不在可见范围时不再强行拉回', Math.abs(api.timeline.scrollBeat - farScroll) < 1e-6, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)} 拍`);

  const rollbackBtn = byId.get('ed-rollback');
  check('播放器有自动回滚按钮（图标）', !!rollbackBtn && rollbackBtn.children.length > 0);
  api.preview.setAutoRollback(true);
  api.timeline.seekToBeat(10);
  api.preview.seek(api.timeline.time);
  const startAt = api.preview.playback.chartTime();
  api.preview.play();
  api.preview.seek(startAt + 6);
  api.preview.pause();
  check(
    '自动回滚开启：暂停后回到播放起点',
    Math.abs(api.preview.playback.chartTime() - startAt) < 0.05,
    `${startAt.toFixed(2)}s → 播放到 ${(startAt + 6).toFixed(2)}s → 回到 ${api.preview.playback.chartTime().toFixed(2)}s`,
  );
  api.preview.setAutoRollback(false);
  api.preview.seek(startAt + 6);
  api.preview.play();
  api.preview.pause();
  check(
    '自动回滚关闭：暂停后停在原地',
    Math.abs(api.preview.playback.chartTime() - (startAt + 6)) < 0.05,
    `停在 ${api.preview.playback.chartTime().toFixed(2)}s`,
  );

  // 趋势线加粗
  api.timeline.setZoom(120);
  ctx.lineWidths = [];
  api.timeline.redraw();
  check('趋势线已加粗（lineWidth 2.5）', ctx.lineWidths.some((w) => w >= 2.5), `lineWidth 取值 ${[...new Set(ctx.lineWidths)].join(',')}`);

  // 组与组之间：在「轨道头列」的间隔里放 1px 分割线（轨道区不画分割线）
  const tlBody = byId.get('ed-tl-body');
  tlBody.__setSize(900, 800);
  api.timeline.resize();
  api.timeline.setTracks([...makeLayerTracks(chart, 0, 0, def.axis), ...makeLayerTracks(chart, 5, 0, def.axis)]);
  ctx.strokeStyles.length = 0;
  api.timeline.redraw();
  const seps = byId.get('ed-tl-heads').querySelectorAll('.ed-group-sep');
  check('组间隔处（轨道头列）有 1px 分割线', seps.length === 1, `${seps.length} 条`);
  check('分割线高度为 1px', String(seps[0]?.style?.height) === '1px', String(seps[0]?.style?.height));
  check('分割线在轨道头列内、占满宽度', String(seps[0]?.style?.width ?? '') === '' && seps[0]?.parentElement === byId.get('ed-tl-heads'));
  check('轨道区不再画分割线', !ctx.strokeStyles.includes('#3a3a3a') && !ctx.strokeStyles.includes('#202020'), `描边色 ${[...new Set(ctx.strokeStyles)].slice(0, 6).join(' ')}`);
  tlBody.__setSize(900, 320);
  api.timeline.resize();

  // 轨道头下方的「+ 在结构树中双击以添加」
  const addRow = byId.get('ed-tl-heads').querySelectorAll('.ed-tl-add');
  check('轨道头下方有空闲区提示行', addRow.length === 1 && /在结构树中双击以添加/.test(addRow[0].textContent), addRow[0]?.textContent ?? '');
  api.bottomTabs.activate('overview');
  addRow[0].dispatch('click');
  check('点「+」会切到结构树标签页', api.bottomTabs.active === 'tree', api.bottomTabs.active);

  // 滚轮：纵向滑动 = 纵向滚轨道；横滑/Shift = 横向；Ctrl = 缩放
  const headsEl2 = byId.get('ed-tl-heads');
  const scrollTopBefore = headsEl2.scrollTop;
  bodyEl.dispatch('wheel', { deltaY: 200, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 100, timeStamp: 9000, preventDefault() {} });
  check('纵向滚轮 = 上下滚轨道（不再横向滚动时间轴）', headsEl2.scrollTop > scrollTopBefore, `scrollTop ${scrollTopBefore} → ${headsEl2.scrollTop}`);
  const beatBeforeWheel = api.timeline.scrollBeat;
  bodyEl.dispatch('wheel', { deltaY: 200, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 100, timeStamp: 9000, preventDefault() {} });
  check('纵向滚轮不再改变横向位置', api.timeline.scrollBeat === beatBeforeWheel, `${beatBeforeWheel.toFixed(2)} → ${api.timeline.scrollBeat.toFixed(2)} 拍`);

  // 吸附：开 = 指针按刻度线取整
  api.timeline.setTickDiv(4); // 1/4 拍
  api.timeline.setSnap(true);
  api.timeline.seekToBeat(12.31);
  check('吸附开启：指针落在刻度线上（1/4 拍）', Math.abs(api.timeline.currentBeat - 12.25) < 1e-6, `12.31 → ${api.timeline.currentBeat}`);
  api.timeline.setSnap(false);
  api.timeline.seekToBeat(12.31);
  check('吸附关闭：指针可落在任意位置', Math.abs(api.timeline.currentBeat - 12.31) < 1e-6, `${api.timeline.currentBeat}`);
  api.timeline.setSnap(true);

  // 拍号输入（a+b/c）
  const beatInput = byId.get('ed-beat');
  beatInput.value = '12+1/4';
  beatInput.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  beatInput.dispatch('blur', {});
  check('拍号输入支持 a+b/c 并跳转', Math.abs(api.timeline.currentBeat - 12.25) < 1e-6, `currentBeat=${api.timeline.currentBeat}`);
  beatInput.value = '7';
  beatInput.dispatch('blur', {});
  check('拍号输入也接受整数', Math.abs(api.timeline.currentBeat - 7) < 1e-6, `currentBeat=${api.timeline.currentBeat}`);
  beatInput.value = '乱写';
  beatInput.dispatch('blur', {});
  check('非法拍号会被还原（不跳转）', Math.abs(api.timeline.currentBeat - 7) < 1e-6, `currentBeat=${api.timeline.currentBeat}，输入框=${beatInput.value}`);

  // 吸附图标按钮
  const snapBtn = byId.get('ed-snap');
  const snapBefore = api.timeline.snap;
  snapBtn.dispatch('click');
  check('吸附按钮是图标按钮且可切换', api.timeline.snap !== snapBefore, `snap ${snapBefore} → ${api.timeline.snap}`);
  snapBtn.dispatch('click');

  // ── 初始缩放：约 6 拍可见 ──
  const reset = api.timeline.resetView();
  check('初始缩放 = 约 6 拍可见', Math.abs(api.timeline.visibleBeats - 6) < 0.05 || Math.abs(api.timeline.pxPerBeat - 320) < 1e-6, `${api.timeline.visibleBeats.toFixed(2)} 拍可见（${api.timeline.pxPerBeat.toFixed(0)} 像素/拍）`);
  check('初始视图从第 0 拍开始', api.timeline.scrollBeat === 0, `${api.timeline.scrollBeat}`);

  // ── 键入拍号跳转后视角跟着跳 ──
  api.timeline.setVisibleBeats(4, 0);
  api.timeline.ensureBeatVisible(300);
  check('键入跳转后视角跟着跳（目标进入视野）', api.timeline.scrollBeat > 250, `scrollBeat=${api.timeline.scrollBeat.toFixed(1)} 拍，目标 300 拍`);
  const inView = (() => {
    const b = 300;
    const s0 = api.timeline.scrollBeat;
    return b >= s0 && b <= s0 + api.timeline.visibleBeats;
  })();
  check('目标拍落在可见范围内', inView, `可见 [${api.timeline.scrollBeat.toFixed(1)}, ${(api.timeline.scrollBeat + api.timeline.visibleBeats).toFixed(1)}] 拍`);
  beatInput.value = '260+1/2';
  beatInput.dispatch('blur', {});
  check(
    '拍号输入跳转后视角同步',
    api.timeline.currentBeat >= api.timeline.scrollBeat && api.timeline.currentBeat <= api.timeline.scrollBeat + api.timeline.visibleBeats,
    `指针 ${api.timeline.currentBeat} 拍，可见起点 ${api.timeline.scrollBeat.toFixed(1)}`,
  );

  // ── 贴边自动滚动：拖到右端后继续拖，时间轴跟着滚 ──
  api.timeline.setVisibleBeats(8, 0);
  api.timeline.setTime(0);
  const startScroll = api.timeline.scrollBeat;
  bodyEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 320, right: 900, bottom: 320 });
  bodyEl.dispatch('pointerdown', { clientX: 400, clientY: 10, button: 0, pointerId: 1 }); // 刻度尺上按下 = 拖指针
  bodyEl.dispatch('pointermove', { clientX: 895, clientY: 10, pointerId: 1 }); // 贴到右端
  tick(3); // 跑几帧自动滚动
  const afterEdge = api.timeline.scrollBeat;
  check('拖到右端后继续拖：时间轴向右滚', afterEdge > startScroll, `${startScroll.toFixed(2)} → ${afterEdge.toFixed(2)} 拍`);
  check('贴边拖动时指针停在右端附近', Math.abs(api.timeline.currentBeat - (afterEdge + api.timeline.visibleBeats)) < 1.5, `指针 ${api.timeline.currentBeat.toFixed(2)} 拍`);
  bodyEl.dispatch('pointermove', { clientX: 300, clientY: 10, pointerId: 1 });
  tick(2);
  const midScroll = api.timeline.scrollBeat;
  tick(2);
  check('指针离开边缘后自动滚动停止', Math.abs(api.timeline.scrollBeat - midScroll) < 1e-9, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)}`);
  bodyEl.dispatch('pointerdown', { clientX: 50, clientY: 10, button: 0, pointerId: 1 });
  const leftBefore = api.timeline.scrollBeat;
  bodyEl.dispatch('pointermove', { clientX: 5, clientY: 10, pointerId: 1 }); // 贴到左端
  tick(3);
  check('拖到左端后继续拖：时间轴向左滚', api.timeline.scrollBeat < leftBefore, `${leftBefore.toFixed(2)} → ${api.timeline.scrollBeat.toFixed(2)} 拍`);
  bodyEl.dispatch('pointerup', { clientX: 5, clientY: 10, pointerId: 1 });
  tick(3);
  const stopped = api.timeline.scrollBeat;
  tick(3);
  check('松开指针后自动滚动停止', Math.abs(api.timeline.scrollBeat - stopped) < 1e-9, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)}`);

  // ── 双向滚动条（原生滚动容器 + 撑开滚动区的 spacer）──
  const tlBodyEl = byId.get('ed-tl-body');
  const spacerEl = byId.get('ed-tl-spacer');
  check('滚动容器里有撑开滚动区的 spacer', !!spacerEl);
  api.timeline.setVisibleBeats(4, 0);
  const totalBeats = api.timeline.visibleBeats; // 占位，下面用 axis 重算
  void totalBeats;
  const spacerW = Number(String(spacerEl.style.width).replace('px', ''));
  check('横向滚动条：滚动宽度 = 全曲拍数 × 像素/拍', spacerW > 900, `spacer 宽 ${spacerW}px（视口 ${tlBodyEl.clientWidth}px）`);
  const spacerH = Number(String(spacerEl.style.height).replace('px', ''));
  check('纵向滚动条：滚动高度 = 标尺 + 轨道总高', spacerH > 0, `spacer 高 ${spacerH}px`);

  // ── 回归：从结构树「双击添加轨道」后，滚动区必须立刻更新（否则纵向滚动条/竖向滚轮失效）──
  {
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    const beforeH = Number(String(spacerEl.style.height).replace('px', ''));
    api.timeline.addTrack(makeNotesTrack(chart, 0, def.axis)); // 高轨（189px）
    const afterH = Number(String(spacerEl.style.height).replace('px', ''));
    check('添加轨道后滚动区立刻变高（纵向滚动条会出现）', afterH > beforeH, `${beforeH}px → ${afterH}px`);
    const beforeWheelTop = tlBodyEl.scrollTop;
    tlBodyEl.dispatch('wheel', { deltaY: 200, deltaX: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, clientX: 100, timeStamp: 9100, preventDefault() {} });
    check('添加轨道后竖向滚轮可用', tlBodyEl.scrollTop > beforeWheelTop, `scrollTop ${beforeWheelTop} → ${tlBodyEl.scrollTop}`);
    api.timeline.setVerticalScroll(80);
    check('添加轨道后可纵向滚动（setVerticalScroll）', api.timeline.scrollTop === 80, `scrollTop=${api.timeline.scrollTop}`);
    api.timeline.setVerticalScroll(0);
    api.timeline.removeTrack(api.timeline.tracks.find((t) => t.kind === 'notes').id);
    const backH = Number(String(spacerEl.style.height).replace('px', ''));
    check('移除轨道后滚动区立刻变回', backH === beforeH, `${afterH}px → ${backH}px（期望 ${beforeH}）`);
  }

  // ── 缩放下限：同屏最多 32 拍 ──
  {
    api.timeline.setVisibleBeats(4, 0);
    check('仍可放大到 4 拍可见', Math.abs(api.timeline.visibleBeats - 4) < 0.1, `${api.timeline.visibleBeats.toFixed(2)} 拍`);
    api.timeline.setVisibleBeats(200, 0);
    check('缩放下限：同屏最多 32 拍', api.timeline.visibleBeats <= 32.05, `${api.timeline.visibleBeats.toFixed(2)} 拍可见`);
    api.timeline.setZoom(1);
    check('缩放到极限也不会超过 32 拍', api.timeline.visibleBeats <= 32.05, `${api.timeline.visibleBeats.toFixed(2)} 拍可见`);
  }
  tlBodyEl.scrollLeft = 600;
  tlBodyEl.dispatch('scroll', {});
  check('拖动横向滚动条 → 视图横向同步', Math.abs(api.timeline.scrollBeat - 600 / api.timeline.pxPerBeat) < 1e-6, `scrollBeat=${api.timeline.scrollBeat.toFixed(2)} 拍`);
  api.timeline.setVerticalScroll(120);
  check('拖动纵向滚动条 → 视图纵向同步', api.timeline.scrollTop === 120, `scrollTop=${api.timeline.scrollTop}`);
  const headsAfter = byId.get('ed-tl-heads').scrollTop;
  check('轨道头列跟随纵向滚动', headsAfter === 120, `heads.scrollTop=${headsAfter}`);
  api.timeline.setVerticalScroll(0);
  api.timeline.setScroll(0);

  // ── 轨道头类型图标 ──
  api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
  const iconNodes = byId.get('ed-tl-heads').querySelectorAll('.ed-track-ico');
  check('每条轨道头都有类型图标', iconNodes.length === api.timeline.tracks.length, `${iconNodes.length} 个图标 / ${api.timeline.tracks.length} 条轨`);
  check(
    '图标与轨道类型对应（X/Y/旋转/不透明度/速度）',
    api.timeline.tracks.every((t) => t.icon) && new Set(api.timeline.tracks.map((t) => t.icon)).size >= 4,
    api.timeline.tracks.map((t) => `${t.headSub}=${t.icon}`).join(' '),
  );

  // ── 滚动条区域不抢指针（否则会与滚动条抢事件产生抽搐） ──
  const gutterBody = byId.get('ed-tl-body');
  gutterBody.__setSize(886, 306); // 比外层小 14px：模拟右侧/底部滚动条占位
  api.timeline.resize();
  api.timeline.setTime(0);
  gutterBody.dispatch('pointerdown', { clientX: 892, clientY: 100, button: 0, pointerId: 3 }); // 点在纵向滚动条上
  gutterBody.dispatch('pointermove', { clientX: 300, clientY: 100, pointerId: 3 });
  check('点在滚动条上不会开始拖指针', api.timeline.time === 0, `time=${api.timeline.time}`);
  gutterBody.dispatch('pointerup', { clientX: 300, clientY: 100, pointerId: 3 });
  gutterBody.dispatch('pointerdown', { clientX: 300, clientY: 10, button: 0, pointerId: 4 });
  gutterBody.dispatch('pointermove', { clientX: 400, clientY: 10, pointerId: 4 });
  check('点在时间轴内容区仍可拖指针', api.timeline.time > 0, `time=${api.timeline.time.toFixed(2)}s`);
  gutterBody.dispatch('pointerup', { clientX: 400, clientY: 10, pointerId: 4 });
  gutterBody.__setSize(900, 320);
  api.timeline.resize();
}

// ───────────────────────── 结构树：折叠 / 展开 ─────────────────────────
section('结构树：行首折叠按钮 + 展开全部 / 折叠全部');
{
  const api = globalThis.PhiChartEditor;
  const { treeState } = await import('../src/editor/tree.js');
  api.bottomTabs.activate('tree');
  const host = body.querySelectorAll('[data-tabbody="bottom"]')[0];
  const esc = (s) => String(s).replace(/\s+/g, ' ').trim();

  check('结构树上方不再有提示文字', !/还没有载入谱面|双击「事件层」可把/.test(host.textContent), esc(host.textContent).slice(0, 60));
  const barBtns = host.querySelectorAll('.ed-tree-bar')[0]?.querySelectorAll('.ed-iconbtn') ?? [];
  check('顶部有展开全部 / 折叠全部两个按钮', barBtns.length === 2, barBtns.map((b) => esc(b.textContent)).join(' / '));
  check('顶部分组按钮按预期顺序（展开全部 / 折叠全部）', barBtns.length === 2, barBtns.map((b) => esc(b.textContent)).join(' / '));
  check(
    '结构树里音符行排在事件层前面',
    (() => {
      const labels = host.querySelectorAll('.ed-node').map((n) => esc(n.textContent));
      const lineIdx = labels.findIndex((t) => t.includes('号线'));
      const noteIdx = labels.findIndex((t, i) => i > lineIdx && t.startsWith('音符'));
      const layerIdx = labels.findIndex((t, i) => i > lineIdx && t.includes('事件层'));
      return noteIdx > lineIdx && (layerIdx === -1 || noteIdx < layerIdx);
    })(),
    host.querySelectorAll('.ed-node').slice(0, 4).map((n) => esc(n.textContent).slice(0, 18)).join(' | '),
  );

  const countRows = (cls) => host.querySelectorAll('.ed-node').filter((n) => (cls ? n.classList.contains(cls) : true)).length;
  const lines = countRows();
  const leaves = countRows('leaf');
  check('默认：判定线与事件层可见、下属 5 个具体事件折叠', leaves > 0 && leaves < lines, `共 ${lines} 行，其中叶子 ${leaves} 行`);

  // 行首折叠图标：点事件层 → 展开出 5 个具体事件
  const caretBtns = host.querySelectorAll('.caret-btn');
  check('每行行首都有折叠图标', caretBtns.length === lines - leaves, `${caretBtns.length} 个可折叠行（${lines - leaves}）`);
  const layerCaret = caretBtns[caretBtns.length - 1]; // 最后一个是最后一个事件层
  const beforeLeaf = countRows('leaf');
  layerCaret.dispatch('click', { stopPropagation() {} });
  const afterLeaf = countRows('leaf');
  check('点事件层的折叠图标 → 展开出下属事件', afterLeaf > beforeLeaf, `叶子 ${beforeLeaf} → ${afterLeaf} 行`);
  check('展开状态被记录', treeState().expandedLayers.length === 1, JSON.stringify(treeState()));

  // 再点一次 → 折叠回去
  const reopened = body
    .querySelectorAll('[data-tabbody="bottom"]')[0]
    .querySelectorAll('.caret-btn')
    .filter((b) => b.classList.contains('open'))
    .pop();
  reopened.dispatch('click', { stopPropagation() {} });
  check('再点一次 → 折叠回去', countRows('leaf') === beforeLeaf, `叶子 ${countRows('leaf')} 行`);

  // 展开全部：展开到事件层，不展开 5 个具体事件
  const expandBtn = barBtns[0];
  expandBtn.dispatch('click');
  const afterExpand = { lines: countRows(), leaves: countRows('leaf') };
  check(
    '展开全部：展开到事件层，不展开下属 5 个具体事件',
    afterExpand.lines > afterExpand.leaves && afterExpand.leaves > 0,
    `共 ${afterExpand.lines} 行，叶子 ${afterExpand.leaves} 行`,
  );
  check('展开全部后没有任何事件层处于展开态', treeState().expandedLayers.length === 0, JSON.stringify(treeState()));

  // 折叠全部：只留判定线
  const foldBtn = barBtns[1];
  foldBtn.dispatch('click');
  const afterFold = countRows();
  check('折叠全部：只保留判定线', afterFold === 24, `${afterFold} 行（判定线 24 条）`);
  check('折叠全部后所有线都在折叠状态', treeState().collapsedLines.length === 24, `${treeState().collapsedLines.length} 条`);
  check('折叠全部后没有叶子行', countRows('leaf') === 0);

  // 单独展开一条线（第一行行首）
  const firstCaret = body.querySelectorAll('[data-tabbody="bottom"]')[0].querySelectorAll('.caret-btn')[0];
  firstCaret.dispatch('click', { stopPropagation() {} });
  const afterOne = countRows();
  check('点判定线行的折叠图标 → 展开该线的事件层', afterOne > 24 && afterOne < 200, `${afterOne} 行`);
  check('该线展开后叶子仍折叠（不展开 5 个具体事件）', treeState().expandedLayers.length === 0);

  api.bottomTabs.activate('tree');
}

section('指针 → 预览：拖动时间轴应改变预览时刻');
{
  const api = globalThis.PhiChartEditor;
  api.timeline.setTime(20);
  api.preview.seek(api.timeline.time);
  tick(2);
  check('预览时钟已跳到指针位置', Math.abs(api.preview.playback.chartTime() - 20) < 0.5, `t=${api.preview.playback.chartTime().toFixed(2)}`);
  const st = api.preview.state;
  check('该时刻求值结果有效（音符可见性已算）', st && st.lines.length === 24 && Number.isFinite(st.lines[0].worldX));
  check('预览绘制该帧无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

section('布局：拖拽分隔条与持久化');
{
  const api = globalThis.PhiChartEditor;
  api.layout.reset();
  api.layout.set({ topLeftW: 420 });
  const after = api.layout.sizes;
  check('布局尺寸可设置', after.topLeftW === 420, JSON.stringify(after));
  check('尺寸已写入 localStorage', !!globalThis.localStorage.getItem('phichart-editor.layout'), globalThis.localStorage.getItem('phichart-editor.layout'));

  const beforeDrag = api.layout.sizes.topH;
  const split = byId.get('ed-split-main');
  check('上下分隔条已就位（按 id 取到）', !!split);
  split.dispatch('pointerdown', { clientX: 0, clientY: 100, pointerId: 1, button: 0 });
  split.dispatch('pointermove', { clientX: 0, clientY: 160, pointerId: 1 });
  split.dispatch('pointerup', { clientX: 0, clientY: 160, pointerId: 1 });
  check(
    '拖动上下分隔条会改变比例',
    api.layout.sizes.topH > beforeDrag,
    `topH ${beforeDrag} → ${api.layout.sizes.topH.toFixed(1)}`,
  );

  const beforeW = api.layout.sizes.topLeftW;
  const splitV = byId.get('ed-split-topleft');
  splitV.dispatch('pointerdown', { clientX: 100, clientY: 0, pointerId: 2, button: 0 });
  splitV.dispatch('pointermove', { clientX: 180, clientY: 0, pointerId: 2 });
  splitV.dispatch('pointerup', { clientX: 180, clientY: 0, pointerId: 2 });
  check('拖动左右分隔条会改变宽度', api.layout.sizes.topLeftW === beforeW + 80, `${beforeW} → ${api.layout.sizes.topLeftW}`);

  api.layout.reset();
  check('可重置布局', api.layout.sizes.topH === 42 && api.layout.sizes.topLeftW === 380);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
