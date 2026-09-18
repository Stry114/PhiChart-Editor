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
const drawCalls = []; // 记录 drawImage 的完整参数，便于断言绘制几何
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
      if (prop === 'drawImage') {
        return (...args) => {
          calls.drawImage++;
          const [tex, ...rest] = args;
          if (rest.length <= 2) obj.__lastImage = tex;
          if (rest.length >= 8) {
            const [sx, sy, sw, sh, dx, dy, dw, dh] = rest;
            drawCalls.push({ tex, sx, sy, sw, sh, dx, dy, dw, dh, alpha: obj.globalAlpha });
          } else {
            const [dx, dy, dw, dh] = rest;
            drawCalls.push({ tex, dx, dy, dw, dh, alpha: obj.globalAlpha, full: true });
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
  check('长 Hold：三段（尾帽/中段/头帽）都画出来了', long.slices.length >= 3, `${long.slices.length} 段`);
  check(
    '长 Hold：各段目标高度之和 = 几何长度（不被拉长/缩短）',
    Math.abs(long.bodyTotal - long.geometric) <= 1.5,
    `绘制 ${long.bodyTotal.toFixed(1)}px vs 几何 ${long.geometric.toFixed(1)}px`,
  );
  const mid = long.slices.reduce((a, c) => (c.dh > a.dh ? c : a), long.slices[0]);
  const capMax = Math.max(...long.slices.filter((c) => c !== mid).map((c) => c.dh));
  check(
    '长 Hold：中段占主体（头尾帽合计 < 30% 长度）',
    (long.slices.reduce((a, c) => a + c.dh, 0) - mid.dh) / long.bodyTotal < 0.3,
    `中段 ${mid.dh.toFixed(1)}px，帽合计 ${(long.bodyTotal - mid.dh).toFixed(1)}px，单帽上限 ${capMax.toFixed(1)}px`,
  );
  check('长 Hold：头尾帽尺寸固定（按源像素×缩放，约 6–32px），不随长度放大', capMax < 40, `最大帽高 ${capMax.toFixed(2)}px`);

  const short = measure(0.05, 1 / 8); // 0.05 拍 ≈ 50ms
  check('极短 Hold：不会出现负/零高度的中段', short.slices.every((c) => c.dh > 0) && short.slices.every((c) => c.dh <= short.geometric + 0.01));
  check(
    '极短 Hold：总高仍等于几何长度',
    Math.abs(short.bodyTotal - short.geometric) <= 0.5,
    `绘制 ${short.bodyTotal.toFixed(3)}px vs 几何 ${short.geometric.toFixed(3)}px`,
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
  check(
    'HL 光效不计入本体：三段总高 = 几何长度（不因左右/下侧光效变长）',
    Math.abs(hlBody - long.geometric) <= 1.5,
    `绘制 ${hlBody.toFixed(1)}px vs 几何 ${long.geometric.toFixed(1)}px`,
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

  // 取样方案：默认 tailCap 的主体应取自「偏青」区段（不出现一长段发灰发白的体）
  const sampleCheck = (mode) => {
    const chart = prepareChart(parseRpeChart(mk(4, `sample-${mode}`)));
    const st = createState(chart);
    const r = createCanvasRenderer(makeCanvas(), textures);
    r.opts.noteWidthRatio = 1 / 8;
    r.opts.holdSample = mode;
    r.resize(1280, 720);
    evaluate(st, 3.5);
    drawCalls.length = 0;
    r.draw(st, []);
    const body = drawCalls.filter((c) => !c.full && c.tex === textures.hold && c.sh > 1);
    const coreTop = textures.hold.__meta.core.y;
    const coreH = textures.hold.__meta.core.h;
    // 主体切片：源高度最大的那一段（卡口只有很小一段源高度）
    const bodySeg = body.reduce((a, c) => (c.sh > a.sh ? c : a), body[0]);
    return { body, bodyTopPct: (bodySeg.sy - coreTop) / coreH, total: body.reduce((t, c) => t + c.dh, 0) };
  };
  const tailCap = sampleCheck('tailCap');
  const gradient = sampleCheck('gradient');
  check(
    '默认取样 tailCap：主体取自贴图偏青的下半段（≥50%）',
    tailCap.bodyTopPct >= 0.5,
    `主体起始于 ${(tailCap.bodyTopPct * 100).toFixed(0)}% 处`,
  );
  check(
    'gradient 取样：主体从贴图顶部开始（保留整根渐变）',
    gradient.bodyTopPct < 0.1,
    `主体起始于 ${(gradient.bodyTopPct * 100).toFixed(0)}% 处`,
  );
  check(
    '两种取样的目标高度都等于几何长度',
    Math.abs(tailCap.total - long.geometric) <= 2 && Math.abs(gradient.total - long.geometric) <= 2,
    `${tailCap.total.toFixed(1)} / ${gradient.total.toFixed(1)} vs ${long.geometric.toFixed(1)}`,
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

console.log('\n== 资源包适配：五段式长条贴图的自动识别与切片 ==');
{
  const { detectHoldStructure, attachTextureMeta } = await import('../src/render/textures.js');
  const { computeHoldSlices } = await import('../src/render/hold-geometry.js');

  // 合成一张 [48 光效][48 帽][200 主体][48 帽][48 光效] 的贴图（宽 140，内容宽 100）
  const W = 140;
  const G = 48;
  const BODY = 200;
  const H2 = G * 4 + BODY; // 392
  const rgba = new Uint8ClampedArray(W * H2 * 4);
  const put = (y, x, r, g, b, a) => {
    const i = (y * W + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };
  for (let y = 0; y < H2; y++) {
    // 分段：光效（更宽、低 alpha）/ 帽（不透明）/ 主体（略带透明）
    const isGlow = y < G || y >= G + G + BODY + G;
    const isCap = !isGlow && (y < G + G || y >= G + G + BODY);
    const half = isGlow ? W / 2 : 50; // 光效横向外扩
    for (let x = 0; x < W; x++) {
      const inside = Math.abs(x + 0.5 - W / 2) <= half;
      if (!inside) continue;
      put(y, x, 160, 235, 255, isGlow ? 70 : isCap ? 255 : 210);
    }
  }
  const img = { width: W, height: H2, __rgba: rgba };

  const detected = detectHoldStructure(img);
  check('自动识别出 4 处台阶（光效/帽/主体/帽/光效）', !!detected && detected.steps.length === 4, detected ? `台阶 y=${detected.steps.join(',')}` : '未识别');
  check(
    '识别出的分段与设计一致（48/48/200/48/48）',
    detected &&
      detected.segments.glowTop === 48 &&
      detected.segments.capTop === 48 &&
      detected.segments.capBottom === 48 &&
      detected.segments.glowBottom === 48 &&
      detected.segments.bodyTop === 96 &&
      detected.segments.bodyBottom === 296,
    detected ? JSON.stringify(detected.segments) : '',
  );

  // 用识别结果切片：帽与光效按源像素×缩放取固定高度，主体吃满剩余长度
  const meta = attachTextureMeta(img, 'hold').__meta;
  check('attachTextureMeta 采用识别出的分段', !!meta.segments && meta.segments.capTop === 48, JSON.stringify(meta.segments ?? null));
  const scale = 160 / meta.core.w; // 目标本体宽 160px
  const total = 400;
  const slices = computeHoldSlices({ meta, headLocalY: total, tailLocalY: 0, texW: W, scale });
  const caps = slices.filter((s) => s.kind === 'cap');
  const body = slices.find((s) => s.kind === 'body');
  const glows = slices.filter((s) => s.kind === 'glow');
  check('五段齐全（2 光效 + 2 帽 + 1 主体）', caps.length === 2 && !!body && glows.length === 2, slices.map((s) => s.kind).join(','));
  check(
    '帽高 = 源 48px × 缩放（固定，不随长度放大）',
    Math.abs(caps[0].dh - 48 * scale) <= 0.01 && Math.abs(caps[1].dh - 48 * scale) <= 0.01,
    `${caps[0].dh.toFixed(2)}px（缩放 ${scale.toFixed(3)}）`,
  );
  check('帽高不随长度变化（长 400 → 长 800 时帽高不变）', (() => {
    const s2 = computeHoldSlices({ meta, headLocalY: 800, tailLocalY: 0, texW: W, scale });
    const c2 = s2.filter((s) => s.kind === 'cap');
    return Math.abs(c2[0].dh - caps[0].dh) <= 0.01;
  })());
  check(
    '本体吃满剩余长度（400 − 两帽）',
    Math.abs(body.dh - (total - caps[0].dh - caps[1].dh)) <= 0.01,
    `本体 ${body.dh.toFixed(1)}px / 总 ${total}px`,
  );
  check('本体只取主体区段（源行 96..296）', body.sy === 96 && body.sh === 200, `sy=${body.sy} sh=${body.sh}`);

  // 显式指定优先于自动识别
  const meta2 = attachTextureMeta(img, 'hold', { holdAtlas: { cap: 20, glow: 10 } }).__meta;
  check(
    '显式 holdAtlas 覆盖自动识别',
    meta2.segments.capTop === 20 && meta2.segments.capBottom === 20 && meta2.segments.glowTop === 10,
    JSON.stringify(meta2.segments),
  );

  // 尺寸不符的内置元数据必须被忽略（换资源包场景）
  const small = attachTextureMeta({ width: 120, height: 300 }, 'hold').__meta;
  check(
    '贴图尺寸与内置元数据不符时按整图处理',
    small.core.w === 120 && small.core.h === 300,
    `core=${JSON.stringify(small.core)}`,
  );
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
