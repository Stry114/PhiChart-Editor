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
            drawCalls.push({ kind: 'drawImage', tex, sx, sy, sw, sh, dx, dy, dw, dh, cx, cy, alpha: obj.globalAlpha });
          } else {
            const [dx, dy, dw, dh] = rest;
            const [cx, cy] = applyM(obj.__m, dx + dw / 2, dy + dh / 2);
            drawCalls.push({ kind: 'drawImage', tex, dx, dy, dw, dh, cx, cy, alpha: obj.globalAlpha, full: true });
          }
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
  const segCheckBody = (meta) => meta.core.h - 144;
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
      `${label} Hold：主体源区间 = [core+48, core+coreH-96]`,
      res.body.length === 1 && res.body[0].sy === res.meta.core.y + 48 && res.body[0].sh === res.meta.core.h - 144,
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
