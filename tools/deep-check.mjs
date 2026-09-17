// Deep-dive checks on the two sample charts: verify unit/integration formulas and dump raw samples.
import fs from 'node:fs';

const OFFICIAL = 'packages/白复生 AT（official格式）/Chart_AT #3649.json';
const RPE = 'packages/领土战争AT（RPE格式）/29519800.json';

const out = [];
const p = (...a) => out.push(a.map(String).join(' '));

// ============ OFFICIAL ============
{
  const d = JSON.parse(fs.readFileSync(OFFICIAL, 'utf8'));
  p('===== OFFICIAL =====');
  p(`formatVersion=${d.formatVersion} offset=${d.offset} lines=${d.judgeLineList.length}`);
  const line = d.judgeLineList[0];
  const bpm = line.bpm;
  p(`line0 bpm=${bpm}  secPerUnit=${(1.875 / bpm).toFixed(10)} (time->second: t*1.875/bpm)`);

  // build F(t) = integral of speed over seconds (seconds = t*1.875/bpm)
  const se = [...line.speedEvents].sort((a, b) => a.startTime - b.startTime);
  const toSec = (t) => (t * 1.875) / bpm;
  function F(t) { // integral from -inf..t of v(tau) dtau, tau in seconds
    let acc = 0;
    for (const e of se) {
      if (e.startTime >= t) break;
      const end = Math.min(e.endTime, t);
      acc += e.value * (toSec(end) - toSec(e.startTime));
    }
    return acc;
  }
  p('speedEvents:', se.map((e) => `[${e.startTime}..${e.endTime} v=${e.value}]`).join(' '));
  // check candidate formulas for note.floorPosition
  const notes = [...line.notesAbove, ...line.notesBelow];
  let matchPlain = 0, matchScaled = 0, neither = 0;
  const examples = [];
  for (const n of notes) {
    const f = F(n.time);
    const plain = Math.abs(f - n.floorPosition) < 1e-3 * Math.max(1, Math.abs(n.floorPosition));
    const scaled = Math.abs(f * n.speed - n.floorPosition) < 1e-3 * Math.max(1, Math.abs(n.floorPosition));
    if (plain) matchPlain++;
    else if (scaled) matchScaled++;
    else { neither++; if (examples.length < 8) examples.push({ ...n, F: f, FxSpeed: f * n.speed, sec: toSec(n.time) }); }
  }
  p(`notes=${notes.length} floorPosition==F(time): ${matchPlain}  ==F(time)*speed: ${matchScaled}  neither: ${neither}`);
  p('mismatch examples: ' + JSON.stringify(examples, null, 1));
  // hold notes: does floorPosition of hold count end or start?
  const holds = notes.filter((n) => n.type === 3);
  p(`holds=${holds.length} sample: ${JSON.stringify(holds.slice(0, 3))}`);
  // speed distribution of notes
  p('note speed histogram: ' + [...new Set(notes.map((n) => n.speed))].sort((a, b) => a - b).join(','));
  // duration of song: max event/note time
  const allTimes = [...notes.map((n) => n.time), ...se.map((e) => e.endTime)];
  p(`max time=${Math.max(...allTimes)} (=${toSec(Math.max(...allTimes)).toFixed(3)}s)  min note time=${Math.min(...notes.map((n) => n.time))}`);
  // sentinel in events
  p('first moveEvents: ' + JSON.stringify(line.judgeLineMoveEvents.slice(0, 3)));
  p('last moveEvents: ' + JSON.stringify(line.judgeLineMoveEvents.slice(-2)));
  p('moveEvent startTime min/max: ' + Math.min(...line.judgeLineMoveEvents.map((e) => e.startTime)) + '/' + Math.max(...line.judgeLineMoveEvents.map((e) => e.endTime)));
  p('rotate first/last: ' + JSON.stringify([line.judgeLineRotateEvents[0], line.judgeLineRotateEvents.at(-1)]));
  p('disappear first/last: ' + JSON.stringify([line.judgeLineDisappearEvents[0], line.judgeLineDisappearEvents.at(-1)]));
  // move event x/y ranges across all lines
  let mx = [], my = [];
  for (const l of d.judgeLineList) for (const e of l.judgeLineMoveEvents) { mx.push(e.start, e.end); my.push(e.start2, e.end2); }
  p(`all moveX range: ${Math.min(...mx)}..${Math.max(...mx)}   moveY range: ${Math.min(...my)}..${Math.max(...my)}`);
  let al = [];
  for (const l of d.judgeLineList) for (const e of l.judgeLineDisappearEvents) al.push(e.start, e.end);
  p(`alpha(=disappear) range: ${Math.min(...al)}..${Math.max(...al)}`);
  let ro = [];
  for (const l of d.judgeLineList) for (const e of l.judgeLineRotateEvents) ro.push(e.start, e.end);
  p(`rotate range: ${Math.min(...ro)}..${Math.max(...ro)}`);
  let px = [];
  for (const l of d.judgeLineList) for (const n of [...l.notesAbove, ...l.notesBelow]) px.push(n.positionX);
  p(`note positionX range: ${Math.min(...px)}..${Math.max(...px)} distinct=${new Set(px).size}`);
  const above = d.judgeLineList.reduce((a, l) => a + l.notesAbove.length, 0);
  const below = d.judgeLineList.reduce((a, l) => a + l.notesBelow.length, 0);
  p(`notesAbove=${above} notesBelow=${below}`);
  p('lines with notes: ' + d.judgeLineList.filter((l) => l.notesAbove.length + l.notesBelow.length > 0).length);
  p('speedEvent value 0 count: ' + d.judgeLineList.flatMap((l) => l.speedEvents).filter((e) => e.value === 0).length);
}

