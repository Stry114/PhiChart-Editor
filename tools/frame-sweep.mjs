// 批量渲染若干帧（在同一进程内调用 renderFrame，避免 spawn 被沙箱拦截），
// 打印每帧的可见音符与长条几何，便于定位渲染问题。
// 用法：node tools/frame-sweep.mjs <chart.json> <起始秒> <结束秒> <步长> [前缀]
import path from 'node:path';
import { renderFrame } from './render-frame.mjs';

const [chartFile, t0, t1, step, prefix = 'sweep'] = process.argv.slice(2);
const times = [];
for (let t = Number(t0); t <= Number(t1); t += Number(step)) times.push(Math.round(t * 100) / 100);

for (const t of times) {
  const out = path.join('tools/out', `${prefix}-${String(t).replace('.', '_')}s.png`);
  const res = await renderFrame({ chartFile, timeSec: t, outFile: out });
  console.log(`t=${String(t).padStart(6)}s  可见 ${res.visible.length} ${JSON.stringify(res.byType)}`);
  for (const h of res.visible.filter((n) => n.type === 'hold')) {
    const lenPx = Math.abs(h.tailY - h.headY) * 0.6 * 720;
    console.log(
      `    Hold line=${h.lineId} dur=${h.durationSec.toFixed(3)}s 长度=${lenPx.toFixed(0)}px ` +
        `above=${h.above} isMulti=${!!h.isMulti} headY=${h.headY.toFixed(2)} tailY=${h.tailY.toFixed(2)}`,
    );
  }
}
console.log(`\n图片输出到 tools/out/${prefix}-*.png`);
