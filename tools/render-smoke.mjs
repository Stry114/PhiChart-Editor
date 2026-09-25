// 渲染路径的无头冒烟测试：用最小 DOM/Canvas 桩件跑通「贴图预处理 + Canvas2D 绘制」，
// 并检查绘制调用是否合理（音符/判定线/打击特效都画出来了）。
// 运行：node tools/render-smoke.mjs
import fs from 'node:fs';
import { parseOfficialChart } from '../src/core/parse-official.js';
import { parseRpeChart } from '../src/core/parse-rpe.js';
import { prepareChart } from '../src/core/model.js';
import { createState, evaluate, advanceJudging } from '../src/core/state.js';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- DOM 桩件
const calls = { drawImage: 0, fillRect: 0, save: 0, restore: 0, translate: 0, rotate: 0, clearRect: 0, setTransform: 0 };
const drawCalls = []; // 记录 drawImage / fillRect 的参数（含经变换后的绝对中心 cx,cy），便于断言绘制几何
/** 2D 仿射矩阵工具（桩件里用来算出调用的绝对位置） */
const mulM = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function makeCtx() {
  const target = {
    canvas: null,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    font: '',
    textAlign: '',
    __lastImage: null,
    __m: [1, 0, 0, 1, 0, 0],
    __stack: [],
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'getImageData') {
        // 供 textures.detectHoldStructure 使用：返回最近一次 drawImage 的贴图数据
        return (_x, _y, w, h) => {
          const src = obj.__lastImage;
          const data = new Uint8ClampedArray(w * h * 4);
          if (src?.__rgba) data.set(src.__rgba.subarray(0, data.length));
          return { data, width: w, height: h };
        };
      }
      if (prop === 'translate') {
        return (x, y) => {
          calls.translate++;
          obj.__m = mulM(obj.__m, [1, 0, 0, 1, x, y]);
        };
      }
      if (prop === 'rotate') {
        return (r) => {
          calls.rotate++;
          obj.__m = mulM(obj.__m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        };
      }
      if (prop === 'scale') {
        return (x, y) => {
          calls.scale = (calls.scale ?? 0) + 1;
          obj.__m = mulM(obj.__m, [x, 0, 0, y, 0, 0]);
        };
      }
      if (prop === 'setTransform') {
        return (a, b, c, d, e, f) => {
          calls.setTransform++;
          obj.__m = [a, b, c, d, e, f];
        };
      }
      if (prop === 'save') {
        return () => {
          calls.save++;
          obj.__stack.push([...obj.__m]);
        };
      }
      if (prop === 'restore') {
        return () => {
          calls.restore++;
          if (obj.__stack.length) obj.__m = obj.__stack.pop();
        };
      }
      if (prop === 'createLinearGradient') {
        return (...args) => {
          const g = { kind: 'linear-gradient', args, stops: [] };
          g.addColorStop = (at, color) => g.stops.push([at, color]);
          return g;
        };
      }
      if (prop === 'fillRect') {
        return (x, y, w, h) => {
          calls.fillRect++;
          const [cx, cy] = applyM(obj.__m, x + w / 2, y + h / 2);
          drawCalls.push({ kind: 'fillRect', x, y, w, h, cx, cy, alpha: obj.globalAlpha, fillStyle: obj.fillStyle });
        };
      }
      if (prop === 'drawImage') {
        return (...args) => {
          calls.drawImage++;
          const [tex, ...rest] = args;
          if (rest.length <= 2) obj.__lastImage = tex;
          if (rest.length >= 8) {
            const [sx, sy, sw, sh, dx, dy, dw, dh] = rest;
            const [cx, cy] = applyM(obj.__m, dx + dw / 2, dy + dh / 2);
            drawCalls.push({ kind: 'drawImage', tex, sx, sy, sw, sh, dx, dy, dw, dh, cx, cy, alpha: obj.globalAlpha, m: [...obj.__m], clip: obj.__clip ?? null });
          } else {
            const [dx, dy, dw, dh] = rest;
            const [cx, cy] = applyM(obj.__m, dx + dw / 2, dy + dh / 2);
            drawCalls.push({ kind: 'drawImage', tex, dx, dy, dw, dh, cx, cy, alpha: obj.globalAlpha, full: true, m: [...obj.__m], clip: obj.__clip ?? null });
          }
        };
      }
      // 路径：只记录「多边形填充」，供判定范围叠加层这类路径绘制的断言使用
      if (prop === 'beginPath') {
        return () => {
          calls.beginPath = (calls.beginPath ?? 0) + 1;
          obj.__path = [];
        };
      }
      if (prop === 'moveTo') {
        return (x, y) => {
          calls.moveTo = (calls.moveTo ?? 0) + 1;
          (obj.__path ??= []).push([x, y]);
        };
      }
      if (prop === 'lineTo') {
        return (x, y) => {
          calls.lineTo = (calls.lineTo ?? 0) + 1;
          (obj.__path ??= []).push([x, y]);
        };
      }
      if (prop === 'closePath') {
        return () => {
          calls.closePath = (calls.closePath ?? 0) + 1;
        };
      }
      if (prop === 'clip') {
        return () => {
          calls.clip = (calls.clip ?? 0) + 1;
          obj.__clip = (obj.__path ?? []).map(([x, y]) => {
            const [px, py] = applyM(obj.__m, x, y);
            return { x: px, y: py };
          });
        };
      }
      if (prop === 'fill') {
        return () => {
          calls.fill = (calls.fill ?? 0) + 1;
          const points = (obj.__path ?? []).map(([x, y]) => {
            const [px, py] = applyM(obj.__m, x, y);
            return { x: px, y: py };
          });
          if (points.length >= 3) drawCalls.push({ kind: 'path', op: 'fill', points, alpha: obj.globalAlpha, fillStyle: obj.fillStyle });
        };
      }
      if (prop === 'stroke') {
        return () => {
          calls.stroke = (calls.stroke ?? 0) + 1;
        };
      }
      return (...args) => {
        if (prop in calls) calls[prop]++;
        void args;
        return undefined;
      };
    },
    set(obj, prop, value) {
      obj[prop] = value;
      return true;
    },
  });
}
function makeCanvas(w = 300, h = 150) {
  const canvas = { width: w, height: h, style: {} };
  canvas.getContext = () => {
    if (!canvas.__ctx) {
      canvas.__ctx = makeCtx();
      canvas.__ctx.canvas = canvas;
    }
    return canvas.__ctx;
  };
  return canvas;
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {} }),
};
globalThis.window = { devicePixelRatio: 1 };
// Image 桩件：按真实资产尺寸返回（设置 src 后异步触发 onload）
const IMAGE_SIZES = {
  'Tap.png': [989, 100],
  'TapHL.png': [1089, 200],
  'Drag.png': [989, 60],
  'DragHL.png': [1089, 160],
  'Flick.png': [989, 200],
  'FlickHL.png': [1089, 300],
  'Hold.png': [989, 2000],
  'HoldHL.png': [1062, 2048],
  'hit.png': [2520, 2160],
};
globalThis.Image = class {
  constructor() {
    this.width = 989;
    this.height = 100;
    this._src = '';
  }
  set src(v) {
    this._src = v;
    const name = String(v).split('/').pop().split('?')[0];
    const size = IMAGE_SIZES[name];
    if (size) {
      [this.width, this.height] = size;
    }
    setTimeout(() => this.onload?.(), 0);
  }
  get src() {
    return this._src;
  }
};

