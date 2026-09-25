// 应用层（player.html + src/app/main.js）的无头冒烟测试：
// 用最小 DOM/Audio/Image/fetch 桩件启动真正的 main.js，走一遍「启动 → 点示例包按钮 → 跑若干帧
// → 载入 RPE 包 → 目录包（FileList）→ 快捷键」，断言不抛异常且 HUD 有正确数值。
// 这类测试能抓住「原始 JSON 直接进 prepareChart」之类的接线错误。
// 运行：node tools/app-smoke.mjs
import fs from 'node:fs';
import { hasSample, skipSample } from './samples.mjs';
const MISSING = ['official', 'rpe'].filter((k) => !hasSample(k));
if (MISSING.length) {
  console.log('跳过整个用例集：仓库里没有 packages/ 下的第三方谱面包（放进 packages/ 后即可运行）');
  process.exit(0);
}

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
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    style: { setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name] ?? ''; } },
    dataset: {},
    children: [],
    _listeners: {},
    _text: '',
    _html: '',
    // textContent / innerHTML 与真实 DOM 一致：读 textContent 会把子节点拼起来
    // （setIcon 会把按钮内容换成「图标 + 文字」两个 span，读按钮文字要靠这一条）
    get textContent() {
      return this._text + this.children.map((c) => c.textContent ?? '').join('');
    },
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    },
    get innerHTML() {
      return this._html + this.children.map((c) => c.innerHTML ?? '').join('');
    },
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
      if (v === '') this._text = '';
    },
    value: '0',
    checked: true,
    disabled: false,
    files: null,
    onclick: null,
    width: 300,
    height: 150,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
    attributes: new Map(),
    setAttribute(k, v) {
      this.attributes.set(k, v);
      if (k === 'class') classes.add(v);
    },
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    },
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn);
    },
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
/** player.html 里各 id 上的静态 class：桩件照抄，才能断言「图标按钮没有背景/外框」这类结构约定 */
const htmlClasses = new Map();
{
  const html = fs.readFileSync(path.join(ROOT, 'player.html'), 'utf8');
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const cls = /\bclass="([^"]*)"/.exec(m[0]);
    htmlClasses.set(m[1], cls ? cls[1].split(/\s+/).filter(Boolean) : []);
  }
}
for (const id of [
  'boot', 'stage', 'stage-wrap', 'hud', 'hud-score', 'hud-combo', 'hud-combo-label', 'hud-acc', 'hud-name', 'hud-level',
  'hud-time', 'hud-progress', 'hud-progress-fill',
  'hud-fps',
  'hud-notes', 'hud-status', 'hud-judge', 'btn-pause', 'warnings', 'chart-info', 'file-input', 'zip-input', 'json-input',
  'btn-play', 'btn-restart', 'btn-rate', 'btn-note-narrow', 'btn-note-wide', 'rate', 'note-width', 'multi-hint', 'show-lines',
  'show-notes', 'progress', 'play-mode', 'play-mode-hint', 'pause-screen', 'play-result', 'play-result-text',
  'btn-again', 'btn-back', 'btn-fullscreen', 'hold-sample', 'judge-band', 'judge-tilt', 'judge-screen',
  // 暂停页：主层图标按钮 + 二级页面（设置 / 打开）
  'pause-back', 'pause-main', 'pause-settings', 'pause-open',
  'btn-open', 'btn-autoplay', 'btn-settings', 'btn-fullscreen-main',
  'btn-open-folder', 'btn-open-zip', 'btn-open-json', 'pause-open-status',
]) {
  const node = makeElement(id === 'stage' ? 'canvas' : 'div', id);
  for (const cls of htmlClasses.get(id) ?? []) node.classList.add(cls);
  elements.set(id, node);
}
const windowListeners = {};
const documentListeners = {};
const bodyElement = makeElement('body', 'body');
/** 全屏桩件：记录调用次数，并在状态变化时派发 fullscreenchange（与真实浏览器一致） */
const fullscreenCalls = { requested: 0, exited: 0 };
const documentElement = {
  requestFullscreen: async () => {
    fullscreenCalls.requested++;
    globalThis.document.fullscreenElement = documentElement;
    for (const fn of documentListeners.fullscreenchange ?? []) fn();
  },
};
globalThis.document = {
  body: bodyElement,
  documentElement,
  fullscreenElement: null,
  exitFullscreen: async () => {
    fullscreenCalls.exited++;
    globalThis.document.fullscreenElement = null;
    for (const fn of documentListeners.fullscreenchange ?? []) fn();
  },
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => makeElement(tag),
  addEventListener(type, fn) {
    (documentListeners[type] ??= []).push(fn);
  },
};
globalThis.window = {
  devicePixelRatio: 1,
  // 桩件按「触屏设备」来（真实游玩只在触屏可用；桌面分支另有用例直接测 isTouchDevice）
  ontouchstart: null,
  navigator: { maxTouchPoints: 5 },
  addEventListener(type, fn) {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener() {},
};
globalThis.location = { search: '' };
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
/** 打击音效「响了几次」：桩件里 createBufferSource().start() 就是播一次（用于音效时序的回归） */
let soundStarts = 0;
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
      start() {
        soundStarts++;
      },
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { value: 1 },
      connect() {},
    };
  }
  async decodeAudioData() {
    return { duration: 100, sampleRate: 44100 };
  }
};
globalThis.URL = globalThis.URL ?? {};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