// ============ RPE ============
{
  const d = JSON.parse(fs.readFileSync(RPE, 'utf8'));
  p('\n===== RPE =====');
  p(`top keys: ${Object.keys(d).join(', ')}`);
  p(`META: ${JSON.stringify(d.META)}`);
  p(`BPMList: ${JSON.stringify(d.BPMList)}`);
  p(`judgeLineGroup: ${JSON.stringify(d.judgeLineGroup)}  multiScale=${d.multiScale} multiLineString=${JSON.stringify(d.multiLineString)}`);
  const lines = d.judgeLineList;

  // time array format
  const timeSamples = new Set();
  for (const l of lines) {
    for (const n of (l.notes ?? []).slice(0, 200)) timeSamples.add(JSON.stringify(n.startTime) + ' -> ' + JSON.stringify(n.endTime));
    const a = (l.eventLayers?.[0]?.moveXEvents ?? []).slice(0, 50);
    for (const e of a) timeSamples.add(JSON.stringify(e.startTime) + ' -> ' + JSON.stringify(e.endTime));
  }
  p('time array samples (start->end):\n  ' + [...timeSamples].slice(0, 40).join('\n  '));
  const lens = new Set(), denoms = new Set();
  const scan = (arr) => arr.forEach((t) => { if (Array.isArray(t)) { lens.add(t.length); denoms.add(t[1] + '/' + t[2]); } });
  for (const l of lines) {
    for (const n of (l.notes ?? [])) { scan([n.startTime, n.endTime]); }
    for (const lay of (l.eventLayers ?? [])) for (const k of Object.keys(lay)) if (Array.isArray(lay[k])) for (const e of lay[k]) scan([e.startTime, e.endTime]);
    for (const k of Object.keys(l.extended ?? {})) for (const e of l.extended[k]) scan([e.startTime, e.endTime]);
  }
  p(`time array lengths: ${[...lens].join(',')}`);
  p(`time array denominators observed (first 60): ${[...denoms].slice(0, 60).join(' ')}  (total ${denoms.size})`);

  // event structure
  const lay = lines[0].eventLayers[0];
  p(`layer keys: ${Object.keys(lay).join(', ')}`);
  p(`alphaEvents sample: ${JSON.stringify(lay.alphaEvents.slice(0, 3))}`);
  p(`moveXEvents first3: ${JSON.stringify(lay.moveXEvents.slice(0, 3))}`);
  p(`speedEvents all (line0): ${JSON.stringify(lay.speedEvents)}`);
  p(`notes sample: ${JSON.stringify(lines[0].notes.slice(0, 3))}`);
  p(`line controls: alphaControl=${JSON.stringify(lines[0].alphaControl)} posControl=${JSON.stringify(lines[0].posControl)} yControl=${JSON.stringify(lines[0].yControl)} sizeControl=${JSON.stringify(lines[0].sizeControl)} skewControl=${JSON.stringify(lines[0].skewControl)}`);
  p(`extended keys used: ${[...new Set(lines.flatMap((l) => Object.keys(l.extended ?? {})))].join(', ')}`);
  p(`father values: ${[...new Set(lines.map((l) => l.father))].join(',')}  isCover: ${[...new Set(lines.map((l) => l.isCover))].join(',')}  Group: ${[...new Set(lines.map((l) => l.Group))].join(',')}  zOrder: ${[...new Set(lines.map((l) => l.zOrder))].join(',')}`);
  p(`Texture values: ${[...new Set(lines.map((l) => l.Texture))].join(', ')}`);

  // easing types used anywhere
  const et = new Set(), bez = new Set(), lg = new Set(), el = new Set(), er = new Set();
  for (const l of lines) {
    for (const layX of (l.eventLayers ?? [])) for (const k of Object.keys(layX)) for (const e of layX[k]) {
      if (e.easingType !== undefined) et.add(e.easingType);
      if (e.bezier !== undefined) bez.add(e.bezier);
      if (e.linkgroup !== undefined) lg.add(e.linkgroup);
      if (e.easingLeft !== undefined) el.add(e.easingLeft);
      if (e.easingRight !== undefined) er.add(e.easingRight);
    }
    for (const k of Object.keys(l.extended ?? {})) for (const e of l.extended[k]) if (e.easingType !== undefined) et.add(e.easingType);
  }
  p(`easingType used: ${[...et].sort((a, b) => a - b).join(',')}`);
  p(`bezier used: ${[...bez].join(',')}   linkgroup used: ${[...lg].join(',')}`);
  p(`easingLeft values: ${[...el].join(',')}   easingRight values: ${[...er].join(',')}`);

  // note stats
  const notes = lines.flatMap((l) => l.notes ?? []);
  p(`notes=${notes.length} perLine=${lines.map((l) => (l.notes ?? []).length).join(',')}`);
  p(`numOfNotes sum=${lines.reduce((a, l) => a + l.numOfNotes, 0)}`);
  p(`note above values: ${[...new Set(notes.map((n) => n.above))].join(',')}  type values: ${[...new Set(notes.map((n) => n.type))].join(',')}`);
  p(`note alpha values: ${[...new Set(notes.map((n) => n.alpha))].join(',')}`);
  p(`note speed values: ${[...new Set(notes.map((n) => n.speed))].join(',')}  size: ${[...new Set(notes.map((n) => n.size))].join(',')} visibleTime: ${[...new Set(notes.map((n) => n.visibleTime))].join(',')} yOffset: ${[...new Set(notes.map((n) => n.yOffset))].join(',')}`);
  p(`note positionX range: ${Math.min(...notes.map((n) => n.positionX))}..${Math.max(...notes.map((n) => n.positionX))}`);
  const beat = (t) => (Array.isArray(t) ? (t[2] ? t[0] + (t[1] ?? 0) / (t[2] ?? 1) : t[0]) : t);
  const bpms = lines.flatMap((l) => (l.notes ?? []).map((n) => beat(n.startTime)));
  p(`note startTime beat range: ${Math.min(...bpms)}..${Math.max(...bpms)}`);
  const holds = notes.filter((n) => n.type === 3);
  p(`holds=${holds.length} sample=${JSON.stringify(holds.slice(0, 2))}`);
  const durs = holds.map((n) => beat(n.endTime) - beat(n.startTime));
  p(`hold durations (beats) min/max: ${Math.min(...durs)}/${Math.max(...durs)}`);
  const taps = notes.filter((n) => n.type === 1);
  p(`tap endTime==startTime: ${taps.filter((n) => JSON.stringify(n.startTime) === JSON.stringify(n.endTime)).length}/${taps.length}`);

  // speed events across lines
  const sp = lines.flatMap((l) => l.eventLayers?.[0]?.speedEvents ?? []);
  p(`speedEvents total=${sp.length}; values: ${[...new Set(sp.map((e) => e.start))].sort((a, b) => a - b).join(',')}`);
  p(`speedEvent samples: ${JSON.stringify(sp.slice(0, 6))}`);
  const zeroLen = sp.filter((e) => JSON.stringify(e.startTime) === JSON.stringify(e.endTime)).length;
  p(`speedEvents with start==end time: ${zeroLen}`);
}

fs.writeFileSync('tools/deep-findings.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