const { createCanvasRenderer } = await import('../src/render/canvas2d.js');
const { loadTextures, makeBackground } = await import('../src/render/textures.js');
const { createProjection, pickNote, pickLine } = await import('../src/render/projection.js');

console.log('== 贴图加载（Image 桩件） ==');
const textures = await loadTextures('assets/');
const keys = ['tap', 'tapHL', 'drag', 'dragHL', 'flick', 'flickHL', 'hold', 'holdHL', 'hit', 'hitPerfect', 'hitGood'];
check('全部贴图 key 就绪', keys.every((k) => !!textures[k]), keys.filter((k) => !textures[k]).join(',') || 'ok');
check(
  '打击特效已按 Perfect/Good 两色预着色',
  textures.hitPerfect.width === textures.hit.width && textures.hitGood.height === textures.hit.height,
  `${textures.hitPerfect.width}x${textures.hitPerfect.height}`,
);
check(
  '贴图元数据区分本体与光效（HL 贴图带外扩）',
  textures.tap.__meta.core.w === 987 && textures.tapHL.__meta.core.x === 50 && textures.holdHL.__meta.core.y === 49 && textures.holdHL.__meta.content.h === 1991,
  `tap.core=${JSON.stringify(textures.tap.__meta.core)} holdHL.core=${JSON.stringify(textures.holdHL.__meta.core)}`,
);
const bg = makeBackground({ width: 1920, height: 1080 }, 640, 360);
check('背景预处理产出离屏画布', bg.width === 640 && bg.height === 360);

// ── iOS 背景回归：没有 ctx.filter 时也要「模糊 + 压暗」──────────────────────────
// WebKit（iPhone/iPad 的 Safari）至今没有实现 CanvasRenderingContext2D.filter：
// 赋值被忽略、读回 'none'。以前模糊与压暗写在同一句 filter 里，于是两个效果一起消失。
{
  const { supportsCanvasFilter } = await import('../src/render/textures.js');
  const makeFakeCtx = ({ filterWorks }) => {
    const calls = { drawImage: 0, fillRect: 0, fillStyles: [], alphas: [], filters: [] };
    let filter = 'none';
    return {
      calls,
      canvas: { width: 640, height: 360 },
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
      globalAlpha: 1,
      get filter() {
        return filter;
      },
      set filter(v) {
        calls.filters.push(v);
        if (filterWorks) filter = v; // 不支持 filter 的浏览器：赋值被吞掉
      },
      get fillStyle() {
        return calls.fillStyles[calls.fillStyles.length - 1];
      },
      set fillStyle(v) {
        calls.fillStyles.push(v);
      },
      drawImage() {
        calls.drawImage++;
      },
      fillRect() {
        calls.fillRect++;
        calls.alphas.push(this.globalAlpha);
      },
    };
  };
  const makeFakeCanvasCtx = (opts) => {
    const ctx = makeFakeCtx(opts);
    return { getContext: () => ctx, ctx };
  };

  const prevCreate = globalThis.document.createElement;
  const canvases = [];
  let fakeFilterWorks = false; // 由用例切换：模拟 iOS（false）/ 正常浏览器（true）
  globalThis.document.createElement = (tag) => {
    if (tag !== 'canvas') return prevCreate(tag);
    const c = makeFakeCanvasCtx({ filterWorks: fakeFilterWorks });
    canvases.push(c);
    return c;
  };
  try {
    check('supportsCanvasFilter：支持时为 true / 不支持（iOS）时为 false', supportsCanvasFilter(makeFakeCtx({ filterWorks: true })) === true && supportsCanvasFilter(makeFakeCtx({ filterWorks: false })) === false);

    const iOSbg = makeBackground({ width: 1920, height: 1080 }, 640, 360, { blur: 120, brightness: 0.4 });
    const mainCtx = canvases[0].ctx;
    check('没有 ctx.filter 时仍然压暗（黑色叠加层，alpha = 1 − brightness）', mainCtx.calls.fillRect === 1 && Math.abs(mainCtx.calls.alphas[0] - 0.6) < 1e-9, `fillRect=${mainCtx.calls.fillRect} alpha=${mainCtx.calls.alphas[0]}`);
    check('没有 ctx.filter 时改用「缩小→放大」近似模糊（生成离屏小画布并放大回来）', canvases.length >= 3 && mainCtx.calls.drawImage >= 1, `离屏画布 ${canvases.length} 个`);
    check('压暗不写进 filter（旧实现把 brightness 放在 filter 里，iOS 上会一起失效）', !mainCtx.calls.filters.some((f) => /brightness/.test(f)), mainCtx.calls.filters.join(' | ') || '（没有用过 filter）');
    void iOSbg;

    canvases.length = 0;
    fakeFilterWorks = true;
    const webBg = makeBackground({ width: 1920, height: 1080 }, 640, 360, { blur: 120, brightness: 0.4 });
    const webCtx = canvases[0].ctx;
    check('支持 ctx.filter 时用 blur() 且同样叠加压暗层', webCtx.calls.filters.includes('blur(120px)') && webCtx.calls.fillRect === 1, webCtx.calls.filters.join(' | '));
    void webBg;
  } finally {
    globalThis.document.createElement = prevCreate;
  }
}

import { hasSample, skipSample } from './samples.mjs';

