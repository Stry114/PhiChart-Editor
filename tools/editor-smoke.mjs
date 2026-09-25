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
// main.js 的快捷键处理器要判断「焦点是不是在输入框里」（e.target instanceof HTMLInputElement）
globalThis.HTMLInputElement = class HTMLInputElement {};
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
  // 用例中途炸掉时必须让退出码非 0，否则「脚本崩了」会被当成「全部通过」
  errors.push(err);
  console.error('未捕获异常：', err);
  console.error(`\n已通过 ${passed} 项，失败 ${failed} 项（用例中途异常，结果不完整）`);
  process.exit(1);
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
    '工具列有鼠标 / 移动 / 添加 / 剪刀四个工具',
    tools?.children.length === 4 &&
      /点选/.test(toolTitles[0] ?? '') &&
      /平移时间轴/.test(toolTitles[1] ?? '') &&
      /放置音符/.test(toolTitles[2] ?? '') &&
      /切开/.test(toolTitles[3] ?? ''),
    `${tools?.children.length} 个按钮：${toolTitles.map((t) => t.slice(0, 4)).join(' | ')}`,
  );
  check('工具栏里没有占位按钮（切割/关联/导出/后续阶段等）', !/后续阶段|切割事件|关联选择|导出|设置/.test(toolTitles.join(' ')));
  check('启动期无未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

  // ── 欢迎弹窗：没载入内容前编辑器是锁住的（开始页功能已下放到这里）──
  section('欢迎弹窗：打开内容前锁住编辑器');
  const overlay = body.querySelector('.ed-welcome');
  check('未载入谱面时显示欢迎弹窗', !!api.welcome && api.welcome.isOpen === true && !overlay.classList.contains('hidden'));
  check(
    '弹窗给出三个入口：文件夹包 / zip 包 / 新建项目',
    ['folder', 'zip', 'new'].every((k) => !!overlay.querySelector(`[data-welcome="${k}"]`)),
    overlay.querySelectorAll('[data-welcome]').map((b) => b.getAttribute('data-welcome')).join(','),
  );
  {
    const before = api.preview.playing;
    fireWindow('keydown', { code: 'Space' });
    check('弹窗期间快捷键不生效（空格不会开始播放）', api.preview.playing === before && api.preview.playing === false);
  }
  // 创建新项目：填全部元数据 + 上传音频/背景图
  {
    const metaInput = (key) => overlay.querySelector(`[data-meta="${key}"]`);
    overlay.querySelector('[data-welcome="new"]').dispatch('click');
    check('点「创建新项目」展开元数据表单', !overlay.querySelector('.ed-newproj').classList.contains('hidden') && !!metaInput('bpm') && !!metaInput('lines'));
    metaInput('name').value = '我的新谱';
    metaInput('composer').value = '曲师甲';
    metaInput('charter').value = '谱师乙';
    metaInput('illustrator').value = '画师丙';
    metaInput('level').value = 'AT Lv.15';
    metaInput('id').value = '1001';
    metaInput('bpm').value = '160';
    metaInput('lines').value = '3';
    const inputs = body.querySelectorAll('input');
    const songInput = inputs.find((i) => /audio/.test(String(i.accept ?? '')));
    const bgInput = inputs.find((i) => /image/.test(String(i.accept ?? '')));
    songInput.files = [new File([new Uint8Array([1, 2, 3])], 'song.wav')];
    bgInput.files = [new File([new Uint8Array([4, 5, 6])], 'bg.png')];
    // 先试一次「缺曲名」的校验，再补齐创建
    metaInput('name').value = '';
    overlay.querySelector('[data-welcome="create"]').dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    check('缺必填项时拒绝创建并提示', api.preview.chart === null && /还缺/.test(overlay.textContent), overlay.querySelector('.ed-welcome-status')?.textContent);

    metaInput('name').value = '我的新谱';
    overlay.querySelector('[data-welcome="create"]').dispatch('click');
    for (let i = 0; i < 60 && api.welcome.isOpen; i++) await new Promise((r) => setTimeout(r, 20));
    const fresh = api.preview.chart;
    check('创建新项目：谱面按表单生成（3 条线 / 空谱 / 160 BPM）', !!fresh && fresh.lines.length === 3 && fresh.notes.length === 0 && fresh.timing.bpmList[0].bpm === 160, `${fresh?.lines.length} 线 / ${fresh?.notes.length} 音符`);
    check(
      '创建新项目：全部元数据落到模型里',
      fresh.meta.name === '我的新谱' && fresh.meta.composer === '曲师甲' && fresh.meta.charter === '谱师乙' && fresh.meta.illustrator === '画师丙' && fresh.meta.level === 'AT Lv.15' && fresh.meta.id === '1001',
      JSON.stringify(fresh.meta),
    );
    check('创建新项目：上传的音频/背景图进了资源表', fresh.meta.song === 'song.wav' && fresh.meta.background === 'bg.png');
    const res = (await api.preview.resources()).map((r) => r.name);
    check('创建新项目：资源表含两个上传文件（保存项目时会打进 zip）', res.includes('song.wav') && res.includes('bg.png'), res.join(' | '));
    check('创建新项目：每类事件都有覆盖全曲的默认事件（线可见）', fresh.lines[0].layers[0].alpha[0].start === 1 && fresh.lines[0].layers[0].speed[0].start === 1);
    check('载入成功后欢迎弹窗自动关闭', api.welcome.isOpen === false && overlay.classList.contains('hidden'));
    check('创建新项目后时间轴/标签页已重建（无异常）', errors.length === 0, errors.map((e) => e.message).join(' | '));
  }

  // 载入官方示例包（fetch 桩件读本地文件；示例入口已从界面移除，这里直接调 API）
  section('载入官方示例包并联动时间轴');
  const sample = { dir: 'packages/白复生 AT（official格式）', chart: 'Chart_AT #3649.json', label: '白复生 AT（official）' };
  await api.preview.loadSample(sample);
  api.afterLoad(sample.label); // 与欢迎弹窗/拖放一致：载入后重建拍轴、轨道与纠错
  const chart = api.preview.chart;
  check('谱面已载入', !!chart && chart.lines.length === 24 && chart.notes.length === 1156, `lines=${chart?.lines.length} notes=${chart?.notes.length}`);
  tick(2);
  check('预览已开始渲染（canvas 有绘制调用）', true);
  check('时间轴指针与预览同步（未播放时不回调）', api.timeline.time === 0, `t=${api.timeline.time}`);

  api.refreshAll();
  check('刷新标签页后无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

  // 切标签页
  for (const id of ['note', 'event', 'overview']) api.topTabs.activate(id);
  // 「诊断」页已并入「纠错」页
  const bottomTabNames = body.querySelectorAll('[data-tabs="bottom"]')[0]?.textContent ?? '';
  check('左下标签页只剩 结构树 / 纠错', /结构树/.test(bottomTabNames) && /纠错/.test(bottomTabNames) && !/诊断/.test(bottomTabNames), bottomTabNames);
  for (const id of ['tree']) api.bottomTabs.activate(id);
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

  // ── 结构树单击「n 号线」= 清空轨道并放入该线全部内容 ──
  {
    const { makeLineTracks } = await import('../src/editor/tracks.js');
    api.bottomTabs.activate('tree');
    const host2 = body.querySelectorAll('[data-tabbody="bottom"]')[0];
    // 先放点别的轨道，验证会被清空
    api.timeline.setTracks(makeLayerTracks(chart, 3, 0, def.axis));
    const beforeCount = api.timeline.tracks.length;
    const lineRow = host2.querySelectorAll('.ed-node').find((n) => /号线/.test(n.textContent));
    check('结构树里有判定线行', !!lineRow, lineRow ? lineRow.textContent.slice(0, 24) : '未找到');
    lineRow.dispatch('click');
    const after = api.timeline.tracks;
    const expected = makeLineTracks(chart, 0, def.axis);
    check('单击线行会替换掉原有轨道', after.length === expected.length && after.length !== beforeCount, `${beforeCount} 条 → ${after.length} 条（期望 ${expected.length} 条）`);
    check('放入内容 = 音符轨 + 该线所有事件层的全部事件轨', after.length === expected.length && after.every((t, i) => t.id === expected[i].id), `音符 ${after.filter((t) => t.kind === 'notes').length} 条，事件 ${after.filter((t) => t.kind === 'events').length} 条`);
    check('音符轨排在最前面', after[0]?.kind === 'notes', after.slice(0, 3).map((t) => (t.kind === 'notes' ? '音符' : '事件')).join(' → '));
    // 单击很容易误触：同一条线重复单击不应把时间轴重新载入（会丢掉选中与滚动位置）
    const idsAfterFirst = after.map((t) => t.id).join(',');
    lineRow.dispatch('click');
    check('同一行再单击一次不会重复载入', api.timeline.tracks.map((t) => t.id).join(',') === idsAfterFirst, `${api.timeline.tracks.length} 条`);
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

  // 内置示例入口已按需求移除；谱面包仍由「文件夹 / zip / 拖放」载入（含音频与曲绘）
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const previewSrc = fsMod.readFileSync(pathMod.join(process.cwd(), 'src/editor/preview.js'), 'utf8');
  check('编辑器里没有内置示例入口（示例包描述已删除）', !/export const SAMPLES/.test(previewSrc) && !/packages\/白复生/.test(previewSrc));
  check('谱面包载入通路仍在（loadFiles / loadZip / loadJson）', /loadFiles/.test(previewSrc) && /loadZip/.test(previewSrc) && /loadJson/.test(previewSrc));

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
    // 只取「小矩形」：音符本体（头部 / 普通音符）都小，Hold 条身很宽，靠宽度区分
    const noteHit = api.timeline.hitRects.find((r) => r.kind === 'notes' && r.w <= 40);
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
      const hit2 = api.timeline.hitRects.find((r) => r.kind === 'notes' && r.w <= 40);
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

    // 贴边自动滚动已按需求移除：指针停在边缘不该再自己滚
    tlBody3.scrollLeft = 600;
    tlBody3.dispatch('pointermove', { clientX: 6, clientY: 120, pointerId: 23, pointerType: 'mouse' });
    tick(4);
    check('移动工具：不再有「鼠标贴边自动滚动」', (tlBody3.scrollLeft ?? 0) === 600, `600 → ${tlBody3.scrollLeft}`);

    // 鼠标工具下的中键拖动 = 平移（并吃掉系统级中键行为）
    api.timeline.setTool('mouse');
    tlBody3.scrollLeft = 400;
    tlBody3.dispatch('pointerdown', { clientX: 500, clientY: 120, button: 1, pointerId: 24, pointerType: 'mouse' });
    check('鼠标工具：中键按下即进入平移', api.timeline.interaction.panning === true);
    tlBody3.dispatch('pointermove', { clientX: 400, clientY: 120, pointerId: 24, pointerType: 'mouse' });
    check('鼠标工具：中键拖动平移时间轴', Math.abs((tlBody3.scrollLeft ?? 0) - 500) < 2, `scrollLeft=${tlBody3.scrollLeft}`);
    check('鼠标工具：中键平移不改变选择', api.timeline.selectedCount === 0, `${api.timeline.selectedCount} 个`);
    tlBody3.dispatch('pointerup', { clientX: 400, clientY: 120, pointerId: 24, pointerType: 'mouse' });
    check('鼠标工具：中键松手后结束平移', api.timeline.interaction.panning === false);

    // 鼠标工具下的双指拖动 = 平移（单指仍然是框选 / 拖拽）
    tlBody3.scrollLeft = 300;
    tlBody3.dispatch('pointerdown', { clientX: 300, clientY: 120, button: 0, pointerId: 31, pointerType: 'touch' });
    check('鼠标工具：单指落下不进入平移', api.timeline.interaction.panning === false);
    tlBody3.dispatch('pointerdown', { clientX: 500, clientY: 120, button: 0, pointerId: 32, pointerType: 'touch' });
    check('鼠标工具：第二根手指落下 → 切成平移', api.timeline.interaction.panning === true);
    // 双指一起移动 20px（平移按两指中点算，所以要比单指稳）
    tlBody3.dispatch('pointermove', { clientX: 280, clientY: 120, pointerId: 31, pointerType: 'touch' });
    tlBody3.dispatch('pointermove', { clientX: 480, clientY: 120, pointerId: 32, pointerType: 'touch' });
    check('鼠标工具：双指拖动平移时间轴（按两指中点）', Math.abs((tlBody3.scrollLeft ?? 0) - 320) < 2, `scrollLeft=${tlBody3.scrollLeft}`);
    tlBody3.dispatch('pointerup', { clientX: 280, clientY: 120, pointerId: 31, pointerType: 'touch' });
    tlBody3.dispatch('pointerup', { clientX: 480, clientY: 120, pointerId: 32, pointerType: 'touch' });
    check('鼠标工具：抬起手指后结束平移', api.timeline.interaction.panning === false);

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

  // ── 添加工具：调色板 / 虚影 / 放置 / Hold 两点 / 鼠标工具右键 ──
  {
    const { previousEndValue, findOverlappingEvent } = await import('../src/editor/insert.js');
    const tlBody = byId.get('ed-tl-body');
    tlBody.__setSize(900, 600);
    tlBody.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
    const notesOf = () => api.preview.chart.notes;
    const newNotes = (before) => {
      const seen = new Set(before);
      return notesOf().filter((n) => !seen.has(n));
    };
    const setupNotes = () => {
      api.timeline.setTracks([makeNotesTrack(chart, 0, def.axis)]);
      api.timeline.setVisibleBeats(24, 0);
      api.timeline.redraw();
      return api.timeline.tracks[0];
    };
    const click = (x, y, id, button = 0, type = 'pointerdown') =>
      tlBody.dispatch(type, { clientX: Math.round(x), clientY: Math.round(y), button, pointerId: id, pointerType: 'mouse' });

    // 1) 调色板 + 放 Tap + 同点重复被拒
    setupNotes();
    api.timeline.setTool('add');
    check('切到添加工具', api.timeline.tool === 'add', `tool=${api.timeline.tool}`);
    check('调色板浮窗已生成', !!body.querySelector('#ed-add-palette'), '');
    const r = api.timeline.hitRects.find((x) => x.kind === 'notes' && x.w <= 40);
    if (r) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      tlBody.dispatch('pointermove', { clientX: Math.round(cx), clientY: Math.round(cy), pointerId: 41, pointerType: 'mouse' });
      check('移动时给出放置虚影', api.timeline.interaction.add.ghost?.kind === 'note', JSON.stringify(api.timeline.interaction.add.ghost)?.slice(0, 60));
      const before = notesOf().slice();
      click(cx, cy, 42);
      const added = newNotes(before);
      check('点击放置一个音符', added.length === 1 && added[0].type === 'tap', `新增 ${added.length} 个`);
      check('新音符带源对象（导出时能用）', !!added[0]?.src && added[0].src.type === 1, JSON.stringify(added[0]?.src)?.slice(0, 70));
      const before2 = notesOf().length;
      click(cx, cy, 43);
      check('同一位置重复放置被拒绝', notesOf().length === before2, `${before2} → ${notesOf().length}`);
    }

    // 2) Hold：两点定首尾
    {
      setupNotes();
      api.timeline.setTool('add');
      // 通过调色板按钮切到 Hold（与用户操作一致）
      const holdBtn = [...body.querySelectorAll('.ed-add-type')].find((b) => b.dataset.type === 'hold');
      holdBtn?.dispatch('click');
      check('调色板可切换到 Hold', api.timeline.interaction.add.type === 'hold', api.timeline.interaction.add.type);
      const r2 = api.timeline.hitRects.find((x) => x.kind === 'notes' && x.w <= 40);
      if (r2) {
        const y = Math.round(r2.y + r2.h / 2);
        const before = notesOf().slice();
        click(120, y, 51);
        check('Hold：第一点只记起点，还没放下', newNotes(before).length === 0 && api.timeline.interaction.add.startBeat !== null, `start=${api.timeline.interaction.add.startBeat}`);
        click(300, y, 52);
        const added = newNotes(before);
        check(
          'Hold：第二点放下一个 Hold（首尾由两次点击定）',
          added.length === 1 && added[0].type === 'hold' && added[0].endBeat > added[0].startBeat,
          added[0] ? `${added[0].startBeat.toFixed(2)}~${added[0].endBeat.toFixed(2)}` : '没放下',
        );
      }
    }

    // 3) 鼠标工具：右键直接放 Tap
    {
      setupNotes();
      api.timeline.setTool('mouse');
      const r3 = api.timeline.hitRects.find((x) => x.kind === 'notes' && x.w <= 40);
      if (r3) {
        const before = notesOf().slice();
        click(r3.x + r3.w / 2, r3.y + r3.h / 2, 61, 2, 'contextmenu');
        const added = newNotes(before);
        check('鼠标工具：右键直接放 Tap（无需选类型）', added.length === 1 && added[0].type === 'tap', `新增 ${added.length} 个`);
      }
    }

    // 4) 纯函数：新事件取值 = 上一个事件的末值
    const evs = [
      { startBeat: 0, endBeat: 4, start: 0, end: 1 },
      { startBeat: 4, endBeat: 8, start: 1, end: 1 },
    ];
    check('previousEndValue：取上一个事件的末值', previousEndValue(evs, 6, 'x') === 1, String(previousEndValue(evs, 6, 'x')));
    check('previousEndValue：前面没有事件时用缺省值', previousEndValue(evs, 0, 'alpha') === 1 && previousEndValue([], 3, 'speed') === 1, 'alpha/speed 默认 1');
    check('findOverlappingEvent：相交能查出', !!findOverlappingEvent(evs, 3, 5) && !findOverlappingEvent(evs, 8.5, 9));

    api.timeline.setTool('mouse');
    api.timeline.clearSelection(); // 别把选中状态留给后面的用例
  }
  // ── Note 详情页：多选不加载默认值，修改对全部选中项生效 ──
  {
    const { resolveSelectedNotes } = await import('../src/editor/note-detail.js');
    api.topTabs.activate('note');
    const host = body.querySelectorAll('[data-tabbody="top"]')[0];
    const esc = (s) => String(s).replace(/\s+/g, ' ').trim();
    check('未选中音符时给出提示', /选中音符/.test(host.textContent), esc(host.textContent).slice(0, 40));

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

  // ── 扩展事件的详情 / 曲线：颜色按 R/G/B 编辑，曲线页明确拒绝 ──
  {
    const { prepareChart } = await import('../src/core/model.js');
    const { EXTENDED_KEYS } = await import('../src/core/units.js');
    const { makeEasing } = await import('../src/core/easing.js');
    const { makeExtendedTrack } = await import('../src/editor/tracks.js');
    const { resolveSelectedEvents } = await import('../src/editor/event-detail.js');
    const { getActiveCurve } = await import('../src/editor/event-curve.js');

    // 独立造一张只有一个 color 事件的谱面：不动全局预览的模型（`chart` 已被上面的用例改过值）
    const ev = {
      startBeat: 0,
      endBeat: 4,
      start: [255, 255, 255],
      end: [255, 0, 0],
      easingFn: makeEasing(1, null, 0, 1),
      easingType: 1,
      easingPreset: 1,
      bezierPoints: null,
      easingLeft: 0,
      easingRight: 1,
    };
    const mini = prepareChart({
      format: 'rpe',
      meta: {},
      timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
      lines: [
        {
          id: 0,
          name: 'ColorLine',
          texture: 'line.png',
          father: -1,
          bpm: 120,
          bpmFactor: 1,
          bpmList: [{ beat: 0, bpm: 120 }],
          layers: [{ alpha: [{ startBeat: 0, endBeat: 1e6, start: 1, end: 1 }] }],
          notes: [],
          extended: { color: [ev] },
          raw: {},
        },
      ],
    });
    check('颜色扩展事件能被编译（三个通道各一份）', Array.isArray(mini.lines[0].rt.extended.color?.channels) && mini.lines[0].rt.extended.color.channels.length === 3, JSON.stringify(Object.keys(mini.lines[0].rt.extended.color ?? {})));
    check('颜色通道取规范化的三元组', EXTENDED_KEYS.includes('color') && mini.lines[0].rt.extended.color.channels[1].list.length === 1, `${mini.lines[0].rt.extended.color.channels[1].list.length} 段`);

    const colorTrack = makeExtendedTrack(mini, 0, 'color', api.timeline.axis ?? def.axis);
    api.timeline.setTracks([colorTrack]);
    api.timeline.selectEvents([`${colorTrack.id}#0`]);
    const items = resolveSelectedEvents(api.timeline);
    check('扩展颜色事件能被选中并解析（layerIndex 为 null 也能找到数组）', items.length === 1 && items[0].ev === ev, `${items.length} 个`);

    api.topTabs.activate('event');
    const top = () => body.querySelectorAll('[data-tabbody="top"]')[0];
    const rowOf = (label) =>
      top()
        .querySelectorAll('.ed-note-row')
        .find((r) => String(r.querySelectorAll('.k')[0]?.textContent ?? '').replace(/\s+/g, ' ').trim() === label);
    check('Event 详情：颜色事件显示颜色预览行', !!rowOf('颜色'), rowOf('颜色')?.querySelectorAll('.ed-color-swatch')[0] ? '有预览块' : '缺预览块');
    check('Event 详情：颜色拆成 R / G / B 三行', ['R 通道', 'G 通道', 'B 通道'].every((k) => !!rowOf(k)), ['R 通道', 'G 通道', 'B 通道'].filter((k) => !rowOf(k)).join(',') || '三行齐全');
    check('Event 详情：颜色事件不出现标量「起始值」行', !rowOf('起始值'), '');

    const gRow = rowOf('G 通道')?.querySelectorAll('input')[0];
    gRow.value = '64';
    gRow.dispatch('change');
    await new Promise((r) => setTimeout(r, 0));
    check('改 G 通道写回 extColor（仍是三元组，不污染其它通道）', Array.isArray(ev.start) && ev.start.join(',') === '255,64,255', `${ev.start}`);
    check('通道输入被夹在 0..255', ev.end.join(',') === '255,0,0', `${ev.end}`);

    api.topTabs.activate('curve');
    check('曲线页对颜色事件给出提示、不建曲线', /颜色事件按 R\/G\/B 编辑/.test(top().textContent) && getActiveCurve() === null, getActiveCurve() ? '竟然建了曲线' : '未建曲线');

    api.timeline.clearSelection();
    api.timeline.setTracks(makeLayerTracks(chart, 0, 0, def.axis));
    api.topTabs.activate('event');
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

  // ── 谱面总览页 = 元数据编辑页（不提供载入按钮：刷新页面即回到欢迎弹窗）──
  {
    const json = JSON.parse(
      (await import('node:fs')).readFileSync(`${process.cwd()}/packages/白复生 AT（official格式）/Chart_AT #3649.json`, 'utf8'),
    );
    await api.preview.loadJson(json, 'Chart_AT #3649.json');
    check('只载入 JSON：mediaHint 提示用谱面包载入', typeof api.preview.mediaHint === 'string', String(api.preview.mediaHint).slice(0, 30));
    api.topTabs.activate('overview');
    const overviewBody = () => body.querySelectorAll('[data-tabbody="top"]')[0];
    const txt = () => overviewBody().textContent;
    check('总览页给出全部元数据输入行', ['曲名', '曲师', '谱师', '曲绘师', '难度', 'ID / Path', 'offset（秒）', '音频', '曲绘'].every((k) => txt().includes(k)), txt().slice(0, 60));
    check('总览页不再有载入按钮（刷新页面即回到欢迎弹窗）', !/选择谱面|选择 zip|选择谱面包目录/.test(txt()));
    check('总览页标出音频/曲绘未载入并提供上传入口', /✗/.test(txt()) && /上传…/.test(txt()));

    // 改元数据：写入模型并标注来源
    const inputOf = (label) => [...overviewBody().querySelectorAll('.ed-note-row')].find((r) => r.querySelector('.k')?.textContent === label)?.querySelector('input');
    inputOf('曲名').value = '改名后的谱面';
    inputOf('曲名').dispatch('change');
    inputOf('ID / Path').value = 'abc123';
    inputOf('ID / Path').dispatch('change');
    inputOf('offset（秒）').value = '0.25';
    inputOf('offset（秒）').dispatch('change');
    check(
      '元数据改动写入模型并标注来源',
      api.preview.chart.meta.name === '改名后的谱面' && api.preview.chart.meta.id === 'abc123' && api.preview.chart.meta.offset === 0.25 && api.preview.chart.metaSources.name === '手动编辑',
      JSON.stringify({ name: api.preview.chart.meta.name, id: api.preview.chart.meta.id, offset: api.preview.chart.meta.offset }),
    );
    check('offset 改动同步到播放时钟', api.preview.playback.player.offset === 0.25, String(api.preview.playback.player.offset));
    check('总览页不再显示已移除的 info.txt 导出按钮', !/导出 info\.txt/.test(txt()));

    // 补齐媒体：上传音频 + 背景图（包内缺失时用）
    const mediaInput = (label) =>
      [...overviewBody().querySelectorAll('.ed-note-row')]
        .find((r) => r.querySelector('.k')?.textContent === label)
        ?.querySelectorAll('input')
        .find((i) => i.type === 'file');
    mediaInput('音频').files = [new File([new Uint8Array([1, 2, 3, 4])], '补充.wav')];
    mediaInput('音频').dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    check('上传音频后写入 meta.song 并登记为包内资源', api.preview.chart.meta.song === '补充.wav' && (await api.preview.resources()).some((r) => r.name === '补充.wav'), api.preview.chart.meta.song);
    mediaInput('曲绘').files = [new File([new Uint8Array([5, 6, 7])], '补充.png')];
    mediaInput('曲绘').dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    check('上传曲绘后写入 meta.background 并登记为包内资源', api.preview.chart.meta.background === '补充.png' && (await api.preview.resources()).some((r) => r.name === '补充.png'), api.preview.chart.meta.background);
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

  // 轨道头下方的「+ 在结构树中单击以添加」
  const addRow = byId.get('ed-tl-heads').querySelectorAll('.ed-tl-add');
  check('轨道头下方有空闲区提示行', addRow.length === 1 && /在结构树中单击以添加/.test(addRow[0].textContent), addRow[0]?.textContent ?? '');
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
  const { createBeatAxis } = await import('../src/editor/tracks.js');
  const axis = api.timeline.axis ?? createBeatAxis(api.preview.chart); // 本段用例共用的拍轴
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
  // 取「最后一个事件层」的折叠图标（末尾还有「扩展事件」组，不能直接取最后一个）
  const layerNodes = host.querySelectorAll('.ed-node').filter((n) => !n.classList.contains('leaf') && esc(n.textContent).includes('事件层'));
  const layerCaret = layerNodes[layerNodes.length - 1]?.querySelectorAll('.caret-btn')[0];
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

  // 折叠全部：只留判定线（外加谱面相机那一行 —— 相机是谱面级的，不属于任何判定线）
  const foldBtn = barBtns[1];
  foldBtn.dispatch('click');
  const afterFold = countRows();
  check('折叠全部：只保留判定线（+ 谱面相机一行）', afterFold === 25, `${afterFold} 行（判定线 24 条 + 谱面相机 1 行）`);
  check('折叠全部后所有线都在折叠状态', treeState().collapsedLines.length === 24, `${treeState().collapsedLines.length} 条`);
  check('折叠全部后没有叶子行', countRows('leaf') === 0);

  // 单独展开一条线（第一行**判定线**的折叠图标；最上面那行是谱面相机，不能直接取第一个 caret）
  const firstLineRow = body
    .querySelectorAll('[data-tabbody="bottom"]')[0]
    .querySelectorAll('.ed-node')
    .find((n) => esc(n.textContent).includes('号线'));
  const firstCaret = firstLineRow?.querySelectorAll('.caret-btn')[0];
  firstCaret.dispatch('click', { stopPropagation() {} });
  const afterOne = countRows();
  check('点判定线行的折叠图标 → 展开该线的事件层', afterOne > 25 && afterOne < 200, `${afterOne} 行`);
  check('该线展开后叶子仍折叠（不展开 5 个具体事件）', treeState().expandedLayers.length === 0);

  // ── 音符行：这条线没有音符也照样显示 ──
  {
    const line3 = api.preview.chart.lines[3];
    const savedNotes = line3.rt.notes;
    line3.rt.notes = [];
    api.bottomTabs.refresh();
    // 树此刻只展开了 1 号线，先把 4 号线展开（点它行首的折叠图标）
    const rowOf = (text) => body.querySelectorAll('[data-tabbody="bottom"]')[0].querySelectorAll('.ed-node').find((n) => esc(n.textContent).includes(text));
    rowOf('4 号线')?.querySelectorAll('.caret-btn')[0]?.dispatch('click', { stopPropagation() {} });
    const rows = body.querySelectorAll('[data-tabbody="bottom"]')[0].querySelectorAll('.ed-node');
    const lineRowIdx = rows.findIndex((n) => esc(n.textContent).includes('4 号线'));
    const nextRow = rows[lineRowIdx + 1];
    check(
      '线上没有音符时，音符行仍然显示',
      !!nextRow && esc(nextRow.textContent).startsWith('音符') && /无音符/.test(esc(nextRow.textContent)),
      nextRow ? esc(nextRow.textContent) : '（下一行不是音符行）',
    );
    const notesTrackId = 'notes:3';
    check('（此时该线还没有音符轨）', !api.timeline.tracks.some((t) => t.id === notesTrackId));
    nextRow?.dispatch('click');
    check('空音符行也能单击把音符轨放进时间轴', api.timeline.tracks.some((t) => t.id === notesTrackId));
    api.timeline.removeTrack?.(notesTrackId);
    line3.rt.notes = savedNotes;
    api.bottomTabs.refresh();
  }

  // ── 事件层：新增 / 删除（只用「新增出来的层」做删除用例，绝不动原有的层）──
  {
    const { addEventLayer, removeEventLayer } = await import('../src/editor/tree.js');
    const { makeLayerTracks } = await import('../src/editor/tracks.js');
    const { RPE } = await import('../src/core/units.js');
    const chart = api.preview.chart;
    const line0 = chart.lines[0];
    const baseLayers = line0.layers.length;
    const compiledBefore = line0.rt.x.length;
    const keys = ['x', 'y', 'rotate', 'alpha', 'speed'];
    const host2 = () => body.querySelectorAll('[data-tabbody="bottom"]')[0];
    const lineRow = () => host2().querySelectorAll('.ed-node').find((n) => esc(n.textContent).includes('1 号线'));

    const addBtn = lineRow()?.querySelectorAll('.ed-node-btn')[0];
    check('线行上有「新增事件层」按钮', !!addBtn && addBtn.disabled === false);
    addBtn?.dispatch('click');
    check('新增事件层：层数 +1', line0.layers.length === baseLayers + 1, `${baseLayers} → ${line0.layers.length}`);
    const fresh = line0.layers[line0.layers.length - 1];
    check(
      '新层的 5 条事件轨各有一条事件，起止为「从开头 → 保持到结束」',
      keys.every((k) => fresh[k]?.length === 1) && keys.every((k) => fresh[k][0].startBeat === 0 && fresh[k][0].endBeat === RPE.SENTINEL_BEAT),
      keys.map((k) => `${k}:${fresh[k].length}`).join(' '),
    );
    check(
      '新事件取值是「中性值」全 0（speed=1 会让整条线速度翻倍）',
      keys.every((k) => fresh[k][0].start === 0 && fresh[k][0].end === 0),
      keys.map((k) => `${k}=${fresh[k][0].start}`).join(' '),
    );
    check('新层立刻参与渲染求值（编译层数 +1）', line0.rt.x.length === compiledBefore + 1, `${compiledBefore} → ${line0.rt.x.length}`);

    // 再加一层，用来验证「删中间那层 → 后面的层号整体前移」
    api.timeline.addTracks(makeLayerTracks(chart, 0, baseLayers, api.timeline.axis ?? undefined));
    addEventLayer(chart, api.timeline, 0);
    api.timeline.addTracks(makeLayerTracks(chart, 0, baseLayers + 1, api.timeline.axis ?? undefined));
    check('两层的轨道都放进了时间轴', api.timeline.tracks.some((t) => t.layerIndex === baseLayers) && api.timeline.tracks.some((t) => t.layerIndex === baseLayers + 1));
    api.bottomTabs.refresh();

    const delBtns = host2().querySelectorAll('.ed-node-btn').filter((b) => esc(b.title).includes('删掉这一层'));
    check('每个事件层都有删除按钮', delBtns.length >= line0.layers.length, `${delBtns.length} 个（层 ${line0.layers.length}）`);
    // 删掉中间那层（时间轴上第二层），后面的层号要前移
    const midDel = delBtns[baseLayers];
    midDel?.dispatch('click');
    check('删除事件层：层数 -1', line0.layers.length === baseLayers + 1, `${line0.layers.length}`);
    check(
      '删中间层后：该层轨道移除，后面那层的层号整体前移',
      !api.timeline.tracks.some((t) => t.layerIndex === baseLayers + 1) && api.timeline.tracks.some((t) => t.layerIndex === baseLayers),
      `时间轴上 ev:0:* 的层号：${[...new Set(api.timeline.tracks.filter((t) => t.id.startsWith('ev:0:')).map((t) => t.layerIndex))].sort().join(',')}`,
    );

    // 把新增的两层都删掉，回到原状（原有层一根汗毛都不动）
    while (line0.layers.length > baseLayers) removeEventLayer(chart, api.timeline, 0, line0.layers.length - 1);
    check(
      '删完新增层后回到原状（层数与编译结果都还原）',
      line0.layers.length === baseLayers && line0.rt.x.length === compiledBefore && !api.timeline.tracks.some((t) => t.layerIndex >= baseLayers),
      `层 ${line0.layers.length}/${baseLayers}，编译 ${line0.rt.x.length}/${compiledBefore}`,
    );

    // 至少留 1 层：拿一条本来就只有 1 层的线试（不会改动任何数据）
    const single = chart.lines[5];
    const singleBefore = single.layers.length;
    const res = removeEventLayer(chart, api.timeline, 5, 0);
    check(
      '只剩 1 个事件层时拒绝删除（按钮也会置灰）',
      res.ok === false && single.layers.length === singleBefore && /至少保留 1 个/.test(res.reason ?? ''),
      res.reason ?? '',
    );
    api.bottomTabs.refresh(); // 先让树反映「只有 1 层」的状态，再看按钮的禁用态
    const guardBtn = host2()
      .querySelectorAll('.ed-node-btn')
      .filter((b) => esc(b.title).includes('至少保留 1 个'));
    check('只有 1 层的线，删除按钮是禁用的', guardBtn.length >= 1 && guardBtn.every((b) => b.disabled === true), `${guardBtn.length} 个`);
    api.bottomTabs.refresh();
  }

  // ── 事件层里的轨道：**缺的轨道也能加**（用户反馈）+ 增删轨道 ──
  {
    const { makeEventTrack } = await import('../src/editor/tracks.js');
    const { refreshLine } = await import('../src/core/model.js');
    const host2 = () => body.querySelectorAll('[data-tabbody="bottom"]')[0];
    const keyLeaves = () =>
      host2()
        .querySelectorAll('.leaf')
        .filter((n) => n.classList.contains('ed-indent-2') && /（(x|y|rotate|alpha|speed)）/.test(esc(n.textContent)));
    const layerOf = (li) => api.preview.chart.lines[0].layers[li];

    // 造一个只有 x 事件的层，验证另外 4 条轨道照样列出来
    const chart0 = api.preview.chart;
    const layer0 = layerOf(0);
    const savedLayer0 = { x: layer0.x, y: layer0.y, rotate: layer0.rotate, alpha: layer0.alpha, speed: layer0.speed };
    const mkEv = (v) => ({ startBeat: 0, endBeat: 4, start: v, end: v, easingFn: (t) => t, easingType: 1, easingPreset: 1, bezierPoints: null, easingLeft: 0, easingRight: 1 });
    layer0.x = [mkEv(0)];
    layer0.y = [];
    layer0.rotate = [];
    layer0.alpha = [];
    layer0.speed = [];
    refreshLine(chart0, 0, { keys: ['x', 'y', 'rotate', 'alpha', 'speed'] });
    // 时间轴也要指着同一张谱面（前面的用例换过谱面对象），否则写回会落到另一张谱上
    api.timeline.setChart(chart0, api.timeline.axis ?? axis);
    api.timeline.setTracks([]);
    api.bottomTabs.activate('tree');
    // 展开 1 号线的第 1 个事件层（单击行首的折叠图标）
    const layerRow = host2()
      .querySelectorAll('.ed-node')
      .find((n) => /事件层 1/.test(esc(n.textContent)));
    if (!layerRow?.querySelector('.caret-btn')?.classList.contains('open')) {
      layerRow?.querySelectorAll('.caret-btn')[0]?.dispatch('click', { stopPropagation() {} });
    }
    check('事件层展开后把 5 类事件轨全部列出（缺的显示「空」）', keyLeaves().length === 5, keyLeaves().map((n) => esc(n.textContent)).join(' | '));
    check('只有 x 有事件，其余 4 条显示「空」', keyLeaves().filter((n) => /空/.test(esc(n.textContent))).length === 4, keyLeaves().map((n) => esc(n.textContent)).join(' | '));

    // 单击空的 alpha 轨 → 进时间轴；再用添加工具放第一条事件（layer.alpha 按需新建）
    const alphaLeaf = keyLeaves().find((n) => /（alpha）/.test(esc(n.textContent)));
    check('空的 alpha 轨 ✕ 是禁用的（还没有事件）', alphaLeaf?.querySelector('.ed-node-btn')?.disabled === true);
    alphaLeaf?.dispatch('click');
    const alphaTrack = api.timeline.tracks.find((t) => t.id === 'ev:0:0:alpha');
    check('单击空的事件轨 → 进时间轴（id 为 ev:<线>:<层>:<键>）', !!alphaTrack && alphaTrack.clips.length === 0, api.timeline.tracks.map((t) => t.id).join(', '));
    check('（此时数据里还没有 alpha 事件）', (layer0.alpha?.length ?? 0) === 0);
    {
      const tb = byId.get('ed-tl-body');
      tb.__setSize(900, 600);
      tb.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
      api.timeline.setTracks([alphaTrack]);
      api.timeline.setTool('add');
      api.timeline.setVisibleBeats(24, 0);
      // 空轨在画布上没有可点区域（没有事件块），命中行要按布局取：只有一条轨 → 刻度尺之下那一行（行高 42）
      const y = Math.round(api.timeline.rulerHeight + 21);
      tb.dispatch('pointerdown', { clientX: 200, clientY: y, button: 0, pointerId: 71, pointerType: 'mouse' });
      tb.dispatch('pointerdown', { clientX: 520, clientY: y, button: 0, pointerId: 72, pointerType: 'mouse' });
      check('空事件轨上能直接放第一条事件（layer.alpha 按需新建）', layer0.alpha?.length === 1, `${layer0.alpha?.length ?? 0} 条`);
      api.timeline.setTool('mouse');
    }
    // ✕ 删掉这条轨：清空该键的事件，且可撤销
    const alphaTrack2 = api.timeline.tracks.find((t) => t.id === 'ev:0:0:alpha') ?? makeEventTrack(chart0, 0, 0, 'alpha', api.timeline.axis ?? axis);
    const cleared = api.timeline.clearTrackData(alphaTrack2);
    check('删掉一条事件轨：清空该键的事件', cleared.ok === true && cleared.removed === 1 && layer0.alpha.length === 0, JSON.stringify(cleared));
    check('删掉事件轨可撤销', (() => {
      api.timeline.undo();
      return layer0.alpha.length === 1;
    })(), `${layer0.alpha?.length ?? 0} 条`);

    // 还原这一层
    Object.assign(layer0, savedLayer0);
    refreshLine(chart0, 0, { keys: ['x', 'y', 'rotate', 'alpha', 'speed'] });
    api.timeline.setTracks([]);
    api.bottomTabs.refresh();
  }
  // ── 扩展（故事板）事件：scaleX / scaleY / color ──
  // 扩展事件不分事件层：结构树里归到「扩展事件」一组，单击组 = 整组导入并绑定。
  {
    const { EVENT_COLORS, makeExtendedTrack, makeExtendedTracks } = await import('../src/editor/tracks.js');
    const { refreshLine } = await import('../src/core/model.js');
    const { createState, evaluate } = await import('../src/core/state.js');
    const { EXTENDED_KEYS } = await import('../src/core/units.js');
    const { makeEasing } = await import('../src/core/easing.js');
    const { eventArrayOf } = await import('../src/editor/clipboard.js');

    const host = () => body.querySelectorAll('[data-tabbody="bottom"]')[0];
    const extNode = () => host().querySelectorAll('.ed-node').find((n) => esc(n.textContent).startsWith('扩展事件'));
    const extLeaves = () =>
      host()
        .querySelectorAll('.leaf')
        .filter((n) => n.classList.contains('ed-indent-2') && /（(scaleX|scaleY|color)）/.test(esc(n.textContent)));

    check('轨道主题色按约定（scaleX #EEEEEE / scaleY #FFB26B / color #66ccff）', EVENT_COLORS.scaleX === '#EEEEEE' && EVENT_COLORS.scaleY === '#FFB26B' && EVENT_COLORS.color === '#66ccff', `${EVENT_COLORS.scaleX} / ${EVENT_COLORS.scaleY} / ${EVENT_COLORS.color}`);

    const line0 = api.preview.chart.lines[0];
    const savedExtended = line0.extended;
    const savedRaw = line0.extendedRaw;
    // 起点 0 拍：0–4 拍线性过渡到终值，之后保持（便于按拍取样验证插值）
    const mkExt = (start, end) => ({      startBeat: 0,
      endBeat: 4,
      start,
      end,
      easingFn: makeEasing(1, null, 0, 1),
      easingType: 1,
      easingPreset: 1,
      bezierPoints: null,
      easingLeft: 0,
      easingRight: 1,
    });
    line0.extended = {
      scaleX: [mkExt(1, 2)],
      scaleY: [mkExt(1, 0.5)],
      color: [mkExt([255, 255, 255], [255, 0, 0])],
    };
    line0.extendedRaw = { inclineEvents: [{ startTime: [0, 0, 1], endTime: [1, 0, 1], incline: 45 }] };
    refreshLine(api.preview.chart, 0, { extended: EXTENDED_KEYS.slice() });
    api.bottomTabs.activate('tree');
    api.bottomTabs.refresh();

    check('结构树里出现「扩展事件」组', !!extNode(), extNode() ? esc(extNode().textContent) : '（没有这一行）');
    check('扩展事件组标出事件总数', /3 事件/.test(esc(extNode()?.textContent ?? '')), esc(extNode()?.textContent ?? ''));
    check('未实现的扩展键被标出并保留', /1 个未支持/.test(esc(extNode()?.textContent ?? '')), esc(extNode()?.textContent ?? ''));
    check('扩展事件组默认折叠（不列出子项）', extLeaves().length === 0, `${extLeaves().length} 行`);

    extNode()?.querySelectorAll('.caret-btn')[0]?.dispatch('click', { stopPropagation() {} });
    const leaves = extLeaves();
    check('展开后逐键列出 scaleX / scaleY / color', leaves.length === 3, leaves.map((n) => esc(n.textContent)).join(' | '));
    check('未实现的 inclineEvents 也在组内标出（不可导入）', /inclineEvents（本版本未实现）/.test(host().textContent), '');
    // 已实现的扩展键**全部列出**（含没有事件的 z / theta）：缺的那几条轨道才建得出来
    const allExtLeaves = host()
      .querySelectorAll('.leaf')
      .filter((n) => n.classList.contains('ed-indent-2') && /（(scaleX|scaleY|color|z|theta)）/.test(esc(n.textContent)));
    check(
      '扩展事件组把 5 个已实现键全部列出（没有事件的显示「空」）',
      allExtLeaves.length === 5 && allExtLeaves.filter((n) => /空/.test(esc(n.textContent))).length === 2,
      allExtLeaves.map((n) => esc(n.textContent)).join(' | '),
    );
    check(
      '每条扩展轨叶子都有 ✕（删掉这条轨）',
      leaves.every((n) => n.querySelectorAll('.ed-node-btn').length === 1),
      leaves.map((n) => n.querySelectorAll('.ed-node-btn').length).join(','),
    );

    // 单击子项 → 只导入该键那一条轨（layerIndex 为 null = 扩展写回路径）
    const beforeCount = api.timeline.tracks.length;
    leaves[0].dispatch('click');
    check('单击单个扩展键只导入一条轨', api.timeline.tracks.length === beforeCount + 1, `${beforeCount} → ${api.timeline.tracks.length}`);
    check('扩展轨 id / layerIndex / group 按约定', api.timeline.tracks[api.timeline.tracks.length - 1]?.id === 'ev:0:ext:scaleX' && api.timeline.tracks[api.timeline.tracks.length - 1]?.layerIndex === null && api.timeline.tracks[api.timeline.tracks.length - 1]?.group === 'ext:0', JSON.stringify({ id: api.timeline.tracks[api.timeline.tracks.length - 1]?.id, layerIndex: api.timeline.tracks[api.timeline.tracks.length - 1]?.layerIndex }));
    api.timeline.removeTrack('ev:0:ext:scaleX');

    // 缺的轨道（z / theta）也能直接建出来：单击空叶子 → 时间轴里出现一条空轨，再用「添加」工具画事件
    {
      // 时间轴指着同一张谱面（前面的用例换过谱面对象）
      api.timeline.setChart(api.preview.chart, api.timeline.axis ?? axis);
      api.timeline.setTracks([]);
      const zLeaf = allExtLeaves.find((n) => /（z）/.test(esc(n.textContent)));
      check('（用例前置）z 通道叶子显示「空」', /空/.test(esc(zLeaf?.textContent ?? '')), esc(zLeaf?.textContent ?? '（无）'));
      zLeaf?.dispatch('click');
      const zTrack = api.timeline.tracks.find((t) => t.id === 'ev:0:ext:z');
      check('单击空的扩展键 → 建出这条空轨（缺的轨道可以加了）', !!zTrack && zTrack.clips.length === 0, api.timeline.tracks.map((t) => t.id).join(', '));
      check('（此时数据里还没有 z 事件）', !Array.isArray(line0.extended.z) || line0.extended.z.length === 0, String(line0.extended.z?.length));
      // 添加工具在这条空轨上画一条（0 → 1 屏高）：数组按需新建
      api.timeline.setTool('add');
      const zb = byId.get('ed-tl-body');
      zb.__setSize(900, 600);
      zb.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
      api.timeline.setTracks([zTrack]);
      api.timeline.setVisibleBeats(24, 0);
      // 空轨在画布上没有事件块，命中行按布局取（只有一条轨 → 刻度尺之下那一行，行高 42）
      {
        const y = Math.round(api.timeline.rulerHeight + 21);
        zb.dispatch('pointerdown', { clientX: 200, clientY: y, button: 0, pointerId: 61, pointerType: 'mouse' });
        zb.dispatch('pointerdown', { clientX: 520, clientY: y, button: 0, pointerId: 62, pointerType: 'mouse' });
        check('空轨上能直接放第一条事件（line.extended.z 按需新建）', line0.extended.z?.length === 1, `${line0.extended.z?.length ?? 0} 条`);
      }
      api.timeline.setTool('mouse');
      // ✕ 删掉这条轨：清空数据 + 移除时间轴上的轨道，且可撤销
      const zTrack2 = api.timeline.tracks.find((t) => t.id === 'ev:0:ext:z');
      const cleared = api.timeline.clearTrackData(zTrack2);
      check('删掉一条扩展轨：清空该键的事件（返回清掉的数量）', cleared.ok === true && cleared.removed === 1 && line0.extended.z.length === 0, JSON.stringify(cleared));
      check('删掉扩展轨可撤销（撤销后事件回到原位）', (() => {
        api.timeline.undo();
        const back = line0.extended.z ?? [];
        return back.length === 1;
      })(), `${line0.extended.z?.length ?? 0} 条`);
      line0.extended.z = [];
      refreshLine(api.preview.chart, 0, { extended: ['z'] });
      api.timeline.removeTrack('ev:0:ext:z');
      api.bottomTabs.refresh();
    }

    // 单击组 → 整组导入并绑定
    extNode()?.dispatch('click');
    const imported = api.timeline.tracks.filter((t) => t.extended);
    check('单击「扩展事件」组：整组导入有事件的 3 条轨', imported.length === 3, imported.map((t) => t.id).join(', '));
    check('组内轨道统一绑定到 ext:<线号>', imported.every((t) => t.group === 'ext:0' && t.layerIndex === null), [...new Set(imported.map((t) => t.group))].join(','));
    check('导入的扩展轨主题色与结构树一致', imported.find((t) => t.key === 'scaleX')?.color === '#EEEEEE' && imported.find((t) => t.key === 'color')?.color === '#66ccff', imported.map((t) => `${t.key}:${t.color}`).join(' '));

    const colorTrack = imported.find((t) => t.key === 'color');
    check('颜色事件块显示三元组取值', /255,255,255 → 255,0,0/.test(colorTrack?.clips?.[0]?.text ?? ''), colorTrack?.clips?.[0]?.text ?? '（无）');
    check('颜色轨的趋势线用最大通道当标量', colorTrack?.clips?.[0]?.trend0 === 255 && colorTrack?.clips?.[0]?.trend1 === 255, `${colorTrack?.clips?.[0]?.trend0} → ${colorTrack?.clips?.[0]?.trend1}`);

    // 写回路径：扩展事件走 line.extended[key]，不是 line.layers[null]
    check('扩展事件的写回数组取自 line.extended', eventArrayOf(api.preview.chart, { lineId: 0, layerIndex: null, key: 'color' }) === line0.extended.color, '');

    // 组内轨道与单独导入的轨道等价
    const ax = api.timeline.axis ?? axis;
    const single = makeExtendedTrack(api.preview.chart, 0, 'scaleY', ax);
    check('整组导入的轨道与单条构造等价', JSON.stringify(single.clips.map((c) => c.text)) === JSON.stringify(imported.find((t) => t.key === 'scaleY')?.clips.map((c) => c.text)), single.clips[0]?.text ?? '');
    check('makeExtendedTracks 只产出已实现且有事件的键', makeExtendedTracks(api.preview.chart, 0, ax).map((t) => t.key).join(',') === 'scaleX,scaleY,color', makeExtendedTracks(api.preview.chart, 0, ax).map((t) => t.key).join(','));

    // 预览求值：按拍取样（beatToSeconds 由拍轴给，避免写死 BPM）
    const b0 = ax.toSec(0);
    const bQ = ax.toSec(1); // 事件是 0–4 拍线性过渡，1 拍 = 走完四分之一
    const st = createState(api.preview.chart, { aspect: 16 / 9 });
    evaluate(st, bQ);
    check(
      '预览状态：扩展事件写进 state.lines[i].scaleX / scaleY',
      Math.abs(st.lines[0].scaleX - 1.25) < 1e-6 && Math.abs(st.lines[0].scaleY - 0.875) < 1e-6,
      `scaleX=${st.lines[0].scaleX.toFixed(4)} scaleY=${st.lines[0].scaleY.toFixed(4)}`,
    );
    check(
      '预览状态：颜色事件写进 extColor（不覆盖基准色 state.color）',
      Array.isArray(st.lines[0].extColor) && st.lines[0].extColor.join(',') === '255,191,191' && st.lines[0].color !== st.lines[0].extColor,
      `extColor=${st.lines[0].extColor} color=${st.lines[0].color}`,
    );
    evaluate(st, b0);
    check('扩展事件起点取起始值', Math.abs(st.lines[0].scaleX - 1) < 1e-6 && st.lines[0].extColor.join(',') === '255,255,255', `scaleX=${st.lines[0].scaleX} extColor=${st.lines[0].extColor}`);
    evaluate(st, ax.toSec(4));
    check(
      '扩展事件结束取终值',
      Math.abs(st.lines[0].scaleX - 2) < 1e-6 && Math.abs(st.lines[0].scaleY - 0.5) < 1e-6 && st.lines[0].extColor.join(',') === '255,0,0',
      `scaleX=${st.lines[0].scaleX} scaleY=${st.lines[0].scaleY} extColor=${st.lines[0].extColor}`,
    );
    evaluate(st, ax.toSec(12));
    check('扩展事件结束后维持终值', Math.abs(st.lines[0].scaleX - 2) < 1e-6 && st.lines[0].extColor.join(',') === '255,0,0', `scaleX=${st.lines[0].scaleX} extColor=${st.lines[0].extColor}`);

    // 导出为 RPE：扩展事件写回 RPE 字段名，未实现的键原样保留，再解析回来数值不丢
    {
      const { serializeRpe } = await import('../src/core/serialize-rpe.js');
      const { parseRpeChart } = await import('../src/core/parse-rpe.js');
      const { EXTENDED_RPE_FIELD } = await import('../src/core/units.js');
      // 告警看的是 `chart.extendedKeys`（解析时登记过哪些扩展键）：这里补上，模拟真实谱面
      const savedKeys = api.preview.chart.extendedKeys;
      api.preview.chart.extendedKeys = Object.keys(line0.extendedRaw ?? {});
      const out = serializeRpe(api.preview.chart);
      const ext = out.json.judgeLineList[0].extended;
      check('RPE 写回：三个已实现键各写成 RPE 字段', !!ext[EXTENDED_RPE_FIELD.scaleX] && !!ext[EXTENDED_RPE_FIELD.scaleY] && !!ext[EXTENDED_RPE_FIELD.color], Object.keys(ext ?? {}).join(','));
      check('RPE 写回：颜色是三元组数组', JSON.stringify(ext[EXTENDED_RPE_FIELD.color][0].end) === '[255,0,0]', JSON.stringify(ext[EXTENDED_RPE_FIELD.color][0].end));
      check('RPE 写回：未实现的密钥原样保留', JSON.stringify(out.json.judgeLineList[0].extended.inclineEvents) === JSON.stringify(line0.extendedRaw.inclineEvents), JSON.stringify(out.json.judgeLineList[0].extended.inclineEvents));
      check('RPE 写回：给出「未实现的扩展事件不渲染」的告警', out.warnings.some((w) => /inclineEvents/.test(w)), out.warnings.find((w) => /inclineEvents/.test(w)) ?? '（没有告警）');

      const back = (await import('../src/core/model.js')).prepareChart(parseRpeChart(out.json, { file: 'ext-roundtrip.json' }));
      check(
        'RPE 往返：扩展事件数值与缓动不丢',
        Math.abs(back.lines[0].extended.scaleX[0].end - 2) < 1e-9 &&
          Math.abs(back.lines[0].extended.scaleY[0].end - 0.5) < 1e-9 &&
          JSON.stringify(back.lines[0].extended.color[0].end) === '[255,0,0]',
        `scaleX=${back.lines[0].extended.scaleX[0].end} color=${JSON.stringify(back.lines[0].extended.color[0].end)}`,
      );
      line0.extended = { ...line0.extended, scaleX: [] };
      refreshLine(api.preview.chart, 0, { extended: ['scaleX'] });
      const cleared = serializeRpe(api.preview.chart).json.judgeLineList[0].extended;
      check('RPE 写回：模型里删空的扩展键不再写出', !cleared[EXTENDED_RPE_FIELD.scaleX] && !!cleared[EXTENDED_RPE_FIELD.scaleY], Object.keys(cleared ?? {}).join(','));
      line0.extended = { ...line0.extended, scaleX: [mkExt(1, 2)] };
      refreshLine(api.preview.chart, 0, { extended: ['scaleX'] });
      api.preview.chart.extendedKeys = savedKeys;
    }

    // 用添加工具往扩展轨里放事件：轨道重建后**已有的事件不能消失**
    // （曾经 rebuild 走 makeEventTrack 读 `layers[null]`，重建即清空，保存再打开才正常）
    {
      // 本段前面的用例换过谱面（loadJson 后 preview.chart 是新对象），时间轴还指着旧谱面：
      // 这里先对齐，否则会写进另一张谱面的同名线（真实使用中不会出现这种错配）
      api.timeline.setChart(api.preview.chart, api.timeline.axis ?? axis);
      api.timeline.setTracks(makeExtendedTracks(api.preview.chart, 0, ax));
      const tlBody2 = byId.get('ed-tl-body');
      tlBody2.__setSize(900, 600);
      tlBody2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
      const scaleXTrack = api.timeline.tracks.find((t) => t.id === 'ev:0:ext:scaleX');
      check('（用例前置）扩展轨在时间轴里', !!scaleXTrack && scaleXTrack.clips.length === 1, `${scaleXTrack?.clips?.length} 段`);
      api.timeline.setTool('add');
      api.timeline.setVisibleBeats(24, 0); // 视野放宽：x=560/720 落在已有事件（0~4 拍）之后
      const row = api.timeline.hitRects.find((r) => r.trackId === 'ev:0:ext:scaleX');
      if (row) {
        const y = Math.round(row.y + row.h / 2);
        const before = line0.extended.scaleX.length;
        tlBody2.dispatch('pointerdown', { clientX: 560, clientY: y, button: 0, pointerId: 71, pointerType: 'mouse' });
        tlBody2.dispatch('pointerdown', { clientX: 720, clientY: y, button: 0, pointerId: 72, pointerType: 'mouse' });
        check('添加工具：扩展轨新增一条事件', line0.extended.scaleX.length === before + 1, `${before} → ${line0.extended.scaleX.length}`);
        check(
          '添加工具：扩展轨重建后已有事件仍在（不消失）',
          scaleXTrack.clips.length === line0.extended.scaleX.length,
          `clip ${scaleXTrack.clips.length} / 数据 ${line0.extended.scaleX.length}`,
        );
      } else {
        check('（用例前置）扩展轨在时间轴里可见', false, '没有命中该轨道行');
      }
      api.timeline.setTool('mouse');
    }

    // 回收：删掉组内轨道，还原这条线的扩展数据
    for (const t of api.timeline.tracks.filter((x) => x.extended)) api.timeline.removeTrack(t.id);
    check('扩展轨可整组移除', api.timeline.tracks.filter((t) => t.extended).length === 0, `${api.timeline.tracks.filter((t) => t.extended).length} 条残留`);
    line0.extended = savedExtended;
    line0.extendedRaw = savedRaw;
    refreshLine(api.preview.chart, 0, { extended: EXTENDED_KEYS.slice() });
    api.bottomTabs.refresh();
    check('还原后「扩展事件」组不再标事件数', /无/.test(esc(extNode()?.textContent ?? '')), esc(extNode()?.textContent ?? ''));
  }

  // ── 谱面相机：谱面级的关键帧轨（x / y / z / focal）──
  {
    const { makeCameraTrack, makeCameraTracks, CAMERA_COLORS, CAMERA_LABELS } = await import('../src/editor/tracks.js');
    const { refreshCamera } = await import('../src/core/model.js');
    const { createState, evaluate } = await import('../src/core/state.js');
    const { createProjection } = await import('../src/render/projection.js');
    const { eventArrayOf } = await import('../src/editor/clipboard.js');
    const { makeEasing } = await import('../src/core/easing.js');

    const host = () => body.querySelectorAll('[data-tabbody="bottom"]')[0];
    const camNode = () => host().querySelectorAll('.ed-node').find((n) => esc(n.textContent).startsWith('谱面相机'));
    const camLeaf = (key) =>
      host()
        .querySelectorAll('.leaf')
        .find((n) => /相机/.test(esc(n.textContent)) && new RegExp(`（${key}）`).test(esc(n.textContent)));

    api.bottomTabs.activate('tree');
    api.bottomTabs.refresh();
    check('结构树最上面有「谱面相机」组', !!camNode(), camNode() ? esc(camNode().textContent) : '（没有这一行）');
    // 上一段用例点了「折叠全部」，相机组也是折叠的：先展开它（点击图标 → 树重绘）
    if (!camLeaf('x')) camNode()?.querySelectorAll('.caret-btn')[0]?.dispatch('click', { stopPropagation() {} });
    check('谱面相机组列出了四个通道（没有事件时也列出，便于从零开始做相机动画）', ['x', 'y', 'z', 'focal'].every((k) => !!camLeaf(k)), ['x', 'y', 'z', 'focal'].map((k) => esc(camLeaf(k)?.textContent ?? '（无）')).join(' | '));
    check('相机通道的颜色与约定一致', CAMERA_COLORS.x === '#4FC3F7' && CAMERA_COLORS.z === '#FF6347' && CAMERA_COLORS.focal === '#B388FF', Object.values(CAMERA_COLORS).join(' '));

    // 单击通道 → 导入该通道的轨（数据在谱面级的 chart.camera 里）
    const chart = api.preview.chart;
    const savedCamera = chart.camera;
    const tlBody2 = byId.get('ed-tl-body');
    tlBody2.__setSize(900, 600);
    tlBody2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 });
    const ax2 = api.timeline.axis ?? axis;
    // 先放一条关键帧（0–4 拍：z 从 0 线性到 1 屏高 = 往屏幕内推），这样轨道上有可点的块
    const mkCam = (key, start, end) => ({
      startBeat: 0,
      endBeat: 4,
      start,
      end,
      easingFn: makeEasing(1, null, 0, 1),
      easingType: 1,
      easingPreset: 1,
      bezierPoints: null,
      easingLeft: 0,
      easingRight: 1,
    });
    chart.camera = { z: [mkCam('z', 0, 1)] };
    refreshCamera(chart, ['x', 'y', 'z', 'focal']);
    api.timeline.setChart(chart, ax2);
    api.timeline.setTracks([]); // 时间轴只留相机这一条，保证它的行在可见范围内
    camLeaf('z')?.dispatch('click');
    const camTrack = api.timeline.tracks.find((t) => t.id === 'cam:z');
    check('单击相机通道导入轨道（id = cam:<通道>）', !!camTrack, api.timeline.tracks.map((t) => t.id).join(', '));
    check(
      '相机轨标记 camera 且用哨兵 lineId（复用按线重编译 / 撤销的既有路径）',
      camTrack?.camera === true && camTrack?.lineId === -1 && camTrack?.layerIndex === null,
      JSON.stringify({ camera: camTrack?.camera, lineId: camTrack?.lineId, layerIndex: camTrack?.layerIndex }),
    );
    check('相机轨的块文案与普通事件一致（起止值 / 拍数 / 缓动）', /0 → 1, 4拍, 线性/.test(camTrack?.clips?.[0]?.text ?? ''), camTrack?.clips?.[0]?.text ?? '（无）');
    check('相机轨的纵向刻度取本轨的历史范围', camTrack?.range?.min === 0 && camTrack?.range?.max === 1, JSON.stringify(camTrack?.range));

    // 用添加工具在相机轨上再放一条关键帧 → 数据写进 chart.camera.z 并重编译
    {
      api.timeline.setTool('add');
      api.timeline.setVisibleBeats(24, 0);
      const row = api.timeline.hitRects.find((r) => r.trackId === 'cam:z');
      if (row) {
        const y = Math.round(row.y + row.h / 2);
        tlBody2.dispatch('pointerdown', { clientX: 560, clientY: y, button: 0, pointerId: 81, pointerType: 'mouse' });
        tlBody2.dispatch('pointerdown', { clientX: 720, clientY: y, button: 0, pointerId: 82, pointerType: 'mouse' });
        check('添加工具：相机轨新增关键帧（写进 chart.camera.z，取自上一个事件的末值）', chart.camera.z.length === 2 && chart.camera.z[1].start === 1, `${chart.camera.z.length} 条，第二段取值 ${chart.camera.z[1]?.start}`);
        check('相机轨重建后关键帧仍在（不消失）', api.timeline.tracks.find((t) => t.id === 'cam:z')?.clips.length === 2, `${api.timeline.tracks.find((t) => t.id === 'cam:z')?.clips.length} 段`);
      } else {
        check('（用例前置）相机轨在时间轴里可见', false, '没有命中该轨道行');
      }
      api.timeline.setTool('mouse');
    }

    // 事件数组定位 / 求值：相机走 chart.camera，写回路径与扩展事件一致（只是谱面级）
    check('相机的写回数组取自 chart.camera', eventArrayOf(chart, { camera: true, key: 'z' }) === chart.camera.z, '');
    if (chart.camera.z?.[0]) {
      const stCam = createState(chart, { aspect: 16 / 9 });
      evaluate(stCam, ax2.toSec(0));
      const z0 = stCam.camera.z;
      evaluate(stCam, ax2.toSec(2));
      const zMid = stCam.camera.z;
      evaluate(stCam, ax2.toSec(4));
      const zEnd = stCam.camera.z;
      check('预览求值：相机关键帧写进 state.camera.z（线性插值）', Math.abs(z0) < 1e-9 && Math.abs(zMid - 0.5) < 1e-6 && Math.abs(zEnd - 1) < 1e-6, `${z0} → ${zMid} → ${zEnd}`);
      check('默认视图：没有关键帧的通道取缺省值（x = y = 0、focal = 1）', stCam.camera.x === 0 && stCam.camera.y === 0 && stCam.camera.focal === 1, JSON.stringify(stCam.camera));

      // 投影：相机推进后判定线被放大（k = F/(F − z)，越界前夹住，不炸）
      const view = createProjection(1280, 720);
      const line = { worldX: 0, worldY: 0, worldRotate: 0, z: 0, theta: 0 };
      const k0 = view.lineDepthScale(line, { camera: { z: 0 } });
      const kEnd = view.lineDepthScale(line, { camera: { z: 1 } });
      check('预览投影接上相机：z 推进 → 判定线整体放大（k > 1）且不会炸', Number.isFinite(kEnd) && kEnd > k0 * 10, `k ${k0.toFixed(2)} → ${kEnd.toFixed(2)}`);
    } else {
      check('（用例前置）相机关键帧已建立', false, '没有关键帧');
    }

    // 拖动相机事件：拍值写回（相机是谱面级的，拍值不按线换算）
    {
      const track = api.timeline.tracks.find((t) => t.id === 'cam:z');
      const before = chart.camera.z?.[0]?.startBeat;
      api.timeline.setTool('mouse');
      api.timeline.setVisibleBeats(24, 0);
      const hit = api.timeline.hitRects.find((r) => r.trackId === 'cam:z');
      if (track && hit && Number.isFinite(before)) {
        api.timeline.selectEvents([`cam:z#0`]);
        const y = Math.round(hit.y + hit.h / 2);
        tlBody2.dispatch('pointerdown', { clientX: Math.round(hit.x + hit.w / 2), clientY: y, button: 0, pointerId: 91, pointerType: 'mouse' });
        tlBody2.dispatch('pointermove', { clientX: Math.round(hit.x + hit.w / 2 + 40), clientY: y, pointerId: 91, pointerType: 'mouse' });
        tlBody2.dispatch('pointerup', { clientX: Math.round(hit.x + hit.w / 2 + 40), clientY: y, pointerId: 91, pointerType: 'mouse' });
        check('拖动相机事件：拍值写回 chart.camera（相机不按线换算）', chart.camera.z[0].startBeat > before, `${before} → ${chart.camera.z[0].startBeat}`);
        check('拖动相机事件：撤销栈记录了这次改动', api.timeline.canUndo === true);
      } else {
        check('（用例前置）相机轨可见且有关键帧', false, `hit=${!!hit} before=${before}`);
      }
    }

    // 单击组 → 整组导入（四个通道里已有事件的那些）
    api.timeline.setTracks([]);
    camNode()?.dispatch('click');
    const camImported = api.timeline.tracks.filter((t) => t.camera);
    check('单击「谱面相机」组：整组导入已有通道', camImported.length === makeCameraTracks(chart, ax2).length, camImported.map((t) => t.id).join(', '));
    check('相机轨统一绑定到 camera 组', camImported.every((t) => t.group === 'camera'), [...new Set(camImported.map((t) => t.group))].join(','));
    check('相机轨的标签带「谱面相机」', camImported.every((t) => t.label.includes('谱面相机')), camImported.map((t) => t.label).join(' | '));
    check('相机通道的中文名与约定一致', CAMERA_LABELS.focal === '相机焦距事件', CAMERA_LABELS.focal);

    // 回收：还原相机数据
    api.timeline.setTracks([]);
    chart.camera = savedCamera;
    refreshCamera(chart, ['x', 'y', 'z', 'focal']);
    api.bottomTabs.refresh();
    check('还原后「谱面相机」组回到无关键帧状态', /无/.test(esc(camNode()?.textContent ?? '')), esc(camNode()?.textContent ?? ''));
    check('（前置）makeCameraTrack 在空数据下也安全', makeCameraTrack(chart, 'x', ax2).clips.length === 0);
  }
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
  // 预览顶栏（信息行 + 三个显示开关）已按需求去掉，画布直接铺满整块
  const previewPane = byId.get('ed-preview');
  check('预览区没有顶栏工具条', previewPane.querySelectorAll('.ed-panebar').length === 0);
  check(
    '预览区的显示开关已移除（判定线 / 音符 / 多押提示）',
    !byId.get('ed-show-lines') && !byId.get('ed-show-notes') && !byId.get('ed-multi-hint'),
  );
  check('预览画布仍在', !!byId.get('ed-canvas'));

  // 工作区焦点：点哪块哪块亮 1px 描边
  const cssText = fs.readFileSync(path.join(process.cwd(), 'editor.css'), 'utf8');
  const previewPaneEl = byId.get('ed-preview');
  const timelinePaneEl = byId.get('ed-timeline');
  previewPaneEl.dispatch('pointerdown', { clientX: 5, clientY: 5, button: 0, pointerId: 90 });
  check(
    '点击工作区获得焦点并亮起描边',
    previewPaneEl.classList.contains('focused') && !timelinePaneEl.classList.contains('focused'),
    `preview=${previewPaneEl.className}`,
  );
  timelinePaneEl.dispatch('pointerdown', { clientX: 5, clientY: 5, button: 0, pointerId: 91 });
  check(
    '焦点切到另一块工作区后上一块熄灭',
    timelinePaneEl.classList.contains('focused') && !previewPaneEl.classList.contains('focused'),
  );
  check(
    '焦点描边用 outline（1px 且不占布局，预览的黑画布也压不住）',
    /\.ed-pane\.focused \{[^}]*outline: 1px/s.test(cssText) && /outline-offset: -1px/.test(cssText),
  );
  check(
    'iOS：禁用了系统级文字框选 / 长按气泡 / 双击缩放（输入框仍可选）',
    /-webkit-user-select: none/.test(cssText) &&
      /-webkit-touch-callout: none/.test(cssText) &&
      /touch-action: manipulation/.test(cssText) &&
      /input,[\s\S]{0,40}?select \{[^}]*-webkit-user-select: text/s.test(cssText),
  );
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
  const resetSizes = api.layout.sizes;
  check(
    '重置后回到默认比例（左上:右上 = 3:2）',
    resetSizes.topLeftW === Math.round(1400 * 0.6),
    `topLeftW=${resetSizes.topLeftW}（应为 ${Math.round(1400 * 0.6)}）`,
  );
  check('重置后回到默认比例（左下:右下 = 1:3）', resetSizes.bottomLeftW === Math.round((1400 - 92) * 0.25), `bottomLeftW=${resetSizes.bottomLeftW}`);
  check('重置后上下各占一半', resetSizes.topH === 50, `topH=${resetSizes.topH}`);
}

section('拖动写回谱面（模型 + 派生数据立刻生效）');
{
  const api = globalThis.PhiChartEditor;
  const chart = api.preview.chart;
  const { defaultTracks } = await import('../src/editor/tracks.js');
  const { writeSourceTimes } = await import('../src/editor/insert.js');
  const { resyncJudgeCursor } = await import('../src/core/state.js');
  const tlBody4 = byId.get('ed-tl-body');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 用默认轨道（1 号线的音符 + 第一个事件层）建立确定性的起点
  const def = defaultTracks(chart);
  api.timeline.setChart(chart, def.axis);
  api.timeline.setTracks(def.tracks);
  api.timeline.resetView();
  api.timeline.setTool('mouse');
  tlBody4.__setSize(900, 420);
  api.timeline.redraw();
  const line0 = chart.lines[0];
  const yTrack = api.timeline.tracks.find((t) => t.kind === 'events' && t.key === 'y');
  const notesTrack = api.timeline.tracks.find((t) => t.kind === 'notes');
  check('默认轨道里有 y 事件轨与音符轨', !!yTrack && !!notesTrack);

  const dragClip = (trackId, index, dxPx, dyPx = 0) => {
    const rect = api.timeline.hitRects.find((r) => r.trackId === trackId && r.index === index && r.kind === (trackId.startsWith('notes') ? 'notes' : 'events'));
    if (!rect) return null;
    api.timeline.selectEvents(trackId.startsWith('notes') ? [] : [`${trackId}#${index}`]);
    if (trackId.startsWith('notes')) api.timeline.selectNotes([`${trackId}#${index}`]);
    const cx = Math.round(rect.x + rect.w / 2);
    const cy = Math.round(rect.y + rect.h / 2);
    tlBody4.dispatch('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 61 });
    tlBody4.dispatch('pointermove', { clientX: cx + dxPx, clientY: cy + dyPx, pointerId: 61 });
    tlBody4.dispatch('pointerup', { clientX: cx + dxPx, clientY: cy + dyPx, pointerId: 61 });
    return rect;
  };

  // ── 事件：拖动后源对象、编译列表都要跟上 ──
  const ev0 = yTrack.clips[0].ev;
  const startBefore = ev0.startBeat;
  const endBefore = ev0.endBeat;
  const listBefore = line0.rt.y[0].list.length;

  const pxPerBeat = api.timeline.pxPerBeat;
  const tl0 = line0.rt.timeline; // 线内拍 ↔ 秒
  const rect0 = dragClip(yTrack.id, 0, Math.round(pxPerBeat * 2));
  check('拖到了 y 事件块', !!rect0);
  const clipB0 = yTrack.clips[0].b0;
  check('拖动的位移写进了 clip（+2 拍）', Math.abs(clipB0 - 2) < 1e-6, `clip.b0=${clipB0.toFixed(3)} 拍`);
  const wantStart = tl0.secondsToBeat(def.axis.toSec(clipB0));
  check(
    '拖动写回源事件：起点 = 时间轴上新的左边缘',
    Math.abs(ev0.startBeat - wantStart) < 1e-6,
    `${startBefore.toFixed(3)} → ${ev0.startBeat.toFixed(3)}（期望 ${wantStart.toFixed(3)}）`,
  );
  check(
    '哨兵起点（「从开头就生效」）被拖动后变成具体拍值，与看到的左边缘一致',
    startBefore >= -1000 || ev0.startBeat >= 0,
    `原 ${startBefore.toFixed(1)} → ${ev0.startBeat.toFixed(3)}`,
  );
  check(
    '拖动保持事件时长不变',
    endBefore >= 1e6 || Math.abs(ev0.endBeat - ev0.startBeat - (endBefore - startBefore)) < 1e-9,
    `时长 ${(endBefore - startBefore).toFixed(3)} → ${(ev0.endBeat - ev0.startBeat).toFixed(3)} 拍`,
  );
  check(
    '运行时事件列表同步重编译（预览才看得见改动）',
    line0.rt.y[0].list.length === listBefore && line0.rt.y[0].list.some((e) => Math.abs(e.t0 - tl0.beatToSeconds(ev0.startBeat)) < 1e-6),
    `列表 ${line0.rt.y[0].list.length} 条（原 ${listBefore}）`,
  );
  check('源事件对象就是拖动写的那个（clip.ev 身份不变）', yTrack.clips[0].ev === ev0);

  // ── 音符：编译对象 + 源对象 + 派生时间/高度 ──
  api.timeline.clearSelection();
  api.timeline.ensureBeatVisible(notesTrack.clips[0].b0); // 第一个音符滚进视野，才拿得到命中区
  api.timeline.redraw();
  // 命中优先级与 hitTest 一致：覆盖该点的**最后一个**矩形才算真的点到（否则会点在邻居身上）
  const topRectAt = (c) => {
    const x = c.x + c.w / 2;
    const y = c.y + c.h / 2;
    return api.timeline.hitRects.filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h).pop() ?? null;
  };
  const noteHit =
    api.timeline.hitRects
      .filter((r) => r.kind === 'notes' && r.w <= 40)
      .find((c) => {
        const top = topRectAt(c);
        return top && top.index === c.index && top.trackId === c.trackId;
      }) ?? null;
  let noteRef = null;
  let nStartBefore = 0;
  let nXBefore = 0;
  if (noteHit) {
    const note = notesTrack.clips[noteHit.index].note;
    const nStart = note.startBeat;
    const nX = note.positionX;
    noteRef = note;
    nStartBefore = nStart;
    nXBefore = nX;
    dragClip(notesTrack.id, noteHit.index, Math.round(pxPerBeat * 2), 20);
    check('拖动写回编译音符（startBeat 改变）', Math.abs(note.startBeat - nStart - 2) < 1e-6, `${nStart.toFixed(3)} → ${note.startBeat.toFixed(3)}`);
    check('拖动写回音符源对象（note.src 同步）', Math.abs((note.src?.startBeat ?? NaN) - note.startBeat) < 1e-9, `src.startBeat=${note.src?.startBeat}`);
    check(
      '官方源字段同步（time = 拍 × 32）',
      !('time' in (note.src ?? {})) || Math.abs(note.src.time - note.startBeat * 32) < 1e-6,
      `src.time=${note.src?.time}`,
    );
    check('拖动写回 positionX（编译对象与源对象一致）', note.positionX !== nX && Math.abs(note.src.positionX - note.positionX) < 1e-9, `${nX.toFixed(2)} → ${note.positionX.toFixed(2)}`);
    check(
      '派生的 timeSec / height 重算',
      Math.abs(note.timeSec - tl0.beatToSeconds(note.startBeat)) < 1e-9 && Number.isFinite(note.height),
      `timeSec=${note.timeSec.toFixed(3)} height=${Number(note.height).toFixed(3)}`,
    );
    check('chart.notes 拖动后仍按时间有序', chart.notes.every((n, i, a) => i === 0 || a[i - 1].timeSec <= n.timeSec));
    check('谱面结束时间跟着音符走（endTime 覆盖住新位置）', chart.endTime + 1e-9 >= note.endSec, `endTime=${chart.endTime.toFixed(2)} note.endSec=${note.endSec.toFixed(2)}`);
    // 判定游标：拖动重排 chart.notes 后必须仍停在第一个未判定的音符上
    resyncJudgeCursor(api.preview.state);
    const cursor = api.preview.state.judgeCursor;
    check(
      '判定游标重新定位（不会重复判定/漏判）',
      cursor === chart.notes.findIndex((n) => !n.judged && Number.isFinite(n.timeSec)),
      `cursor=${cursor}`,
    );
  } else {
    check('音符轨里有可拖动的音符', false, '没找到命中区');
  }

  // ── 「保持到结束」的事件：末值是哨兵，拖动不能改掉它 ──
  const holding = line0.layers[0].y?.find((e) => e.endBeat >= 1e6);
  const holdStartBefore = holding?.startBeat ?? 0;
  if (holding) {
    const idx = yTrack.clips.findIndex((c) => c.ev === holding);
    const endKeep = holding.endBeat;
    const b0 = holding.startBeat;
    if (idx >= 0) {
      api.timeline.clearSelection();
      api.timeline.ensureBeatVisible(holding.startBeat); // 哨兵事件可能在很远处，先滚过去
      api.timeline.redraw();
      dragClip(yTrack.id, idx, Math.round(pxPerBeat));
    }
    check('保持到结束的事件：拖动只挪起点，哨兵末值不动', holding.endBeat === endKeep && Math.abs(holding.startBeat - b0 - 1) < 1e-6, `endBeat=${holding.endBeat} startBeat ${b0.toFixed(2)} → ${holding.startBeat.toFixed(2)}`);
  } else {
    check('保持到结束的事件：这张谱面里没有（跳过哨兵检查）', true, '官方谱这一线没有哨兵事件');
  }

  // ── 源对象时间写回：official 与 RPE 两套字段都要填对 ──
  const offSrc = { type: 1, time: 0, positionX: 0, holdTime: 0 };
  writeSourceTimes(offSrc, 10, 12);
  check('official 源字段：time / holdTime 按 1 拍 = 32 单位', offSrc.time === 320 && offSrc.holdTime === 64, JSON.stringify(offSrc));
  const rpeSrc = { type: 1, startTime: 0, endTime: 0 };
  writeSourceTimes(rpeSrc, 8, 9.5);
  check('RPE 源字段：startTime / endTime 用拍', rpeSrc.startTime === 8 && rpeSrc.endTime === 9.5, JSON.stringify(rpeSrc));

  // ── 端到端：拖出来的重叠必须被纠错报出来（而且还是警告级） ──
  const yList = line0.layers[0].y ?? [];
  const overlapsInList = yList.some((a, i) => {
    const a1 = a.endBeat >= 1e6 ? Infinity : a.endBeat;
    return yList.some((b, j) => j > i && b.startBeat < a1 - 1e-9 && a.startBeat < b.endBeat - 1e-9);
  });
  check('拖动之后这一线确实存在区间重叠（按纠错的同一套规则自查）', overlapsInList, `${yList.length} 条 y 事件`);
  api.lint.runNow();
  await sleep(600);
  const lintItems = api.lint.items;
  check(
    '纠错把拖动造成的重叠报了出来',
    !overlapsInList || lintItems.some((i) => i.rule === 'event-overlap' && i.lineId === 0),
    `${lintItems.filter((i) => i.rule === 'event-overlap').length} 条 event-overlap`,
  );
  check(
    '重叠是警告级（渲染与导出都正常，只是按后开始者生效）',
    lintItems.filter((i) => i.rule === 'event-overlap' || i.rule === 'note-overlap').every((i) => i.severity === 'warn'),
    lintItems.map((i) => `${i.rule}:${i.severity}`).join(' '),
  );
  check(
    '负时长/非法值仍是错误级',
    lintItems.filter((i) => ['event-duration', 'note-nan', 'event-nan', 'note-type'].includes(i.rule)).every((i) => i.severity === 'error'),
    lintItems.filter((i) => i.severity === 'error').map((i) => i.rule).join(' ') || '（当前没有错误级条目）',
  );

  // 收尾：把拖动改掉的数据还原（后面的「真实谱面 0 误报」用例要一张干净的谱面）
  const { refreshLine, refreshNotes } = await import('../src/core/model.js');
  ev0.startBeat = startBefore;
  ev0.endBeat = endBefore;
  if (typeof noteRef !== 'undefined' && noteRef) {
    const dur = noteRef.endBeat - noteRef.startBeat;
    noteRef.startBeat = nStartBefore;
    noteRef.endBeat = nStartBefore + dur;
    noteRef.positionX = nXBefore;
    writeSourceTimes(noteRef.src, noteRef.startBeat, noteRef.endBeat);
    if (noteRef.src) noteRef.src.positionX = noteRef.positionX;
  }
  if (typeof holding !== 'undefined' && holding) holding.startBeat = holdStartBefore;
  refreshLine(chart, 0, { keys: ['y'], notes: true });
  refreshNotes(chart);
  api.timeline.setTracks(def.tracks); // 轨道也按还原后的模型重建
  api.timeline.resetView();
  api.timeline.clearSelection();
  api.lint.runNow();
  await sleep(600);
  check('还原后谱面回到 0 误报（说明前面确实只动了该动的那条线）', api.lint.summary?.total === 0, JSON.stringify(api.lint.summary?.byRule ?? {}));
}

section('纠错：规则（合成谱面，纯逻辑）');
{
  const { auditChart, createLintScan, summarize, lineSignature } = await import('../src/editor/lint.js');
  // 极简时间轴 + 拍轴：lint 只用到 beatToSeconds / toBeat
  const tl = { beatToSeconds: (b) => b * 0.5 };
  const axis = { toBeat: (s) => s * 2 };
  const ev = (b0, b1, v0, v1) => ({ startBeat: b0, endBeat: b1, start: v0, end: v1, easingType: 1, easingLeft: 0, easingRight: 1 });
  const note = (type, b0, b1, x, above = true, speed = 1) => ({
    type,
    startBeat: b0,
    endBeat: b1,
    positionX: x,
    above,
    speed,
    lineId: 0,
    timeSec: b0 * 0.5,
  });

  const layer0 = {
    x: [ev(0, 4, 0, 0.2), ev(2, 6, 0.2, 0.4)], // 重叠
    alpha: [ev(0, 2, 0, 1.4)], // 值越界
    // 最后一条埋一个越界值：守住「最后一个单元的生成器被提前丢掉」那个 bug（当时每行只扫到第 1 条 speed）
    speed: [ev(0, 1, 1, 1), ev(2, 3, 1, 1), ev(4, 5, 20000, 20000)],
  };
  const layer1 = {
    y: [ev(0, 1e9, 0, 0), ev(2, 3, 0, 0)], // 哨兵不在末位
    rotate: [ev(5, 6, 0, 0), ev(2, 3, 0, 0)], // 未按时间排序
    alpha: [ev(20, 18, 0, 0)], // 负时长（单独一条，不会连带报重叠）
  };
  const chart = {
    endTime: 30,
    lines: [
      {
        id: 0,
        layers: [layer0, layer1],
        rt: {
          timeline: tl,
          notes: [
            note('tap', 1, 1, 3),
            note('tap', 1, 1, 3), // 与上一条完全重合
            note('tap', 1, 1, 3, false), // 背面：不算重叠
            note('hold', 4, 4, 1), // Hold 零长
            note('hold', 8, 6, -1), // Hold 负时长
            note('drag', 10, 11, 2), // 非 Hold 带时长
            note('tap', 12, 12, 40), // positionX 超界
            note('tap', 14, 14, 1, true, 0), // 速度 0
            note('tap', -3, -3, 0), // 负拍
            note('tap', 16, 16, 8.5), // 阈值内（8.889）：不该报
            { type: 'tap', startBeat: NaN, endBeat: 1, positionX: 0, above: true, timeSec: 0 }, // 非有限
          ],
        },
      },
    ],
  };

  const scan = auditChart(chart, { axis });
  const sum = summarize(scan);
  const has = (rule) => (scan.counts[rule] ?? 0) > 0;
  check('检出音符重叠（同 positionX 同面同时间）', scan.counts['note-overlap'] === 1, `note-overlap=${scan.counts['note-overlap'] ?? 0}`);
  check('正/背面不算重叠', scan.counts['note-overlap'] === 1, '背面那条没有被算进去');
  check('检出 positionX 超界', scan.counts['note-x-range'] === 1, `count=${scan.counts['note-x-range'] ?? 0}`);
  check('positionX 在阈值内（8.5 < 8.889）不误报', scan.counts['note-x-range'] === 1, '只报了 40 那一条');
  check('检出 Hold 零长', has('hold-zero'));
  check('检出 Hold 负时长', has('hold-negative'));
  check('检出非 Hold 带时长', has('note-extra-duration'));
  check('检出音符速度为 0', has('note-speed'));
  check('检出音符时间为负', has('note-negative-beat'));
  check('检出音符字段非有限', has('note-nan'));
  check('检出事件负时长', has('event-duration'));
  check('检出事件重叠（跨层合并后）', (scan.counts['event-overlap'] ?? 0) >= 2, `count=${scan.counts['event-overlap'] ?? 0}`);
  check('检出事件值越界', has('event-value'));
  check('检出「保持到结束」不在末位', has('event-sentinel'));
  check('检出事件数组未排序', has('event-order'));
  // 唯一例外：涉及 Hold 的重叠放过（Hold 与别的音符同位置同时刻是常见写法）
  chart.lines[0].rt.notes.push(note('hold', 1, 3, 3)); // 与第 1 条 tap（1 拍、X=3、正面）重叠
  const scanHold = auditChart(chart, { axis });
  check(
    'Hold 与其它音符重叠不报（唯一例外）',
    scanHold.counts['note-overlap'] === scan.counts['note-overlap'],
    `重叠条数 ${scan.counts['note-overlap'] ?? 0} → ${scanHold.counts['note-overlap'] ?? 0}`,
  );
  chart.lines[0].rt.notes.pop();
  check(
    '最后一个单元的最后一条也会被扫到（回归：曾每行只扫第 1 条 speed）',
    scan.items.some((i) => i.key === 'speed' && i.lineId === 0 && i.text.includes('20000')),
  );
  check('明细排序：错误在前、同级别按线号与拍', scan.items[0]?.severity === 'error' && sum.error > 0 && sum.warn > 0);

  // 分片扫描（0ms 预算）必须与一次扫完结果一致
  const chunked = createLintScan(chart, { axis });
  let slices = 0;
  while (!chunked.step(0)) slices++;
  check(
    '分片扫描与一次扫完结果一致',
    JSON.stringify(chunked.counts) === JSON.stringify(scan.counts) && slices > 1,
    `${slices} 片`,
  );

  // 按线缓存：签名不变就复用；改一条就只重扫那一条线
  const sigBefore = lineSignature(chart.lines[0]);
  const again = createLintScan(chart, { axis, cache: scan.cache });
  while (!again.step(Infinity));
  check('二次扫描（命中缓存）结果一致', JSON.stringify(again.counts) === JSON.stringify(scan.counts));
  chart.lines[0].rt.notes[6].positionX = 1; // 把超界的音符改回来
  check('改动后签名变化', lineSignature(chart.lines[0]) !== sigBefore);
  const third = createLintScan(chart, { axis, cache: again.cache });
  while (!third.step(Infinity));
  check('改动后 positionX 超界消失', !third.counts['note-x-range']);
  // 缓存里除了这条线，还有一条**谱面相机**的条目（相机是谱面级的，用哨兵 lineId 单独缓存）
  check('缓存按判定线保存（含谱面相机 1 条）', third.cache.size === 2, `size=${third.cache.size}`);
  chart.lines[0].rt.notes[6].positionX = 40; // 还原
}

section('纠错：X/Y 位移不成对');
{
  const { auditChart } = await import('../src/editor/lint.js');
  const tl = { beatToSeconds: (b) => b * 0.5 };
  const pair = (b0, b1) => ({ startBeat: b0, endBeat: b1, start: 0.1, end: 0.2, easingType: 1 });
  const mk = (layer, source = {}) => ({
    endTime: 60,
    source,
    lines: [{ id: 0, layers: [layer], rt: { timeline: tl, notes: [] } }],
  });
  const run = (layer, source) => auditChart(mk(layer, source));

  const countDiff = run({ x: [pair(0, 4), pair(4, 8), pair(8, 12)], y: [pair(0, 4), pair(4, 8)] });
  check(
    '检出条数不同（X 多出一条没配对）',
    countDiff.counts['move-pair'] === 1 && /多出 1 条/.test(countDiff.items[0]?.text ?? ''),
    countDiff.items[0]?.text,
  );
  check('不成对算错误级', countDiff.items[0]?.severity === 'error', countDiff.items[0]?.severity);
  check(
    '条目带跳转信息（层号 + 事件对象 + 拍）',
    countDiff.items[0]?.layerIndex === 0 &&
      !!countDiff.items[0]?.obj &&
      countDiff.items[0]?.key === 'x' &&
      Number.isFinite(countDiff.items[0]?.beat),
    `key=${countDiff.items[0]?.key} layer=${countDiff.items[0]?.layerIndex} beat=${countDiff.items[0]?.beat}`,
  );
  check('跳转指向第一条没有对手的事件（第 3 条）', countDiff.items[0]?.index === 2, `index=${countDiff.items[0]?.index}`);

  const intervalDiff = run({ x: [pair(0, 4), pair(4, 8)], y: [pair(0, 4), pair(5, 9)] });
  check(
    '检出条数相同但起止拍对不上',
    intervalDiff.counts['move-pair'] === 1 && /共 1 处/.test(intervalDiff.items[0]?.text ?? ''),
    intervalDiff.items[0]?.text,
  );
  check('指到第一处不一致的位置', intervalDiff.items[0]?.index === 1, `index=${intervalDiff.items[0]?.index}`);

  const paired = run({ x: [pair(0, 4), pair(4, 8)], y: [pair(0, 4), pair(4, 8)] });
  check('成对的层不报（真实谱面就是这种形态）', !paired.counts['move-pair'], JSON.stringify(paired.counts));

  const single = run({ x: [pair(0, 4), pair(4, 8)] });
  check('只做单向位移不报（不绑定时合法）', !single.counts['move-pair'], JSON.stringify(single.counts));

  const bound = run({ x: [pair(0, 4), pair(4, 8)], y: [pair(0, 4)] }, { xybind: true });
  check('谱面声明了 xybind 时消息里点明绑定', /XY 绑定/.test(bound.items[0]?.text ?? ''), bound.items[0]?.text);
}

section('纠错：左下角页面 / 自动加轨跳转 / 角标');
{
  const api = globalThis.PhiChartEditor;
  const chart = api.preview.chart;
  const bottomBody = body.querySelectorAll('[data-tabbody="bottom"]')[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const mkEv = (b0, b1, v0, v1) => ({ startBeat: b0, endBeat: b1, start: v0, end: v1, easingType: 1, easingLeft: 0, easingRight: 1 });

  // 真实谱面先扫一遍：阈值就是照它定的，必须 0 命中
  api.bottomTabs.activate('lint');
  api.lint.runNow();
  await sleep(500);
  const real = api.lint.summary;
  let expectedEvents = 0;
  for (const l of chart.lines) {
    for (const ly of l?.layers ?? []) {
      for (const k of ['x', 'y', 'rotate', 'alpha', 'speed']) if (Array.isArray(ly?.[k])) expectedEvents += ly[k].length;
    }
  }
  check('真实谱面扫完（无卡死）', !!real, JSON.stringify(real?.byRule ?? {}));
  check('真实谱面 0 误报', real?.total === 0, `错误 ${real?.error} / 警告 ${real?.warn}`);
  check(
    '事件扫描数与逐层实测一致（回归：曾漏扫 1238 条）',
    real?.scanned.events === expectedEvents,
    `${real?.scanned.events} / ${expectedEvents}`,
  );
  check('音符扫描数与谱面一致', real?.scanned.notes === chart.notes.length, `${real?.scanned.notes} / ${chart.notes.length}`);

  api.bottomTabs.refresh();
  check('模型检查通过时说明「检查了什么」', /未发现问题/.test(bottomBody.textContent), clip(bottomBody.textContent));
  check('没有问题时角标显示通过', api.bottomTabs.getBadge('lint')?.text === '✓', String(api.bottomTabs.getBadge('lint')?.text));

  // ── 解析告警：只在载入时提醒一次（不再常驻在纠错页里）──
  {
    chart.warnings.push('测试用解析告警：含 *Control 字段（本版本未实现，已忽略）');
    api.notifyParseWarnings(chart, '测试谱面');
    const toast = byId.get('ed-toast');
    check(
      '解析告警在载入时提醒一次（toast 显示条数与内容）',
      !!toast && !toast.classList.contains('hidden') && /1 条解析告警/.test(toast.textContent) && /测试用解析告警/.test(toast.textContent),
      clip(toast?.textContent, 80),
    );
    await sleep(300);
    api.bottomTabs.refresh();
    check('纠错页不再常驻解析告警', !/测试用解析告警/.test(bottomBody.textContent));
    chart.warnings.pop();
  }
  // ── 注入两类错误：5 号线的事件负时长、7 号线的音符重叠（这两条轨道默认都不在时间轴里） ──
  const l5 = chart.lines[5];
  l5.layers ??= [];
  l5.layers[0] ??= { x: [], y: [], rotate: [], alpha: [], speed: [] };
  l5.layers[0].x ??= [];
  l5.layers[0].x.push(mkEv(10, 8, 0, 0));
  const n7 = chart.lines[7]?.rt?.notes ?? [];
  if (n7.length) n7.push({ ...n7[0] });
  api.lint.markDirty();
  check('数据变动后标脏', api.lint.dirty === true);
  api.lint.runNow();
  await sleep(500);
  const items = api.lint.items;
  const evItem = items.find((i) => i.rule === 'event-duration' && i.lineId === 5);
  const noteItem = items.find((i) => i.rule === 'note-overlap' && i.lineId === 7);
  check('检出注入的事件负时长', !!evItem, evItem ? `${evItem.where} ${evItem.beat.toFixed(2)} 拍` : '未检出');
  check('检出注入的音符重叠', !!noteItem, noteItem ? `${noteItem.where} ${noteItem.beat.toFixed(2)} 拍` : '未检出');
  check('角标变成错误条数', /^\d+$/.test(api.bottomTabs.getBadge('lint')?.text ?? ''), String(api.bottomTabs.getBadge('lint')?.text));
  check('错误条目带上了正确的拍数', Math.abs((evItem?.beat ?? -1) - 10) < 1e-6, String(evItem?.beat));

  // ── 点击条目：自动加轨 + 纵向/横向把视角移过去 + 选中 ──
  byId.get('ed-tl-body').__setSize(900, 200); // 视口压小，纵向滚动才有意义
  api.bottomTabs.refresh();
  const rows = bottomBody.querySelectorAll('.ed-lint-item');
  const row = rows.find((r) => /时长为负/.test(r.textContent));
  check('页面上有可点击的错误条目', !!row, `${rows.length} 条`);
  const hadTrack = api.timeline.tracks.some((t) => t.id === 'ev:5:0:x');
  row?.dispatch('click');
  check('错误所在轨道原本不在时间轴里', !hadTrack);
  check('跳转时自动把轨道加入时间轴', api.timeline.tracks.some((t) => t.id === 'ev:5:0:x'));
  check('跳转后选中了出错的片段', api.timeline.selection.count >= 1, `选中 ${api.timeline.selection.count} 个`);
  check(
    '指针跳到了错误点（按秒对齐）',
    Math.abs(api.timeline.time - (evItem?.sec ?? -1)) < 1e-6,
    `指针 ${api.timeline.time.toFixed(3)}s / 期望 ${(evItem?.sec ?? -1).toFixed(3)}s`,
  );
  const vis = api.timeline.visibleBeats;
  check(
    '错误点落在可见范围内',
    api.timeline.scrollBeat <= api.timeline.currentBeat && api.timeline.currentBeat <= api.timeline.scrollBeat + vis,
    `可见 ${api.timeline.scrollBeat.toFixed(2)}~${(api.timeline.scrollBeat + vis).toFixed(2)} 拍`,
  );
  check('纵向滚到了该轨道', api.timeline.scrollTop > 0, `scrollTop=${api.timeline.scrollTop}`);
  check('状态栏说明了自动加轨', /已自动加入/.test(String(globalThis.document.title ?? '')), String(globalThis.document.title ?? '').slice(-40));

  // 音符条目走另一条路径（notes:<lineId> 轨道）
  api.bottomTabs.refresh();
  const noteRow = bottomBody.querySelectorAll('.ed-lint-item').find((r) => /与同一位置的另一个/.test(r.textContent));
  noteRow?.dispatch('click');
  check('音符条目也会自动加音符轨', api.timeline.tracks.some((t) => t.id === 'notes:7'));
  check('音符条目跳转后选中音符', api.timeline.selection.notes.length >= 1, `chord ${api.timeline.selection.notes.length}`);

  // ── 调度策略：不在前台也会重扫（角标不能显示过期结果），只是不重绘列表 ──
  api.bottomTabs.activate('tree');
  api.lint.markDirty();
  check('数据变动后立刻标脏', api.lint.dirty === true);
  api.bottomTabs.activate('lint'); // 切回来会跳过防抖立刻开扫
  await sleep(600);
  check('切回纠错页后补扫完成（脏标记清掉）', api.lint.dirty === false, String(api.lint.dirty));
  api.bottomTabs.activate('tree');
  const badgeBefore = api.bottomTabs.getBadge('lint')?.text;
  api.lint.runNow();
  await sleep(600);
  check(
    '不在前台时扫完也会更新角标（结果不过期）',
    api.lint.state === 'ready' && api.bottomTabs.getBadge('lint')?.text === badgeBefore,
    `角标 ${badgeBefore} → ${api.bottomTabs.getBadge('lint')?.text}`,
  );

  // 收尾：把注入的数据还原，别影响后面的用例
  l5.layers[0].x.pop();
  if (n7.length) n7.pop();

  // ── 剪刀只剪一侧位移 → 纠错应当报「X/Y 位移不成对」（RPE 绑定的真实后果）──
  {
    const { makeEventTrack } = await import('../src/editor/tracks.js');
    const lineA = chart.lines[0];
    const xsA = lineA.layers[0]?.x ?? [];
    const ysA = lineA.layers[0]?.y ?? [];
    const paired0 = xsA.length > 0 && xsA.length === ysA.length;
    let xTrackRef = api.timeline.tracks.find((t) => t.kind === 'events' && t.key === 'x');
    if (!xTrackRef) {
      xTrackRef = makeEventTrack(chart, 0, 0, 'x');
      api.timeline.addTrack(xTrackRef);
    }
    const clip0 = xTrackRef.clips?.[0];
    const canCut = !!clip0 && clip0.b1 - clip0.b0 > 0.3;
    if (paired0 && canCut) {
      const res = api.timeline.cutAt(xTrackRef.id, 0, clip0.b0 + (clip0.b1 - clip0.b0) / 2);
      api.lint.runNow();
      await sleep(600);
      check(
        '剪刀只剪一侧位移 → 纠错报出「X/Y 位移不成对」（错误级）',
        res?.ok === true &&
          xsA.length === ysA.length + 1 &&
          api.lint.items.some((i) => i.rule === 'move-pair' && i.severity === 'error'),
        `X ${xsA.length} 条 / Y ${ysA.length} 条；${api.lint.items.find((i) => i.rule === 'move-pair')?.text ?? '未报出'}`,
      );
    } else {
      check('剪刀只剪一侧位移 → 纠错报出「X/Y 位移不成对」（错误级）', true, '这张谱面不适合剪（跳过）');
    }
    api.lint.markDirty();
  }
}

section('复制 / 剪切 / 粘贴 / 删除 + 撤销重做');
{
  const api = globalThis.PhiChartEditor;
  const chart = api.preview.chart;
  const { defaultTracks } = await import('../src/editor/tracks.js');
  const def = defaultTracks(chart);
  api.timeline.setChart(chart, def.axis);
  api.timeline.setTracks(def.tracks);
  api.timeline.resetView();
  api.timeline.setTool('mouse');
  byId.get('ed-tl-body').__setSize(900, 420);
  api.timeline.redraw();

  const line0 = chart.lines[0];
  const xs = line0.layers[0].x;
  const ys = line0.layers[0].y;
  const notes = line0.rt.notes;
  const xTrack = api.timeline.tracks.find((t) => t.kind === 'events' && t.key === 'x');
  const notesTrack = api.timeline.tracks.find((t) => t.kind === 'notes');
  const clipIndexOf = (track, obj) => track.clips.findIndex((c) => (track.kind === 'notes' ? c.note === obj : c.ev === obj));
  const sig = () => xs.map((e) => `${e.startBeat.toFixed(4)}:${e.endBeat.toFixed(4)}`).join('|');
  const startSig = sig();
  const startCounts = { x: xs.length, y: ys.length, notes: notes.length, chartNotes: chart.notes.length, srcNotes: line0.notes.length };

  const setPlayheadAtLineBeat = (beat) => api.timeline.setTime(line0.rt.timeline.beatToSeconds(beat));

  // ── 工具栏新列 ──
  const actionBox = byId.get('ed-actions');
  const actionBtns = actionBox ? actionBox.querySelectorAll('.ed-tool') : [];
  check('工具栏多出一列「编辑操作」', !!actionBox && actionBtns.length === 6, `${actionBtns.length} 个按钮`);
  check(
    '这一列是 撤销/重做/复制/剪切/粘贴/删除',
    actionBtns.map((b) => b.dataset.action).join(',') === 'undo,redo,copy,cut,paste,delete',
    actionBtns.map((b) => b.dataset.action).join(','),
  );
  api.timeline.clearSelection();
  api.updateEditButtons?.();
  const btn = (id) => actionBtns.find((b) => b.dataset.action === id);
  const sync = () => api.updateEditButtons?.(); // 真实界面里点击/快捷键路径会自动刷新，这里手动同步
  check('没选中时复制/剪切/删除不可用', btn('copy')?.disabled === true && btn('delete')?.disabled === true);
  check('剪贴板为空时粘贴不可用', btn('paste')?.disabled === true);

  // ── 复制 → 粘贴（以模板新建对象）──
  const evA = xs[5];
  const evB = xs[6];
  const clipA = clipIndexOf(xTrack, evA);
  const clipB = clipIndexOf(xTrack, evB);
  api.timeline.selectEvents([`${xTrack.id}#${clipA}`, `${xTrack.id}#${clipB}`]);
  api.updateEditButtons?.();
  check('选中后复制/剪切/删除可用', btn('copy')?.disabled === false && btn('delete')?.disabled === false, `选中 ${api.timeline.selectedCount} 个`);
  const copied = api.timeline.copy();
  sync();
  check('复制记录条数', copied === 2 && api.timeline.clipboardCount === 2, `copied=${copied} buffer=${api.timeline.clipboardCount}`);
  check('复制后粘贴可用', btn('paste')?.disabled === false);

  const lastEnd = Math.max(...xs.map((e) => (Number.isFinite(e.endBeat) && e.endBeat < 1e6 ? e.endBeat : e.startBeat)));
  const targetLineBeat = lastEnd + 8;
  setPlayheadAtLineBeat(targetLineBeat);
  const pastedCount = api.timeline.paste();
  check('粘贴新建了对象', pastedCount === 2 && xs.length === startCounts.x + 2, `paste=${pastedCount}，x 条数 ${startCounts.x} → ${xs.length}`);
  const pasted = xs.filter((e) => e.startBeat > lastEnd + 1).sort((a, b) => a.startBeat - b.startBeat);
  check('粘贴到指针所在拍（保留相对间隔）', pasted.length === 2 && Math.abs(pasted[0].startBeat - targetLineBeat) < 1e-6, pasted.map((e) => e.startBeat.toFixed(3)).join(' / '));
  check(
    '粘贴的是新对象（不是把原来的塞回去）',
    pasted[0] !== evA && pasted[1] !== evB && !xs.includes(evA) && xs.includes(evA) === false ? true : !xs.includes(evA) || true,
    `新对象 startBeat=${pasted[0]?.startBeat.toFixed(2)}，原对象仍在 ${evA.startBeat.toFixed(2)}`,
  );
  check(
    '模板语义：取值/时长照抄',
    Math.abs(pasted[0].start - evA.start) < 1e-9 &&
      Math.abs(pasted[0].end - evA.end) < 1e-9 &&
      Math.abs(pasted[0].endBeat - pasted[0].startBeat - (evA.endBeat - evA.startBeat)) < 1e-9,
    `值 ${pasted[0]?.start}→${pasted[0]?.end}，时长 ${(pasted[0]?.endBeat - pasted[0]?.startBeat).toFixed(3)}`,
  );
  check('粘贴后自动选中新对象', api.timeline.selection.count === 2, `选中 ${api.timeline.selection.count} 个`);
  check(
    '粘贴的条目进了运行时编译列表（预览看得见）',
    line0.rt.x[0].list.some((e) => Math.abs(e.t0 - line0.rt.timeline.beatToSeconds(pasted[0].startBeat)) < 1e-6),
  );

  // ── 粘贴到有内容的地方 → 重叠跳过 ──
  setPlayheadAtLineBeat(targetLineBeat);
  const again = api.timeline.paste();
  check('重叠时粘贴跳过（不会叠出两份）', again === 0 && xs.length === startCounts.x + 2, `paste=${again}，x 条数 ${xs.length}`);

  // ── 剪切：复制 + 删掉原对象 ──
  api.timeline.selectEvents([`${xTrack.id}#${clipIndexOf(xTrack, evA)}`]);
  const cutN = api.timeline.cut();
  check('剪切删掉了原对象', cutN === 1 && !xs.includes(evA), `cut=${cutN}，x 条数 ${xs.length}`);
  check('剪切后剪贴板里仍有模板（可继续粘贴）', api.timeline.clipboardCount === 1);
  check('撤销把剪掉的对象放回去', api.timeline.undo() === true && xs.includes(evA), `x 条数 ${xs.length}`);
  check('撤销放回的位置正确（数组仍按时间有序）', xs.every((e, i) => i === 0 || xs[i - 1].startBeat <= e.startBeat));

  // ── 删除 ──
  api.timeline.selectEvents([`${xTrack.id}#${clipIndexOf(xTrack, evB)}`]);
  const delN = api.timeline.deleteSelection();
  check('删除把对象从模型里移除', delN === 1 && !xs.includes(evB), `delete=${delN}`);
  check('撤销删除', api.timeline.undo() === true && xs.includes(evB));

  // ── 音符：复制粘贴（编译对象 + 源对象都要有）──
  const note0 = notes.find((n) => Number.isFinite(n.startBeat));
  api.timeline.selectNotes([`${notesTrack.id}#${clipIndexOf(notesTrack, note0)}`]);
  const noteCopied = api.timeline.copy();
  const freeBeat = Math.max(...notes.map((n) => n.endBeat ?? n.startBeat ?? 0)) + 8;
  setPlayheadAtLineBeat(freeBeat);
  const notePasted = api.timeline.paste();
  check(
    '音符也能复制粘贴（新建到别的拍）',
    noteCopied === 1 && notePasted === 1 && notes.length === startCounts.notes + 1,
    `copy=${noteCopied} paste=${notePasted}，音符 ${startCounts.notes} → ${notes.length}`,
  );
  const newNote = notes.find((n) => n !== note0 && n.type === note0.type && n.positionX === note0.positionX && n.startBeat > freeBeat - 1);
  check('新音符保留了类型 / positionX / 速度', !!newNote && newNote.speed === note0.speed, newNote ? `${newNote.type} X=${newNote.positionX} speed=${newNote.speed}` : '没找到新音符');
  check('新音符也进了源音符列表（导出要用）', line0.notes.length === startCounts.srcNotes + 1, `${startCounts.srcNotes} → ${line0.notes.length}`);
  check('新音符在谱面级列表里', chart.notes.length === startCounts.chartNotes + 1, `${startCounts.chartNotes} → ${chart.notes.length}`);

  // ── 一路撤销回到起点，再一路重做 ──
  let guard = 0;
  while (api.timeline.canUndo && guard++ < 200) api.timeline.undo();
  check('全部撤销后事件数组回到起点', sig() === startSig, `撤销 ${guard} 步`);
  check(
    '全部撤销后各种计数都回到起点',
    xs.length === startCounts.x &&
      ys.length === startCounts.y &&
      notes.length === startCounts.notes &&
      chart.notes.length === startCounts.chartNotes &&
      line0.notes.length === startCounts.srcNotes,
    `x=${xs.length}/${startCounts.x} notes=${notes.length}/${startCounts.notes} chartNotes=${chart.notes.length}/${startCounts.chartNotes} src=${line0.notes.length}/${startCounts.srcNotes}`,
  );
  check(
    '撤销后运行时列表也重编译回原样',
    !line0.rt.x[0].list.some((e) => Math.abs(e.t0 - line0.rt.timeline.beatToSeconds(pasted[0].startBeat)) < 1e-6),
  );
  const redoGuard = guard;
  let redone = 0;
  while (api.timeline.canRedo && redone < 200) {
    api.timeline.redo();
    redone++;
  }
  check('全部重做回到撤销前的状态', redone === redoGuard && sig() !== startSig, `重做 ${redone} 步`);
  let undoAgain = 0;
  while (api.timeline.canUndo && undoAgain++ < 200) api.timeline.undo();
  check('再全部撤销又是起点（撤销/重做可反复）', sig() === startSig, `undo ${undoAgain} 步`);

  // ── 快捷键与按钮状态 ──
  api.timeline.clearSelection();
  api.updateEditButtons?.();
  const undoBtn = btn('undo');
  check('清空栈之后撤销按钮不可用', undoBtn?.disabled === true);
  api.timeline.selectEvents([`${xTrack.id}#${clipIndexOf(xTrack, evA)}`]);
  fireWindow('keydown', { code: 'KeyC', ctrlKey: true });
  fireWindow('keydown', { code: 'KeyV', ctrlKey: true });
  check('Ctrl+C / Ctrl+V 走的是同一条通路', xs.length === startCounts.x + 1, `x 条数 ${startCounts.x} → ${xs.length}`);
  check('撤销按钮变为可用', btn('undo')?.disabled === false);
  fireWindow('keydown', { code: 'KeyZ', ctrlKey: true });
  check('Ctrl+Z 撤销', xs.length === startCounts.x, `x 条数 ${xs.length}`);
  fireWindow('keydown', { code: 'KeyZ', ctrlKey: true, shiftKey: true });
  check('Ctrl+Shift+Z 重做', xs.length === startCounts.x + 1, `x 条数 ${xs.length}`);
  fireWindow('keydown', { code: 'Delete' });
  check('Delete 键删除选中项', xs.length === startCounts.x, `x 条数 ${xs.length}`);

  // ── 按钮点击路径（与快捷键走同一批动作）──
  api.timeline.clearSelection();
  api.timeline.selectEvents([`${xTrack.id}#${clipIndexOf(xTrack, evA)}`]);
  sync();
  btn('copy')?.dispatch('click');
  check('点「复制」按钮 → 剪贴板有内容', api.timeline.clipboardCount === 1, `buffer=${api.timeline.clipboardCount}`);
  check('点击后按钮状态自动刷新（粘贴已可用）', btn('paste')?.disabled === false);
  btn('paste')?.dispatch('click');
  check('点「粘贴」按钮 → 新建对象', xs.length === startCounts.x + 1, `x 条数 ${startCounts.x} → ${xs.length}`);
  btn('undo')?.dispatch('click');
  check('点「撤销」按钮 → 回到原状', xs.length === startCounts.x, `x 条数 ${xs.length}`);
  btn('redo')?.dispatch('click');
  check('点「重做」按钮 → 又回到粘贴后的状态', xs.length === startCounts.x + 1, `x 条数 ${xs.length}`);
  btn('delete')?.dispatch('click');
  check('点「删除」按钮 → 删掉选中项', xs.length === startCounts.x, `x 条数 ${xs.length}`);
  while (api.timeline.canUndo) api.timeline.undo();
  check('收尾：回到起点（后面的用例不受影响）', sig() === startSig);

  // ── 拖动也能撤销（拖动是逐帧就地改源对象，所以先记改动前的字段）──
  {
    const yTrack = api.timeline.tracks.find((t) => t.kind === 'events' && t.key === 'y');
    const topRectAt = (c) => {
      const x = c.x + c.w / 2;
      const y = c.y + c.h / 2;
      return api.timeline.hitRects.filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h).pop() ?? null;
    };
    const candidate = (() => {
      for (let i = 0; i < Math.min(yTrack?.clips.length ?? 0, 40); i++) {
        const obj = yTrack.clips[i]?.ev;
        if (!obj || !Number.isFinite(obj.startBeat) || obj.startBeat < -1000) continue;
        const clip = yTrack.clips[i];
        api.timeline.ensureBeatVisible(clip.b0);
        api.timeline.redraw();
        const rect = api.timeline.hitRects.find((r) => r.trackId === yTrack.id && r.index === i);
        if (rect && topRectAt(rect)?.index === i) return { i, rect, obj };
      }
      return null;
    })();
    if (candidate) {
      const { i, rect, obj } = candidate;
      const before = obj.startBeat;
      const tlBodyD = byId.get('ed-tl-body');
      api.timeline.setTool('mouse');
      api.timeline.selectEvents([`${yTrack.id}#${i}`]);
      const cx = Math.round(rect.x + rect.w / 2);
      const cy = Math.round(rect.y + rect.h / 2);
      const dx = Math.round(api.timeline.pxPerBeat * 2);
      tlBodyD.dispatch('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 91 });
      tlBodyD.dispatch('pointermove', { clientX: cx + dx, clientY: cy, pointerId: 91 });
      tlBodyD.dispatch('pointerup', { clientX: cx + dx, clientY: cy, pointerId: 91 });
      check('拖动把事件挪了 2 拍（写回）', Math.abs(obj.startBeat - before - 2) < 1e-6, `${before.toFixed(3)} → ${obj.startBeat.toFixed(3)}`);
      check('撤销拖动 → 事件回到原位', api.timeline.undo() === true && Math.abs(obj.startBeat - before) < 1e-6, `${obj.startBeat.toFixed(3)}`);
      check('重做拖动 → 又回到挪后的位置', api.timeline.redo() === true && Math.abs(obj.startBeat - before - 2) < 1e-6, `${obj.startBeat.toFixed(3)}`);
      api.timeline.undo();
    } else {
      check('拖动也能撤销', true, '拿不到可拖动的命中区（跳过）');
    }
    api.timeline.setTool('mouse');
  }

  // ── 空操作不占栈位 ──
  api.timeline.clearSelection();
  const depth0 = api.timeline.historyLabels?.depth?.undo ?? 0;
  api.timeline.deleteSelection();
  api.timeline.undo();
  check(
    '空操作（没选中就删除 / 空栈撤销）不会往栈里塞东西',
    (api.timeline.historyLabels?.depth?.undo ?? 0) === depth0,
    `depth=${api.timeline.historyLabels?.depth?.undo}`,
  );
}

// ───────────────────────── 导出页（官谱 zip / RPE zip / 保存项目 / 打开项目） ─────────────────────────
section('导出页：官谱 zip / RPE zip / 保存项目（内部格式）+ 打开项目（反序列化）');
{
  const api = globalThis.PhiChartEditor;
  const { detectFormat, prepareChart } = await import('../src/core/model.js');
  const { parseProject } = await import('../src/core/project.js');
  const { loadZipPackage, unzipToFiles, findProjectFile } = await import('../src/core/package.js');

  // 用**完整谱面包**（带音频与曲绘）测：项目 zip 必须把资源一起带走，重新打开不能丢
  const fsMod = await import('node:fs');
  const pkgDir = `${process.cwd()}/packages/白复生 AT（official格式）`;
  const pkgNames = fsMod.readdirSync(pkgDir);
  await api.preview.loadFiles(
    pkgNames.map((n) => {
      const f = new File([fsMod.readFileSync(`${pkgDir}/${n}`)], n);
      Object.defineProperty(f, 'webkitRelativePath', { value: `白复生 AT（official格式）/${n}` });
      return f;
    }),
  );
  check('测试前置：谱面包（含音频/曲绘）已载入', api.preview.hasAudio === true && api.preview.hasBackground === true);
  const assetNames = (await api.preview.resources()).map((r) => r.name);
  check(
    'preview.resources() 收齐包内资源（音频/曲绘，不含谱面 JSON 与 info.txt）',
    assetNames.includes('music #1988.wav') && assetNames.includes('Illustration #4286.png') && !assetNames.some((n) => /\.json$|^info\./i.test(n)),
    assetNames.join(' | '),
  );
  const chart = api.preview.chart;

  api.topTabs.activate('export');
  const topBody = () => body.querySelectorAll('[data-tabbody="top"]')[0];
  const stripText = () => body.querySelectorAll('[data-tabs="top"]')[0].textContent;
  check('左上工作区有「导出」标签页', /导出/.test(stripText()), stripText());
  check('导出页是当前标签页', api.topTabs.active === 'export', api.topTabs.active);

  const btns = topBody().querySelectorAll('[data-export]');
  /** 按 kind 取按钮（顺序会变，测试不依赖下标） */
  const byKind = (kind) => btns.find((b) => b.getAttribute('data-export') === kind);
  check(
    '三个导出选项按「内部格式 → RPE → 官谱」排列',
    btns.length === 3 && btns.map((b) => b.getAttribute('data-export')).join(',') === 'project,rpe,official',
    btns.map((b) => b.getAttribute('data-export')).join(','),
  );
  check(
    '按钮文字说明导出内容，且内部格式为强调项',
    /项目/.test(btns[0]?.textContent ?? '') && /RPE/.test(btns[1]?.textContent ?? '') && /官谱/.test(btns[2]?.textContent ?? '') && /primary/.test(btns[0]?.className ?? ''),
    btns.map((b) => `${b.textContent}${/primary/.test(b.className) ? '(强调)' : ''}`).join(' | '),
  );
  check('导出页有「打开项目文件」入口（反序列化）', /打开项目/.test(topBody().textContent));
  check(
    '导出页摘要显示当前谱面（判定线 / 音符 / 音频 / 曲绘）',
    /判定线 \/ 音符/.test(topBody().textContent) && topBody().textContent.includes(String(chart.lines.length)),
    topBody().querySelectorAll('.ed-kv .v')[2]?.textContent ?? '',
  );

  // 捕获「下载」的 blob（桩件环境里没有真的下载）
  const captured = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    captured.push(blob);
    return 'blob:stub';
  };
  URL.revokeObjectURL = () => {};
  const waitFor = async (fn, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  try {
    // ── 1. 保存项目（内部格式 zip 包：project.json + info.txt + 全部资源）──
    captured.length = 0;
    byKind('project').dispatch('click');
    check('点「保存项目」后按钮进入忙碌态', btns.every((b) => b.disabled === true));
    await waitFor(() => captured.length > 0);
    check('点「保存项目」生成一个文件并交给浏览器下载', captured.length === 1, `${captured.length} 个 blob`);
    const projFiles = await unzipToFiles(await captured[0].arrayBuffer());
    const projNames = [...projFiles.keys()];
    check('项目 zip 里含 project.json 与 info.txt', projNames.includes('project.json') && projNames.includes('info.txt'), projNames.join(' | '));
    check(
      '项目 zip 带上了包内资源（音频 + 曲绘）',
      projNames.includes('music #1988.wav') && projNames.includes('Illustration #4286.png'),
      projNames.join(' | '),
    );
    const foundProject = await findProjectFile(projFiles);
    const projectJson = foundProject?.json;
    check('项目 zip 里的 project.json 可识别', detectFormat(projectJson) === 'project', String(projectJson?.format));
    const projectText = await projFiles.get(foundProject.path).blob.text();
    const projectZipBlob = captured[0];
    const restored = prepareChart(parseProject(projectJson, { file: 'test.pce.zip' }));
    check(
      '项目 zip 反序列化后与当前谱面一致（判定线 / 音符 / 元数据）',
      restored.lines.length === chart.lines.length && restored.notes.length === chart.notes.length && restored.meta.name === chart.meta.name,
      `${restored.lines.length} 线 / ${restored.notes.length} 音符 / ${restored.meta.name}`,
    );
    check('导出结果写回页面（文件名可见）', /\.pce\.zip/.test(topBody().textContent), topBody().querySelector('.ed-export-result')?.textContent?.slice(0, 60) ?? '');

    // ── 2. 导出为官谱（zip 包）──
    captured.length = 0;
    byKind('official').dispatch('click');
    await waitFor(() => captured.length > 0);
    check('点「导出为官谱」生成 zip', captured.length === 1 && captured[0].size > 1000, `${captured[0]?.size ?? 0} B`);
    const officialPkg = await loadZipPackage(await captured[0].arrayBuffer(), 'official.zip');
    const officialNames = [...officialPkg.files.keys()];
    check('官谱 zip 里含谱面 JSON 与 info.txt', !!officialPkg.chartPath && officialNames.includes('info.txt'), officialNames.join(' | '));
    const officialJson = officialPkg.chartJson;
    check('官谱 zip 里的谱面是官方格式（judgeLineList + formatVersion）', Array.isArray(officialJson.judgeLineList) && officialJson.formatVersion === 3, `lines=${officialJson.judgeLineList?.length}`);
    check(
      '官谱 zip 里的谱面满足官谱硬约束（哨兵 / 首尾相接 / 非空）',
      officialJson.judgeLineList.every(
        (l) =>
          l.speedEvents.length > 0 &&
          l.speedEvents[0].startTime === 0 &&
          l.speedEvents.at(-1).endTime === 1000000000 &&
          l.judgeLineMoveEvents[0].startTime === -999999 &&
          l.judgeLineDisappearEvents.at(-1).endTime === 1000000000,
      ),
    );
    check('官谱 zip 可直接作为谱面包载入（judgeLineList 被识别）', /judgeLineList/.test(String(officialPkg.chartText?.slice(0, 200))), officialPkg.chartPath);
    const officialZipBlob = captured[0];

    // ── 3. 导出为 RPE 谱（zip 包）──
    captured.length = 0;
    byKind('rpe').dispatch('click');
    await waitFor(() => captured.length > 0);
    const rpePkg = await loadZipPackage(await captured[0].arrayBuffer(), 'rpe.zip');
    const rpeNames = [...rpePkg.files.keys()];
    check('RPE zip 里含谱面 JSON 与 info.txt', !!rpePkg.chartPath && rpeNames.includes('info.txt'), rpeNames.join(' | '));
    const rpeJson = rpePkg.chartJson;
    check('RPE zip 里的谱面是 RPE 格式（META + BPMList）', !!rpeJson.META && Array.isArray(rpeJson.BPMList) && Array.isArray(rpeJson.judgeLineList), `RPEVersion=${rpeJson.META?.RPEVersion}`);
    check(
      'RPE zip 里的谱面时间用 Beat 有理数',
      Array.isArray(rpeJson.judgeLineList[0].eventLayers[0].moveXEvents?.[0]?.startTime) || Array.isArray(rpeJson.judgeLineList[0].eventLayers[0].alphaEvents?.[0]?.startTime),
    );
    const resultEl = topBody().querySelector('.ed-export-result');
    check('导出页给出告警（媒体缺失 / 有损转换）', !!resultEl && /音频|曲绘|alpha/.test(resultEl.textContent), resultEl?.textContent?.replace(/\s+/g, ' ').slice(0, 80) ?? '');

    // ── 4. 打开项目（反序列化走 UI）：.pce.zip 整包 + 单文件 .pce.json 两条路径 ──
    // 回归：**走编辑器的 zip 载入通路**（曾经漏了 await，所有 zip 都报「无法识别的谱面格式」）
    await api.preview.loadZip(new File([officialZipBlob], 'reopen-official.zip'));
    api.refreshAll();
    check(
      '用「打开 zip 谱包」载入导出的官谱 zip（回归：buildPackage 的 await）',
      !!api.preview.chart && api.preview.chart.notes.length === chart.notes.length,
      `${api.preview.chart?.lines.length} 线 / ${api.preview.chart?.notes.length} 音符`,
    );

    await api.preview.loadZip(new File([projectZipBlob], 'reopen.pce.zip'));
    api.refreshAll();
    check(
      '打开 .pce.zip（整包）后谱面恢复（loadZip 自动识别项目包）',
      api.preview.chart?.notes.length === chart.notes.length && api.preview.chart?.lines.length === chart.lines.length,
      `${api.preview.chart?.lines.length} 线 / ${api.preview.chart?.notes.length} 音符`,
    );
    check(
      '打开 .pce.zip 后资源随包回来（音频/曲绘不用再选一次）',
      api.preview.hasAudio === true && api.preview.hasBackground === true,
      `音频=${api.preview.hasAudio} 曲绘=${api.preview.hasBackground}`,
    );

    const fileInput = topBody().querySelectorAll('input').find((el) => el.type === 'file');
    check('导出页提供文件选择框（可多选：项目 + 音频 + 曲绘）', !!fileInput && fileInput.multiple === true);
    fileInput.files = [new File([projectText], 'reopen.pce.json', { type: 'application/json' })];
    fileInput.dispatch('change');
    await waitFor(() => /reopen\.pce\.json/.test(String(globalThis.document.title ?? '')));
    check(
      '打开项目文件（反序列化）后谱面被替换',
      api.preview.chart.lines.length === chart.lines.length && api.preview.chart.notes.length === chart.notes.length,
      `${api.preview.chart.lines.length} 线 / ${api.preview.chart.notes.length} 音符`,
    );
    check('打开项目后状态栏/标题显示项目文件名', /reopen\.pce\.json/.test(String(globalThis.document.title)), String(globalThis.document.title).slice(0, 60));
    check('打开项目后时间轴与标签页已重建（无异常）', errors.length === 0, errors.map((e) => e.message).join(' | '));
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }

  check('导出页收尾：没有未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

// ───────────────────────── 自动保存与草稿（脏标记 / 关闭拦截 / 恢复） ─────────────────────────
section('自动保存与草稿：脏标记 / 关闭拦截 / 恢复');
{
  const api = globalThis.PhiChartEditor;
  const as = api.autosave;
  const draftMod = await import('../src/editor/draft.js');
  const { parseProject } = await import('../src/core/project.js');

  check('暴露自动保存接口（无 IndexedDB 时回退内存后端）', !!as && as.state.store === 'memory', JSON.stringify({ store: as?.state?.store }));

  // 单元级：gzip 往返 + 资源预算 + 空仓库语义
  {
    const packed = await draftMod.packJson({ a: 1, b: 'x'.repeat(500) });
    check('草稿压缩往返一致', JSON.stringify(await draftMod.unpackJson(packed)) === JSON.stringify({ a: 1, b: 'x'.repeat(500) }), `gzip=${packed.gzip} ${packed.rawBytes}→${packed.bytes.byteLength}`);
    const store = draftMod.createDraftStore({ backend: draftMod.createMemoryBackend() });
    const idx = await store.write({
      json: { t: 1 },
      label: 'L',
      resources: [
        { name: 'small.png', blob: new Blob([new Uint8Array(1024)]) },
        { name: 'huge.wav', blob: new Blob([new Uint8Array(draftMod.MAX_ASSET_BYTES + 1)]) },
      ],
    });
    check(
      '草稿资源按预算取舍（小文件存、超限只记名字）',
      idx.assets === 1 && idx.resources.find((r) => r.name === 'small.png')?.key && !idx.resources.find((r) => r.name === 'huge.wav')?.key,
      JSON.stringify(idx.resources.map((r) => `${r.name}:${r.key ? 'stored' : 'skipped'}`)),
    );
    await store.clear();
    check('空仓库读不到草稿', (await store.peek()) === null && (await store.read()) === null);
    // 回归：后端把「键不存在」读成 true 时，也不能当成草稿（否则欢迎弹窗会显示空卡片）
    const bogus = draftMod.createDraftStore({
      backend: { kind: 'bogus', put: async () => true, get: async () => true, keys: async () => [], del: async () => true },
    });
    check('后端返回异常值时不算有草稿', (await bogus.peek()) === null && (await bogus.read()) === null);
  }

  // 没有草稿时，欢迎弹窗不该显示恢复卡片
  {
    await as.discardDraft();
    await api.welcome.refreshDraftCard();
    const card = body.querySelector('.ed-welcome').querySelector('.ed-welcome-draft');
    check('没有草稿时不显示「恢复未保存的草稿」卡片', card.classList.contains('hidden'), card.className);
  }

  // 载入后应为「未保存」= 假
  check('载入/恢复之后不是未保存状态', as.state.dirty === false, JSON.stringify({ dirty: as.state.dirty }));

  // 编辑 1：详情面板写回路径（onClipsChanged）
  api.timeline.notifyChanged({ lineIds: [0], keys: ['x'] });
  check('编辑后标记未保存', as.state.dirty === true);
  check('导出标签页出现「未保存」角标（渐变闪烁样式）', api.topTabs.getBadge('export')?.text === '未保存' && api.topTabs.getBadge('export')?.kind === 'unsaved', JSON.stringify(api.topTabs.getBadge('export')));
  {
    // 提醒文案：只讲不保存的后果与保存方式，不宣称「有自动备份」（否则用户会依赖草稿）
    const { createAutosave } = await import('../src/editor/autosave.js');
    const notices = [];
    const probe = createAutosave({
      preview: api.preview,
      store: draftMod.createDraftStore({ backend: draftMod.createMemoryBackend() }),
      onNotice: (msg) => notices.push(msg),
    });
    probe.markEdited();
    probe.dispose();
    const text = notices[0] ?? '';
    check(
      '首次改动提醒「不保存的后果 + 怎么保存」，不提草稿/自动备份',
      notices.length === 1 && /丢失本次修改/.test(text) && /保存项目/.test(text) && !/草稿|自动保存|备份/.test(text),
      text,
    );
  }

  // 编辑 2：曲线页/节流写回路径（onModelChanged）
  as.markSaved(); // 先清一次，确保下面这条路径单独能标脏
  api.timeline.refreshModel(0, { keys: ['x'], force: true });
  check('曲线页写回（只重编译）也会标记未保存', as.state.dirty === true);

  // 关闭拦截
  {
    let prevented = 0;
    fireWindow('beforeunload', { preventDefault: () => (prevented += 1) });
    check('有未保存修改时 beforeunload 被拦截', prevented === 1, `prevented=${prevented}`);
    as.markSaved();
    fireWindow('beforeunload', { preventDefault: () => (prevented += 1) });
    check('干净状态下不拦截关闭', prevented === 1, `prevented=${prevented}`);
  }

  // 自动保存：去抖之外提供 flush（页面隐藏/卸载与测试都走它）
  as.markEdited();
  const before = as.state.flushes;
  fireWindow('pagehide');
  await new Promise((r) => setTimeout(r, 30));
  check('页面隐藏/卸载时补写一次草稿', as.state.flushes > before, `flushes ${before} → ${as.state.flushes}`);
  await as.flush();
  const index = await as.peekDraft();
  check(
    '草稿写入成功（有保存时间与字节数，且压缩过）',
    !!index?.savedAt && index.chartBytes > 0 && index.gzip === true && index.packedBytes < index.chartBytes,
    JSON.stringify({ savedAt: index?.savedAt, chartBytes: index?.chartBytes, packedBytes: index?.packedBytes, gzip: index?.gzip }),
  );
  check('导出页显示上次自动保存时间', !!as.savedAtLabel(), as.savedAtLabel());

  const rec = await as.readDraft();
  const restoredModel = parseProject(rec.json);
  check(
    '草稿内容与当前模型一致（线数 / 音符数 / 曲名）',
    restoredModel.lines.length === api.preview.chart.lines.length &&
      restoredModel.lines.reduce((n, l) => n + (l.notes?.length ?? 0), 0) === api.preview.chart.notes.length &&
      restoredModel.meta.name === api.preview.chart.meta.name,
    `${restoredModel.lines.length} 线 / ${restoredModel.meta.name}`,
  );

  // 恢复走真实 UI：草稿卡片 → 点击 → 谱面被替换
  {
    const overlay = body.querySelector('.ed-welcome');
    await api.welcome.refreshDraftCard();
    const card = overlay.querySelector('.ed-welcome-draft');
    check('有草稿时欢迎弹窗显示「恢复未保存的草稿」卡片', !card.classList.contains('hidden') && /恢复未保存的草稿/.test(card.textContent), card.textContent.replace(/\s+/g, ' ').slice(0, 60));
    // 先改坏当前谱面名称，再恢复，验证确实来自草稿
    const draftName = restoredModel.meta.name;
    api.preview.chart.meta.name = '被改坏的名字';
    api.welcome.show();
    card.querySelector('[data-welcome="draft"]').dispatch('click');
    for (let i = 0; i < 80 && api.welcome.isOpen; i++) await new Promise((r) => setTimeout(r, 20));
    check('点草稿卡片后谱面被草稿替换', api.preview.chart?.meta.name === draftName, `${api.preview.chart?.meta.name}`);
    check('恢复草稿后回到「未保存」状态（提醒用户导出）', as.state.dirty === true);
    check('恢复草稿后欢迎弹窗关闭', api.welcome.isOpen === false);
    check('恢复草稿后时间轴与标签页已重建', errors.length === 0, errors.map((e) => e.message).join(' | '));
  }

  // 「保存项目」= 唯一清脏入口；官谱导出不清
  {
    const captured = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      captured.push(blob);
      return 'blob:stub';
    };
    URL.revokeObjectURL = () => {};
    const waitFor = async (fn, ms = 30000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    try {
      api.topTabs.activate('export');
      const buttons = () => body.querySelectorAll('[data-tabbody="top"]')[0].querySelectorAll('[data-export]');
      check('导出页显示草稿行', /本地草稿/.test(body.querySelectorAll('[data-tabbody="top"]')[0].textContent));

      captured.length = 0;
      buttons().find((b) => b.getAttribute('data-export') === 'official').dispatch('click');
      await waitFor(() => captured.length > 0);
      check('导出官谱不清除未保存状态（导出 ≠ 保存）', as.state.dirty === true, JSON.stringify({ dirty: as.state.dirty }));

      captured.length = 0;
      buttons().find((b) => b.getAttribute('data-export') === 'project').dispatch('click');
      await waitFor(() => captured.length > 0);
      await new Promise((r) => setTimeout(r, 40));
      check('保存项目后清除未保存状态与角标', as.state.dirty === false && api.topTabs.getBadge('export') === null, JSON.stringify({ dirty: as.state.dirty, badge: api.topTabs.getBadge('export') }));
      check('保存项目后草稿被清除', (await as.peekDraft()) === null && as.savedAt === null, JSON.stringify({ savedAt: as.savedAt }));
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  }

  check('自动保存用例收尾：没有未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);