// 倾斜 Hold 的渲染取舍：把「为什么要分段 / 为什么一段只能用一个仿射」量化出来。
//
// 结论（也是 src/render/canvas2d.js 里 drawTiltedHoldBands 的设计依据）：
//   1. 一段的真实形状 = 四个角精确投影出来的**四边形**：倾斜面上的一条直线投影后仍是直线
//      （下面 `boundaryLineDeviation()` 实测偏离 0.000px），所以只要四个角对，轮廓就精确。
//   2. 三点定标的仿射（drawImage 能做的）只能对上三个角，第四条边必然偏出去：
//      `affineFourthCornerError()` 给出偏差随段高的**线性**增长 —— 18px 就有 3~5px、
//      θ=70° 时 40px 以上，正好是肉眼可见的锯齿台阶。所以段高要小（现取 4 设备像素），
//      并用**精确四边形裁剪**把轮廓切准（偏差只留在贴图内部，看不出来）。
//   3. 分段仍然必要：整段贴图用一次仿射会被「拉直」（长度方向的透视丢失，远端明显不对），
//      而只靠加密段数把误差压到 0.4px 需要 300~1000 段 —— 4 设备像素是质量与开销的平衡点：
//      `rowsNeededForError()` 就是这条结论的数据。
//
// 运行：node tools/measure-tilt-hold.mjs
import { parseRpeChart } from '../src/core/parse-rpe.js';
import { prepareChart } from '../src/core/model.js';
import { createState, evaluate } from '../src/core/state.js';
import { createProjection } from '../src/render/projection.js';

const view = createProjection(1280, 720);
const areaW = view.areaW;
const noteWidthRatio = 1 / 8;
const dyScale = 0.6 * view.areaH;
const beats = (n) => [n, 0, 1];