const SAMPLES_OK = hasSample('official') && hasSample('rpe');
if (!SAMPLES_OK) skipSample('渲染调用（示例谱）');
if (SAMPLES_OK) {
console.log('\n== 渲染调用（官方谱） ==');
const officialRaw = JSON.parse(fs.readFileSync('packages/白复生 AT（官方格式）'.replace('官方格式', 'official格式') + '/Chart_AT #3649.json', 'utf8'));
const official = prepareChart(parseOfficialChart(officialRaw));
const canvas = makeCanvas();
const renderer = createCanvasRenderer(canvas, textures);
renderer.resize(1280, 720);
renderer.setBackground({ width: 1920, height: 1080 });
const state = createState(official);
// 找一个音符密集的时刻
const t = official.notes[Math.floor(official.notes.length * 0.35)].timeSec;
evaluate(state, t);
advanceJudging(state, t);
const visibleNotes = official.notes.filter((n) => n.visible).length;
renderer.draw(state, []);
check('resize 后画布尺寸按 dpr 设置', canvas.width === 1280 && canvas.height === 720);
check('绘制时调用了 drawImage（背景/判定线/音符）', calls.drawImage > 0, `drawImage=${calls.drawImage}`);
check('save/restore 配平', calls.save > 0 && calls.save === calls.restore, `save=${calls.save} restore=${calls.restore}`);
check('存在可见音符时确实绘制了音符', visibleNotes > 0 && calls.drawImage >= visibleNotes, `可见 ${visibleNotes} 个，drawImage=${calls.drawImage}`);
check('判定线按颜色绘制（fillRect 或贴图）', calls.fillRect > 0 || calls.drawImage > 0);

console.log('\n== 判定线着色（扩展事件 color） ==');
{
  // 有 color 事件时判定线**完全按事件颜色**（不再显示为 AP 金 / FC 蓝 / 白），
  // 且线段两端颜色不同时改用线性渐变
  const chart = prepareChart(
    parseRpeChart({
      META: { RPEVersion: 140, offset: 0 },
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      judgeLineList: [
        {
          Name: 'color',
          Texture: 'line.png',
          eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }],
          extended: { colorEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: [255, 255, 255], end: [255, 0, 0], easingType: 1 }] },
          notes: [],
        },
      ],
    }),
  );
  const st = createState(chart);
  evaluate(st, 2);
  check('有 color 事件：这一帧判定线用事件颜色', st.lines[0].useExtColor === true && st.lines[0].extColor.join(',') === '255,128,128', `extColor=${st.lines[0].extColor}`);
  const before = drawCalls.length;
  renderer.draw(st, []);
  const lineFill = drawCalls.slice(before).filter((c) => c.kind === 'fillRect').pop();
  check(
    '判定线用事件颜色填充（不再用判定金/蓝/白）',
    lineFill?.fillStyle?.kind === 'linear-gradient' && JSON.stringify(lineFill.fillStyle.stops?.[0]) === JSON.stringify([0, 'rgb(255,128,128)']),
    `fillStyle=${JSON.stringify(lineFill?.fillStyle?.stops?.[0])}`,
  );
  check('渐变区间画成线性渐变（两端颜色 = 事件起止色）', !!lineFill?.fillStyle?.kind, '');
  check(
    '渐变端点色正确（当前 128 → 末端 0）',
    JSON.stringify(lineFill?.fillStyle?.stops) === JSON.stringify([
      [0, 'rgb(255,128,128)'],
      [1, 'rgb(255,0,0)'],
    ]),
    JSON.stringify(lineFill?.fillStyle?.stops),
  );

  // 常色线段（该段起止色相同）退回纯色填充：不必要地每帧建渐变只增加开销
  const solidChart = prepareChart(
    parseRpeChart({
      META: { RPEVersion: 140, offset: 0 },
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      judgeLineList: [
        {
          Name: 'solid',
          Texture: 'line.png',
          eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }],
          extended: {
            colorEvents: [
              { startTime: [0, 0, 1], endTime: [4, 0, 1], start: [255, 255, 255], end: [255, 0, 0], easingType: 1 },
              { startTime: [4, 0, 1], endTime: [8, 0, 1], start: [0, 200, 255], end: [0, 200, 255], easingType: 1 },
            ],
          },
          notes: [],
        },
      ],
    }),
  );
  const stSolid = createState(solidChart);
  evaluate(stSolid, 5); // 落在第二段（常色）内部
  const before3 = drawCalls.length;
  renderer.draw(stSolid, []);
  const solidFill = drawCalls.slice(before3).filter((c) => c.kind === 'fillRect').pop();
  check(
    '常色线段用纯色（不建渐变）',
    stSolid.lines[0].useExtColor === true && solidFill?.fillStyle === 'rgb(0,200,255)',
    `fillStyle=${solidFill?.fillStyle}`,
  );

  // 没有 color 事件的线：保持判定色（全 Perfect → 金）
  const plain = prepareChart(
    parseRpeChart({
      META: { RPEVersion: 140, offset: 0 },
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      judgeLineList: [{ Name: 'plain', Texture: 'line.png', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
    }),
  );
  const stPlain = createState(plain);
  evaluate(stPlain, 1);
  const before2 = drawCalls.length;
  renderer.draw(stPlain, []);
  const plainFill = drawCalls.slice(before2).filter((c) => c.kind === 'fillRect').pop();
  check(
    '没有 color 事件：判定线仍用判定色',
    stPlain.lines[0].useExtColor === false && /^rgb\(/.test(String(plainFill?.fillStyle ?? '')) && plainFill.fillStyle !== 'rgb(255,255,255)',
    `fillStyle=${plainFill?.fillStyle}`,
  );
}

console.log('\n== 渲染调用（RPE 谱 + 打击特效） ==');
const rpeRaw = JSON.parse(fs.readFileSync('packages/领土战争AT（RPE格式）/29519800.json', 'utf8'));
const rpe = prepareChart(parseRpeChart(rpeRaw));
const canvas2 = makeCanvas();
const renderer2 = createCanvasRenderer(canvas2, textures);
renderer2.resize(1920, 1080);
const state2 = createState(rpe);
const t2 = rpe.notes[Math.floor(rpe.notes.length * 0.5)].timeSec;
evaluate(state2, t2);
const hits = advanceJudging(state2, t2);
// 收集一批特效（模拟 0.3s 内连续判定）
const fx = [...hits];
for (let dt = 0.05; dt <= 0.3; dt += 0.05) {
  evaluate(state2, t2 + dt);
  fx.push(...advanceJudging(state2, t2 + dt));
}
const before = calls.drawImage;
renderer2.draw(state2, fx);
check('RPE 谱绘制无异常', calls.drawImage > before, `新增 drawImage=${calls.drawImage - before}`);
check('打击特效被绘制（42 帧图集）', fx.length > 0 && calls.drawImage > before, `特效 ${fx.length} 个`);

console.log('\n== 投影与拾取（制谱器接入点） ==');
{
  const proj = createProjection(1280, 720); // 正好 16:9：不留边
  check('16:9 画布不须留边', near(proj.areaW, 1280, 1e-9) && near(proj.areaH, 720, 1e-9) && near(proj.cx, 640, 1e-9), `areaW=${proj.areaW}`);
  const wide = createProjection(2000, 720);
  check('超宽画布左右留边', wide.areaW === 1280 && near(wide.cx, 1000, 1e-9), `areaW=${wide.areaW} cx=${wide.cx}`);
  const back = { x: proj.toWorldX(proj.toScreenX(0.31)), y: proj.toWorldY(proj.toScreenY(-0.22)) };
  check('世界 ↔ 屏幕可逆', near(back.x, 0.31, 1e-9) && near(back.y, -0.22, 1e-9), `(${back.x.toFixed(4)}, ${back.y.toFixed(4)})`);

  // 与渲染器共用同一投影：点选应能命中刚被绘制的音符
  const renderer3 = createCanvasRenderer(makeCanvas(), textures);
  renderer3.resize(1280, 720);
  const state3 = createState(official);
  const t3 = official.notes[Math.floor(official.notes.length * 0.35)].timeSec;
  evaluate(state3, t3);
  const target = official.notes.find((n) => n.visible && n.type !== 'hold');
  const tr = renderer3.projection.noteTransform(target, state3.lines[target.lineId], { noteWidthRatio: renderer3.opts.noteWidthRatio });
  const hit = renderer3.pickNote(state3, tr.x, tr.y, 6);
  check('pickNote 命中目标音符', hit?.note === target, hit ? `类型 ${hit.note.type}` : '未命中');
  check('pickNote 在远处应返回 null', renderer3.pickNote(state3, tr.x + 500, tr.y + 300, 6) === null);
  const lineHit = renderer3.pickLine(state3, renderer3.projection.toScreenX(state3.lines[0].worldX), renderer3.projection.toScreenY(state3.lines[0].worldY), 8);
  check('pickLine 命中判定线', lineHit?.index === 0, lineHit ? `线 ${lineHit.index}` : '未命中');
  const seg = renderer3.projection.lineSegment(state3.lines[0]);
  check('lineSegment 返回两端点', near(Math.hypot(seg[0].x - seg[1].x, seg[0].y - seg[1].y), 5.76 * 720, 1e-6));
  void pickNote;
  void pickLine;
}

}
console.log('\n== Hold 绘制几何（头尾帽不得被拉长；HL 光效不得计入本体） ==');
{
  // 合成谱面：一个长 Hold、一个极短 Hold；bpm 60、速度 1 Y/s
  const mk = (holdBeats, name) => ({
    META: { RPEVersion: 163, offset: 0, name },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      {
        Name: name,
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [
          {
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [16, 0, 1], start: 255, end: 255, easingType: 1 }],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [16, 0, 1], start: 1.8, end: 1.8 }],
          },
        ],
        notes: [
          { type: 2, above: 1, startTime: [4, 0, 1], endTime: [4 + holdBeats, 0, 1], positionX: 0, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
        ],
      },
    ],
  });

  const measure = (holdBeats, noteWidthRatio) => {
    const chart = prepareChart(parseRpeChart(mk(holdBeats, `hold-${holdBeats}`)));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = noteWidthRatio;
    r.resize(1280, 720);
    evaluate(st, 3.5);
    const note = chart.notes[0];
    // 该音符的几何长度（屏幕像素）
    const dyScale = 0.6 * 720;
    const geometric = Math.abs((note.tailY - note.headY) * dyScale);
    drawCalls.length = 0;
    r.draw(st, []);
    const slices = drawCalls.filter((c) => !c.full && c.tex === textures.hold);
    const bodyTotal = slices.reduce((a, c) => a + c.dh, 0);
    const widestDest = Math.max(...slices.map((c) => c.dw));
    return { note, geometric, slices, bodyTotal, widestDest, ratio: noteWidthRatio };
  };

  const long = measure(4, 1 / 8); // 4 拍 = 4 秒
  check('长 Hold：主体 + 头尾帽都画出来了', long.slices.length >= 3, `${long.slices.length} 段`);
  // 头尾帽与主体各重叠 1px（消除接缝），因此各段高度之和会比几何长度多出 ~2px；
  // 真正要保证的是「覆盖范围恰好等于几何长度」。
  const coverTop = Math.min(...long.slices.map((c) => c.dy));
  const coverBottom = Math.max(...long.slices.map((c) => c.dy + c.dh));
  check(
    '长 Hold：绘制覆盖范围 = 几何长度（不多不少）',
    Math.abs(Math.abs(coverBottom - coverTop) - long.geometric) <= 0.6,
    `覆盖 ${Math.abs(coverBottom - coverTop).toFixed(1)}px vs 几何 ${long.geometric.toFixed(1)}px`,
  );
  check(
    '长 Hold：切片之间有 1px 重叠（避免接缝），总高略大于几何长度',
    long.bodyTotal > long.geometric - 0.01 && long.bodyTotal <= long.geometric + 2.5,
    `各段之和 ${long.bodyTotal.toFixed(1)}px vs 几何 ${long.geometric.toFixed(1)}px`,
  );
  const mid = long.slices.reduce((a, c) => (c.dh > a.dh ? c : a), long.slices[0]);
  const capMax = Math.max(...long.slices.filter((c) => c !== mid).map((c) => c.dh));
  check(
    '长 Hold：中段占主体（头尾帽合计 < 30% 长度）',
    (long.slices.reduce((a, c) => a + c.dh, 0) - mid.dh) / long.bodyTotal < 0.3,
    `中段 ${mid.dh.toFixed(1)}px，帽合计 ${(long.bodyTotal - mid.dh).toFixed(1)}px，单帽上限 ${capMax.toFixed(1)}px`,
  );
  check(
    '长 Hold：头尾帽按「源 48px × 缩放」取固定高度，不随长度放大',
    Math.abs(capMax - 48 * (1280 / 8) / textures.hold.__meta.core.w) <= 1,
    `帽高 ${capMax.toFixed(2)}px（源 48px × ${((1280 / 8) / textures.hold.__meta.core.w).toFixed(4)}）`,
  );
  check('长 Hold：帽高不随长度变化（4s 与 8s 相同）', (() => {
    const longer = measure(8, 1 / 8);
    const caps2 = longer.slices.filter((c) => c.sh === 48);
    return caps2.length === 2 && Math.abs(caps2[0].dh - capMax) <= 0.01;
  })());

  const short = measure(0.05, 1 / 8); // 0.05 拍 ≈ 50ms
  check('极短 Hold：不会出现负/零高度的中段', short.slices.every((c) => c.dh > 0) && short.slices.every((c) => c.dh <= short.geometric + 2.01));
  check(
    '极短 Hold：覆盖范围仍等于几何长度',
    Math.abs(Math.abs(Math.max(...short.slices.map((c) => c.dy + c.dh)) - Math.min(...short.slices.map((c) => c.dy))) - short.geometric) <= 0.6,
    `覆盖 ${Math.abs(Math.max(...short.slices.map((c) => c.dy + c.dh)) - Math.min(...short.slices.map((c) => c.dy))).toFixed(3)}px vs 几何 ${short.geometric.toFixed(3)}px`,
  );

  // HL 与普通贴图：本体宽度都必须等于设定宽度（光效只能溢出到本体之外）
  const wide = measure(4, 1 / 8);
  const expectWidth = (1 / 8) * 1280;
  check(
    '本体宽度 = 设定音符宽度（普通 Hold）',
    Math.abs((wide.widestDest * textures.hold.__meta.core.w) / textures.hold.width - expectWidth) <= 0.5,
    `本体宽 ${((wide.widestDest * 987) / 989).toFixed(2)}px vs 设定 ${expectWidth}px`,
  );
  const hlSlices = [];
  {
    const chart = prepareChart(parseRpeChart(mk(4, 'hl-hold')));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.opts.multiHint = true;
    r.resize(1280, 720);
    evaluate(st, 3.5);
    chart.notes[0].isMulti = true; // 强制走 HL 贴图
    drawCalls.length = 0;
    r.draw(st, []);
    hlSlices.push(...drawCalls.filter((c) => !c.full && c.tex === textures.holdHL));
  }
  const hlCore = textures.holdHL.__meta.core;
  // 本体切片：源行完全落在 core 之内；其余是补画在本体之外的光效条
  const hlBodySlices = hlSlices.filter((c) => c.sy >= hlCore.y - 0.5 && c.sy + c.sh <= hlCore.y + hlCore.h + 0.5);
  check('HL Hold：本体三段 + 光效条（光效单独绘制）', hlBodySlices.length >= 3 && hlSlices.length > hlBodySlices.length, `本体 ${hlBodySlices.length} 段 / 共 ${hlSlices.length} 段`);
  const hlBody = hlBodySlices.reduce((a, c) => a + c.dh, 0);
  const hlWidest = Math.max(...hlSlices.map((c) => c.dw));
  check(
    'HL 光效不计入本体：本体宽度仍 = 设定宽度',
    Math.abs((hlWidest * textures.holdHL.__meta.core.w) / textures.holdHL.width - expectWidth) <= 0.5,
    `本体宽 ${((hlWidest * 964) / 1062).toFixed(2)}px vs 设定 ${expectWidth}px`,
  );
  const hlCover =
    Math.max(...hlBodySlices.map((c) => c.dy + c.dh)) - Math.min(...hlBodySlices.map((c) => c.dy));
  check(
    'HL 光效不计入本体：本体覆盖范围 = 几何长度（光效画在体量之外）',
    Math.abs(hlCover - long.geometric) <= 0.6,
    `本体覆盖 ${hlCover.toFixed(1)}px vs 几何 ${long.geometric.toFixed(1)}px（各段之和 ${hlBody.toFixed(1)}px 含 1px 重叠）`,
  );

  // 水平位置：长条必须落在 positionX 指定的位置（曾经因为重构丢掉 localX，全被画到线中心）
  const holdLeft = (positionX, above = true) => {
    const json = mk(1, 'pos');
    json.judgeLineList[0].notes[0].positionX = positionX * 75.9375; // RPE 单位（1 X = 75.9375 RPE）
    if (!above) json.judgeLineList[0].notes = [
      { type: 2, above: 2, startTime: [4, 0, 1], endTime: [5, 0, 1], positionX: positionX * 75.9375, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
    ];
    const chart = prepareChart(parseRpeChart(json));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.resize(1280, 720);
    evaluate(st, 3.5);
    drawCalls.length = 0;
    r.draw(st, []);
    const call = drawCalls.find((c) => c.tex === textures.hold);
    return call?.dx;
  };
  // 记录的 dx 是判定线局部坐标（调用方已 translate 到线的屏幕位置），因此期望值不含 screenX
  const areaW = 1280;
  const expectLeft = (positionX, above = true) => {
    const scale = ((1 / 8) * areaW) / textures.hold.__meta.core.w;
    const localX = positionX * 0.05625 * areaW * (above ? 1 : -1);
    return localX - (textures.hold.__meta.core.x + textures.hold.__meta.core.w / 2) * scale;
  };
  check(
    '长条水平位置跟随 positionX（+4 X）',
    Math.abs(holdLeft(4) - expectLeft(4)) <= 1,
    `dx=${holdLeft(4)?.toFixed(1)} 期望 ${expectLeft(4).toFixed(1)}`,
  );
  check(
    '长条水平位置跟随 positionX（−4 X）',
    Math.abs(holdLeft(-4) - expectLeft(-4)) <= 1,
    `dx=${holdLeft(-4)?.toFixed(1)} 期望 ${expectLeft(-4).toFixed(1)}`,
  );
  check(
    '背面长条的水平位置镜像',
    Math.abs(holdLeft(4, false) - expectLeft(4, false)) <= 1,
    `dx=${holdLeft(4, false)?.toFixed(1)} 期望 ${expectLeft(4, false).toFixed(1)}`,
  );

  // ── （伪）3D：下落面倾斜时，长条按「沿下落方向逐行投影」画成梯形 ──
  {
    const { createProjection } = await import('../src/render/projection.js');
    const mkTilt = (thetaDeg, { rotateDeg = 0, holdBeats = 4 } = {}) => {
      const json = mk(holdBeats, `tilt-${thetaDeg}-${rotateDeg}`);
      json.judgeLineList[0].extended = {
        thetaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: thetaDeg, end: thetaDeg, easingType: 1 }],
      };
      if (rotateDeg) {
        json.judgeLineList[0].eventLayers[0].rotateEvents = [
          { startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: rotateDeg, end: rotateDeg, easingType: 1 },
        ];
      }
      return json;
    };
    /**
     * 渲染一次并收集长条的分段。
     *
     * 新画法（判定线没旋转）每段**一次裁剪 + 一次仿射**：裁剪多边形就是这一段的精确四边形
     * （四个角都是投影出来的），段边界落在**设备像素整数 y** 上 —— 相邻段共用同一条边界，
     * 抗锯齿覆盖是 0/1 判定，因此不会留缝（真浏览器实测：边界落在 y=200 时覆盖 255，
     * 落在 200.5 时只有 191）。
     * 旧画法（判定线被旋转时回退）每行按贴图横向结构拆块、每块两个裁剪三角形。
     * 这里两种形状都按「局部 y 区间」归成一段，再用每个角反解回判定线局部坐标来断言几何。
     */
    const holdRows = (thetaDeg, opts) => {
      const chart = prepareChart(parseRpeChart(mkTilt(thetaDeg, opts)));
      const st = createState(chart);
      const r = createCanvasRenderer(makeCanvas(), textures);
      r.opts.noteWidthRatio = 1 / 8;
      r.resize(1280, 720);
      evaluate(st, 3.5);
      if (opts?.hl) chart.notes[0].isMulti = true; // 多押 → HL 贴图（本体左右各有一圈 48px 光效）
      drawCalls.length = 0;
      r.draw(st, []);
      const note = chart.notes[0];
      const line = st.lines[0];
      const view = createProjection(1280, 720);
      const invOpts = { noteWidthRatio: 1 / 8, camera: st.camera, focalH: r.opts.zFocalH };
      const tex = opts?.hl ? textures.holdHL : textures.hold;
      const calls = drawCalls.filter((c) => !c.full && c.tex === tex);
      const groups = new Map();
      const localXs = new Set();
      const clipSizes = new Set();
      const fullWidth = calls.every((c) => c.sx === 0 && c.sw === tex.width);
      for (const c of calls) {
        const clip = c.clip ?? [];
        if (clip.length < 3) continue;
        clipSizes.add(clip.length);
        const pts = clip.map((p) => ({ ...p, ...view.toLineChart(note, line, p.x, p.y, invOpts) }));
        for (const p of pts) localXs.add(p.localX.toFixed(4));
        const y0 = Math.min(...pts.map((p) => p.localY0));
        const y1 = Math.max(...pts.map((p) => p.localY0));
        const key = `${y0.toFixed(4)}|${y1.toFixed(4)}`;
        const g = groups.get(key) ?? { pts: [], y0, y1, clips: 0, devY: new Set() };
        g.pts.push(...pts);
        g.clips++;
        for (const p of clip) g.devY.add(p.y.toFixed(6));
        groups.set(key, g);
      }
      const rows = [];
      for (const g of [...groups.values()]) {
        const left = Math.min(...g.pts.map((p) => p.localX));
        const right = Math.max(...g.pts.map((p) => p.localX));
        const pick = (lx, ly) => g.pts.find((p) => Math.abs(p.localX - lx) < 1e-6 && Math.abs(p.localY0 - ly) < 1e-6);
        const tl = pick(left, g.y0);
        const tr = pick(right, g.y0);
        const bl = pick(left, g.y1);
        const br = pick(right, g.y1);
        if (!tl || !tr || !bl || !br) continue;
        rows.push({
          tl,
          tr,
          bl,
          br,
          y0: g.y0,
          y1: g.y1,
          cx: (tl.x + br.x) / 2,
          cy: (tl.y + br.y) / 2,
          scaledW: Math.hypot(tr.x - tl.x, tr.y - tl.y), // 该段**上边**在屏幕上的宽度
          scaledH: Math.hypot(bl.x - tl.x, bl.y - tl.y),
          kTop: tl.k,
          kBottom: bl.k,
          clips: g.clips,
          devY: [...g.devY],
        });
      }
      rows.sort((a, b) => a.y0 - b.y0);
      const o = { noteWidthRatio: 1 / 8 };
      const headT = view.noteTransform(note, line, { ...o, distY: note.headY ?? note.distY });
      const tailT = view.noteTransform(note, line, { ...o, distY: note.tailY ?? note.headY ?? note.distY });
      return {
        calls,
        rows,
        localXCount: localXs.size,
        clipSizes: [...clipSizes],
        fullWidth,
        note,
        line,
        headT,
        tailT,
        view,
        stats: r.stats,
      };
    };

    const flat = holdRows(0);
    const tilt = holdRows(30);
    check(
      'θ = 0：长条仍走原来的单次变换（按切片画，不分段、不加裁剪）',
      flat.calls.length <= 5 && flat.calls.every((c) => !c.clip) && flat.rows.length === 0,
      `${flat.calls.length} 段，裁剪 ${flat.calls.filter((c) => c.clip).length} 段`,
    );
    check(
      'θ = 30°：按设备整数 y 分段，每段一次四边形裁剪 + 一次仿射（不再拆三角形、不再拆横向分块）',
      tilt.rows.length >= 2 &&
        tilt.stats.holdRowsDrawn === tilt.rows.length &&
        tilt.calls.length === tilt.rows.length &&
        tilt.clipSizes.length === 1 &&
        tilt.clipSizes[0] === 4 &&
        tilt.rows.every((row) => row.clips === 1) &&
        tilt.localXCount === 2 &&
        tilt.fullWidth,
      `${tilt.rows.length} 段 × 1 次 drawImage（裁剪 ${tilt.clipSizes.join('/')} 点）/ 本地竖边界 ${tilt.localXCount} 条（θ=0 时 ${flat.calls.length} 段）`,
    );
    // **接缝 invariant**：内部段边界全部落在设备整数 y 上（长条自身的两端不吸附，是轮廓边）
    const boundaryYs = [...new Set(tilt.rows.flatMap((row) => row.devY))].map(Number).sort((a, b) => a - b);
    const innerYs = boundaryYs.slice(1, -1);
    const allInt = innerYs.every((y) => Math.abs(y - Math.round(y)) < 1e-6);
    const contiguous = boundaryYs.length === tilt.rows.length + 1 && boundaryYs.every((y, i) => i === 0 || y > boundaryYs[i - 1]);
    const maxGap = Math.max(...boundaryYs.slice(1).map((y, i) => y - boundaryYs[i]));
    check(
      '缝的根因：段边界全部落在设备整数 y 上（共享边覆盖互补，实测非整数边界会掉 25% 覆盖）',
      allInt && contiguous && maxGap <= 4 + 1e-6,
      `${boundaryYs.length} 条边界（内部 ${innerYs.length} 条全部为整数 ${allInt}），相邻最大间距 ${maxGap.toFixed(2)}px（段高 4）`,
    );
    // 横向不分块：HL 贴图（本体左右各一圈光效）与普通贴图走同一条路径
    const hl = holdRows(30, { hl: true });
    check(
      'HL 贴图（双押）与普通贴图同一条路径：整幅横向铺满，本体边缘天然落在精确角上',
      hl.rows.length >= 2 &&
        hl.calls.length === hl.rows.length &&
        hl.localXCount === 2 &&
        hl.fullWidth &&
        hl.clipSizes.length === 1 &&
        hl.clipSizes[0] === 4,
      `${hl.rows.length} 段 / 本地竖边界 ${hl.localXCount} 条 / 横向铺满 ${hl.fullWidth}`,
    );
    const longHold = holdRows(30, { holdBeats: 24 });
    const shortHold = holdRows(30, { holdBeats: 0.5 });
    check(
      '段数跟着「屏幕上露出的长度」走：长条封顶不再增长，短条只画少数段',
      longHold.stats.holdRowsPlanned <= tilt.stats.holdRowsPlanned + 8 &&
        shortHold.stats.holdRowsPlanned > 0 &&
        shortHold.stats.holdRowsPlanned < tilt.stats.holdRowsPlanned &&
        tilt.stats.holdRowsPlanned < 400,
      `长 ${longHold.stats.holdRowsPlanned} 段 / 中 ${tilt.stats.holdRowsPlanned} 段 / 短 ${shortHold.stats.holdRowsPlanned} 段`,
    );
    // 屏幕外的部分不画：绘制范围只比画布多出 8px 余量
    const offTop = Math.min(...tilt.rows.map((row) => Math.min(row.tl.y, row.tr.y, row.bl.y, row.br.y)));
    const offBottom = Math.max(...tilt.rows.map((row) => Math.max(row.tl.y, row.tr.y, row.bl.y, row.br.y)));
    const maxRowH = Math.max(...tilt.rows.map((row) => row.scaledH));
    check(
      '屏幕外的整段不画（绘制范围只多出 8px 余量 + 一段）',
      tilt.stats.holdCulled > 0 && offTop >= -(maxRowH + 8.5) && offBottom <= 720 + maxRowH + 8.5,
      `剔除 ${tilt.stats.holdCulled} 段（计划 ${tilt.stats.holdRowsPlanned} / 实画 ${tilt.stats.holdRowsDrawn}）；绘制范围 y ${offTop.toFixed(1)} ~ ${offBottom.toFixed(1)}（最高一段 ${maxRowH.toFixed(1)}px）`,
    );
    check(
      '被剔除的确实是屏幕外的部分（长条远端已经跑到画面外）',
      [tilt.headT, tilt.tailT].some((t) => t.y < -8 || t.y > 728),
      `头 ${tilt.headT.y.toFixed(0)} / 尾 ${tilt.tailT.y.toFixed(0)}`,
    );
    // **四个角都是精确投影**：反解回判定线局部坐标后，局部 x 只有「左边 / 右边」两个取值，
    // 局部 y 只有「上边 / 下边」两个取值（也就是每块就是那个本地矩形[列 × 切片]的真实投影）
    const leftX = tilt.rows[0].tl.localX;
    const rightX = tilt.rows[0].tr.localX;
    const localXSpread = Math.abs(rightX - leftX);
    const gridErr = Math.max(
      ...tilt.rows.flatMap((row) =>
        [row.tl, row.bl, row.tr, row.br].map((c) => Math.min(Math.abs(c.localX - leftX), Math.abs(c.localX - rightX))),
      ),
    );
    check(
      '四个角严格落在（左|右）×（上|下）网格上（局部坐标反解，误差 < 1e-6px）',
      localXSpread > 1 && gridErr < 1e-6,
      `左右 ${leftX.toFixed(2)} / ${rightX.toFixed(2)}，最大偏差 ${gridErr.toExponential(2)}px`,
    );
    // **没有锯齿台阶**：每块的四条边都是直线，串起来仍是一条直线（真实投影的边界就是直线）
    const lineDev = (pts) => {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return Math.max(...pts.map((p) => Math.abs(((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len)));
    };
    const sortedQuads = [...tilt.rows].sort((a, b) => a.y0 - b.y0);
    const leftEdge = [...sortedQuads.map((row) => row.tl), sortedQuads[sortedQuads.length - 1].bl];
    const rightEdge = [...sortedQuads.map((row) => row.tr), sortedQuads[sortedQuads.length - 1].br];
    check(
      '左右两条边界各是一条直线（各切片的角串起来最大偏离 < 1px → 没有锯齿台阶）',
      lineDev(leftEdge) < 1 && lineDev(rightEdge) < 1,
      `左边界偏离 ${lineDev(leftEdge).toExponential(2)}px / 右边界 ${lineDev(rightEdge).toExponential(2)}px`,
    );
    // 每块上边宽度 = 该处 k × 音符宽（z = 0 空间）：所有块算出来的「本地宽度」必须一致
    const localWidths = tilt.rows.map((row) => row.scaledW / row.kTop);
    const widthSpread = Math.max(...localWidths) - Math.min(...localWidths);
    check(
      '每块上边宽度 / 该处 k = 同一个「本地宽度」（与投影公式一致，误差 < 1e-6px）',
      widthSpread < 1e-6,
      `本地宽度 ${Math.min(...localWidths).toFixed(4)} ~ ${Math.max(...localWidths).toFixed(4)}px`,
    );
    // 按「离判定线的远近」排序：近端（贴线）应当最宽，远端最窄 → 梯形
    const centerY = 720 / 2; // 判定线在画面中心（worldY = 0）
    const sorted = [...tilt.rows].sort((a, b) => Math.abs(a.cy - centerY) - Math.abs(b.cy - centerY));
    const widest = sorted[0];
    const narrowest = sorted[sorted.length - 1];
    check(
      '倾斜后长条呈梯形：贴线一端最宽、远端最窄',
      widest.scaledW > narrowest.scaledW * 1.05,
      `近端 ${widest.scaledW.toFixed(1)}px → 远端 ${narrowest.scaledW.toFixed(1)}px`,
    );
    // 宽度比 = 两端各自的深度缩放比（k 由反解得到，不是渲染时用的那条路径）
    check(
      '梯形两端的宽度比 = 两端各自的透视缩放比（与投影公式一致）',
      Math.abs(widest.scaledW / narrowest.scaledW - widest.kTop / narrowest.kTop) < 0.02,
      `实测 ${(widest.scaledW / narrowest.scaledW).toFixed(4)} vs 期望 ${(widest.kTop / narrowest.kTop).toFixed(4)}`,
    );
    check(
      '倾斜后长条的纵向长度按 cosθ 缩短（贴图压扁）',
      offBottom - offTop < long.geometric,
      `${(offBottom - offTop).toFixed(1)}px vs 平放 ${long.geometric.toFixed(1)}px`,
    );
    // 判定线转 90° 时，倾斜带来的「横向偏移」必须体现出来（远端沿线的长轴方向偏出去）
    const rot = holdRows(30, { rotateDeg: 90 });
    const rotSorted = [...rot.rows].sort((a, b) => Math.abs(a.cx - 640) - Math.abs(b.cx - 640));
    const rotNear = Math.abs(rotSorted[0].cx - 640);
    const rotFar = Math.abs(rotSorted[rotSorted.length - 1].cx - 640);
    check(
      '线转 90° 后倾斜：远端沿线的长轴方向横向偏移（近端贴线不动）',
      rotFar > rotNear + 5,
      `近端 |Δx| ${rotNear.toFixed(1)}px / 远端 ${rotFar.toFixed(1)}px`,
    );
    // 头尾帽也各按自己那一端的 k 缩放（远端帽更小）
    check(
      '头尾帽各自按自己那一端的透视缩放（远端帽更小）',
      sorted.every((c, i) => i === 0 || c.scaledW <= sorted[i - 1].scaledW + 0.01),
      sorted.map((c) => c.scaledW.toFixed(1)).join(' → '),
    );
  }

  // 硬编码分段：48px 头尾帽 + 48px 光效（源像素），主体 = 中间区间
  const segCheck = (tex, label) => {
    const chart = prepareChart(parseRpeChart(mk(4, `seg-${label}`)));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.resize(1280, 720);
    evaluate(st, 3.5);
    if (label === 'HL') chart.notes[0].isMulti = true;
    drawCalls.length = 0;
    r.draw(st, []);
    const calls = drawCalls.filter((c) => !c.full && c.tex === tex);
    const meta = tex.__meta;
    const insideCore = (c) => c.sy >= meta.core.y && c.sy + c.sh <= meta.core.y + meta.core.h;
    const caps = calls.filter((c) => c.sh === 48 && insideCore(c));
    const body = calls.filter((c) => c.sh === segCheckBody(meta) && insideCore(c));
    return { calls, caps, body, meta };
  };
  const segCheckBody = (meta) => meta.core.h - 96;
  for (const [tex, label, scale] of [
    [textures.hold, '普通', (1280 / 8) / textures.hold.__meta.core.w],
    [textures.holdHL, 'HL', (1280 / 8) / textures.holdHL.__meta.core.w],
  ]) {
    const res = segCheck(tex, label);
    check(
      `${label} Hold：头尾帽源高度 = 48px（硬编码）`,
      res.caps.length === 2 && res.caps.every((c) => c.sh === 48),
      `帽切片 ${res.caps.map((c) => `sh=${c.sh}`).join(',')}`,
    );
    check(
      `${label} Hold：帽的目标高度 = 48 × 缩放（固定）`,
      res.caps.every((c) => Math.abs(c.dh - 48 * scale) <= 1),
      `帽高 ${res.caps.map((c) => c.dh.toFixed(2)).join(',')}px（48×${scale.toFixed(4)}=${(48 * scale).toFixed(2)}）`,
    );
    check(
      `${label} Hold：主体源区间 = [core+48, core+coreH-48]（与帽严丝合缝，不漏源行）`,
      res.body.length === 1 && res.body[0].sy === res.meta.core.y + 48 && res.body[0].sh === res.meta.core.h - 96,
      `sy=${res.body[0]?.sy} sh=${res.body[0]?.sh}（core.y=${res.meta.core.y} core.h=${res.meta.core.h}）`,
    );
  }
  const hlSeg = textures.holdHL.__meta.segments;
  check(
    'HL Hold：上下各 48px 光效（补画在体量之外）',
    hlSeg.glowTop === 48 && hlSeg.glowBottom === 48,
    JSON.stringify(hlSeg),
  );
  check(
    '长条分段不经过任何运行时识别（贴图表里硬编码）',
    textures.hold.__meta.segments.capTop === 48 && !('detected' in textures.hold.__meta),
    JSON.stringify(textures.hold.__meta.segments),
  );

  // 短音符（Tap / TapHL）：本体宽度一致，HL 只是多出光效
  const tapWidth = (optsKey) => {
    const chart = prepareChart(parseOfficialChart({
      formatVersion: 3,
      offset: 0,
      judgeLineList: [{
        bpm: 60,
        notesAbove: [{ type: 1, time: 256, positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 }],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      }],
    }));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.resize(1280, 720);
    evaluate(st, 7.9);
    if (optsKey === 'tapHL') chart.notes[0].isMulti = true;
    drawCalls.length = 0;
    r.draw(st, []);
    const tex = textures[optsKey];
    const call = drawCalls.find((c) => c.tex === tex);
    return call ? (call.dw * tex.__meta.core.w) / tex.width : NaN;
  };
  check('Tap 与 TapHL 的本体宽度一致（HL 不会大一圈）', Math.abs(tapWidth('tap') - tapWidth('tapHL')) <= 0.5, `${tapWidth('tap').toFixed(2)} vs ${tapWidth('tapHL').toFixed(2)}`);
}

