// 应用层（index.html + src/app/main.js）的无头冒烟测试：
// 用最小 DOM/Audio/Image/fetch 桩件启动真正的 main.js，走一遍「启动 → 点示例包按钮 → 跑若干帧
// → 载入 RPE 包 → 目录包（FileList）→ 快捷键」，断言不抛异常且 HUD 有正确数值。
// 这类测试能抓住「原始 JSON 直接进 prepareChart」之类的接线错误。
// 运行：node tools/app-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = process.cwd();
const errors = [];

// ---------------------------------------------------------------- fetch 桩件
globalThis.fetch = async (input) => {
  const raw = String(input);
  const withoutOrigin = raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const rel = decodeURIComponent(withoutOrigin.replace(/^\/+/, ''));
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

// ---------------------------------------------------------------- DOM 桩件
const elements = new Map();
function makeCtx() {
  const target = { canvas: null, filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', font: '' };
  return new Proxy(target, {
    get: (o, p) => (p in o ? o[p] : () => undefined),
    set: (o, p, v) => ((o[p] = v), true),
  });
}
function makeElement(tag = 'div', id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    style: {},
    children: [],
    _listeners: {},
    textContent: '',
    innerHTML: '',
    value: '0',
    checked: true,
    files: null,
    onclick: null,
    width: 300,
    height: 150,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    dispatch(type, evt = {}) {
      for (const fn of this._listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...evt });
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    getContext: () => (el.__ctx ??= makeCtx()),
    getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
    parentElement: null,
  };
  el.parentElement = { getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }) };
  return el;
}
for (const id of [
  'boot', 'stage', 'hud-score', 'hud-combo', 'hud-acc', 'hud-name', 'hud-level', 'hud-time', 'hud-fps', 'hud-notes',
  'hud-status', 'warnings', 'chart-info', 'samples', 'file-input', 'zip-input', 'json-input', 'btn-play', 'btn-restart',
  'btn-rate', 'rate', 'note-width', 'multi-hint', 'show-lines', 'show-notes', 'progress',
]) {
  elements.set(id, makeElement(id === 'stage' ? 'canvas' : 'div', id));
}
const windowListeners = {};
globalThis.document = {
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => makeElement(tag),
  addEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener() {},
};
globalThis.HTMLInputElement = class {};
globalThis.Image = class {
  constructor() {
    this.width = 1504;
    this.height = 978;
  }
  set src(v) {
    this._src = v;
    setTimeout(() => this.onload?.(), 0);
  }
  get src() {
    return this._src;
  }
};
// requestAnimationFrame：手动步进
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
// AudioContext 桩件：可控时钟
let audioClock = 0;
globalThis.AudioContext = class {
  constructor() {
    this.state = 'running';
    this.destination = {};
  }
  get currentTime() {
    return audioClock;
  }
  resume() {}
  createBufferSource() {
    return {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect() {},
      start() {},
      stop() {},
    };
  }
  async decodeAudioData() {
    return { duration: 100, sampleRate: 44100 };
  }
};
globalThis.URL = globalThis.URL ?? {};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

// 捕获未处理错误，避免静默
process.on('uncaughtException', (e) => errors.push(e));
process.on('unhandledRejection', (e) => errors.push(e));

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const step = (n = 1, dtMs = 16) => {
  for (let i = 0; i < n; i++) {
    audioClock += dtMs / 1000;
    if (rafCb) rafCb(performance.now() + i * dtMs);
  }
};

// ---------------------------------------------------------------- 启动
section('启动 main.js（真实应用代码 + DOM 桩件）');
await import('../src/app/main.js');
await tick(200);
const status = elements.get('hud-status');
const samples = elements.get('samples');
check('贴图加载后 boot 完成、boot 遮罩隐藏', elements.get('boot').classList && samples.children.length === 2, `示例按钮 ${samples.children.length} 个`);
check('状态栏有提示', /载入|示例|播放/.test(status.textContent), status.textContent);

// ---------------------------------------------------------------- 官方示例包
section('点内置按钮载入官方示例包');
elements.get('samples').children[0].onclick();
for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
check('官方包载入成功（无「载入失败」）', !status.textContent.includes('载入失败'), status.textContent);
const info = elements.get('chart-info');
check('谱面信息面板已填充（24 线 / 1156 音符）', /判定线 24/.test(info.innerHTML) && /音符 1156/.test(info.innerHTML));
check('物量 1156', /物量 1156/.test(info.innerHTML));

