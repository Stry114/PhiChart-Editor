// Chart structure profiler for Phigros chart JSON (official / RPE).
// Usage: node tools/inspect-chart.mjs <chart.json> [--sample N]
// Prints a field-level profile: keys, presence counts, value ranges, histograms.
import fs from 'node:fs';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const sampleN = Number(args.includes('--sample') ? args[args.indexOf('--sample') + 1] : 3);
if (!path) {
  console.error('usage: node tools/inspect-chart.mjs <chart.json>');
  process.exit(2);
}

const t0 = Date.now();
const raw = fs.readFileSync(path, 'utf8');
const data = JSON.parse(raw);
const out = [];
const p = (...a) => out.push(a.map(String).join(' '));
const dump = () => process.stdout.write(out.join('\n') + '\n');

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? `array[${v.length}]` : typeof v);

function describe(v, depth = 0, maxDepth = 3) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const head = v.slice(0, sampleN).map((x) => describe(x, depth + 1, maxDepth));
    const uniq = [...new Set(head)];
    return `[${v.length}] ${uniq.length === 1 ? uniq[0] : `{${uniq.join(' | ')}}`}`;
  }
  if (v && typeof v === 'object') {
    if (depth >= maxDepth) return '{...}';
    return `{ ${Object.entries(v).slice(0, 60).map(([k, x]) => `${k}:${describe(x, depth + 1, maxDepth)}`).join(' ')} }`;
  }
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v);
  return String(v);
}

function unionKeys(arr) {
  const s = new Set();
  for (const o of arr) if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) s.add(k);
  return [...s];
}
function presence(arr, keys) {
  const c = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const o of arr) if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) c[k]++;
  return Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');
}
function histogram(arr, fn) {
  const m = new Map();
  for (const o of arr) { const k = String(fn(o)); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
}
function numRange(arr, fn, label) {
  let min = Infinity, max = -Infinity, n = 0; const set = new Set();
  for (const o of arr) {
    const v = fn(o);
    if (typeof v === 'number' && Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); n++; set.add(v); }
  }
  return n ? `${label}: n=${n} min=${round(min)} max=${round(max)} distinct=${set.size}` : `${label}: (none)`;
}
const round = (x) => (Number.isInteger(x) ? x : Number(x.toFixed(6)));
const nonDefault = (arr, fn, def) => arr.filter((o) => { const v = fn(o); return v !== undefined && v !== def; }).length;

p(`## file: ${path}`);
p(`bytes=${raw.length} parseMs=${Date.now() - t0}`);

p('\n## TOP LEVEL');
for (const [k, v] of Object.entries(data)) p(`  ${k}: ${kindOf(v)}`);
for (const [k, v] of Object.entries(data)) {
  if (!Array.isArray(v) && (typeof v !== 'object' || v === null)) p(`  ${k} = ${JSON.stringify(v)}`);
}

const lines = Array.isArray(data.judgeLineList) ? data.judgeLineList : [];
p('\n## JUDGE LINES');
p(`count=${lines.length}`);
const lKeys = unionKeys(lines);
p(`unionKeys: ${lKeys.join(', ')}`);
p(`presence: ${presence(lines, lKeys)}`);
p(`sample line: ${describe(lines.slice(0, 1), 0, 4)}`);
p(`line name histogram (top): ${histogram(lines, (l) => l.Name ?? l.name ?? '(none)').slice(0, 400)}`);
p(`texture distinct: ${new Set(lines.map((l) => l.Texture ?? l.texture).filter(Boolean)).size}`);
p(`anchors: ${JSON.stringify([...new Set(lines.map((l) => JSON.stringify(l.anchor ?? null)))].slice(0, 6))}`);
p(`line Group histogram: ${histogram(lines, (l) => l.Group ?? '(none)').slice(0, 300)}`);
p(`isCover: ${presence(lines, ['isCover', 'bpm', 'numOfNotes', 'zOrder', 'attachUI'])}`);

