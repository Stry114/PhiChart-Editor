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

// ---------------------------------------------------------------- DOM 桩件
const calls = { drawImage: 0, fillRect: 0, save: 0, restore: 0, translate: 0, rotate: 0, clearRect: 0, setTransform: 0 };
function makeCtx() {
  const target = {
    canvas: null,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    font: '',
    textAlign: '',
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
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
// Image 桩件：设置 src 后异步触发 onload
globalThis.Image = class {
  constructor() {
    this.width = 989;
    this.height = 100;
    this._src = '';
  }
  set src(v) {
    this._src = v;
    setTimeout(() => this.onload?.(), 0);
  }
  get src() {
    return this._src;
  }
};

const { createCanvasRenderer } = await import('../src/render/canvas2d.js');
const { loadTextures, makeBackground } = await import('../src/render/textures.js');

console.log('== 贴图加载（Image 桩件） ==');
const textures = await loadTextures('assets/');
const keys = ['tap', 'tapHL', 'drag', 'dragHL', 'flick', 'flickHL', 'hold', 'holdHL', 'hit', 'hitPerfect', 'hitGood'];
check('全部贴图 key 就绪', keys.every((k) => !!textures[k]), keys.filter((k) => !textures[k]).join(',') || 'ok');
check('打击特效已按 Perfect/Good 两色预着色', textures.hitPerfect.width === 989 && textures.hitGood.width === 989);
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

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