/** 合成一条倾斜判定线 + 一个 Hold（bpm 60 → 1 拍 = 1 秒） */
const mkChart = (thetaDeg, { rotate = 0, z = 0, above = 1, holdBeats = 8, positionX = 2 } = {}) => ({
  META: { RPEVersion: 163, offset: 0, name: 'measure' },
  BPMList: [{ bpm: 60, startTime: beats(0) }],
  judgeLineList: [
    {
      Name: 'measure',
      Texture: 'line.png',
      isCover: 0,
      eventLayers: [
        {
          alphaEvents: [{ startTime: beats(0), endTime: beats(1e6), start: 255, end: 255, easingType: 1 }],
          speedEvents: [{ startTime: beats(0), endTime: beats(1e6), start: 1.5, end: 1.5, easingType: 1 }],
          rotateEvents: [{ startTime: beats(0), endTime: beats(1e6), start: rotate, end: rotate, easingType: 1 }],
        },
      ],
      extended: {
        thetaEvents: [{ startTime: beats(0), endTime: beats(1e6), start: thetaDeg, end: thetaDeg, easingType: 1 }],
        moveZEvents: [{ startTime: beats(0), endTime: beats(1e6), start: z, end: z, easingType: 1 }],
      },
      notes: [
        { type: 2, above, startTime: beats(4), endTime: beats(4 + holdBeats), positionX: positionX * 75.9375, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
      ],
    },
  ],
});

/** 取出这个 fixture 的投影上下文：一条线上的一个 Hold 的局部坐标 → 屏幕 */
const setup = (opts) => {
  const chart = prepareChart(parseRpeChart(mkChart(opts.thetaDeg, opts)));
  const st = createState(chart);
  evaluate(st, 4.2);
  const note = chart.notes[0];
  const line = st.lines[0];
  const head = view.noteTransform(note, line, { noteWidthRatio, distY: note.headY });
  const tail = view.noteTransform(note, line, { noteWidthRatio, distY: note.tailY });
  const xLeft = -noteWidthRatio * areaW * 0.5; // 只是把长条挪到画面里，不影响误差
  const fullW = noteWidthRatio * areaW;
  const screenOf = (x, y0) => view.lineLocalToScreen(x, y0, line, { above: note.above !== false });
  const top = Math.min(head.localY0, tail.localY0);
  const totalLocal = Math.abs(tail.localY0 - head.localY0);
  const mid = screenOf(xLeft + fullW / 2, head.localY0);
  const midTail = screenOf(xLeft + fullW / 2, tail.localY0);
  const span = Math.hypot(mid.x - midTail.x, mid.y - midTail.y);
  return { note, line, head, tail, xLeft, fullW, screenOf, top, totalLocal, span };
};

/** 一行（本地 y ∈ [y0, y0+h]）的真实四角 */
const rowQuad = (ctx, y0, h) => {
  const { screenOf, xLeft, fullW } = ctx;
  return {
    tl: screenOf(xLeft, y0),
    tr: screenOf(xLeft + fullW, y0),
    bl: screenOf(xLeft, y0 + h),
    br: screenOf(xLeft + fullW, y0 + h),
  };
};

/** 三点定标（左上 / 右上 / 左下）的仿射，第四个角会偏多少 */
const affineFourthCornerError = (q) => Math.hypot(q.tr.x + q.bl.x - q.tl.x - q.br.x, q.tr.y + q.bl.y - q.tl.y - q.br.y);

/** 左右两条边界是不是直线（首尾连线最大偏离）；顺带报告远端是否已经撞到深度下限（会多一个折点） */
const boundaryLineDeviation = (ctx, steps = 64) => {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(rowQuad(ctx, ctx.top + (ctx.totalLocal * i) / steps, 0.001));
  const dev = (list) => {
    const a = list[0];
    const b = list[list.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return Math.max(...list.map((p) => Math.abs(((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len)));
  };
  // 深度下限：k 封顶在 1 / MIN_DEPTH_RATIO（投影在这里出现折点，边界变成两段直线）
  const maxK = Math.max(...pts.map((p) => p.tl.k));
  return { left: dev(pts.map((p) => p.tl)), right: dev(pts.map((p) => p.tr)), clamped: maxK > 19.99 };
};

/** 只靠加密行数：把误差压到 targetPx 需要多少行 */
const rowsNeededForError = (ctx, targetPx = 0.4) => {
  let rows = 0;
  let y = ctx.top;
  let guard = 0;
  while (y < ctx.top + ctx.totalLocal - 1e-6 && guard++ < 20000) {
    const remain = ctx.top + ctx.totalLocal - y;
    if (affineFourthCornerError(rowQuad(ctx, y, remain)) <= targetPx) {
      rows++;
      break;
    }
    let lo = Math.min(1, remain);
    let hi = remain;
    for (let it = 0; it < 40; it++) {
      const midH = (lo + hi) / 2;
      if (affineFourthCornerError(rowQuad(ctx, y, midH)) <= targetPx) lo = midH;
      else hi = midH;
    }
    y += lo;
    rows++;
  }
  return rows;
};

console.log('== 1. 边界确实是直线：倾斜面上直线投影后仍是直线（所以「四角精确」= 轮廓精确）');for (const theta of [10, 35, 70, -35]) {
  const ctx = setup({ thetaDeg: theta, holdBeats: 8 });
  const d = boundaryLineDeviation(ctx);
  const note = d.clamped ? '（远端触及深度下限 k≤20，投影在此处有折点 → 边界是两段直线）' : '';
  console.log(`   θ=${String(theta).padStart(3)}°  左边界偏离 ${d.left.toExponential(2)}px  右边界偏离 ${d.right.toExponential(2)}px ${note}`);
}

console.log('\n== 2. 三点仿射的第四个角偏差（按 18px 行高，只看屏幕内可见的行）');
for (const theta of [10, 35, 70, -35]) {
  for (const above of [1, 2]) {
    const ctx = setup({ thetaDeg: theta, holdBeats: 8, above });
    const rows = Math.max(1, Math.min(24, Math.round(ctx.span / 18)));
    const h = ctx.totalLocal / rows;
    let maxErr = 0;
    let visRows = 0;
    for (let i = 0; i < rows; i++) {
      const q = rowQuad(ctx, ctx.top + i * h, h);
      const minY = Math.min(q.tl.y, q.tr.y, q.bl.y, q.br.y);
      const maxY = Math.max(q.tl.y, q.tr.y, q.bl.y, q.br.y);
      if (maxY < -8 || minY > 728) continue;
      visRows++;
      maxErr = Math.max(maxErr, affineFourthCornerError(q));
    }
    console.log(`   θ=${String(theta).padStart(3)}° ${above === 1 ? '正面' : '背面'}  可见 ${String(visRows).padStart(2)}/${rows} 行，第四角最大偏差 ${maxErr.toFixed(2)}px`);
  }
}

console.log('\n== 3. 只靠加密行数把误差压到 0.4px 需要多少行（长条越长越夸张）');
for (const [theta, hb] of [
  [35, 0.5],
  [35, 2],
  [35, 8],
  [35, 24],
  [10, 8],
  [70, 8],
]) {
  const ctx = setup({ thetaDeg: theta, holdBeats: hb });
  console.log(`   θ=${String(theta).padStart(3)}° ${String(hb).padStart(4)} 拍  本地长 ${ctx.totalLocal.toFixed(0).padStart(6)}px → 需要 ${String(rowsNeededForError(ctx)).padStart(4)} 行`);
}
console.log('\n（所以：每行两个三角形 + 裁剪保证轮廓精确；18px/24 行是「透视够准」与「别画太多」的平衡点。）');