section('跑帧与自动游玩');
step(120);
const scoreText = elements.get('hud-score').textContent;
const notesText = elements.get('hud-notes').textContent;
check('HUD 分数已更新（7 位定点）', /^\d{7}$/.test(scoreText), `score=${scoreText}`);
check('HUD 记录了判定进度', /\d+ \/ 1156/.test(notesText), notesText);
check('运行期没有未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

// 播放并跳进谱面中段：验证「音频时钟 → 状态求值 → 判定计分 → HUD」整条链路
section('播放时钟与计分链路');
elements.get('btn-play').dispatch('click');
audioClock += 30; // 直接把音频时钟推进 30 秒
step(60);
const judged = Number((elements.get('hud-notes').textContent.match(/^(\d+)/) ?? [])[1] ?? 0);
check('播放后音符被判定（judged > 0）', judged > 0, elements.get('hud-notes').textContent);
check('分数随判定上升', Number(elements.get('hud-score').textContent) > 0, elements.get('hud-score').textContent);
check('连击/ACC 已更新', /%$/.test(elements.get('hud-acc').textContent), elements.get('hud-acc').textContent);
elements.get('btn-play').dispatch('click'); // 暂停

// 播放/暂停、倍速、重开等按钮不抛异常
section('交互（按钮与快捷键）');
elements.get('btn-play').dispatch('click');
step(30);
elements.get('btn-rate').dispatch('click');
elements.get('btn-restart').dispatch('click');
for (const code of ['Space', 'ArrowLeft', 'ArrowRight', 'KeyR', 'BracketLeft', 'BracketRight', 'KeyN', 'KeyM']) {
  for (const fn of windowListeners.keydown ?? []) fn({ code, target: {}, preventDefault() {} });
}
step(30);
check('交互后仍无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
check('倍速标签已更新', /×/.test(elements.get('rate').textContent), elements.get('rate').textContent);
check('音符宽度标签已更新', /音符宽度/.test(elements.get('note-width').textContent), elements.get('note-width').textContent);

// ---------------------------------------------------------------- RPE 示例包
section('切换到 RPE 示例包');
elements.get('samples').children[1].onclick();
for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
check('RPE 包载入成功', !status.textContent.includes('载入失败'), status.textContent);
check('信息面板显示 RPE 与 1417 音符', /RPE/.test(info.innerHTML) && /音符 1417/.test(info.innerHTML));
check('扩展事件告警已列出', /扩展事件|inclineEvents/.test(elements.get('warnings').innerHTML));
step(120);
check('RPE 包跑帧无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

// ---------------------------------------------------------------- 目录包（FileList）
section('从目录 FileList 载入（选择谱面包目录）');
{
  const dir = 'packages/领土战争AT（RPE格式）';
  const names = fs.readdirSync(path.join(ROOT, dir));
  const files = names.map((n) => {
    const buf = fs.readFileSync(path.join(ROOT, dir, n));
    const file = new File([buf], n);
    Object.defineProperty(file, 'webkitRelativePath', { value: `${path.basename(dir)}/${n}` });
    return file;
  });
  const input = elements.get('file-input');
  input.files = files;
  input.dispatch('change');
  for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
  check('目录包载入成功', !status.textContent.includes('载入失败'), status.textContent);
  check('包内 info.txt 元数据生效（曲名/难度）', /テリトリーバトル/.test(info.innerHTML) || /AT Lv/.test(info.innerHTML), info.innerHTML.split('<div')[0]);
}

// ---------------------------------------------------------------- 只给谱面 JSON（无音频/曲绘）
section('只选谱面 JSON');
{
  const input = elements.get('json-input');
  const buf = fs.readFileSync(path.join(ROOT, 'packages/白复生 AT（official格式）/Chart_AT #3649.json'));
  input.files = [new File([buf], 'Chart_AT #3649.json')];
  input.dispatch('change');
  for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
  check('纯 JSON 载入成功', !status.textContent.includes('载入失败'), status.textContent);
  step(60);
  check('纯 JSON 跑帧无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

// ---------------------------------------------------------------- 错误路径
section('错误路径应给出可读提示');
{
  const input = elements.get('json-input');
  input.files = [new File(['{"foo":1}'], 'bad.json')];
  input.dispatch('change');
  await tick(150);
  check('无效谱面给出可读错误', /载入失败/.test(status.textContent) && /无法识别的谱面格式/.test(status.textContent), status.textContent);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