// 捕获未处理错误，避免静默（**必须打印**：否则模块顶层抛错会「悄悄中断剩下的用例」，
// 进程还会以 0 退出，看起来像全部通过）
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('未捕获异常：', e);
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('未处理的 Promise 拒绝：', e);
});

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
// 轮询等待 boot 完成（贴图加载含长条结构识别，耗时与机器有关）
const waitFor = async (cond, ms = 5000, stepMs = 50) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await tick(stepMs);
  }
  return cond();
};
// 局内 HUD 现在只有进度条 / 暂停键 / 连击 / 分数 / 曲名 / 难度（其余元素按需求删除），
// 于是下面这些断言改为直接读应用状态：数值含义与原来的 HUD 文本完全一致。
const appApi = () => globalThis.PhiChartPlayer ?? {};
const appStats = () => appApi().state?.stats ?? {};
const hudNotes = () => {
  const s = appApi().state;
  const chart = appApi().chart;
  return s && chart ? `${s.stats.judged} / ${chart.noteCount}` : '';
};
const hudAcc = () => {
  const s = appApi().state;
  return s ? `${(s.stats.accuracy * 100).toFixed(2)}%` : '';
};
const hudTime = () => {
  const pb = appApi().playback;
  if (!pb) return '';
  const dur = pb.duration ?? appApi().chart?.endTime ?? 0;
  return `${pb.chartTime().toFixed(2)} / ${dur.toFixed(2)}s`;
};