// ---------- notes ----------
const noteBuckets = {}; // label -> notes[]
const push = (label, arr) => { if (Array.isArray(arr)) (noteBuckets[label] ??= []).push(...arr); };
for (const l of lines) {
  for (const k of ['notes', 'notesAbove', 'notesBelow']) {
    if (Array.isArray(l[k])) {
      if (Array.isArray(l[k][0])) l[k].forEach((lay, i) => Array.isArray(lay) && push(`${k}[${i}]`, lay));
      else push(k, l[k]);
    }
  }
}
p('\n## NOTES');
for (const [label, notes] of Object.entries(noteBuckets)) {
  if (!notes.length) continue;
  const nk = unionKeys(notes);
  p(`-- bucket ${label}: count=${notes.length}`);
  p(`   unionKeys: ${nk.join(', ')}`);
  p(`   presence: ${presence(notes, nk)}`);
  p(`   sample: ${describe(notes.slice(0, 2), 0, 3)}`);
  for (const nk2 of ['type', 'above']) if (notes[0][nk2] !== undefined) p(`   ${nk2} histogram: ${histogram(notes, (n) => n[nk2])}`);
  for (const vk of ['time', 'startTime', 'endTime', 'holdTime', 'positionX', 'speed', 'floorPosition', 'alpha', 'size', 'visibleTime', 'yOffset', 'hitsound', 'judgeType']) {
    if (notes[0][vk] !== undefined) p(`   ${numRange(notes, (n) => n[vk], vk)}`);
  }
  if (notes[0].speed !== undefined) p(`   speed != 1.0 count: ${nonDefault(notes, (n) => n.speed, 1)}`);
  if (notes[0].size !== undefined) p(`   size != 1.0 count: ${nonDefault(notes, (n) => n.size, 1)}`);
  if (notes[0].alpha !== undefined) p(`   alpha != 1.0 count: ${nonDefault(notes, (n) => n.alpha, 1)}`);
  if (notes[0].isFake !== undefined) p(`   isFake true count: ${notes.filter((n) => n.isFake).length}`);
  if (notes[0].visibleTime !== undefined) p(`   visibleTime != 999999 count: ${notes.filter((n) => n.visibleTime !== 999999).length}`);
  for (const vk of ['isFake', 'above', 'type']) if (notes[0][vk] !== undefined) p(`   ${vk} types: ${[...new Set(notes.map((n) => typeof n[vk]))].join(',')}`);
}

// ---------- events ----------
p('\n## EVENTS');
// official: eventLayers[{moveEvents:[{startTime,endTime,start,end,start2,end2}], rotateEvents, alphaEvents}]
// RPE:      eventLayers[{moveXEvents,moveYEvents,rotateEvents,alphaEvents,speedEvents:[{bezier,bezierPoints,easingType,linkTo,startTime,endTime,start,end}]}]
const layerObjs = [];
for (const l of lines) {
  if (Array.isArray(l.eventLayers)) for (const lay of l.eventLayers) if (lay && typeof lay === 'object') layerObjs.push(lay);
  else if (Array.isArray(l.events)) for (const lay of l.events) if (lay && typeof lay === 'object') layerObjs.push(lay);
}
p(`lines with eventLayers: ${lines.filter((l) => Array.isArray(l.eventLayers)).length}`);
p(`total event layers: ${layerObjs.length}`);
p(`layers per line histogram (top): ${histogram(lines, (l) => (l.eventLayers ? l.eventLayers.length : 0)).slice(0, 200)}`);
const layKeys = unionKeys(layerObjs);
p(`layer unionKeys: ${layKeys.join(', ')}`);
p(`layer presence: ${presence(layerObjs, layKeys)}`);