// 说明：长条分段已按需求改为**硬编码**（TEXTURE_TRIM.hold/holdHL 的 segments：48px 帽 + 48px 光效），
// 不再做任何运行时识别；相应断言见上面「Hold 绘制几何」小节。

console.log('\n== 判定范围叠加层：跟随判定模式（垂直判定 = 2D 列 / 轨道判定 = 楔形） ==');
{
  // 一张带倾斜的合成谱面：一条线 + 一个偏离中心的音符（positionX = -4）
  const mkTiltChart = (thetaDeg, positionX = -300) => ({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      {
        Name: 'range',
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [
          {
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 1, end: 1 }],
          },
        ],
        extended: thetaDeg
          ? { thetaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: thetaDeg, end: thetaDeg, easingType: 1 }] }
          : undefined,
        notes: [
          { type: 1, above: 1, startTime: [2, 0, 1], endTime: [2, 0, 1], positionX, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
        ],
      },
    ],
  });
  /** 渲染一帧，取出叠加层画出的多边形（每帧每音符一个 fill 路径） */
  const ranges = (mode, thetaDeg) => {
    const chart = prepareChart(parseRpeChart(mkTiltChart(thetaDeg)));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.opts.showJudgeRange = true;
    r.opts.judgeRangeMode = mode;
    r.resize(1280, 720);
    evaluate(st, 2.0);
    drawCalls.length = 0;
    r.draw(st, []);
    const paths = drawCalls.filter((c) => c.kind === 'path' && c.op === 'fill');
    const polygon = paths[0]?.points ?? [];
    const n = polygon.length;
    // points = 左边界由近到远 + 右边界由远到近 → 近端 = 首尾两点、远端 = 中间两点
    const width = (a, b) => Math.hypot(polygon[a].x - polygon[b].x, polygon[a].y - polygon[b].y);
    return { paths, polygon, near: n ? width(0, n - 1) : 0, far: n ? width(n / 2 - 1, n / 2) : 0 };
  };

  const tilt = ranges('tilt', 30);
  const band = ranges('band', 30);
  const flatTilt = ranges('tilt', 0);
  check('轨道判定：叠加层画成多边形（沿下落方向采样 13 段 → 26 个顶点）', tilt.polygon.length === 26, `${tilt.polygon.length} 个顶点`);
  check(
    '轨道判定：范围呈楔形（远端明显比近端窄）',
    tilt.far < tilt.near * 0.85,
    `近端 ${tilt.near.toFixed(1)}px → 远端 ${tilt.far.toFixed(1)}px`,
  );
  check(
    '垂直判定：同一个音符画成等宽长条（4 个顶点、近端 = 远端）',
    band.polygon.length === 4 && Math.abs(band.far - band.near) < 1e-6,
    `${band.polygon.length} 个顶点，${band.near.toFixed(1)} → ${band.far.toFixed(1)}px`,
  );
  check(
    '两种模式画的确实不是同一条带（切换模式时叠加层会变）',
    Math.abs(band.near - tilt.near) > 5 || band.polygon.length !== tilt.polygon.length,
    `垂直 ${band.near.toFixed(1)}px / 轨道 ${tilt.near.toFixed(1)}px`,
  );
  check(
    'θ = 0 时轨道判定退化成等宽长条（与垂直判定一致）',
    Math.abs(flatTilt.far - flatTilt.near) < 1e-6,
    `${flatTilt.near.toFixed(1)} → ${flatTilt.far.toFixed(1)}px`,
  );
  check('全屏判定：不画判定范围', ranges('screen', 30).paths.length === 0);
}