await waitFor(() => !!appApi().chart || /谱面包|失败/.test(elements.get('pause-open-status').textContent));
const status = elements.get('pause-open-status');
check('贴图加载后 boot 完成（暂停页状态行给出载入指引）', /谱面包/.test(status.textContent), status.textContent);
{
  const { loadTextures } = await import('../src/render/textures.js');
  const tex = await loadTextures('assets/');
  check(
    '长条贴图元数据就绪（本体 / 卡口 / 分段）',
    !!tex.hold.__meta?.core && !!tex.hold.__meta?.capPx,
    JSON.stringify({ core: tex.hold.__meta?.core, capPx: tex.hold.__meta?.capPx, segments: tex.hold.__meta?.segments ?? null }),
  );
  check(
    '长条分段为硬编码的 48px 帽 + 48px 光效（不做运行时识别）',
    tex.hold.__meta.segments?.capTop === 48 && tex.holdHL.__meta.segments?.glowTop === 48 && !('detected' in tex.hold.__meta),
    JSON.stringify({ hold: tex.hold.__meta.segments, holdHL: tex.holdHL.__meta.segments }),
  );
}
check('启动期无未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

// ---------------------------------------------------------------- 官方示例包（自选目录载入）
/** 用「选择谱面包目录」的通路载入一个包（浏览器里就是 webkitdirectory 选择器） */
async function loadPackageDir(dir) {
  const names = fs.readdirSync(path.join(ROOT, dir));
  const files = names.map((n) => {
    const file = new File([fs.readFileSync(path.join(ROOT, dir, n))], n);
    Object.defineProperty(file, 'webkitRelativePath', { value: `${path.basename(dir)}/${n}` });
    return file;
  });
  const input = elements.get('file-input');
  input.files = files;
  input.dispatch('change');
  for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
}

section('选择谱面包目录载入官方包');
await loadPackageDir('packages/白复生 AT（official格式）');
check('官方包载入成功（无「载入失败」）', !status.textContent.includes('载入失败'), status.textContent);
const info = elements.get('chart-info');
check('谱面信息面板已填充（24 线 / 1156 音符）', /判定线 24/.test(info.innerHTML) && /音符 1156/.test(info.innerHTML));
check('物量 1156', /物量 1156/.test(info.innerHTML));

section('跑帧与自动游玩');
step(120);
const scoreText = elements.get('hud-score').textContent;
const notesText = hudNotes();
check('HUD 分数已更新（7 位定点）', /^\d{7}$/.test(scoreText), `score=${scoreText}`);
check('HUD 记录了判定进度', /\d+ \/ 1156/.test(notesText), notesText);
check('运行期没有未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

// 播放并跳进谱面中段：验证「音频时钟 → 状态求值 → 判定计分 → HUD」整条链路
section('播放时钟与计分链路');
elements.get('btn-play').dispatch('click');
audioClock += 30; // 直接把音频时钟推进 30 秒
step(60);
const judged = Number((hudNotes().match(/^(\d+)/) ?? [])[1] ?? 0);
check('播放后音符被判定（judged > 0）', judged > 0, hudNotes());
check('分数随判定上升', Number(elements.get('hud-score').textContent) > 0, elements.get('hud-score').textContent);
check('连击/ACC 已更新', /%$/.test(hudAcc()), hudAcc());
elements.get('btn-play').dispatch('click'); // 暂停

// 局内 HUD 参考图布局：顶部进度条 / 正上方连击与可配置小字 / 四角信息
section('局内 HUD（参考图布局与可配置文案）');
{
  check('顶部有进度条（轨道 + 填充两个元素）', !!elements.get('hud-progress') && !!elements.get('hud-progress-fill'));
  const pct = parseFloat(elements.get('hud-progress-fill').style.width);
  check('进度条填充宽度随播放进度写入百分比', Number.isFinite(pct) && pct > 0 && pct <= 100, `width=${elements.get('hud-progress-fill').style.width}`);
  check('四角信息就位（暂停键 / 曲名 / 分数 / 难度）', !!elements.get('btn-pause') && !!elements.get('hud-name') && !!elements.get('hud-score') && !!elements.get('hud-level'));
  check('暂停键照旧带 hud-icon 类（图标靠 setIcon 注入）', elements.get('btn-pause').classList.contains('hud-icon'));

  // 连击小字：自动游玩 → AUTOPLAY；可配置项能覆盖（后期自定义）
  const labels = globalThis.PhiChartPlayer?.hudLabels;
  check('暴露可配置的连击小字接口', typeof globalThis.PhiChartPlayer?.setHudLabels === 'function' && !!labels, JSON.stringify(labels));
  check('自动游玩时显示 AUTOPLAY', elements.get('hud-combo-label').textContent === 'AUTOPLAY', elements.get('hud-combo-label').textContent);
  globalThis.PhiChartPlayer.setHudLabels({ custom: 'ELEVATED' });
  check('自定义文案生效（参考图里的 ELEVATED）', elements.get('hud-combo-label').textContent === 'ELEVATED', elements.get('hud-combo-label').textContent);
  globalThis.PhiChartPlayer.setHudLabels({ custom: '' });
  check('清掉自定义后回落到自动文案', elements.get('hud-combo-label').textContent === 'AUTOPLAY', elements.get('hud-combo-label').textContent);
}

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

// ---------------------------------------------------------------- RPE 包
section('切换到 RPE 包');
await loadPackageDir('packages/领土战争AT（RPE格式）');
check('RPE 包载入成功', !status.textContent.includes('载入失败'), status.textContent);
check('信息面板显示 RPE 与 1417 音符', /RPE/.test(info.innerHTML) && /音符 1417/.test(info.innerHTML));
check('扩展事件告警已列出', /扩展事件|inclineEvents/.test(elements.get('warnings').innerHTML));
step(120);
check('RPE 包跑帧无异常', errors.length === 0, errors.map((e) => e.message).join(' | '));

// ---------------------------------------------------------------- 目录包（FileList）：info.txt 元数据
section('目录包里的 info.txt 元数据生效');
{
  await loadPackageDir('packages/领土战争AT（RPE格式）');
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

// ---------------------------------------------------------------- 触屏真实游玩
section('触屏真实游玩（仅渲染器页面；关闭自动游玩后真的玩）');
{
  const { isTouchDevice } = await import('../src/app/touch-input.js');
  // 装置判定：桌面（无触摸点、无 ontouchstart）与触屏两个分支
  check('isTouchDevice：桌面判为 false', isTouchDevice({ navigator: { maxTouchPoints: 0 } }) === false);
  check('isTouchDevice：maxTouchPoints > 0 或存在 ontouchstart 判为 true', isTouchDevice({ navigator: { maxTouchPoints: 3 } }) === true && isTouchDevice({ ontouchstart: null }) === true);

  // 一张很小的官谱：tap@2s、双押 tap@2s、flick@3s、drag@4s（bpm 60 → time = 秒 × 32）
  const T = (sec) => Math.round(sec * 32);
  const tiny = {
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 60,
        notesAbove: [
          { type: 1, time: T(2), positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 },
          { type: 1, time: T(2), positionX: 2, holdTime: 0, speed: 1, floorPosition: 1 },
          { type: 4, time: T(3), positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 },
          { type: 2, time: T(4), positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 },
        ],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      },
    ],
  };
  const jsonInput = elements.get('json-input');
  status.textContent = ''; // 清掉上一段的错误文本，否则下面的等待会立刻返回
  jsonInput.files = [new File([JSON.stringify(tiny)], 'tiny.json')];
  jsonInput.dispatch('change');
  for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
  check('小谱面载入成功', !status.textContent.includes('载入失败'), status.textContent);

  const playToggle = elements.get('play-mode');
  const stage = elements.get('stage');
  const startOverlay = elements.get('play-start');
  const resultOverlay = elements.get('play-result');
  check('渲染器页面提供「触屏游玩模式」开关（编辑器页面没有）', !!playToggle && !!resultOverlay);
  check('没有「点击开始」这一层（点播放直接开始）', !startOverlay, startOverlay ? '仍然存在' : 'ok');
  check('触屏设备上开关可用', playToggle.disabled === false, `disabled=${playToggle.disabled}`);

  // 桌面分支：临时摘掉 ontouchstart → 开启被拒绝（游玩仅限触屏）
  delete globalThis.window.ontouchstart;
  globalThis.window.navigator.maxTouchPoints = 0;
  playToggle.checked = true;
  playToggle.dispatch('change');
  check('桌面（无触屏）无法开启游玩模式', !globalThis.document.body.classList.contains('play-mode'), globalThis.document.body.className);
  globalThis.window.ontouchstart = null;
  globalThis.window.navigator.maxTouchPoints = 5;

  // 触屏分支：开启游玩模式
  playToggle.checked = true;
  playToggle.dispatch('change');
  check('触屏上开启后：身体挂上 play-mode', globalThis.document.body.classList.contains('play-mode'));
  check('开启后进度条被禁用（游玩中不允许跳转）', elements.get('progress').disabled === true);
  check('开启后倍速被固定为 1.00×（计分的一局不跑变速）', elements.get('btn-rate').disabled === true && /^1\.00×$/.test(elements.get('rate').textContent), elements.get('rate').textContent);
  check('开启后停在暂停页', elements.get('pause-screen').classList.contains('hidden') === false);

  // 点「播放」→ 立刻进入播放界面（没有中间那层「点击开始」）
  // 触摸监听绑在**画布**上（浮层是画布的兄弟节点，界面控件天生不参与判定），所以往 stage 派发。
  // 判定带（默认判定范围）：音符列在画布上的 x —— 画布桩件 1280×720、判定线居中，
  // 音符 positionX=0 → x=640；positionX=2 → +2×0.05625×1280 = +144 → 784
  const COL = { x0: 640, x2: 784 };
  const touchDown = (id = 1, x = COL.x0, y = 300) => stage.dispatch('touchstart', { changedTouches: [{ identifier: id, clientX: x, clientY: y }] });
  const touchUp = (id = 1) => stage.dispatch('touchend', { changedTouches: [{ identifier: id }] });
  const tap = (id = 1, x = COL.x0, y = 300) => {
    touchDown(id, x, y);
    touchUp(id);
  };
  /** 滑动：touchstart → touchmove（位移超过阈值）→ touchend（不能先抬手，否则没有滑动） */
  const swipe = (id = 1, from = COL.x0 + 60, to = COL.x0 - 60, y = 300) => {
    touchDown(id, from, y);
    stage.dispatch('touchmove', { changedTouches: [{ identifier: id, clientX: to, clientY: y }] });
    touchUp(id);
  };
  /** 把时钟推到 sec 前一帧并让这一帧过去（下一帧就落在 sec 附近） */
  let runBase = audioClock; // 起播时的音频时钟（谱面时间 = audioClock − runBase）
  const frameAt = (sec) => {
    audioClock = runBase + sec - 1 / 60;
    step(1);
  };
  runBase = audioClock;
  elements.get('btn-play').dispatch('click');
  check('点「播放」立刻开始（直接进入播放界面）', elements.get('pause-screen').classList.contains('hidden') === true && elements.get('hud').classList.contains('hidden') === false);
  check('播放中 HUD 可见、暂停页隐藏', elements.get('hud').classList.contains('hidden') === false && elements.get('pause-screen').classList.contains('hidden') === true);

  // 第 1 局：一次都不点 → Tap / Flick 全 Miss（Drag 过线即 Perfect）
  audioClock = runBase + 5;
  step(2);
  check('不点音符 → 全部判完（4 / 4）', /4 \/ 4/.test(hudNotes()), hudNotes());
  check('最近一次判定是 Miss（4 个音符全漏 → miss=4）', appStats().miss === 4, `miss=${appStats().miss}`);

  // 结算浮层（全部判完）
  check('全部判完 → 显示结算浮层', resultOverlay.classList.contains('hidden') === false);
  check(
    '结算内容含 ACC / 最大连击 / 分档统计（什么都不按 → 4 个全 Miss）',
    /ACC/.test(elements.get('play-result-text').innerHTML) &&
      /最大连击/.test(elements.get('play-result-text').innerHTML) &&
      /Miss 4/.test(elements.get('play-result-text').innerHTML) &&
      /Perfect 0/.test(elements.get('play-result-text').innerHTML),
    elements.get('play-result-text').innerHTML.replace(/<[^>]*>/g, ' ').trim(),
  );

  // 第 2 局：「再来一次」按钮重开 → 按时刻 + 按判定带点击 → Perfect
  runBase = audioClock;
  elements.get('btn-again').dispatch('click');
  check('点「再来一次」重开（浮层收起、进度归零）', resultOverlay.classList.contains('hidden') === true && /0 \/ 4/.test(hudNotes()), hudNotes());
  check('默认判定范围是「音符判定带」', elements.get('judge-band').classList.contains('active') === true && elements.get('judge-screen').classList.contains('active') === false);
  frameAt(2.0);
  tap(1, COL.x0); // 第一个音符的列
  step(1);
  check('点击命中（落在判定带里）→ Perfect', appStats().perfect === 1 && /1 \/ 4/.test(hudNotes()), `perfect=${appStats().perfect} / ${hudNotes()}`);
  // 判定带：点在完全不对的列上 → 不算命中
  frameAt(2.0);
  tap(1, 40); // 远离 640 / 784 两列
  step(1);
  check('判定带：点在错误的列上不算命中', /1 \/ 4/.test(hudNotes()), hudNotes());
  audioClock = runBase + 2.4;
  step(1);
  check('判定带：错列点击后该音符按 Miss 结算', /2 \/ 4/.test(hudNotes()), hudNotes());
  // Flick：滑动经过判定带
  frameAt(3.0);
  swipe(1);
  step(1);
  check('滑动命中 Flick（经过判定带）', /3 \/ 4/.test(hudNotes()), hudNotes());
  // Drag：判定时刻要有手指按在判定带里（不是「过线自动满分」）
  frameAt(4.0);
  touchDown(1, COL.x0); // 手指按在拖条自己的判定带里，保持到这一帧
  step(1);
  touchUp(1);
  check('Drag：判定时刻有手指按在带里 → Perfect → 整曲判完', /4 \/ 4/.test(hudNotes()), hudNotes());
  check(
    '本局 3 Perfect + 1 次错列 Miss（判定带真的按位置生效）',
    Number(elements.get('hud-score').textContent) > 0 && /Perfect 3/.test(elements.get('play-result-text').innerHTML) && /Miss 1/.test(elements.get('play-result-text').innerHTML),
    `${elements.get('hud-score').textContent}｜${elements.get('play-result-text').innerHTML.replace(/<[^>]*>/g, ' ').trim()}`,
  );

  // 判定范围选项：全屏判定（保留给习惯「点屏幕任意位置」的玩家）
  elements.get('judge-screen').dispatch('click');
  check('切到「全屏判定」：按钮高亮', elements.get('judge-screen').classList.contains('active') === true && elements.get('judge-band').classList.contains('active') === false);
  runBase = audioClock;
  elements.get('btn-again').dispatch('click');
  frameAt(2.0);
  tap(1, 40); // 同样的错列位置
  step(1);
  check('全屏判定：任意位置的点击都算命中', /1 \/ 4/.test(hudNotes()), hudNotes());
  elements.get('judge-band').dispatch('click');
  check('切回「音符判定带」', elements.get('judge-band').classList.contains('active') === true);

  // 第三档「轨道判定」：判定带跟着画面上的音符走（相机 / Z 轴位移 / 下落面倾斜都参与）
  elements.get('judge-tilt').dispatch('click');
  check(
    '切到「轨道判定」：按钮高亮且与其它两档互斥',
    elements.get('judge-tilt').classList.contains('active') === true &&
      elements.get('judge-band').classList.contains('active') === false &&
      elements.get('judge-screen').classList.contains('active') === false,
  );
  elements.get('judge-band').dispatch('click');

  // 第 3 局：双押 —— 两根手指分别点在各自的判定带上
  runBase = audioClock;
  elements.get('btn-again').dispatch('click');
  frameAt(2.0);
  tap(1, COL.x0);
  tap(2, COL.x2);
  step(1);
  check('双押：两指分别命中各自的判定带', /2 \/ 4/.test(hudNotes()), hudNotes());
  audioClock = runBase + 5;
  step(2);

  // 暂停键（左上角）→ 回暂停页；再点播放 / 空格 = **从暂停处继续**（不从头开始）
  {
    // 停在中段（第 3 局已经判完，先重开一局再走到 3.0s）
    runBase = audioClock;
    elements.get('btn-again').dispatch('click');
    audioClock = runBase + 3.0;
    step(1);
    const timeAtPause = hudTime();
    elements.get('btn-pause').dispatch('click');
    check('点左上角暂停键 → 回到暂停页', elements.get('pause-screen').classList.contains('hidden') === false && elements.get('hud').classList.contains('hidden') === true);
    check('暂停时时钟停住（HUD 时间不再走）', hudTime() === timeAtPause, `${timeAtPause} → ${hudTime()}`);
    elements.get('btn-play').dispatch('click');
    check('点「播放」→ 从暂停处继续（直接回到播放界面）', elements.get('pause-screen').classList.contains('hidden') === true && elements.get('hud').classList.contains('hidden') === false);
    check('继续播放在暂停时刻附近（不是从头开始）', (() => {
      const t = Number((hudTime().match(/^([\d.]+)/) ?? [])[1] ?? 0);
      return t >= 2.9 && t < 3.2;
    })(), `${timeAtPause} → ${hudTime()}`);
    check('继续后判定进度没有被清零（不是重开一局）', !/^0 \//.test(hudNotes()), hudNotes());
  }
  for (const fn of windowListeners.keydown ?? []) fn({ code: 'Escape', target: {}, preventDefault() {} });
  check('Esc → 暂停页', elements.get('pause-screen').classList.contains('hidden') === false);
  for (const fn of windowListeners.keydown ?? []) fn({ code: 'Space', target: {}, preventDefault() {} });
  check('暂停页按空格 → 从暂停处继续', elements.get('pause-screen').classList.contains('hidden') === true && elements.get('hud').classList.contains('hidden') === false);

  // 结算页「返回」→ 回暂停页
  audioClock = runBase + 20;
  step(2);
  check('全部判完 → 结算页', resultOverlay.classList.contains('hidden') === false);
  elements.get('btn-back').dispatch('click');
  check('结算页「返回」→ 回暂停页且进度归零', elements.get('pause-screen').classList.contains('hidden') === false && /0 \/ 4/.test(hudNotes()), hudNotes());

  // 全屏按钮：桩件里 documentElement 有 requestFullscreen，验证真能调用并切换文案
  {
    const fsBtn = elements.get('btn-fullscreen');
    check('提供全屏开关按钮', !!fsBtn && fsBtn.disabled === false);
    fsBtn.dispatch('click');
    await tick(30);
    check('点全屏 → 调用 requestFullscreen 并变成「退出全屏」', fullscreenCalls.requested === 1 && /退出全屏/.test(fsBtn.textContent), `${fsBtn.textContent} requested=${fullscreenCalls.requested}`);
    // 用户按 Esc 退出全屏（浏览器只改状态、派发 fullscreenchange）→ 按钮要同步回来
    globalThis.document.fullscreenElement = null;
    for (const fn of documentListeners.fullscreenchange ?? []) fn();
    check('fullscreenchange → 按钮回到「全屏」', /全屏/.test(fsBtn.textContent) && !/退出/.test(fsBtn.textContent), fsBtn.textContent);
    // 再进一次 → 在真实全屏状态下点同一个按钮才是「退出全屏」
    fsBtn.dispatch('click');
    await tick(30);
    check('再点 → 重新进入全屏', fullscreenCalls.requested === 2 && /退出全屏/.test(fsBtn.textContent), `requested=${fullscreenCalls.requested}`);
    fsBtn.dispatch('click');
    await tick(30);
    check('全屏中点同一按钮 → 退出全屏', fullscreenCalls.exited === 1 && /全屏/.test(fsBtn.textContent) && !/退出/.test(fsBtn.textContent), `${fsBtn.textContent} exited=${fullscreenCalls.exited}`);
  }

  // 暂停时不再重复判定（曾经的 bug：暂停时正好有音符落线 → 音效每帧循环播放）
  {
    // ① 自动游玩分支：不判定时必须返回**空数组**（以前返回上一帧的 state.hits，
    //    于是 playback.update 每帧都把同一批命中当新命中 → 音效每帧循环）
    playToggle.checked = false;
    playToggle.dispatch('change'); // 关掉触屏游玩 = 自动游玩
    runBase = audioClock;
    elements.get('btn-play').dispatch('click');
    frameAt(2.0);
    step(1); // 第 1 个音符（2.0s）落线并被判定
    elements.get('btn-pause').dispatch('click');
    const notesAtPause = hudNotes();
    const starts0 = soundStarts;
    step(6);
    check(
      '暂停时正好有音符落线：音效不会每帧循环播放',
      soundStarts === starts0 && hudNotes() === notesAtPause,
      `音效 ${starts0} → ${soundStarts}｜${notesAtPause}`,
    );

    // ② 触屏游玩分支：暂停时判定函数仍在跑，也不能重复判定
    playToggle.checked = true;
    playToggle.dispatch('change');
    runBase = audioClock;
    elements.get('btn-play').dispatch('click');
    frameAt(2.0);
    tap(1, COL.x0);
    step(1);
    elements.get('btn-pause').dispatch('click');
    const afterPause = hudNotes();
    const starts1 = soundStarts;
    step(6);
    check('触屏游玩暂停时：也不重复判定', soundStarts === starts1 && hudNotes() === afterPause, `音效 ${starts1} → ${soundStarts}｜${afterPause}`);
    audioClock = runBase + 20;
    step(2);
  }

  // Hold 端到端：头部点中 + 按住到尾部才得分；提前 ≤20% 松手仍算；更早松手 = Miss
  {
    const holdChart = {
      formatVersion: 3,
      offset: 0,
      judgeLineList: [
        {
          bpm: 60,
          // 长条：1s 落下、按 2s（1s → 3s）
          notesAbove: [{ type: 3, time: T(1), positionX: 0, holdTime: T(2), speed: 1, floorPosition: 1 }],
          notesBelow: [],
          speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
          judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
          judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
          judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
        },
      ],
    };
    status.textContent = '';
    jsonInput.files = [new File([JSON.stringify(holdChart)], 'hold.json')];
    jsonInput.dispatch('change');
    for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
    check('长条谱面载入成功', !status.textContent.includes('载入失败'), status.textContent);
    // 换谱面会退出游玩模式，这里重新开启
    playToggle.checked = true;
    playToggle.dispatch('change');
    runBase = audioClock;
    elements.get('btn-play').dispatch('click');
    const inPlay = () => elements.get('hud').classList.contains('hidden') === false;

    frameAt(1.0);
    touchDown(1, COL.x0);
    step(1);
    check('Hold 头部点中：还没记分（等按到尾部）', inPlay() && /0 \/ 1/.test(hudNotes()), hudNotes());
    frameAt(2.0);
    step(1);
    check('Hold 按住中：仍未记分', inPlay() && /0 \/ 1/.test(hudNotes()), hudNotes());
    frameAt(3.0);
    step(1);
    check('Hold 按到尾部 → 得分（1 / 1）并结算', /1 \/ 1/.test(hudNotes()) && resultOverlay.classList.contains('hidden') === false, hudNotes());
    touchUp(1);

    // 换手 + 断连宽限：2.6s 松手，60ms 后另一根手指接上 → 仍记分
    runBase = audioClock;
    elements.get('btn-again').dispatch('click');
    frameAt(1.0);
    touchDown(1, COL.x0);
    step(1);
    frameAt(2.6);
    touchUp(1);
    step(3); // 松手后 ~48ms：还在 80ms 宽限内
    touchDown(2, COL.x0); // 换一根手指接上
    step(1);
    frameAt(3.0);
    step(1);
    check('Hold 换手（断连 80ms 内接上）→ 仍记分', /1 \/ 1/.test(hudNotes()), hudNotes());
    touchUp(2);

    // 松手后一直不接 → 断连超过 80ms → Miss，且不是 Bad
    runBase = audioClock;
    elements.get('btn-again').dispatch('click');
    frameAt(1.0);
    touchDown(1, COL.x0);
    step(1);
    frameAt(1.5);
    touchUp(1);
    step(6); // 松手后 ~96ms > 80ms 宽限
    check(
      'Hold 松手后断连超过 80ms → Miss（无 Bad）',
      /1 \/ 1/.test(hudNotes()) && /Miss 1/.test(elements.get('play-result-text').innerHTML) && !/Bad [1-9]/.test(elements.get('play-result-text').innerHTML),
      elements.get('play-result-text').innerHTML.replace(/<[^>]*>/g, ' ').trim(),
    );

    // 快速点一下（按下即抬起，之后不接）→ 超过宽限后同样 Miss（必须是按住）
    runBase = audioClock;
    elements.get('btn-again').dispatch('click');
    frameAt(1.0);
    tap(1, COL.x0);
    step(6);
    check('Hold 快速点一下就松开 → 断连超过 80ms 后 Miss（必须是按住）', /1 \/ 1/.test(hudNotes()) && /Miss 1/.test(elements.get('play-result-text').innerHTML), elements.get('play-result-text').innerHTML.replace(/<[^>]*>/g, ' ').trim());
  }

  // 背面音符（notesBelow / above=false，由下往上落）：判定带与正面同 positionX 的音符在同一列
  {
    const backChart = {
      formatVersion: 3,
      offset: 0,
      judgeLineList: [
        {
          bpm: 60,
          // 同一时刻、同一 positionX（官方 X 单位：2 X = 2 × 0.05625 × 1280 = 144px）
          notesAbove: [{ type: 1, time: T(2), positionX: 2, holdTime: 0, speed: 1, floorPosition: 1 }],
          notesBelow: [{ type: 1, time: T(2), positionX: 2, holdTime: 0, speed: 1, floorPosition: 1 }],
          speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
          judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
          judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
          judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
        },
      ],
    };
    status.textContent = '';
    jsonInput.files = [new File([JSON.stringify(backChart)], 'back.json')];
    jsonInput.dispatch('change');
    for (let i = 0; i < 60 && !/按空格|失败/.test(status.textContent); i++) await tick(100);
    check('背面音符谱面载入成功（1 正面 + 1 背面，同 positionX）', !status.textContent.includes('载入失败'), status.textContent);
    playToggle.checked = true;
    playToggle.dispatch('change');
    runBase = audioClock;
    elements.get('btn-play').dispatch('click');
    // 先点在**镜像位置**（640 − 144 = 496）：两个音符都不该判上
    frameAt(2.0);
    tap(1, COL.x0 - 144);
    step(1);
    check('背面音符：点镜像位置不算命中（正/背面都不判）', /0 \/ 2/.test(hudNotes()), hudNotes());
    // 再在正确的列上两指一起点：正面与背面同时判上
    frameAt(2.0);
    tap(1, COL.x2);
    tap(2, COL.x2);
    step(1);
    check('背面音符：点它自己的列 → 正面与背面同时 Perfect', /2 \/ 2/.test(hudNotes()) && /Perfect 2/.test(elements.get('play-result-text').innerHTML), `${hudNotes()}｜${elements.get('play-result-text').innerHTML.replace(/<[^>]*>/g, ' ').trim()}`);
  }

  // 退出游玩 → 回到自动游玩
  playToggle.checked = false;
  playToggle.dispatch('change');
  check('退出游玩：去掉 play-mode、恢复进度条、自动游玩回归', !globalThis.document.body.classList.contains('play-mode') && elements.get('progress').disabled === false && playToggle.checked === false);
  check(
    '自动游玩开关跟随状态（关闭触屏游玩后回到按下态）',
    elements.get('btn-autoplay').getAttribute('aria-pressed') === 'true',
    `aria-pressed=${elements.get('btn-autoplay').getAttribute('aria-pressed')}`,
  );
  step(30);
  check('整段游玩流程无未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

// ---------------------------------------------------------------- 暂停页：一行图标 + 两个二级页面
section('暂停页：图标按钮与二级页面');
{
  const main = elements.get('pause-main');
  const settings = elements.get('pause-settings');
  const open = elements.get('pause-open');
  const back = elements.get('pause-back');
  const iconIds = ['btn-open', 'btn-restart', 'btn-autoplay', 'btn-fullscreen-main', 'btn-settings', 'btn-play'];
  const iconBtns = iconIds.map((id) => elements.get(id));
  check('主层有 6 个图标按钮（打开 / 重开 / 自动游玩 / 全屏 / 设置 / 继续）', iconBtns.every(Boolean), iconIds.join(','));
  check('图标按钮里没有文字（纯图标）', iconBtns.every((b) => !String(b.textContent ?? '').trim()), iconBtns.map((b) => b.textContent).join('|'));
  check(
    '图标按钮不带背景 / 外框类（只有 pause-icon）',
    iconBtns.every((b) => b.classList.contains('pause-icon') && !b.classList.contains('action') && !b.classList.contains('chip') && !b.classList.contains('card')),
    iconIds.filter((id) => !elements.get(id).classList.contains('pause-icon')).join(',') || '全部合规',
  );

  elements.get('btn-settings').dispatch('click');
  check('点设置 → 显示设置页并出现返回键', !settings.classList.contains('hidden') && !back.classList.contains('hidden'));
  check('其余设置项都在设置页里（判定范围 / 倍速 / 音符宽度 / 显示 / 进度 / 全屏）', ['judge-band', 'judge-tilt', 'judge-screen', 'btn-rate', 'btn-note-narrow', 'btn-note-wide', 'multi-hint', 'show-lines', 'show-notes', 'progress', 'btn-fullscreen'].every((id) => !!elements.get(id)));
  check(
    '判定范围三档叫「垂直判定」/「轨道判定」/「全屏判定」',
    /垂直判定/.test(elements.get('judge-band').textContent) &&
      /轨道判定/.test(elements.get('judge-tilt').textContent) &&
      /全屏判定/.test(elements.get('judge-screen').textContent),
    `${elements.get('judge-band').textContent} / ${elements.get('judge-tilt').textContent} / ${elements.get('judge-screen').textContent}`,
  );
  back.dispatch('click');
  check('点返回 → 回到主层并收起返回键', !main.classList.contains('hidden') && settings.classList.contains('hidden') && back.classList.contains('hidden'));

  elements.get('btn-open').dispatch('click');
  check('点打开 → 打开页（文件夹包 / zip 谱包）', !open.classList.contains('hidden') && main.classList.contains('hidden'));
  const openBtns = ['btn-open-folder', 'btn-open-zip'].map((id) => elements.get(id));
  check(
    '打开页的两个入口也是纯图标按钮',
    openBtns.every((b) => b.classList.contains('pause-icon') && !b.classList.contains('card') && !String(b.textContent ?? '').trim()),
    openBtns.map((b) => b.textContent).join('|'),
  );
  check(
    '打开页保留「只选谱面 JSON」次要入口，且只留一句拖放提示',
    !!elements.get('btn-open-json') && /可拖入文件/.test(elements.get('pause-open-status').textContent),
    elements.get('pause-open-status').textContent,
  );
  check('主层与设置页各有一个全屏按钮', !!elements.get('btn-fullscreen-main') && !!elements.get('btn-fullscreen'));
  back.dispatch('click');
  check('从打开页返回主层', !main.classList.contains('hidden') && open.classList.contains('hidden'));

  // 自动游玩开关：关闭触屏游玩 → 主层按钮回到未按下态，且切换后停在暂停页
  const playToggle2 = elements.get('play-mode');
  playToggle2.checked = true;
  playToggle2.dispatch('change');
  check('关闭自动游玩（触屏判定）后按钮为未按下态', elements.get('btn-autoplay').getAttribute('aria-pressed') === 'false');
  check('切换自动游玩后仍停在暂停页（不会被丢进播放里）', elements.get('pause-screen').classList.contains('hidden') === false && elements.get('hud').classList.contains('hidden') === true);
  // 点主层的开关按钮本身也能切回自动游玩
  elements.get('btn-autoplay').dispatch('click');
  check('点自动游玩按钮 → 切回自动游玩并在暂停页', playToggle2.checked === false && elements.get('btn-autoplay').getAttribute('aria-pressed') === 'true');
  step(20);
  check('暂停页重构后无未捕获异常', errors.length === 0, errors.map((e) => e.message).join(' | '));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
// 注意：这里不能用 process.exit()：stdout 是管道/文件时 Node 的写入是异步的，
// 直接退出会把最后这段汇总（甚至更多输出）截掉，看起来像「测试没跑完」。
process.exitCode = failed ? 1 : 0;