const evTypes = new Map();
for (const k of layKeys) {
  if (!k.endsWith('Events')) continue;
  const arrs = layerObjs.map((l) => l[k]).filter(Array.isArray);
  const items = arrs.flat();
  evTypes.set(k, items);
  if (!items.length) continue;
  const ik = unionKeys(items);
  p(`\n-- ${k}: layers=${arrs.length} events=${items.length}`);
  p(`   unionKeys: ${ik.join(', ')}`);
  p(`   presence: ${presence(items, ik)}`);
  p(`   sample: ${describe(items.slice(0, 2), 0, 3)}`);
  p(`   ${numRange(items, (e) => e.startTime, 'startTime')}`);
  p(`   ${numRange(items, (e) => e.endTime, 'endTime')}`);
  for (const vk of ['start', 'end', 'start2', 'end2', 'easingType', 'bezier', 'linkTo']) {
    if (items[0][vk] === undefined) continue;
    if (typeof items[0][vk] === 'number') p(`   ${numRange(items, (e) => e[vk], vk)}`);
    else p(`   ${vk} histogram: ${histogram(items, (e) => e[vk]).slice(0, 400)}`);
  }
  const missingEnd = items.filter((e) => e.endTime === undefined).length;
  if (missingEnd) p(`   missing endTime: ${missingEnd}`);
  const zeroLen = items.filter((e) => e.startTime === e.endTime).length;
  p(`   zero-length events: ${zeroLen}`);
  const instant = items.filter((e) => e.endTime === undefined || e.endTime - e.startTime <= 0).length;
  p(`   instantaneous events: ${instant}`);
  const linked = items.filter((e) => e.linkTo).length;
  if (linked) p(`   linkTo non-zero: ${linked}`);
  const sorted = items.every((e, i) => i === 0 || e.startTime >= (items[i - 1].endTime ?? items[i - 1].startTime) - 1e-9);
  p(`   globally sorted & non-overlapping: ${sorted}`);
}
p(`\nevent type totals: ${[...evTypes.entries()].map(([k, v]) => `${k}=${v.length}`).join(' ')}`);

// official speedEvents live on the line
const lineSpeed = lines.flatMap((l) => (Array.isArray(l.speedEvents) ? l.speedEvents : []));
if (lineSpeed.length) {
  const sk = unionKeys(lineSpeed);
  p(`\n## LINE-LEVEL speedEvents: count=${lineSpeed.length} unionKeys=[${sk.join(', ')}]`);
  p(`   presence: ${presence(lineSpeed, sk)}`);
  p(`   sample: ${describe(lineSpeed.slice(0, 3), 0, 3)}`);
  p(`   ${numRange(lineSpeed, (e) => e.startTime, 'startTime')}`);
  p(`   ${numRange(lineSpeed, (e) => e.value, 'value')}`);
  p(`   value histogram (top): ${histogram(lineSpeed, (e) => e.value).slice(0, 200)}`);
}

// ---------- extended events ----------
const ext = lines.map((l) => l.extended).filter(Boolean);
if (ext.length) {
  p('\n## EXTENDED (line.extended)');
  p(`lines with extended: ${ext.length}`);
  const ek = unionKeys(ext);
  p(`unionKeys: ${ek.join(', ')}`);
  p(`presence: ${presence(ext, ek)}`);
  p(`sample: ${describe(ext.slice(0, 1), 0, 2)}`);
  for (const k of ek) {
    const items = ext.map((e) => e[k]).filter(Array.isArray).flat();
    if (!items.length) continue;
    const ik = unionKeys(items);
    p(`-- ${k}: events=${items.length} unionKeys=[${ik.join(', ')}]`);
    p(`   sample: ${describe(items.slice(0, 2), 0, 3)}`);
    for (const vk of ['start', 'end', 'startTime', 'endTime']) if (items[0][vk] !== undefined) p(`   ${numRange(items, (e) => e[vk], vk)}`);
    for (const vk of ['easingType', 'bezier', 'linkTo']) if (items[0][vk] !== undefined) p(`   ${vk} histogram: ${histogram(items, (e) => e[vk]).slice(0, 200)}`);
  }
}

// RPE extras
p('\n## RPE EXTRAS');
if (data.META) p(`META: ${describe(data.META, 0, 3)}`);
if (Array.isArray(data.BPMList)) {
  p(`BPMList: count=${data.BPMList.length} sample=${describe(data.BPMList.slice(0, 4), 0, 3)}`);
  p(`  ${numRange(data.BPMList, (b) => b.bpm, 'bpm')}`);
  p(`  ${numRange(data.BPMList, (b) => b.startTime, 'startTime')}`);
}
for (const k of ['chartTime', 'offset', 'formatVersion', 'time', 'song', 'RPEVersion', 'judgeLineGroup']) {
  if (data[k] !== undefined) p(`${k}: ${describe(data[k], 0, 3)}`);
}
const lineLevelExtras = ['Group', 'Name', 'Texture', 'anchor', 'bpm', 'numOfNotes', 'isCover', 'zOrder', 'attachUI', 'rotateWithFather', 'father', 'pos'];
for (const k of lineLevelExtras) if (lines[0]?.[k] !== undefined) p(`line.${k} present: ${presence(lines, [k])}`);

dump();
