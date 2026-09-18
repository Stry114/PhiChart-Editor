// 测量贴图的「本体（不透明核心）」与「光效外扩」区域，用于修正音符/Hold 的绘制尺寸。
// - bbox(alpha>8)   ：含光效的内容范围
// - bbox(alpha>200) ：本体（不透明核心）
// - 逐行/逐列宽度轮廓：找出两端收窄的「卡口」，估算 Hold 的头/尾帽高度
// 运行：node tools/measure-trim.mjs
import fs from 'node:fs';
import { decodePng } from './png.mjs';

const FILES = [
  'assets/Tap.png', 'assets/TapHL.png',
  'assets/Drag.png', 'assets/DragHL.png',
  'assets/Flick.png', 'assets/FlickHL.png',
  'assets/Hold.png', 'assets/HoldHL.png',
];

const bbox = (px, w, h, minAlpha) => {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px(x, y)[3] < minAlpha) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/** 逐行统计本体宽度，返回宽度最大行与两端「收窄段」的范围 */
const rowProfile = (px, w, h, region, minAlpha = 200) => {
  const rows = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    let c = 0;
    for (let x = region.x; x < region.x + region.w; x++) if (px(x, y)[3] >= minAlpha) c++;
    rows.push(c);
  }
  const max = Math.max(...rows);
  const full = max * 0.92;
  let top = 0;
  while (top < rows.length && rows[top] < full) top++;
  let bottom = rows.length - 1;
  while (bottom > 0 && rows[bottom] < full) bottom--;
  return { rows, max, capTop: top, capBottom: rows.length - 1 - bottom };
};

/** 逐行统计宽度（低 alpha 阈值，适合半透明渐变的本体），并打印百分比采样轮廓 */
const rowProfile2 = (px, w, h, region, minAlpha = 8) => {
  const rows = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    let c = 0;
    for (let x = region.x; x < region.x + region.w; x++) if (px(x, y)[3] >= minAlpha) c++;
    rows.push(c);
  }
  const max = Math.max(...rows);
  const full = max * 0.9;
  let top = 0;
  while (top < rows.length && rows[top] < full) top++;
  let bottom = rows.length - 1;
  while (bottom > 0 && rows[bottom] < full) bottom--;
  const samples = [];
  for (let i = 0; i <= 10; i++) {
    const idx = Math.min(rows.length - 1, Math.round((i / 10) * (rows.length - 1)));
    samples.push(`${(i * 10).toString().padStart(3)}%:${String(rows[idx]).padStart(4)}`);
  }
  return { max, capTop: top, capBottom: rows.length - 1 - bottom, samples };
};

console.log('贴图本体/光效测量\n');
const out = {};
for (const file of FILES) {
  const { w, h, px } = decodePng(fs.readFileSync(file));
  const content = bbox(px, w, h, 8);
  const core = bbox(px, w, h, 200);
  const name = file.replace(/^assets\//, '').replace(/\.png$/, '');
  const info = {
    file: `${w}x${h}`,
    content,
    core,
    pad: core && content
      ? { left: core.x - content.x, right: content.x + content.w - (core.x + core.w), top: core.y - content.y, bottom: content.y + content.h - (core.y + core.h) }
      : null,
  };
  if (/^Hold/.test(name) && core) {
    const prof = rowProfile(px, w, h, core);
    const profLow = rowProfile2(px, w, h, content);
    info.holdRows = { coreH: core.h, maxWidth: profLow.max, capTopPx: profLow.capTop, capBottomPx: profLow.capBottom };
    info.widthSamples = profLow.samples.join('  ');
  }
  out[name] = info;
  console.log(`${name}  贴图 ${w}x${h}`);
  console.log(`  含光效 bbox: x${content.x} y${content.y} ${content.w}x${content.h}`);
  console.log(`  本体   bbox: x${core.x} y${core.y} ${core.w}x${core.h}  本体宽高比 ${(core.w / core.h).toFixed(4)}`);
  console.log(`  光效外扩: 左${info.pad.left} 右${info.pad.right} 上${info.pad.top} 下${info.pad.bottom}`);
  if (info.holdRows) {
    const r = info.holdRows;
    console.log(`  Hold 本体逐行（阈值 alpha>=8）: 最大宽度 ${r.maxWidth}px，上端收窄 ${r.capTopPx}px (${((r.capTopPx / r.coreH) * 100).toFixed(2)}%)，下端收窄 ${r.capBottomPx}px (${((r.capBottomPx / r.coreH) * 100).toFixed(2)}%)`);
    console.log(`  宽度轮廓: ${info.widthSamples}`);
  }
  console.log();
}

// 生成可直接粘贴的元数据表
const table = {};
for (const [name, info] of Object.entries(out)) {
  const entry = { core: [info.core.x, info.core.y, info.core.w, info.core.h] };
  table[name] = entry;
}
console.log('--- 可直接粘贴的元数据 ---');
console.log(JSON.stringify(table, null, 0));