console.log('\n== 命中溅射小方块（4–8 个、约特效 1/8、三次缓出、半径 = 1× 特效宽） ==');
{
  const { createState, evaluate, advanceJudging } = await import('../src/core/state.js');
  const chart = prepareChart(parseOfficialChart({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [{
      bpm: 60,
      notesAbove: [{ type: 1, time: 256, positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 }],
      notesBelow: [],
      speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
      judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
      judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
      judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
    }],
  }));
  const st = createState(chart);
  evaluate(st, 7.99);
  const hits = advanceJudging(st, 8.0);
  const r = createCanvasRenderer(makeCanvas(), textures);
  r.resize(1280, 720);
  const noteWidth = r.opts.noteWidthRatio * r.view.areaW;
  const fxSize = noteWidth * r.opts.hitFxScale;

  // 在若干时刻取「我方块的绘制调用」：fillRect 且尺寸 ≈ 特效的 1/8；距离用绝对中心计算
  const particlesAt = (age) => {
    evaluate(st, 8.0 + age);
    calls.fillRect = 0;
    drawCalls.length = 0;
    r.draw(st, hits);
    const s = fxSize * r.opts.hitParticles.sizeRatio;
    const fxCall = drawCalls.find((c) => c.tex === textures.hitPerfect);
    const particles = drawCalls
      .filter((c) => c.kind === 'fillRect' && c.w > s * 0.6 && c.w < s * 1.4 && Math.abs(c.w - c.h) < 0.01)
      .map((c) => {
        const m = /rgba\(\d+,\d+,\d+,([\d.]+)\)/.exec(String(c.fillStyle));
        return {
          ...c,
          alpha: m ? Number(m[1]) : 1,
          r: Math.hypot(c.cx - fxCall.cx, c.cy - fxCall.cy),
        };
      });
    return particles;
  };

  const early = particlesAt(0.02);
  const late = particlesAt(0.48);
  check(
    '每次命中产生 4–8 个小方块',
    early.length >= 4 && early.length <= 8,
    `${early.length} 个（尺寸约 ${(fxSize / 8).toFixed(1)}px）`,
  );
  check(
    '方块大小 ≈ 特效的 1/8（允许 ±25% 随机）',
    early.every((p) => Math.abs(p.w - fxSize / 8) <= (fxSize / 8) * 0.26),
    `尺寸 ${early.map((p) => p.w.toFixed(1)).join(',')} px，1/8 = ${(fxSize / 8).toFixed(1)}`,
  );
  check('方块半透明（rgba 的 alpha 介于 0 与 1）', early.every((p) => p.alpha > 0 && p.alpha < 1), `alpha=${early[0]?.alpha?.toFixed(2)}`);

  const maxEarly = Math.max(...early.map((p) => p.r));
  const maxLate = Math.max(...late.map((p) => p.r));
  check('溅射：随时间向外飞散', maxLate > maxEarly && maxEarly >= 0, `早期 ${maxEarly.toFixed(1)}px → 末尾 ${maxLate.toFixed(1)}px`);
  check(
    '溅射半径 ≈ 1× 特效宽度',
    maxLate <= fxSize * 1.02 && maxLate > fxSize * 0.6,
    `最远 ${maxLate.toFixed(1)}px，特效宽 ${fxSize.toFixed(1)}px`,
  );
  // 三次缓出：起始快、末尾慢 —— 取**等长时间**的四点，看位移增量递减
  const dur = r.opts.hitFxDuration;
  const rs = [0.02, 0.34, 0.66, 0.98].map((u) => Math.max(...particlesAt(u * dur).map((p) => p.r)));
  const deltas = [rs[1] - rs[0], rs[2] - rs[1], rs[3] - rs[2]];
  check(
    '速度逐渐减慢（三次缓出：开始快、末尾慢）',
    deltas[0] > deltas[1] && deltas[1] > deltas[2],
    `等长时段位移 ${deltas.map((d) => d.toFixed(1)).join(' > ')}`,
  );
  check('位置稳定（同一时刻两次绘制结果一致，不抖）', (() => {
    const a = particlesAt(0.3).map((p) => `${p.cx.toFixed(3)},${p.cy.toFixed(3)}`).join('|');
    const b = particlesAt(0.3).map((p) => `${p.cx.toFixed(3)},${p.cy.toFixed(3)}`).join('|');
    return a === b && a.length > 0;
  })());
  check(
    '特效结束时方块淡出（alpha → 0）',
    particlesAt(r.opts.hitFxDuration * 0.999).every((p) => p.alpha < 0.05),
  );
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
