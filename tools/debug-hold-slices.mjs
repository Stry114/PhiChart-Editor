// 诊断：打印某根长条在各取样方案下的切片（源行/目标高度），核对是否取到「偏亮青」的区段。
// 需要示例谱面包（第三方资源，不在版本库里）
if (['official'].some((k) => !hasSample(k))) {
  console.log('缺少 packages/ 下的示例谱面包，跳过。');
  process.exit(0);
}
import fs from 'node:fs';
import { parseOfficialChart } from '../src/core/parse-official.js';
import { prepareChart } from '../src/core/model.js';
import { createState, evaluate } from '../src/core/state.js';
import { TEXTURE_TRIM } from '../src/render/textures.js';
import { computeHoldSlices } from '../src/render/hold-geometry.js';

const raw = JSON.parse(fs.readFileSync('packages/白复生 AT（official格式）/Chart_AT #3649.json', 'utf8'));
const chart = prepareChart(parseOfficialChart(raw));
const state = createState(chart);
evaluate(state, 17.98);

const holds = chart.notes.filter((n) => n.type === 'hold' && n.visible).slice(0, 2);
for (const note of holds) {
  const key = note.isMulti ? 'holdHL' : 'hold';
  const t = TEXTURE_TRIM[key];
  const meta = {
    core: { x: t.core[0], y: t.core[1], w: t.core[2], h: t.core[3] },
    content: { x: t.content[0], y: t.content[1], w: t.content[2], h: t.content[3] },
    capPx: t.capPx,
    segments: t.segments ?? null,
  };
  const width = (1 / 8) * 1280;
  const scale = width / meta.core.w;
  const dyScale = 0.6 * 720;
  const headLocalY = -note.headY * dyScale;
  const tailLocalY = -note.tailY * dyScale;
  console.log(
    `\nHold line=${note.lineId} t=${note.timeSec.toFixed(3)} 纹理=${key} isMulti=${!!note.isMulti} ` +
      `长度=${Math.abs(headLocalY - tailLocalY).toFixed(1)}px`,
  );
  console.log(`  纹理元数据 core=${JSON.stringify(meta.core)} segments=${JSON.stringify(meta.segments ?? null)}`);
  for (const preset of ['gradient', 'tailCap', 'uniform']) {
    const slices = computeHoldSlices({ meta, headLocalY, tailLocalY, texW: key === 'hold' ? 989 : 1062, scale, preset });
    const desc = slices
      .map((s) => `${s.kind}:源y${s.sy}..${s.sy + s.sh}(${(((s.sy - meta.core.y) / meta.core.h) * 100).toFixed(0)}%)→高${s.dh.toFixed(1)}px`)
      .join('  ');
    console.log(`  ${preset.padEnd(9)} ${desc}`);
  }
}
