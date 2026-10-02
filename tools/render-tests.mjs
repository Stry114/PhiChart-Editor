// 渲染器 v1 的无头测试：解析、单位与公式、状态求值、判定计分、zip 读取。
// 运行：node tools/render-tests.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { prepareChart, detectFormat } from '../src/core/model.js';
import { parseOfficialChart } from '../src/core/parse-official.js';
import { hasSample, skipSample } from './samples.mjs';
import { parseRpeChart } from '../src/core/parse-rpe.js';
import { createState, evaluate, advanceJudging, resetState, formatScore } from '../src/core/state.js';
import { EASING_PRESETS, cubicBezier, makeEasing } from '../src/core/easing.js';
import { RPE_SPEED_TO_YPS, RPE_X_TO_X, RPE_Y_TO_Y, NOTE } from '../src/core/units.js';
import { createTimeline, rpeBeat } from '../src/core/timing.js';
import { loadZipPackage, parseInfoCsv, infoCsvToMeta, readZip } from '../src/core/package.js';
import { serializeOfficial } from '../src/core/serialize-official.js';
import { serializeRpe } from '../src/core/serialize-rpe.js';
import { serializeProject, parseProject } from '../src/core/project.js';
import { createZip } from '../src/core/zip.js';
import { buildChartZip, buildProjectJson, buildProjectZip } from '../src/core/export-package.js';
import { findProjectFile, unzipToFiles, buildPackage } from '../src/core/package.js';

const OFFICIAL_PATH = 'packages/白复生 AT（official格式）/Chart_AT #3649.json';
const RPE_PATH = 'packages/领土战争AT（RPE格式）/29519800.json';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

function section(title) {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------- 缓动
section('缓动');
check('预设数量为 29（数组含索引 0 共 30 项）', EASING_PRESETS.length === 30, `len=${EASING_PRESETS.length}`);
let endpointsOk = true;
for (let i = 1; i <= 29; i++) {
  const f = EASING_PRESETS[i];
  if (!near(f(0), 0, 1e-6) || !near(f(1), 1, 1e-6)) {
    endpointsOk = false;
    console.log(`     编号 ${i} 端点异常：f(0)=${f(0)} f(1)=${f(1)}`);
  }
}
check('1..29 缓动端点均为 0/1', endpointsOk);
const cb = cubicBezier(0.25, 0.1, 0.25, 1);
check('cubic-bezier 单调且端点正确', near(cb(0), 0, 1e-6) && near(cb(1), 1, 1e-6) && cb(0.3) < cb(0.6), `cb(0.5)=${cb(0.5).toFixed(4)}`);
const cropped = makeEasing(1, null, 0.25, 0.75);
check('缓动裁剪端点归一化到 0/1', near(cropped(0), 0, 1e-6) && near(cropped(1), 1, 1e-6));

// ---------------------------------------------------------------- 时间轴
section('时间轴');
const tl = createTimeline([{ beat: 0, bpm: 120 }]);
check('单 BPM：1 拍 = 0.5s', near(tl.beatToSeconds(1), 0.5, 1e-9));
const tl2 = createTimeline([
  { beat: 0, bpm: 120 },
  { beat: 4, bpm: 240 },
]);
check('变速：beat 4 = 2s，beat 6 = 2.5s', near(tl2.beatToSeconds(4), 2, 1e-9) && near(tl2.beatToSeconds(6), 2.5, 1e-9));
check('拍/秒互转可逆', near(tl2.secondsToBeat(tl2.beatToSeconds(7.3)), 7.3, 1e-9));
check('RPE Beat 数组解析', near(rpeBeat([6, 1, 4]), 6.25, 1e-12) && near(rpeBeat([-4, 7, 8]), -3.125, 1e-12));

// ---------------------------------------------------------------- 官方格式
// 需要示例谱面包（第三方资源，不在版本库里）：缺了就只跳过这一段
// 解析结果提到外层：后面的「实谱全曲扫描」等段落还要用（缺包时保持 null）
let officialRaw = null;
let official = null;
let rpeRaw = null;
let rpe = null;
if (!hasSample('official')) {
  skipSample('官方格式解析（白复生 AT）');
} else {
section('官方格式解析（白复生 AT）');
officialRaw = JSON.parse(fs.readFileSync(OFFICIAL_PATH, 'utf8'));
check('格式识别为 official', detectFormat(officialRaw) === 'official');
official = prepareChart(parseOfficialChart(officialRaw, { file: OFFICIAL_PATH }));
check('判定线 24 条', official.lines.length === 24, `lines=${official.lines.length}`);
check('音符 1156 个', official.notes.length === 1156, `notes=${official.notes.length}`);
const officialCounts = official.notes.reduce((acc, n) => ((acc[n.type] = (acc[n.type] ?? 0) + 1), acc), {});
check(
  '类型分布 616/324/180/36（tap/drag/hold/flick）',
  officialCounts.tap === 616 && officialCounts.drag === 324 && officialCounts.hold === 180 && officialCounts.flick === 36,
  JSON.stringify(officialCounts),
);
check('物量 = 1156（无假音符）', official.noteCount === 1156);

// 核心公式：note.height == 官方 floorPosition（速度事件对秒积分）
{
  const line0 = official.lines[0];
  // 全部判定线、全部音符：内部 height 必须与谱面里存的 floorPosition 一致。
  // （只查一条线会漏掉「积分段末采样取到下一段速度」这类只在特定事件边界出现的错误。）
  let match = 0;
  let total = 0;
  let maxErr = 0;
  let worstLine = -1;
  for (const line of official.lines) {
    for (const note of line.rt.notes) {
      const raw = note.floorPositionRaw;
      if (!Number.isFinite(raw)) continue;
      total++;
      const err = Math.abs(note.height - raw);
      if (err > maxErr) {
        maxErr = err;
        worstLine = line.id;
      }
      if (err <= 1e-3 * Math.max(1, Math.abs(raw))) match++;
    }
  }
  check(
    `全部 ${total} 个 note 的 height 与 floorPosition 一致`,
    match === total,
    `匹配 ${match}/${total}，最大误差 ${maxErr.toExponential(2)}${match === total ? '' : `（首处 line ${worstLine}）`}`,
  );
  const n0 = line0.rt.notes[0];
  check('time 256 @174BPM → 2.758621s', near(n0.timeSec, 2.7586207, 1e-5), `实际 ${n0.timeSec}`);
}

// 事件求值与官方哨兵
{
  const line0 = official.lines[0];
  evaluate(official.__state ?? (official.__state = createState(official)), 0);
  const st = official.__state;
  check('t=0：移动事件 x = 0.5 → 中心偏移 0', near(st.lines[0].worldX, 0, 1e-6), `worldX=${st.lines[0].worldX}`);
  evaluate(st, 1);
  check('t=1s：线不透明度为 0（首段 disappear = 0）', near(st.lines[0].alpha, 0, 1e-6), `alpha=${st.lines[0].alpha}`);
  evaluate(st, 10);
  check('t=10s：线不透明度 > 0.5', st.lines[0].alpha > 0.5, `alpha=${st.lines[0].alpha.toFixed(3)}`);
  evaluate(st, 60);
  check('旋转事件被读取（弧度）', Number.isFinite(st.lines[0].worldRotate) && Math.abs(st.lines[0].worldRotate) < 100, `rotate=${st.lines[0].worldRotate.toFixed(3)}`);
}

}
// ---------------------------------------------------------------- RPE 格式
if (!hasSample('rpe')) {
  skipSample('RPE 格式解析（领土战争 AT）');
} else {
section('RPE 格式解析（领土战争 AT）');
rpeRaw = JSON.parse(fs.readFileSync(RPE_PATH, 'utf8'));
check('格式识别为 rpe', detectFormat(rpeRaw) === 'rpe');
rpe = prepareChart(parseRpeChart(rpeRaw, { file: RPE_PATH }));
check('判定线 24 条', rpe.lines.length === 24, `lines=${rpe.lines.length}`);
check('音符 1417 个', rpe.notes.length === 1417, `notes=${rpe.notes.length}`);
const rpeCounts = rpe.notes.reduce((acc, n) => ((acc[n.type] = (acc[n.type] ?? 0) + 1), acc), {});
check(
  '类型分布 tap 624 / hold 165 / flick 158 / drag 470（RPE 编号与官方不同）',
  rpeCounts.tap === 624 && rpeCounts.hold === 165 && rpeCounts.flick === 158 && rpeCounts.drag === 470,
  JSON.stringify(rpeCounts),
);
check('numOfNotes 不含 Hold：1417 − 165 = 1252', 1417 - rpeCounts.hold === 1252);
check('offset 毫秒 → 秒（META.offset = 0）', rpe.meta.offset === 0);
check('音符时间：beat 6 @140BPM → 2.5714s', near(rpe.notes.find((n) => n.startBeat === 6).timeSec, 6 * (60 / 140), 1e-9));
check('positionX 单位换算（568.75 RPE → 7.49 X）', near(568.75 * RPE_X_TO_X, 7.4897, 1e-3), `= ${(568.75 * RPE_X_TO_X).toFixed(4)} X`);
{
  let speedEvent = null;
  let lineIndex = -1;
  for (let i = 0; i < rpeRaw.judgeLineList.length && !speedEvent; i++) {
    for (const layer of rpeRaw.judgeLineList[i].eventLayers ?? []) {
      speedEvent = (layer.speedEvents ?? []).find((e) => e.start === 4495.5);
      if (speedEvent) {
        lineIndex = i;
        break;
      }
    }
  }
  check('样本中存在 4495.5 的 RPE 速度事件（瞬移）', !!speedEvent, `判定线 ${lineIndex}`);
  const canonical = speedEvent.start * RPE_SPEED_TO_YPS;
  check('RPE 速度 4495.5 → 官方 999 Y/s（×2/9）', near(canonical, 999, 1e-9), `= ${canonical}`);
}
check('yOffset 换算（900 RPE y → 1.667 Y）', near(900 * RPE_Y_TO_Y, 5 / 3, 1e-9));
check('扩展事件被识别（inclineEvents 保留但不渲染）', rpe.extendedKeys.includes('inclineEvents'), rpe.extendedKeys.join(','));

}
// ---------------------------------------------------------------- 事件层相加
section('事件层相加（合成用例）');
{
  const synthetic = {
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      {
        Name: 'two-layers',
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [
          { moveXEvents: [{ startTime: [0, 0, 1], endTime: [1, 0, 1], start: 135, end: 135, easingType: 1 }] },
          { moveXEvents: [{ startTime: [0, 0, 1], endTime: [1, 0, 1], start: 270, end: 270, easingType: 1 }] },
          { alphaEvents: [{ startTime: [0, 0, 1], endTime: [1, 0, 1], start: 255, end: 255, easingType: 1 }] },
        ],
        notes: [],
      },
    ],
  };
  const chart = prepareChart(parseRpeChart(synthetic));
  const st = createState(chart);
  evaluate(st, 0.25);
  check('两层 x 相加：135 + 270 = 405 → 0.3 屏宽偏移', near(st.lines[0].worldX, 405 / 1350, 1e-9), `worldX=${st.lines[0].worldX.toFixed(6)}`);
  check('未给 alpha 事件的层贡献 0，alpha = 1', near(st.lines[0].alpha, 1, 1e-9), `alpha=${st.lines[0].alpha}`);
  evaluate(st, -5);
  check('首事件之前：x 取默认值 0（画面中心）、alpha 取默认值 0', near(st.lines[0].worldX, 0, 1e-9) && near(st.lines[0].alpha, 0, 1e-9));
}

// ---------------------------------------------------------------- 扩展（故事板）事件
section('官方 formatVersion 兼容（合成用例）');
{
  const mk = (formatVersion, start, start2) => ({
    formatVersion,
    offset: 0,
    judgeLineList: [
      {
        bpm: 120,
        notesAbove: [],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: 0, endTime: 1000, start, end: start, start2, end2: start2 }],
        judgeLineRotateEvents: [{ startTime: 0, endTime: 1000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: 0, endTime: 1000, start: 1, end: 1 }],
      },
    ],
  });
  const v3 = createState(prepareChart(parseOfficialChart(mk(3, 0.5, 0.5))));
  evaluate(v3, 0.5);
  check('v3：start = 0.5 为画面中心', near(v3.lines[0].worldX, 0, 1e-9) && near(v3.lines[0].worldY, 0, 1e-9));
  const v2 = createState(prepareChart(parseOfficialChart(mk(2, 0, 0))));
  evaluate(v2, 0.5);
  check('v2：start = 0 为中心原点', near(v2.lines[0].worldX, 0, 1e-9) && near(v2.lines[0].worldY, 0, 1e-9));
  const v2b = createState(prepareChart(parseOfficialChart(mk(2, 10, 10))));
  evaluate(v2b, 0.5);
  check(
    'v2：10 单位 = 0.5625 画面宽（0.1H）与 1.0 画面高',
    near(v2b.lines[0].worldX, 10 * 0.05625, 1e-9) && near(v2b.lines[0].worldY, 1, 1e-9),
    `x=${v2b.lines[0].worldX} y=${v2b.lines[0].worldY}`,
  );
  const v1 = createState(prepareChart(parseOfficialChart(mk(1, 440 * 1000 + 260, 0))));
  evaluate(v1, 0.5);
  check('v1：1000x + y 解包为 x/880、y/520', near(v1.lines[0].worldX, 440 / 880 - 0.5, 1e-9) && near(v1.lines[0].worldY, 260 / 520 - 0.5, 1e-9));
  const v3473 = createState(prepareChart(parseOfficialChart(mk(3473, 0.75, 0.25))));
  evaluate(v3473, 0.5);
  check('v3473（彩蛋值）与 v3 同构', near(v3473.lines[0].worldX, 0.25, 1e-9) && near(v3473.lines[0].worldY, -0.25, 1e-9));
}

// ---------------------------------------------------------------- 命中消失 / 淡出 / 线色
section('命中即消失、淡出仅用于漏接、判定线颜色（自动游玩满分 → 金色）');
{
  const mkChart = () => ({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 60,
        // 一个普通键（1 拍 = 1 秒）+ 一个长条（1 拍时长）
        notesAbove: [
          { type: 1, time: 128, positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 },
          { type: 3, time: 256, positionX: 0, holdTime: 128, speed: 1, floorPosition: 2 },
        ],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      },
    ],
  });
  const { LINE } = await import('../src/core/units.js');

  // 1) 自动游玩：落到线上那一帧画在线上（判定尚未发生），下一帧起消失并留下特效
  const c1 = prepareChart(parseOfficialChart(mkChart()));
  const s1 = createState(c1);
  evaluate(s1, 3.99);
  check('落线之前：音符仍显示', c1.notes[0].visible === true && c1.notes[0].renderAlpha === 1);
  evaluate(s1, 4.0);
  check(
    '落到线上那一帧：音符停在线上仍可见（判定还没发生）',
    c1.notes[0].visible === true && c1.notes[0].headY === 0,
    `visible=${c1.notes[0].visible} headY=${c1.notes[0].headY}`,
  );
  const hits = advanceJudging(s1, 4.0);
  check('同时产生打击特效（1 个）', hits.length === 1 && hits[0].perfect === true, `hits=${hits.length}`);
  check('分数为 Perfect 计分', s1.stats.perfect === 1 && s1.stats.combo === 1);
  evaluate(s1, 4.05);
  check('判定之后立即不可见（下一帧就消失，无淡出残留）', c1.notes[0].visible === false);

  // 2) 判定线颜色：自动游玩满分 → 金色
  check('判定线为金色（全 Perfect）', s1.lines[0].color === LINE.COLOR_ALL_PERFECT, s1.lines[0].color);
  const s2 = createState(prepareChart(parseOfficialChart(mkChart())));
  s2.stats.good = 1;
  evaluate(s2, 1);
  check('出现 Good 后线色转为全连蓝', s2.lines[0].color === LINE.COLOR_FULL_COMBO, s2.lines[0].color);
  s2.stats.miss = 1;
  evaluate(s2, 1.1);
  check('出现 Miss 后线色转为白', s2.lines[0].color === LINE.COLOR, s2.lines[0].color);

  // 3) 长条是例外：头部命中后本体继续显示到尾部过线
  //    官方格式 1 拍 = 32 单位；bpm 60 → 1 拍 = 1s。长条 time=256（8s）、holdTime=128（4s）
  const c3 = prepareChart(parseOfficialChart(mkChart()));
  const s3 = createState(c3);
  const hold = c3.notes[1];
  evaluate(s3, 8.0); // 长条头部落在线上
  advanceJudging(s3, 8.0);
  check('长条头部命中后仍可见', hold.judged === true && hold.visible === true, `judged=${hold.judged} visible=${hold.visible}`);
  evaluate(s3, 8.4);
  check('长条未到尾部仍可见', hold.visible === true);
  evaluate(s3, 12.01);
  check('长条尾部过线后消失', hold.visible === false);

  // 4) 漏接（未判定）才走淡出；此时不产生特效
  const c4 = prepareChart(parseOfficialChart(mkChart()));
  const s4 = createState(c4);
  s4.options.autoplay = false; // 关闭自动游玩：模拟玩家没点到
  evaluate(s4, 4.08);
  check(
    '未判定且已过线：淡出中（alpha 介于 0 与 1）',
    c4.notes[0].visible === true && c4.notes[0].renderAlpha > 0 && c4.notes[0].renderAlpha < 1,
    `alpha=${c4.notes[0].renderAlpha.toFixed(3)}`,
  );
  evaluate(s4, 4.2);
  check('淡出结束后不可见', c4.notes[0].visible === false);
  // 特效只由「判定」产生：把音符标记为已解决（未判定）时不再产生特效
  c4.notes[0].judged = true;
  check('未判定（漏接）不产生打击特效', advanceJudging(s4, 4.2).length === 0);
}

// ---------------------------------------------------------------- Hold 尾部速度口径
section('音符宽度');
check('默认音符宽度为 W/8（0.125 画面宽）', near(NOTE.DEFAULT_WIDTH_RATIO, 0.125, 1e-12), `= ${NOTE.DEFAULT_WIDTH_RATIO}`);


{
  const csv = [
    'csv,Chart,Name,Musician,Level,Illustrator,Designer,Music,Image,AspectRatio,NoteScale,BackgroundDim',
    ',Spasmodic.json,Spasmodic,"姜米條",SP Lv.16,某画师,某谱师,Spasmodic.wav,bg.png,1.7778,1.0,0.6',
    ',Other.json,Other,X,Y,Z,W,other.wav,other.png,1.7778,1.0,0.6',
  ].join('\n');
  const meta = infoCsvToMeta(parseInfoCsv(csv)[0]);
  check('info.csv：解析列名与含逗号的引号字段', meta.name === 'Spasmodic' && meta.composer === '姜米條', JSON.stringify(meta));
  check('info.csv：别名列（Musician/Designer）映射到 composer/charter', meta.charter === '某谱师' && meta.song === 'Spasmodic.wav');
  check('info.csv：保留 NoteScale / BackgroundDim 供后续使用', meta.noteScale === '1.0' && meta.backgroundDim === '0.6');
}


if (!(hasSample('official') && hasSample('rpe'))) {
  skipSample('实谱全曲扫描（official / RPE）');
} else for (const [label, chart] of [['official', official], ['rpe', rpe]]) {
  const state = createState(chart);
  resetState(state);
  let minDist = Infinity;
  let nan = false;
  const step = 1 / 60;
  for (let t = -1; t <= chart.endTime + 1; t += step) {
    evaluate(state, t);
    advanceJudging(state, t);
    for (const note of chart.notes) {
      if (!Number.isFinite(note.distY) || !Number.isFinite(note.renderAlpha)) nan = true;
      if (t >= note.timeSec - 0.1 && t <= note.timeSec) minDist = Math.min(minDist, Math.abs(note.distY));
    }
  }
  check(`${label}：无 NaN 的求值结果`, !nan);
  check(`${label}：物量全部判定（${state.stats.judged}/${chart.noteCount}）`, state.stats.judged === chart.noteCount);
  check(`${label}：最大连击 = 物量`, state.stats.maxCombo === chart.noteCount);
  check(`${label}：满分 1000000`, near(state.stats.score, 1000000, 1e-6), `score=${state.stats.score}`);
  check(`${label}：All Perfect 状态`, state.stats.allPerfect && state.stats.fullCombo);
  check(`${label}：命中瞬间音符距离趋近 0`, minDist < 0.05, `minDist=${minDist.toFixed(4)} Y`);
  check(`${label}：分数显示格式`, formatScore(state.stats.score) === '1000000');
  // Hold 长度：命中前尾部 > 头部，命中后尾部递减
  const holdNote = chart.notes.find((n) => n.type === 'hold' && n.durationSec > 0.1);
  if (holdNote) {
    evaluate(state, holdNote.timeSec - 0.2);
    const before = holdNote.tailY - holdNote.headY;
    evaluate(state, holdNote.timeSec + holdNote.durationSec * 0.5);
    const after = holdNote.tailY;
    check(`${label}：Hold 命中前有长度、命中后尾部收拢`, before > 0 && after > 0 && after < before, `before=${before.toFixed(3)} after=${after.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------- zip 读取
section('zip 包读取（store 方式，自建）');
{
  const mkZip = (entries) => {
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, contentRaw] of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const content = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(contentRaw, 'utf8');
      const crc = crc32(content);
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6); // store
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(content.length, 18);
      local.writeUInt32LE(content.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(local, 30);
      locals.push(local, content);
      const cen = Buffer.alloc(46 + nameBuf.length);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 10); // store
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(content.length, 20);
      cen.writeUInt32LE(content.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt32LE(offset, 42);
      nameBuf.copy(cen, 46);
      central.push(cen);
      offset += local.length + content.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, eocd]);
  };

  const chartJson = JSON.stringify({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 120,
        notesAbove: [{ type: 1, time: 0, positionX: 0, holdTime: 0, speed: 1, floorPosition: 0 }],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000, start: 1, end: 1 }],
      },
    ],
  });
  const zip = mkZip([
    ['demo/chart.json', chartJson],
    ['demo/song.wav', Buffer.alloc(2048, 7)],
    ['demo/cover.png', Buffer.alloc(128, 3)],
    ['demo/info.txt', 'Name: Zip Demo\nSong: song.wav\nPicture: cover.png\n'],
  ]);
  const pkg = await loadZipPackage(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), 'demo');
  check('zip 中识别出谱面文件', pkg.chartPath === 'demo/chart.json', `chartPath=${pkg.chartPath}`);
  check('zip 中识别出音频与曲绘', pkg.songPath === 'demo/song.wav' && pkg.backgroundPath === 'demo/cover.png');
  check('info.txt 元数据被读取', pkg.meta.name === 'Zip Demo', JSON.stringify(pkg.meta));
  const zipped = prepareChart(parseOfficialChart(pkg.chartJson));
  check('zip 内谱面可正常解析（1 音符）', zipped.notes.length === 1);
  void zlib;
}

// ---------------------------------------------------------------- 打击特效：锚点与 Hold 重放
section('包内元数据权威顺序：info.txt > info.csv > 谱面 JSON 元数据 > 包名');
{
  const { resolveMeta, metaToInfoTxt, normalizeMeta, META_FIELDS } = await import('../src/core/meta.js');
  const { parseInfoTxt } = await import('../src/core/package.js');

  const full = resolveMeta({
    infoTxt: { Name: 'TXT 曲名', Composer: 'TXT 曲师', Charter: 'TXT 谱师', Level: 'SP Lv.16', Song: 'a.wav', Picture: 'b.png', Path: 'TXT-ID' },
    infoCsv: { name: 'CSV 曲名', composer: 'CSV 曲师' },
    chartMeta: { name: 'JSON 曲名', composer: 'JSON 曲师', illustrator: 'JSON 曲绘师' },
    packageName: '包名',
  });
  check(
    'info.txt 优先于 info.csv 与 JSON',
    full.meta.name === 'TXT 曲名' && full.meta.composer === 'TXT 曲师' && full.sources.name === 'info.txt',
    JSON.stringify(full.sources),
  );
  check(
    'info.txt 缺的字段向下一级要（illustrator 来自 JSON）',
    full.meta.illustrator === 'JSON 曲绘师' && full.sources.illustrator === '谱面 JSON',
    `${full.meta.illustrator}（${full.sources.illustrator}）`,
  );

  const csvWins = resolveMeta({ infoTxt: { Name: '' }, infoCsv: { name: 'CSV 曲名' }, chartMeta: { name: 'JSON 曲名' } });
  check('info.txt 无该字段时 info.csv 胜过 JSON', csvWins.meta.name === 'CSV 曲名' && csvWins.sources.name === 'info.csv');

  const jsonWins = resolveMeta({ chartMeta: { name: 'JSON 曲名', composer: 'JSON 曲师' }, packageName: '包名' });
  check('无文本文档时用谱面 JSON 元数据', jsonWins.meta.name === 'JSON 曲名' && jsonWins.sources.name === '谱面 JSON');

  const pkgFallback = resolveMeta({ chartMeta: {}, packageName: '领土战争AT（RPE格式）' });
  check('都没有时用包名兜底曲名', pkgFallback.meta.name === '领土战争AT（RPE格式）' && pkgFallback.sources.name === '包名');
  check(
    '所有字段都补成字符串（不会 undefined）',
    META_FIELDS.every((f) => typeof pkgFallback.meta[f] === 'string'),
    JSON.stringify(pkgFallback.meta),
  );
  check(
    '别名键被归一化（Musician→composer、Designer→charter、Picture→background）',
    (() => {
      const n = normalizeMeta({ Musician: 'M', Designer: 'D', Picture: 'p.png', Path: 'x' });
      return n.composer === 'M' && n.charter === 'D' && n.background === 'p.png' && n.id === 'x';
    })(),
  );

  const txt = metaToInfoTxt(full.meta);
  check(
    '导出统一 info.txt（标准键名）',
    /^Name: TXT 曲名$/m.test(txt) && /^Composer: TXT 曲师$/m.test(txt) && /^Picture: b\.png$/m.test(txt),
    txt.split('\n').slice(1, 3).join(' / '),
  );
  const round = resolveMeta({ infoTxt: parseInfoTxt(txt), packageName: '包名' });
  check('导出的 info.txt 读回来完全一致（往返一致）', META_FIELDS.every((f) => round.meta[f] === full.meta[f]), JSON.stringify(round.meta));

  // 谱面延迟（offset）：official 的 info.csv / info.txt 里的 Offset 才是游戏读的值，
  // 必须按同一套权威顺序仲裁（此前只认谱面 JSON 的 offset，包内文本里的 Offset 被丢掉了）
  {
    const { readMetaOffset } = await import('../src/core/meta.js');
    const { createPlayer } = await import('../src/app/player.js');
    const csvOnly = resolveMeta({ infoCsv: { Offset: '0.25' }, chartMeta: { offset: 0 } });
    check('info.csv 的 Offset 被读取（秒）', csvOnly.meta.offset === 0.25 && csvOnly.sources.offset === 'info.csv', `${csvOnly.meta.offset}（${csvOnly.sources.offset}）`);
    const txtWins = resolveMeta({ infoTxt: { Offset: '-0.12' }, infoCsv: { Offset: '0.25' }, chartMeta: { offset: 0 } });
    check('info.txt 的 Offset 优先于 info.csv', txtWins.meta.offset === -0.12 && txtWins.sources.offset === 'info.txt', `${txtWins.meta.offset}`);
    const none = resolveMeta({ infoTxt: { Name: 'x' }, chartMeta: { offset: 0.4 } });
    check('文本里没有 Offset 时不覆盖谱面 JSON 的值', none.meta.offset === undefined, String(none.meta.offset));
    check('offset 与名称/曲师等不同：它是数值', typeof readMetaOffset({ offset: '1.5' }) === 'number' && readMetaOffset({ Offset: '' }) === null);
    check('导出的 info.txt 带上 Offset（往返保留）', (() => {
      const t = metaToInfoTxt({ ...full.meta, offset: 0.3 });
      return /^Offset: 0\.3$/m.test(t) && resolveMeta({ infoTxt: parseInfoTxt(t) }).meta.offset === 0.3;
    })());

    // 播放时钟语义：谱面时间 = 音乐时间 − offset（正 offset = 谱面开始更晚）
    const clock = createPlayer();
    clock.player.offset = 0.25;
    clock.player.startedAt = 0;
    check('offset=0.25 时，音乐刚开始（0s）谱面还在 −0.25s', Math.abs(clock.chartTime() + 0.25) < 1e-9, `${clock.chartTime()}`);
    clock.seek(0);
    check('跳到谱面 0s → 音频从 0.25s 开始播（谱面延迟生效）', Math.abs(clock.player.startedAt - 0.25) < 1e-9 && Math.abs(clock.chartTime()) < 1e-9, `startedAt=${clock.player.startedAt}`);
    clock.seek(10);
    check('跳到谱面 10s → 音频 10.25s（offset 全程一致）', Math.abs(clock.player.startedAt - 10.25) < 1e-9, `startedAt=${clock.player.startedAt}`);
  }

  // 真实包：白复生 AT 新增的 info.txt 现在是元数据的最高权威来源
  const infoPath = 'packages/白复生 AT（official格式）/info.txt';
  if (fs.existsSync(infoPath)) {
    const info = parseInfoTxt(fs.readFileSync(infoPath, 'utf8'));
    const real = resolveMeta({ infoTxt: info, chartMeta: { name: '应被覆盖' }, packageName: '白复生 AT（official格式）' });
    check(
      '真实包：曲名取 info.txt 的 Name',
      real.meta.name === 'Sigma (HaocoreMix) ~ Regrets of The Yellow Tulip ~' && real.sources.name === 'info.txt',
      real.meta.name,
    );
    check('真实包：曲师/谱师来自 info.txt', real.meta.composer === 'UK' && real.meta.charter === 'UK', `${real.meta.composer} / ${real.meta.charter}`);
    check('真实包：Path 作为 id 保留', real.meta.id.startsWith('Sigma'), real.meta.id);
  } else {
    check('真实包 info.txt 存在', false, infoPath);
  }
}

/** 官谱格式的硬约束（docs/Phigros文档.md 的官方引擎行为约束）：四条事件列表都不能空、哨兵与首尾相接 */
function checkOfficialConstraints(json) {
  const problems = [];
  for (const [index, line] of (json.judgeLineList ?? []).entries()) {
    if (!(line.bpm > 0)) problems.push(`线${index} bpm=${line.bpm}`);
    for (const [key, firstStart] of [
      ['speedEvents', 0],
      ['judgeLineMoveEvents', -999999],
      ['judgeLineRotateEvents', -999999],
      ['judgeLineDisappearEvents', -999999],
    ]) {
      const list = line[key];
      if (!Array.isArray(list) || !list.length) {
        problems.push(`线${index}.${key} 为空`);
        continue;
      }
      if (list[0].startTime !== firstStart) problems.push(`线${index}.${key} 首条 startTime=${list[0].startTime}`);
      if (list[list.length - 1].endTime !== 1000000000) problems.push(`线${index}.${key} 末条 endTime=${list[list.length - 1].endTime}`);
      for (let i = 1; i < list.length; i++) {
        if (list[i].startTime !== list[i - 1].endTime) {
          problems.push(`线${index}.${key} 第${i}条不相接（${list[i - 1].endTime} → ${list[i].startTime}）`);
          break;
        }
        if (!(list[i].endTime > list[i].startTime)) {
          problems.push(`线${index}.${key} 第${i}条非正区间`);
          break;
        }
      }
    }
  }
  return problems;
}

function compareModels(a, b, samples = 160) {
  const sa = createState(a, { aspect: 16 / 9 });
  const sb = createState(b, { aspect: 16 / 9 });
  let line = 0;
  let note = 0;
  let worstAt = 0;
  for (let k = 0; k <= samples; k++) {
    const t = (a.endTime * k) / samples;
    evaluate(sa, t);
    evaluate(sb, t);
    for (let i = 0; i < sa.lines.length && i < sb.lines.length; i++) {
      const p = sa.lines[i];
      const q = sb.lines[i];
      // 扩展事件（scaleX / scaleY / extColor）也要比：否则往返丢了扩展数据也发现不了
      const chan = (v) => (Array.isArray(v) ? v : [v, v, v]);
      const cp = chan(p.extColor);
      const cq = chan(q.extColor);
      const d = Math.max(
        Math.abs(p.x - q.x),
        Math.abs(p.y - q.y),
        Math.abs(p.rotate - q.rotate),
        Math.abs(p.alpha - q.alpha),
        Math.abs(p.scaleX - q.scaleX),
        Math.abs(p.scaleY - q.scaleY),
        ...cp.map((v, ci) => Math.abs(v - cq[ci])),
      );
      if (d > line) {
        line = d;
        worstAt = t;
      }
    }
    for (let i = 0; i < Math.min(sa.chart.notes.length, sb.chart.notes.length); i++) {
      const p = sa.chart.notes[i];
      const q = sb.chart.notes[i];
      if (!p.visible || !q.visible) continue;
      // 判定状态不同就没法比位置：命中会立即隐藏、Hold 命中后头部贴线收尾，
      // 而漏接/未判定的音符会继续下落 —— 形状根本不一样（前面的用例可能已经判过这些音符）。
      if (p.judged || q.judged) continue;
      // 只比较「接近判定线」的那一段：过线后音符会继续下落（不再钳制在线上），
      // 高速判定线（999 Y/s）会把两个模型之间极小的 lineHeight 漂移放大成几百 Y，
      // 那是渲染位置而非玩法几何，不参与这里的一致性判定。
      if (p.distY < -1 || q.distY < -1) continue;
      const d = Math.abs(p.distY - q.distY);
      if (d > note) note = d;
    }
  }
  return { line, note, worstAt };
}


section('序列化：官谱写回（official）');
if (!hasSample('official')) {
  skipSample('序列化：官谱写回（official）');
} else {
  const out = serializeOfficial(official);
  const problems = checkOfficialConstraints(out.json);
  check('写出的官谱满足全部硬约束（非空/哨兵/首尾相接/正区间）', problems.length === 0, problems.slice(0, 3).join(' | ') || 'ok');
  check('判定线与音符数量不变', out.json.judgeLineList.length === 24 && out.stats.notes === 1156, `lines=${out.json.judgeLineList.length} notes=${out.stats.notes}`);

  const back = prepareChart(parseOfficialChart(out.json, { file: 'roundtrip.json' }));
  check('重新解析：音符数一致', back.notes.length === 1156, `${back.notes.length}`);
  let maxDt = 0;
  let maxDh = 0;
  let maxDx = 0;
  let typeMismatch = 0;
  for (let i = 0; i < official.notes.length; i++) {
    const a = official.notes[i];
    const b = back.notes[i];
    maxDt = Math.max(maxDt, Math.abs(a.timeSec - b.timeSec));
    // floorPosition 由速度事件积分重算：官谱的 float32 精度下误差应在 1e-3 Y 以内
    maxDh = Math.max(maxDh, Math.abs(a.height - b.height));
    maxDx = Math.max(maxDx, Math.abs(a.positionX - b.positionX));
    if (a.type !== b.type || a.above !== b.above) typeMismatch++;
  }
  check('往返时间完全一致（<1e-6s）', maxDt < 1e-6, `maxΔt=${maxDt.toExponential(2)}`);
  check('往返 floorPosition 一致（float32 精度内）', maxDh < 1e-3, `maxΔ=${maxDh.toExponential(2)} Y`);
  check('往返 positionX 一致（6 位小数内）', maxDx < 1e-5, `maxΔ=${maxDx.toExponential(2)}`);
  check('往返类型与上下方向一致', typeMismatch === 0, `不一致 ${typeMismatch} 个`);
  const cmp = compareModels(official, back);
  check('逐帧对比：判定线变换与音符位置一致（官谱往返）', cmp.line < 1e-3 && cmp.note < 1e-3, `线 Δ=${cmp.line.toExponential(2)} 音符 Δ=${cmp.note.toExponential(2)}`);
  check('官方样本本来就线性：不产生缓动告警', !out.warnings.some((w) => /缓动/.test(w)), out.warnings.join(' | ') || '无告警');

  // 已知的损失：官方样本有 126 条「瞬移/999 速度」段，往返后仍应保留
  const back999 = back.lines.reduce((n, l) => n + l.rt.speed.reduce((m, c) => m + c.list.filter((e) => Math.abs(e.v0) > 900).length, 0), 0);
  check('速度 999（瞬移）段在往返后保留', back999 > 0, `${back999} 段`);
}

section('序列化：RPE 写回（含官方 <-> RPE 跨格式）');
if (!hasSample('rpe')) {
  skipSample('序列化：RPE 写回（含官方 <-> RPE 跨格式）');
} else {
  const out = serializeRpe(rpe);
  check('判定线 / 音符 / 事件条数不变', out.json.judgeLineList.length === 24 && out.stats.notes === 1417 && out.stats.events === 81320, JSON.stringify(out.stats));
  check('numOfNotes 按 RPE 口径（含假音符、不含 Hold）= 1252', out.stats.numOfNotes === 1252, `${out.stats.numOfNotes}`);
  check('事件层写回为 moveX/moveY/rotate/alpha/speed 五类字段', Object.keys(out.json.judgeLineList[1].eventLayers[0]).sort().join(',') === 'alphaEvents,moveXEvents,moveYEvents,rotateEvents,speedEvents');
  check('根字段齐全（META/BPMList/judgeLineGroup/judgeLineList/multiLineString/multiScale）', ['META', 'BPMList', 'judgeLineGroup', 'judgeLineList', 'multiLineString', 'multiScale'].every((k) => k in out.json));
  check('META.offset 换回毫秒', out.json.META.offset === Math.round(rpe.meta.offset * 1000), `${out.json.META.offset}`);
  check('事件时间是 Beat 有理数', Array.isArray(out.json.judgeLineList[1].eventLayers[0].alphaEvents[0].startTime), JSON.stringify(out.json.judgeLineList[1].eventLayers[0].alphaEvents[0].startTime));
  check('扩展事件（inclineEvents）原样保留', !!out.json.judgeLineList[1].extended?.inclineEvents);
  check('未建模字段（*Control）原样保留', Array.isArray(out.json.judgeLineList[0].posControl));

  const back = prepareChart(parseRpeChart(out.json, { file: 'roundtrip.json' }));
  const cmp = compareModels(rpe, back);
  check('逐帧对比：RPE 往返完全一致（<1e-6）', cmp.line < 1e-6 && cmp.note < 1e-6, `线 Δ=${cmp.line.toExponential(2)} 音符 Δ=${cmp.note.toExponential(2)}`);
  let maxDx = 0;
  for (let i = 0; i < rpe.notes.length; i++) maxDx = Math.max(maxDx, Math.abs(rpe.notes[i].positionX - back.notes[i].positionX));
  check('positionX 往返一致（<1e-6 X）', maxDx < 1e-6, `maxΔ=${maxDx.toExponential(2)}`);

  // RPE -> 官谱：多层合并 + 单位换算 + 哨兵，重新解析后时间与高度必须一致
  const cross = serializeOfficial(rpe);
  const crossProblems = checkOfficialConstraints(cross.json);
  check('RPE -> 官谱：满足官谱硬约束', crossProblems.length === 0, crossProblems.slice(0, 3).join(' | ') || 'ok');
  const crossBack = prepareChart(parseOfficialChart(cross.json, { file: 'cross.json' }));
  let crossDt = 0;
  let crossType = 0;
  for (let i = 0; i < rpe.notes.length; i++) {
    crossDt = Math.max(crossDt, Math.abs(rpe.notes[i].timeSec - crossBack.notes[i].timeSec));
    if (rpe.notes[i].type !== crossBack.notes[i].type) crossType++;
  }
  check('RPE -> 官谱：音符时间与类型不变', crossDt < 1e-6 && crossType === 0, `maxΔt=${crossDt.toExponential(2)} 类型不一致 ${crossType}`);
  const crossCmp = compareModels(rpe, crossBack);
  check('RPE -> 官谱：逐帧画面一致（线性谱面，<1e-3）', crossCmp.line < 1e-3 && crossCmp.note < 1e-3, `线 Δ=${crossCmp.line.toExponential(2)} 音符 Δ=${crossCmp.note.toExponential(2)}`);
  check('RPE -> 官谱：给出「缓动/扩展事件会丢失」的告警', cross.warnings.some((w) => /扩展事件/.test(w)), cross.warnings.join(' | '));

  // 官谱 -> RPE（另一个方向）
  if (hasSample('official')) {
    const toRpe = serializeRpe(official);
    const toRpeBack = prepareChart(parseRpeChart(toRpe.json, { file: 'official-as-rpe.json' }));
    let dt = 0;
    let dx = 0;
    for (let i = 0; i < official.notes.length; i++) {
      dt = Math.max(dt, Math.abs(official.notes[i].timeSec - toRpeBack.notes[i].timeSec));
      dx = Math.max(dx, Math.abs(official.notes[i].positionX - toRpeBack.notes[i].positionX));
    }
    check('官谱 -> RPE：音符时间与位置一致', dt < 1e-6 && dx < 1e-5, `maxΔt=${dt.toExponential(2)} maxΔx=${dx.toExponential(2)}`);
    // RPE 的 alpha 是 0–255 整数、官方是 0..1 浮点：这一项必然有 ≤1/255 的量化误差
    const toRpeCmp = compareModels(official, toRpeBack);
    check('官谱 -> RPE：旋转/位移换算方向正确（alpha 量化误差 ≤ 1/255）', toRpeCmp.line < 3e-3, `线 Δ=${toRpeCmp.line.toExponential(2)}`);
    check('官谱 -> RPE：给出 alpha 量化的告警', toRpe.warnings.some((w) => /alpha/.test(w)), toRpe.warnings.join(' | '));
  }
}

section('内部项目格式：序列化 + 反序列化（project）');
{
  // 合成用例：多层 + 缓动 + 贝塞尔 + 负 alpha + 假音符 + 变速 BPM —— 项目格式必须无损
  const synthetic = {
    format: 'rpe',
    source: { rpeVersion: 140, xybind: true },
    META: {
      RPEVersion: 140,
      name: '项目往返用例',
      composer: 'c',
      charter: 'ch',
      illustrator: 'il',
      level: 'AT Lv.15',
      id: '42',
      song: 'a.wav',
      background: 'b.png',
      offset: 250, // 毫秒
    },
    BPMList: [
      { startTime: [0, 0, 1], bpm: 180 },
      { startTime: [8, 0, 1], bpm: 90 },
    ],
    judgeLineGroup: ['Default', 'Extra'],
    multiLineString: '1:2',
    multiScale: 2,
    xybind: true,
    judgeLineList: [
      {
        Group: 1,
        Name: '主线',
        Texture: 'custom.png',
        zOrder: 3,
        bpmfactor: 1.5,
        isCover: 1,
        father: -1,
        posControl: [{ x: 0, easing: 1, pos: 1 }],
        attachUI: 'ui',
        extended: {
          inclineEvents: [{ startTime: [0, 0, 1], endTime: [1, 0, 1], start: 0, end: 0, easingType: 1 }],
          scaleXEvents: [{ startTime: [0, 0, 1], endTime: [8, 0, 1], start: 1, end: 1.75, easingType: 9, easingLeft: 0.25, easingRight: 0.75 }],
          scaleYEvents: [{ startTime: [0, 0, 1], endTime: [8, 0, 1], start: 2, end: 0.5, easingType: 6, bezier: 1, bezierPoints: [0.25, 0.1, 0.25, 1] }],
          colorEvents: [{ startTime: [0, 0, 1], endTime: [8, 0, 1], start: [255, 255, 255], end: [12, 200, 60], easingType: 1 }],
        },
        eventLayers: [
          {
            moveXEvents: [
              { startTime: [-4, 7, 8], endTime: [4, 0, 1], start: -100, end: 300, easingType: 9, easingLeft: 0.25, easingRight: 0.75, bezier: 0, bezierPoints: [0, 0, 0, 0] },
              { startTime: [4, 0, 1], endTime: [31250000, 0, 1], start: 300, end: 300, easingType: 1 },
            ],
            moveYEvents: [
              { startTime: [-4, 7, 8], endTime: [4, 0, 1], start: 0, end: 0, easingType: 6, bezier: 1, bezierPoints: [0.25, 0.1, 0.25, 1] },
              { startTime: [4, 0, 1], endTime: [31250000, 0, 1], start: 0, end: 0, easingType: 1 },
            ],
            rotateEvents: [{ startTime: [-4, 7, 8], endTime: [31250000, 0, 1], start: 0, end: 450, easingType: 1 }],
            alphaEvents: [
              { startTime: [-4, 7, 8], endTime: [4, 0, 1], start: 255, end: -30, easingType: 1 },
              { startTime: [4, 0, 1], endTime: [31250000, 0, 1], start: 255, end: 255, easingType: 1 },
            ],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 10.8, end: 10.8 }],
          },
          {
            moveXEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 50, end: 50, easingType: 1 }],
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 0, end: 0, easingType: 1 }],
          },
        ],
        notes: [
          { type: 1, startTime: [1, 0, 1], endTime: [1, 0, 1], positionX: 100, above: 1, alpha: 255, size: 1.2, speed: 1.5, yOffset: 30, visibleTime: 2, isFake: 0 },
          { type: 2, startTime: [2, 1, 4], endTime: [5, 0, 1], positionX: -200, above: 2, alpha: 128, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0, tint: [10, 20, 30] },
          { type: 4, startTime: [3, 0, 1], endTime: [3, 0, 1], positionX: 0, above: 1, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 1, hitsound: 'x.wav' },
        ],
      },
      {
        Name: '子线',
        father: 0,
        rotateWithFather: true,
        eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 255, end: 255, easingType: 1 }] }],
        notes: [],
      },
    ],
  };
  const base = prepareChart(parseRpeChart(synthetic, { file: 'synthetic.json' }));
  check('合成用例解析：2 条线 / 3 个音符 / 2 层', base.lines.length === 2 && base.notes.length === 3 && base.lines[0].layers.length === 2);

  // 序列化 -> 反序列化（模拟「保存项目 -> 重新打开」）
  const saved = serializeProject(base, { savedAt: '2025-01-01T00:00:00.000Z' });
  check('项目文件带识别标记与版本', saved.json.format === 'phichart-project' && saved.json.version === 1);
  check('项目文件能被 detectFormat 识别为 project', detectFormat(saved.json) === 'project');
  const text = JSON.stringify(saved.json);
  const restored = prepareChart(parseProject(JSON.parse(text), { file: 'p.pce.json' }));

  check('反序列化：判定线 / 音符数一致', restored.lines.length === base.lines.length && restored.notes.length === base.notes.length);
  check('反序列化：格式与来源（rpe / RPEVersion / xybind）保留', restored.source.sourceFormat === 'rpe' && restored.source.rpeVersion === 140 && restored.source.xybind === true);
  check('反序列化：元数据（含毫秒 offset 换算）一致', restored.meta.name === '项目往返用例' && restored.meta.offset === 0.25 && restored.meta.level === 'AT Lv.15');
  check('反序列化：变速 BPMList 一致', JSON.stringify(restored.timing.bpmList) === JSON.stringify(base.timing.bpmList), JSON.stringify(restored.timing.bpmList));
  check('反序列化：line.bpmFactor / 分组 / zOrder / 贴图 / 父线保留', restored.lines[0].bpmFactor === 1.5 && restored.lines[0].zOrder === 3 && restored.lines[0].texture === 'custom.png' && restored.lines[1].father === 0 && restored.lines[1].rotateWithFather === true);
  check('反序列化：缓动函数被重新建出来（不再是 undefined）', typeof restored.lines[0].layers[0].x[0].easingFn === 'function');
  check('反序列化：缓动编号与裁剪区间保留（9 / 0.25 / 0.75）', restored.lines[0].layers[0].x[0].easingPreset === 9 && restored.lines[0].layers[0].x[0].easingLeft === 0.25 && restored.lines[0].layers[0].x[0].easingRight === 0.75);
  check('反序列化：贝塞尔控制点保留', JSON.stringify(restored.lines[0].layers[0].y[0].bezierPoints) === JSON.stringify([0.25, 0.1, 0.25, 1]));
  check('反序列化：音符类型/上下方向/假音符/自定义贴图字段保留', restored.lines[0].notes[1].type === 'hold' && restored.lines[0].notes[1].above === false && restored.lines[0].notes[2].isFake === true && JSON.stringify(restored.lines[0].notes[1].tint) === JSON.stringify([10, 20, 30]) && restored.lines[0].notes[2].hitsound === 'x.wav');
  // 扩展事件：已实现的键进 `line.extended`（规范事件），未实现的键原样进 `line.extendedRaw`
  check(
    '反序列化：扩展事件与未建模字段保留',
    !!restored.lines[0].extendedRaw?.inclineEvents && restored.lines[0].raw?.attachUI === 'ui' && Array.isArray(restored.lines[0].raw?.posControl),
    `extendedRaw=${Object.keys(restored.lines[0].extendedRaw ?? {}).join(',') || '无'}`,
  );
  check(
    '反序列化：已实现的扩展键（scaleX / scaleY / color）保留为规范事件',
    ['scaleX', 'scaleY', 'color'].every((k) => restored.lines[0].extended?.[k]?.length === 1),
    Object.keys(restored.lines[0].extended ?? {}).join(','),
  );
  check(
    '反序列化：颜色事件仍为三元组、数值事件仍是数值',
    JSON.stringify(restored.lines[0].extended.color[0].start) === '[255,255,255]' && restored.lines[0].extended.scaleX[0].start === 1,
    `${JSON.stringify(restored.lines[0].extended.color[0].start)} / ${restored.lines[0].extended.scaleX[0].start}`,
  );
  check(
    '反序列化：扩展事件的缓动编号 / 裁剪 / 贝塞尔保留',
    restored.lines[0].extended.scaleX[0].easingPreset === 9 &&
      restored.lines[0].extended.scaleX[0].easingLeft === 0.25 &&
      JSON.stringify(restored.lines[0].extended.scaleY[0].bezierPoints) === JSON.stringify([0.25, 0.1, 0.25, 1]),
    `scaleX preset=${restored.lines[0].extended.scaleX[0].easingPreset} scaleY bezier=${JSON.stringify(restored.lines[0].extended.scaleY[0].bezierPoints)}`,
  );

  const cmp = compareModels(base, restored, 400);
  check('项目往返逐帧完全一致（缓动曲线/多层相加都还原）', cmp.line < 1e-9 && cmp.note < 1e-9, `线 Δ=${cmp.line.toExponential(2)} 音符 Δ=${cmp.note.toExponential(2)}`);

  // 反序列化后的模型必须还能再导出成 RPE 与官谱
  const again = serializeRpe(restored);
  check('反序列化后的模型可再导出 RPE（缓动编号写回）', again.json.judgeLineList[0].eventLayers[0].moveXEvents[0].easingType === 9);
  const asOfficial = serializeOfficial(restored);
  check('反序列化后的模型可再导出官谱（缓动被折线近似 + 告警）', checkOfficialConstraints(asOfficial.json).length === 0 && asOfficial.warnings.some((w) => /缓动/.test(w)));

  // 非项目文件必须报可读错误
  let threw = null;
  try {
    parseProject({ judgeLineList: [] });
  } catch (err) {
    threw = err;
  }
  check('非项目文件反序列化时抛出可读错误', !!threw && /项目文件/.test(threw.message), threw?.message ?? '（没有抛错）');
}

section('导出打包：zip 写出 + 包内容');
{
  const zipBlob = await createZip([
    { name: 'chart.json', data: '{"formatVersion":3}' },
    { name: '音乐 #1.wav', data: new Uint8Array(3000).fill(9) },
    { name: '../非法/名字?.txt', data: 'x'.repeat(5000) },
  ]);
  const buf = await zipBlob.arrayBuffer();
  const entries = await readZip(buf);
  check('zip 写出后能被自己的 readZip 读回', entries.size === 3, [...entries.keys()].join(' | '));
  check('中文/空格/# 文件名不乱码', entries.has('音乐 #1.wav') && entries.has('chart.json'));
  check('非法文件名被安全化（不出现路径穿越 / 绝对路径）', [...entries.keys()].every((k) => !k.split('/').includes('..') && !k.startsWith('/') && !/^[a-zA-Z]:/.test(k)), [...entries.keys()].join(' | '));
  const inflate = await loadZipPackage(buf, 'test.zip');
  check('loadZipPackage 能整包载入（store / deflate 两种方式都能解）', inflate.files.size === 3, `${inflate.files.size} 个文件`);

  if (hasSample('rpe')) {
    const media = {
      song: { name: 'song #1.wav', blob: new Blob([new Uint8Array(1000).fill(1)]) },
      background: { name: 'bg.png', blob: new Blob([new Uint8Array(2000).fill(2)]) },
    };
    const officialZip = await buildChartZip(rpe, 'official', { media });
    const entries2 = await readZip(await officialZip.blob.arrayBuffer());
    check('官谱 zip 包内含 谱面 JSON + info.txt + 音频 + 曲绘', entries2.size === 4, [...entries2.keys()].join(' | '));
    check('zip 包名带 [official] 后缀', /\[official\]\.zip$/.test(officialZip.fileName), officialZip.fileName);
    check('音频/曲绘按导出元数据的文件名写进包里', entries2.has('song #1.wav') && entries2.has('bg.png') && officialZip.json.judgeLineList.length === 24);
    const pkg = await loadZipPackage(await officialZip.blob.arrayBuffer(), officialZip.fileName);
    check('整包可载入并认出谱面/音频/曲绘（引用解析正确）', !!pkg.chartJson && pkg.songPath === 'song #1.wav' && pkg.backgroundPath === 'bg.png', `${pkg.chartPath} / ${pkg.songPath} / ${pkg.backgroundPath}`);
    check('info.txt 的曲名与音频引用与元数据一致', pkg.info?.Name === rpe.meta.name && pkg.info?.Song === 'song #1.wav', `${pkg.info?.Name} / ${pkg.info?.Song}`);
    check('官谱 zip 载入后无「找不到谱面」告警', !pkg.warnings.some((w) => /没有找到可用的谱面/.test(w)), pkg.warnings.join(' | ') || '无');

    const rpeZip = await buildChartZip(rpe, 'rpe', { media });
    const pkg2 = await (await import('../src/core/package.js')).loadZipPackage(await rpeZip.blob.arrayBuffer(), rpeZip.fileName);
    check('RPE zip 包同样可整包载入（META 里的音频/曲绘引用有效）', !!pkg2.chartJson && pkg2.chartJson.META.song === 'song #1.wav' && pkg2.chartJson.META.background === 'bg.png', JSON.stringify(pkg2.chartJson?.META));
    check('RPE zip 包名带 [RPE] 后缀', /\[RPE\]\.zip$/.test(rpeZip.fileName), rpeZip.fileName);
    check(
      '导出 RPE / 官谱都会自动带上 info.txt（包内元数据与谱面一致）',
      rpeZip.entries.includes('info.txt') &&
        officialZip.entries.includes('info.txt') &&
        pkg2.info?.Name === rpe.meta.name,
      `RPE: ${rpeZip.entries.join(' | ')}　官谱: ${officialZip.entries.join(' | ')}`,
    );

    const proj = buildProjectJson(rpe);
    check('单文件项目（.pce.json，不含资源）也能生成与读回', /\.pce\.json$/.test(proj.fileName) && prepareChart(parseProject(JSON.parse(proj.text))).notes.length === rpe.notes.length, proj.fileName);

    // ── 项目 zip：project.json + info.txt + **全部资源文件**（重新打开不会丢音频/曲绘）──
    const assets = [
      { name: 'song #1.wav', blob: media.song.blob },
      { name: 'bg.png', blob: media.background.blob },
      { name: 'tex/line_custom.png', blob: new Blob([new Uint8Array(1200).fill(3)]) },
      { name: 'hit.mp3', blob: new Blob([new Uint8Array(800).fill(4)]) },
    ];
    const projZip = await buildProjectZip(rpe, { resources: assets, media });
    const projFiles = await unzipToFiles(await projZip.blob.arrayBuffer());
    const names = [...projFiles.keys()];
    check('项目 zip 含 project.json + info.txt + 全部资源文件', ['project.json', 'info.txt', 'song #1.wav', 'bg.png', 'tex/line_custom.png', 'hit.mp3'].every((n) => names.includes(n)), names.join(' | '));
    /**
     * 关键回归：资源条目的**内容**必须真的写进去了。
     *
     * 此前只断言「文件名在不在」，于是漏掉了一个真实故障：`createZip` 只认 `entry.data`，
     * 而 `buildProjectZip` 的 resources 用的是 `{ name, blob }` —— `entry.data` 是 undefined，
     * 写出来全是 **0 字节**：谱面 JSON 完好、音频与曲绘全空（zip 里 crc=00000000、size=0），
     * 用户在资源管理器里看到「大小 0 / 压缩后 0」。所以这里逐个核对字节数。
     */
    {
      const expected = new Map([
        ['song #1.wav', media.song.blob.size],
        ['bg.png', media.background.blob.size],
        ['tex/line_custom.png', 1200],
        ['hit.mp3', 800],
      ]);
      const wrong = [];
      for (const [name, size] of expected) {
        const got = projFiles.get(name)?.size ?? -1;
        if (got !== size) wrong.push(`${name}: ${got} ≠ ${size}`);
      }
      check('项目 zip 里每个资源都有真实内容（不是 0 字节空文件）', wrong.length === 0, wrong.join('；') || '全部匹配');
      check(
        '项目 zip 的资源非空（音频 / 曲绘 / 贴图都在）',
        [...expected.keys()].every((n) => (projFiles.get(n)?.size ?? 0) > 0),
        [...expected.keys()].map((n) => `${n}=${projFiles.get(n)?.size ?? '缺失'}`).join(' '),
      );
      // 媒体与 resources 指向同一个 blob 时不能重复写两遍
      check(
        '同一份媒体不会在包里出现两次',
        names.filter((n) => n === 'song #1.wav').length === 1 && names.filter((n) => n === 'bg.png').length === 1,
        names.filter((n) => /wav|png/.test(n)).join(' | '),
      );
    }
    // createZip 两种字段名都要接受（data / blob），避免再次因字段名不一致静默写出空文件
    {
      const { createZip } = await import('../src/core/zip.js');
      const withData = await unzipToFiles(await (await createZip([{ name: 'a.bin', data: new Uint8Array(321) }])).arrayBuffer());
      const withBlob = await unzipToFiles(await (await createZip([{ name: 'a.bin', blob: new Blob([new Uint8Array(321)]) }])).arrayBuffer());
      check('createZip 接受 data 字段', withData.get('a.bin')?.size === 321, String(withData.get('a.bin')?.size));
      check('createZip 接受 blob 字段（resources 用的就是它）', withBlob.get('a.bin')?.size === 321, String(withBlob.get('a.bin')?.size));
    }
    check('项目 zip 的文件名是 .pce.zip', /\.pce\.zip$/.test(projZip.fileName), projZip.fileName);
    const found = await findProjectFile(projFiles);
    check('项目 zip 能被识别为项目文件（打开路径）', !!found && found.json.format === 'phichart-project', found?.path ?? '（没找到）');
    const fromZip = prepareChart(parseProject(found.json, { file: found.path }));
    check('项目 zip 反序列化后与源谱面一致（音符数 + 缓动）', fromZip.notes.length === rpe.notes.length && typeof fromZip.lines[1].layers[0].alpha[0].easingFn === 'function', `${fromZip.notes.length}`);
    check('项目 zip 里的 info.txt 记着包内资源文件名', /Song: song #1\.wav/.test(await projFiles.get('info.txt').blob.text()));
    // 播放器路径：项目 zip 必须也能当包读（曾经报「包内没有找到可用的谱面 json」）
    {
      const pkg = await buildPackage('p.pce.zip', projFiles);
      check(
        '播放器读项目 zip：谱面取自 project.json（含 lines，不再报「没找到 json」）',
        !!pkg.chartJson && Array.isArray(pkg.chartJson.lines),
        `chartPath=${pkg.chartPath ?? '（无）'}｜告警 ${pkg.warnings.join('；') || '（无）'}`,
      );
      check(
        '项目 zip 的谱面可编译（判定线数与源谱面一致）',
        (() => {
          const built = prepareChart(pkg.chartJson);
          return built.lines.filter(Boolean).length === rpe.lines.length;
        })(),
        `${pkg.chartJson?.lines?.length} 线`,
      );
      check('项目 zip 的元数据取自内层 chart.meta（曲名不丢）', pkg.meta?.name === rpe.meta.name, `meta.name=${pkg.meta?.name}`);
    }
  }
}

// ---------------------------------------------------------------- 判定范围（音符判定带 / 全屏）
// ---------------------------------------------------------------- AI 提示词守卫（正文内嵌在 src/ai/prompt.js 的 SYSTEM_PROMPT）
section('AI 提示词守卫');
{
  const aiPrompt = await import('../src/ai/prompt.js');
  const promptText = await aiPrompt.loadSystemPrompt();
  check('系统提示词非空且来源为内置', promptText.length > 0 && aiPrompt.systemPromptSource() === 'builtin', `${promptText.length} 字符`);
  check('系统提示词在字数上限内', promptText.length <= aiPrompt.PROMPT_MAX_CHARS, `${promptText.length} / ${aiPrompt.PROMPT_MAX_CHARS}`);
  check('系统提示词含全部工具名', aiPrompt.PROMPT_TOOL_NAMES.every((n) => promptText.includes(n)));
  check('系统提示词含时间与坐标单位说明', aiPrompt.PROMPT_UNIT_KEYS.every((k) => promptText.includes(k)));
  check('系统提示词未把位移事件说成官方 Y 单位（事件值直通内部比例）', !promptText.includes('纵向位移与速度事件用官方 Y 单位'));
}

// ---------------------------------------------------------------- 跨事件层 / 跨判定线的复制粘贴
section('剪贴板：跨事件层 / 跨判定线的粘贴定向规则（resolvePasteTarget）');
{
  const { serializeRefs, resolvePasteTarget, bufferTrackKeys, bufferLineCount, pasteBuffer } = await import('../src/editor/clipboard.js');
  const { prepareChart } = await import('../src/core/model.js');

  /** 一条线、两个事件层（各含 x / y 键），用来验证跨层改指 */
  const mkChart = () =>
    prepareChart({
      lines: [
        {
          id: 0,
          name: 'L',
          layers: [
            { x: [{ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }],
              y: [{ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }] },
            { x: [], y: [] },
          ],
          notes: [],
          extended: { x: [] },
        },
      ],
      notes: [],
      timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
      meta: {},
      warnings: [],
    });
  const chart = mkChart();
  const L0X = chart.lines[0].layers[0].x;
  const L1X = chart.lines[0].layers[1].x;
  const L1Y = chart.lines[0].layers[1].y;

  const refOf = (obj, key, layerIndex = 0) => ({
    kind: 'event',
    lineId: 0,
    layerIndex,
    key,
    obj,
    axisBeat: Number.isFinite(obj.startBeat) ? obj.startBeat : 0,
  });
  const bufL0X = serializeRefs([refOf(L0X[0], 'x', 0)]);
  check('缓冲里记下了来源轨道', bufferTrackKeys(bufL0X).size === 1 && bufferTrackKeys(bufL0X).has('0:0:x'), [...bufferTrackKeys(bufL0X)].join(','));

  const T = (layerIndex, key, extra = {}) => ({ lineId: 0, layerIndex, key, camera: false, ...extra });

  // ① 活跃轨就是源轨道 → 照常（同轨换时间）
  const r1 = resolvePasteTarget(bufL0X, T(0, 'x'));
  check(
    '活跃轨 = 源轨道 → 允许（同一轨道换时间）',
    r1.ok === true && r1.events[0].layerIndex === 0 && r1.retarget === null,
    r1.ok ? `layerIndex=${r1.events[0].layerIndex} retarget=${r1.retarget}` : r1.reason,
  );

  // ② 单条轨道的选区 + 活跃轨在另一层同类型轨 → 跨层改指
  const r2 = resolvePasteTarget(bufL0X, T(1, 'x'));
  check(
    '单轨选区 + 活跃轨在另一层的同类型轨 → 改指到那一层',
    r2.ok === true && r2.events[0].layerIndex === 1 && r2.retarget === 'layer',
    r2.ok ? `→ 层 ${r2.events[0].layerIndex} 的 ${r2.events[0].key}（retarget=${r2.retarget}）` : r2.reason,
  );

  // ③ 活跃轨是另一层的「异类」键 → 仍然改层，但**按各自的 key 落位**（不是塞进活跃轨那个键）
  const r3 = resolvePasteTarget(bufL0X, T(1, 'y'));
  check(
    '活跃轨是另一层的**不同类型**轨 → 照样改层，但落到自己那个键（x 仍进 x 轨）',
    r3.ok === true && r3.retarget === 'layer' && r3.events[0].layerIndex === 1 && r3.events[0].key === 'x',
    r3.ok ? `retarget=${r3.retarget}，落到层 ${r3.events[0].layerIndex} 的 ${r3.events[0].key} 轨` : r3.reason,
  );

  // ④ 扩展事件（layerIndex = null）也走同一套
  chart.lines[0].extended.x.push({ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 });
  const bufExt = serializeRefs([refOf(chart.lines[0].extended.x[0], 'x', null)]);
  check('扩展事件：活跃轨 = 同一条扩展轨 → 允许', resolvePasteTarget(bufExt, T(null, 'x')).ok === true);
  check('扩展事件：活跃轨是普通事件层的 x → 改层', resolvePasteTarget(bufExt, T(1, 'x')).retarget === 'layer');
  check(
    '扩展事件：活跃轨是普通事件层的 y → 仍改层（按自己的 key 落位）',
    resolvePasteTarget(bufExt, T(1, 'y')).retarget === 'layer',
    String(resolvePasteTarget(bufExt, T(1, 'y')).retarget),
  );

  // ⑤ 跨轨道但**同一层** → 活跃轨在另一层时改层
  const sameLayer = serializeRefs([
    refOf(L0X[0], 'x', 0),
    refOf({ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }, 'y', 0),
  ]);
  check('同层两条轨道的选区', bufferTrackKeys(sameLayer).size === 2, [...bufferTrackKeys(sameLayer)].join(','));
  const r5 = resolvePasteTarget(sameLayer, T(1, 'x'));
  check(
    '跨轨道但同层 + 活跃轨在另一层 → 改层（各按自己的 key 落到目标层）',
    r5.ok === true && r5.retarget === 'layer' && r5.events.every((e) => e.layerIndex === 1),
    r5.ok ? `retarget=${r5.retarget}，keys ${[...new Set(r5.events.map((e) => e.key))].join('+')} 落到层 ${[...new Set(r5.events.map((e) => e.layerIndex))].join(',')}` : r5.reason,
  );
  check(
    '跨轨道但同层 + 活跃轨仍在同一层 → 退回原处',
    resolvePasteTarget(sameLayer, T(0, 'x')).retarget === null,
    String(resolvePasteTarget(sameLayer, T(0, 'x')).retarget),
  );

  // ⑥ 跨层但**同一条线** → 活跃轨在另一条线时改线
  const mkChart2 = () =>
    prepareChart({
      lines: [
        { id: 0, name: 'A', layers: [{ x: [{ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }], y: [] }], notes: [], extended: {} },
        { id: 1, name: 'B', layers: [{ x: [] }, { x: [] }], notes: [], extended: {} },
      ],
      notes: [],
      timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
      meta: {},
      warnings: [],
    });
  const crossLine = serializeRefs([
    { kind: 'event', lineId: 0, layerIndex: 0, key: 'x', obj: { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }, axisBeat: 0 },
    { kind: 'event', lineId: 0, layerIndex: 1, key: 'x', obj: { startBeat: 8, endBeat: 12, start: 0, end: 1, easingType: 1 }, axisBeat: 8 },
  ]);
  check('跨层但同线的选区', bufferLineCount(crossLine) === 1 && bufferTrackKeys(crossLine).size === 2, `线 ${bufferLineCount(crossLine)} 条 / 轨 ${bufferTrackKeys(crossLine).size} 条`);
  const r6 = resolvePasteTarget(crossLine, { lineId: 1, layerIndex: 0, key: 'x', camera: false });
  check(
    '跨层但同线 + 活跃轨在另一条线 → 改线',
    r6.ok === true && r6.retarget === 'line' && r6.events.every((e) => e.lineId === 1),
    r6.ok ? `retarget=${r6.retarget}，全部落到线 ${[...new Set(r6.events.map((e) => e.lineId))].join(',')}` : r6.reason,
  );
  check(
    '跨层但同线 + 活跃轨仍在同一条线 → 退回原处',
    resolvePasteTarget(crossLine, { lineId: 0, layerIndex: 1, key: 'x', camera: false }).retarget === null,
  );

  // ⑦ 跨层**又**跨线 → 一律退回原处
  const crossBoth = serializeRefs([
    { kind: 'event', lineId: 0, layerIndex: 0, key: 'x', obj: { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }, axisBeat: 0 },
    { kind: 'event', lineId: 1, layerIndex: 1, key: 'x', obj: { startBeat: 8, endBeat: 12, start: 0, end: 1, easingType: 1 }, axisBeat: 8 },
  ]);
  check(
    '跨层又跨线 → 一律退回原处（不做任何改指）',
    resolvePasteTarget(crossBoth, { lineId: 1, layerIndex: 0, key: 'x', camera: false }).retarget === null,
    String(resolvePasteTarget(crossBoth, { lineId: 1, layerIndex: 0, key: 'x', camera: false }).retarget),
  );
  check('跨层又跨线 + 没有活跃轨信息 → 也退回原处', resolvePasteTarget(crossBoth, null).retarget === null);

  // ⑧ 只有音符：不涉及事件层与键，永远放行
  const noteBuf = serializeRefs([
    { kind: 'note', lineId: 0, layerIndex: null, key: 'notes', obj: { type: 'tap', startBeat: 0, endBeat: 0, positionX: 0 }, axisBeat: 0 },
  ]);
  check('只有音符时不受事件层限制', resolvePasteTarget(noteBuf, T(1, 'y')).ok === true && resolvePasteTarget(noteBuf, null).ok === true);

  // ⑨ 真落地：改层粘贴真的写进了目标层
  const chart2 = mkChart();
  const buf2 = serializeRefs([
    { kind: 'event', lineId: 0, layerIndex: 0, key: 'x', obj: chart2.lines[0].layers[0].x[0], axisBeat: 0 },
  ]);
  const axis2 = (await import('../src/editor/tracks.js')).createBeatAxis(chart2);
  const before1 = chart2.lines[0].layers[1].x.length;
  const res = pasteBuffer(buf2, { chart: chart2, axis: axis2, atAxisBeat: 8, target: { lineId: 0, layerIndex: 1, key: 'x', camera: false } });
  check(
    '改层粘贴真的写进了目标层（而不是回到原层）',
    res.events.length === 1 && res.retarget === 'layer' && chart2.lines[0].layers[1].x.length === before1 + 1 && chart2.lines[0].layers[0].x.length === 1,
    `层0 保持 ${chart2.lines[0].layers[0].x.length} 条，层1 ${before1} → ${chart2.lines[0].layers[1].x.length}`,
  );
  check('粘贴后事件落在目标拍上', Math.abs(chart2.lines[0].layers[1].x.at(-1).startBeat - 8) < 1e-6, String(chart2.lines[0].layers[1].x.at(-1).startBeat));

  // ⑩ 异类键：不写入目标轨（退回原处）
  const chart3 = mkChart();
  const buf3 = serializeRefs([
    { kind: 'event', lineId: 0, layerIndex: 0, key: 'x', obj: chart3.lines[0].layers[0].x[0], axisBeat: 0 },
  ]);
  const res3 = pasteBuffer(buf3, { chart: chart3, axis: axis2, atAxisBeat: 8, target: { lineId: 0, layerIndex: 1, key: 'y', camera: false } });
  check(
    '异类键（活跃轨是 y、内容含 x）：仍改层，且 x 落进**目标层的 x 轨**（不写进 y）',
    res3.events.length === 1 && res3.retarget === 'layer' && chart3.lines[0].layers[1].y.length === 0 && chart3.lines[0].layers[1].x.length === 1,
    `目标层 y 轨 ${chart3.lines[0].layers[1].y.length} 条（应 0）、x 轨 ${chart3.lines[0].layers[1].x.length} 条（应 1），retarget=${res3.retarget}`,
  );

  // ⑫ **用户截图场景**：同一条线同一层选中 5 类事件 → 粘到另一条线 / 另一层的对应 5 条轨
  {
    const five = ['x', 'y', 'rotate', 'alpha', 'speed'];
    const fiveBuf = serializeRefs(
      five.map((k, i) => ({
        kind: 'event',
        lineId: 0,
        layerIndex: 0,
        key: k,
        obj: { startBeat: i, endBeat: i + 2, start: 0, end: 1, easingType: 1 },
        axisBeat: i,
      })),
    );
    check('截图场景：选区是 5 条轨道但同一层', bufferTrackKeys(fiveBuf).size === 5 && bufferLineCount(fiveBuf) === 1);

    const rLine = resolvePasteTarget(fiveBuf, { lineId: 1, layerIndex: 0, key: 'x', camera: false });
    const destLine = rLine.ok ? [...new Set(rLine.events.map((e) => `${e.lineId}/${e.layerIndex}/${e.key}`))].sort() : [];
    check(
      '粘到 1 号线（活跃轨是 1 号线任一条轨）→ 5 类事件各落到 1 号线的对应 5 条轨',
      rLine.ok === true &&
        rLine.retarget === 'line' &&
        rLine.events.every((e) => e.lineId === 1) &&
        rLine.events.map((e) => e.key).sort().join(',') === [...five].sort().join(','),
      destLine.join('  ') || rLine.reason,
    );

    // 活跃轨只是 1 号线里的**某一条**（例如 speed），其余 4 条也要跟着过去
    const rAny = resolvePasteTarget(fiveBuf, { lineId: 1, layerIndex: 0, key: 'speed', camera: false });
    check(
      '活跃轨是 1 号线里的 speed 也一样：5 条全部改线（活跃轨只决定去哪条线）',
      rAny.ok === true && rAny.retarget === 'line' && rAny.events.every((e) => e.lineId === 1) && rAny.events.length === 5,
      `retarget=${rAny.retarget}，${rAny.events.length} 条，全部到线 ${[...new Set(rAny.events.map((e) => e.lineId))].join(',')}`,
    );

    const rLayer = resolvePasteTarget(fiveBuf, { lineId: 0, layerIndex: 1, key: 'x', camera: false });
    check(
      '粘到 0 号线的另一个事件层 → 5 类事件各落到那一层的对应 5 条轨',
      rLayer.ok === true &&
        rLayer.retarget === 'layer' &&
        rLayer.events.every((e) => e.lineId === 0 && e.layerIndex === 1) &&
        rLayer.events.length === 5,
      rLayer.ok ? [...new Set(rLayer.events.map((e) => `${e.lineId}/${e.layerIndex}/${e.key}`))].sort().join('  ') : rLayer.reason,
    );

    // 活跃轨就在原轨上 → 同轨换时间
    const rSame = resolvePasteTarget(fiveBuf, { lineId: 0, layerIndex: 0, key: 'x', camera: false });
    check('活跃轨仍在原层原线 → 退回原处（同轨换时间）', rSame.retarget === null, String(rSame.retarget));
  }

  // ⑪ 相机事件：只能在相机轨之间走
  const camBuf = serializeRefs([
    { kind: 'event', lineId: -1, layerIndex: null, key: 'x', camera: true, obj: { startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }, axisBeat: 0 },
  ]);
  check('相机事件：落到相机轨 → 允许', resolvePasteTarget(camBuf, { lineId: -1, layerIndex: null, key: 'x', camera: true }).ok === true);
  check(
    '相机事件：落到判定线事件轨 → 拒绝（语义不同）',
    resolvePasteTarget(camBuf, { lineId: 0, layerIndex: 0, key: 'x', camera: false }).ok === false,
    resolvePasteTarget(camBuf, { lineId: 0, layerIndex: 0, key: 'x', camera: false }).reason,
  );
  check(
    '判定线事件：落到相机轨 → 拒绝',
    resolvePasteTarget(bufL0X, { lineId: -1, layerIndex: null, key: 'x', camera: true }).ok === false,
  );
}

// ---------------------------------------------------------------- 导出时的谱面长度
section('导出：谱面长度至少覆盖音频（避免导出再打开后时间轴拖不动）');
{
  const { prepareChart } = await import('../src/core/model.js');
  const { buildProjectZip, withExportLength } = await import('../src/core/export-package.js');
  const { unzipToFiles, findProjectFile } = await import('../src/core/package.js');
  const { parseProject } = await import('../src/core/project.js');
  const { createBeatAxis } = await import('../src/editor/tracks.js');

  /** 复刻用户踩到的形状：**没有音符**、事件只到第 5 拍，但音频有 161.7 秒 */
  const mk = (meta, endBeat = 5) =>
    prepareChart({
      lines: [{ id: 0, name: 'L', layers: [{ x: [{ startBeat: 0, endBeat, start: 0, end: 1, easingType: 1 }] }], notes: [], extended: {} }],
      notes: [],
      timing: { bpmList: [{ beat: 0, bpm: 174 }], bpmFactor: 1 },
      meta,
      warnings: [],
    });

  const AUDIO = 161.7;
  const expectedBeats = (AUDIO * 174) / 60;

  // ① 有音频时长 → 谱面长度按音频
  const ch = mk({ audioDuration: AUDIO });
  check('有音频时长时 totalSec 取音频长度（音符为 0 也不怕）', Math.abs(ch.totalSec - AUDIO) < 1e-6, `totalSec=${ch.totalSec}`);
  check(
    '时间轴总拍数按音频撑开（不再是 5 拍）',
    Math.abs(createBeatAxis(ch).totalBeats - expectedBeats) < 1,
    `${createBeatAxis(ch).totalBeats.toFixed(1)} 拍（期望 ${expectedBeats.toFixed(1)}）`,
  );

  // ② 导出 → 打包 → 解包 → 反序列化：长度必须活下来
  const zip = await buildProjectZip(ch, { audioDuration: AUDIO });
  const files = await unzipToFiles(await zip.blob.arrayBuffer());
  const proj = await findProjectFile(files);
  check('导出的 project.json 里写了 meta.audioDuration', Math.abs(Number(proj.json.chart?.meta?.audioDuration) - AUDIO) < 1e-6, String(proj.json.chart?.meta?.audioDuration));
  const reopened = prepareChart(parseProject(proj.json, { file: proj.path }));
  check('反序列化后 audioDuration 被读回来（曾经被白名单丢掉）', Math.abs(Number(reopened.meta?.audioDuration) - AUDIO) < 1e-6, String(reopened.meta?.audioDuration));
  check(
    '**导出再打开后长度不变**（这条就是用户踩的坑）',
    Math.abs(createBeatAxis(reopened).totalBeats - expectedBeats) < 1,
    `重开后 ${createBeatAxis(reopened).totalBeats.toFixed(1)} 拍（导出前 ${expectedBeats.toFixed(1)}）`,
  );

  // ③ 内容比音频长时取内容（谱面比音乐长的谱面不能被截短）
  const longer = mk({ audioDuration: 10 }, 2000);
  const { meta: m3, from } = withExportLength(longer, { audioDuration: 10 });
  const longerBeats = (2000 * 60) / 174;
  check(
    '内容比音频长时取内容长度（不截短谱面）',
    m3.audioDuration > 10 && Math.abs(m3.audioDuration - longerBeats) < 1,
    `${m3.audioDuration}（来自${from}）`,
  );

  // ④ 没有音频时不写这个字段（长度由内容推），且不留旧值
  const noAudio = mk({ audioDuration: 99 });
  const { meta: m4 } = withExportLength({ ...noAudio, meta: { ...noAudio.meta, audioDuration: undefined } }, {});
  check('没有音频时不写 audioDuration（长度由内容推）', m4.audioDuration === undefined, String(m4.audioDuration));
  const zip2 = await buildProjectZip(mk({}), {});
  const proj2 = await findProjectFile(await unzipToFiles(await zip2.blob.arrayBuffer()));
  check('无音频项目导出后不残留 audioDuration', proj2.json.chart?.meta?.audioDuration === undefined, String(proj2.json.chart?.meta?.audioDuration));
  const re2 = prepareChart(parseProject(proj2.json, { file: proj2.path }));
  check('无音频项目重开后长度仍是内容长度（行为不变）', Math.abs(createBeatAxis(re2).totalBeats - 5) < 0.01, `${createBeatAxis(re2).totalBeats.toFixed(2)} 拍`);

  // ⑤ 「保持到结束」的哨兵不能把长度撑爆
  const sentinel = prepareChart({
    lines: [{ id: 0, name: 'L', layers: [{ x: [{ startBeat: 0, endBeat: 1e9, start: 0, end: 1, easingType: 1 }] }], notes: [], extended: {} }],
    notes: [],
    timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
    meta: {},
    warnings: [],
  });
  const { durationSec } = withExportLength(sentinel, {});
  check('「保持到结束」的哨兵不计入导出长度', durationSec === 0, `durationSec=${durationSec}`);
}

// ---------------------------------------------------------------- 谱面总长度（横向滚动区）
section('谱面总拍数：没有音符时也要由事件撑出长度（否则横向拖不动）');
{
  const { createBeatAxis, chartLastEventBeat } = await import('../src/editor/tracks.js');
  const { prepareChart } = await import('../src/core/model.js');
  const mk = (lines) =>
    prepareChart({
      lines,
      notes: [],
      timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
      meta: {},
      warnings: [],
    });
  const emptyLine = (events = {}, extended = {}) => ({ id: 0, name: 'L', layers: [events], notes: [], extended });

  check('空谱面：总拍为 0（没有任何内容）', createBeatAxis(mk([emptyLine()])).totalBeats === 0, String(createBeatAxis(mk([emptyLine()])).totalBeats));

  /**
   * 这是用户实测的 bug：谱面只有事件、**没有音符**时 `chart.endTime` 是 0（它只看音符），
   * 于是时间轴横向滚动区只有 1 拍宽、比视口还窄 → 中键拖动"只能上下、不能左右"。
   */
  const evOnly = mk([emptyLine({ x: [{ startBeat: 0, endBeat: 64, start: 0, end: 1, easingType: 1 }] })]);
  check(
    '只有事件的谱面：总拍由事件撑出（不再是 0）',
    createBeatAxis(evOnly).totalBeats === 64,
    `totalBeats=${createBeatAxis(evOnly).totalBeats}（事件到第 64 拍）`,
  );
  check('chartLastEventBeat 直接给出事件最晚结束拍', chartLastEventBeat(evOnly) === 64, String(chartLastEventBeat(evOnly)));

  // 「保持到结束」是哨兵值（1e6 / 1e9），不能把它当长度，否则滚动区会变成天文数字
  const holdEnd = mk([emptyLine({ x: [{ startBeat: 0, endBeat: 1e9, start: 0, end: 1, easingType: 1 }] })]);
  check('「保持到结束」的哨兵不计入长度', chartLastEventBeat(holdEnd) === 0 && createBeatAxis(holdEnd).totalBeats === 0, `lastEventBeat=${chartLastEventBeat(holdEnd)}`);
  const mixed = mk([emptyLine({ x: [{ startBeat: 0, endBeat: 1e9, start: 0, end: 1, easingType: 1 }, { startBeat: 8, endBeat: 16, start: 0, end: 1, easingType: 1 }] })]);
  check('哨兵与普通事件混在一起时，只取普通事件', chartLastEventBeat(mixed) === 16, String(chartLastEventBeat(mixed)));

  // 扩展事件与相机事件同样要算进去
  check('扩展事件计入长度', chartLastEventBeat(mk([emptyLine({}, { x: [{ startBeat: 0, endBeat: 40, start: 0, end: 1, easingType: 1 }] })])) === 40);
  check(
    '相机事件计入长度',
    chartLastEventBeat({ lines: [emptyLine()], camera: { x: [{ startBeat: 0, endBeat: 24, start: 0, end: 1, easingType: 1 }] } }) === 24,
    String(chartLastEventBeat({ lines: [emptyLine()], camera: { x: [{ startBeat: 0, endBeat: 24, start: 0, end: 1, easingType: 1 }] } })),
  );

  // 有音符时取「音符结束」与「事件结束」的较大值（不因为修 bug 而缩短长谱面）
  const withNotes = prepareChart({
    lines: [{ id: 0, name: 'L', layers: [{ x: [{ startBeat: 0, endBeat: 8, start: 0, end: 1, easingType: 1 }] }], notes: [{ type: 1, startBeat: 0, endBeat: 400, positionX: 0 }], extended: {} }],
    notes: [],
    timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
    meta: {},
    warnings: [],
  });
  const axisN = createBeatAxis(withNotes);
  check('有音符时取两者较大值（长谱面不缩短）', axisN.totalBeats >= 400, `totalBeats=${axisN.totalBeats}`);
}

// ---------------------------------------------------------------- 音符轨的 positionX 范围
section('音符轨：positionX 范围至少一个屏幕宽（超屏才扩大）');
{
  const { notesXRange, SCREEN_HALF_X, FALLBACK_X_RANGE, posGridLines } = await import('../src/editor/tracks.js');
  const { OFFICIAL } = await import('../src/core/units.js');

  check(
    '半个屏幕宽 = 1 / X_RATIO / 2（由官方单位算出，不是写死的 9）',
    Math.abs(SCREEN_HALF_X - 1 / OFFICIAL.X_RATIO / 2) < 1e-12,
    `${SCREEN_HALF_X.toFixed(6)}（1 X = ${OFFICIAL.X_RATIO} 画面宽）`,
  );
  check('兜底范围与基线一致（空轨也是一个屏幕宽）', FALLBACK_X_RANGE === SCREEN_HALF_X, String(FALLBACK_X_RANGE));

  // 基线：不论有没有音符、音符挤在哪儿，都至少一个屏幕宽
  const base = [
    ['没有音符', []],
    ['音符都在中间（±2）', [-2, 0, 2]],
    ['只在右半边', [0, 1, 2, 3]],
    ['只在左半边', [-3, -2, -1]],
    ['全部挤在一点', [1.5, 1.5, 1.5]],
    ['正好贴屏幕边缘', [-SCREEN_HALF_X, SCREEN_HALF_X]],
  ];
  for (const [name, xs] of base) {
    const r = notesXRange(xs);
    check(
      `基线一个屏幕宽：${name}`,
      Math.abs(r.min + SCREEN_HALF_X) < 1e-9 && Math.abs(r.max - SCREEN_HALF_X) < 1e-9,
      `[${r.min.toFixed(3)}, ${r.max.toFixed(3)}]`,
    );
  }

  // 超屏才扩大，且只扩到刚好装下
  const r1 = notesXRange([-20, 0, 3]);
  check('单侧超屏：只扩那一侧（另一侧仍是屏幕边缘）', Math.abs(r1.min + 20) < 1e-9 && Math.abs(r1.max - SCREEN_HALF_X) < 1e-9, `[${r1.min}, ${r1.max}]`);
  const r2 = notesXRange([-30, 40]);
  check('两侧都超屏：两侧各自扩到音符位置', r2.min === -30 && r2.max === 40, `[${r2.min}, ${r2.max}]`);
  const r3 = notesXRange([SCREEN_HALF_X + 0.001]);
  check('只超一点点也照样扩（不取整、不吸附）', Math.abs(r3.max - (SCREEN_HALF_X + 0.001)) < 1e-9, `max=${r3.max}`);
  check('非有限值被忽略（不会把范围污染成 NaN）', notesXRange([NaN, 1, Infinity, -Infinity]).min === -SCREEN_HALF_X, JSON.stringify(notesXRange([NaN, 1])));
  check('范围里带上 screenHalf（供绘制/吸附判断屏幕边界）', r1.screenHalf === SCREEN_HALF_X && r2.screenHalf === SCREEN_HALF_X, String(r1.screenHalf));

  // 接到真实谱面上：范围跟着音符走
  const { prepareChart } = await import('../src/core/model.js');
  const { makeNotesTrack } = await import('../src/editor/tracks.js');
  const mkChart = (xs) =>
    prepareChart({
      lines: [{ id: 0, name: 'L', layers: [], notes: xs.map((x) => ({ type: 1, startBeat: 1, endBeat: 1, positionX: x })), extended: {} }],
      notes: [],
      timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
      meta: {},
      warnings: [],
    });
  check('真实谱面：屏幕内的音符不给范围撑大', makeNotesTrack(mkChart([-3, 3]), 0).xRange.max === SCREEN_HALF_X);
  check('真实谱面：超屏音符把范围撑到该音符', Math.abs(makeNotesTrack(mkChart([-3, 15]), 0).xRange.max - 15) < 1e-9, String(makeNotesTrack(mkChart([-3, 15]), 0).xRange.max));
  check('真实谱面：没有音符时也有一屏（可直接往上画）', makeNotesTrack(mkChart([]), 0).xRange.max === SCREEN_HALF_X);

  // ── 刻度格点：屏幕内固定、屏幕外只在两侧追加 ──
  const baseGrid = posGridLines(notesXRange([]), 9);
  check('基线（一个屏幕宽）就是 9 个屏幕内格点', baseGrid.length === 9 && baseGrid.every((g) => g.inScreen), `${baseGrid.length} 个`);
  check('基线格点对称、含 0', baseGrid[0].pos === -SCREEN_HALF_X && baseGrid[8].pos === SCREEN_HALF_X && baseGrid[4].pos === 0, `[${baseGrid[0].pos.toFixed(3)}, …, ${baseGrid[8].pos.toFixed(3)}]`);
  check('基线格距 = 一个屏幕宽 / (线数-1)', Math.abs(baseGrid[1].pos - baseGrid[0].pos - (SCREEN_HALF_X * 2) / 8) < 1e-9, `格距 ${(baseGrid[1].pos - baseGrid[0].pos).toFixed(4)}`);

  const wide = posGridLines(notesXRange([-25, 20]), 9);
  const inside = wide.filter((g) => g.inScreen);
  const outside = wide.filter((g) => !g.inScreen);
  check('范围撑大后：屏幕内仍是固定 9 格', inside.length === 9, `${inside.length} 格`);
  check(
    '范围撑大后：屏幕内的格距**不变**（不随范围拉稀 —— 否则屏内就没东西可对了）',
    Math.abs(inside[1].pos - inside[0].pos - (SCREEN_HALF_X * 2) / 8) < 1e-9,
    `格距 ${(inside[1].pos - inside[0].pos).toFixed(4)}`,
  );
  check('屏幕外只在两侧追加（左侧负、右侧正）', outside.some((g) => g.pos < -SCREEN_HALF_X) && outside.some((g) => g.pos > SCREEN_HALF_X), `外 ${outside.length} 格`);
  // 用「除以格距后是否接近整数」判断，注意 JS 的 % 对负数会保留符号，这里用四舍五入差
  const step = (SCREEN_HALF_X * 2) / 8;
  check(
    '屏幕外的格点也按同一格距排列（连成一条网格）',
    outside.every((g) => Math.abs(g.pos / step - Math.round(g.pos / step)) < 1e-6),
    `格距 ${step.toFixed(4)}；外格点 ${outside.map((g) => g.pos.toFixed(2)).join(', ')}`,
  );
  check('屏幕外的格点不会越过范围端点', outside.every((g) => g.pos >= -25 - 1e-9 && g.pos <= 20 + 1e-9), `[${Math.min(...outside.map((g) => g.pos)).toFixed(2)}, ${Math.max(...outside.map((g) => g.pos)).toFixed(2)}]`);
  check('格点按位置升序（绘制与吸附都依赖顺序）', wide.every((g, i) => i === 0 || wide[i - 1].pos <= g.pos));
  check('线数变化时屏幕内格点跟着变多', posGridLines(notesXRange([]), 16).filter((g) => g.inScreen).length === 16);
  check('线数下限被夹到 2（不会除零）', posGridLines(notesXRange([]), 1).filter((g) => g.inScreen).length === 2);
}

// ---------------------------------------------------------------- 判定线索引：全局从 0 开始
section('判定线索引：界面 / 数据 / AI 工具统一从 0 开始');
{
  const { lineLabel, lineShort, makeNotesTrack, makeEventTrack, createBeatAxis } = await import('../src/editor/tracks.js');
  const { prepareChart } = await import('../src/core/model.js');
  /** 两条线：第一条有名字，第二条没名字 */
  const chart = prepareChart({
    lines: [
      { id: 0, name: 'Named0', layers: [{ x: [{ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }] }], notes: [{ type: 1, startBeat: 1, endBeat: 1, positionX: 0 }], extended: {} },
      { id: 1, name: '', layers: [], notes: [], extended: {} },
    ],
    notes: [],
    timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
    meta: {},
    warnings: [],
  });
  check('lineShort 不带 +1（第 0 条线就是「0 号线」）', lineShort(0) === '0 号线' && lineShort(1) === '1 号线', `${lineShort(0)} / ${lineShort(1)}`);
  check('lineLabel 带上谱面里的线名', lineLabel(0, 'Named0') === '0 号线 Named0', lineLabel(0, 'Named0'));
  check('lineLabel 没有名字时只给序号', lineLabel(1, '') === '1 号线' && lineLabel(1, undefined) === '1 号线', lineLabel(1, ''));
  check('20 条线也照样按 0 起（不回到 1 起）', lineShort(19) === '19 号线', lineShort(19));

  // 轨道头 / 标签也要用同一套
  const axis = createBeatAxis(chart);
  const notes = makeNotesTrack(chart, 0, axis);
  check('音符轨标题是「0 号线」而不是「1 号线」', notes.headTitle === '0 号线' && /^0 号线/.test(notes.label), `${notes.headTitle} | ${notes.label}`);
  const ev = makeEventTrack(chart, 0, 0, 'x', axis);
  check('事件轨标题同样是 0 起', /^0 号线/.test(ev.headTitle) && /^0 号线/.test(ev.groupLabel), `${ev.headTitle} | ${ev.groupLabel}`);
  check('第 2 条线（下标 1）显示为 1 号线', /^1 号线/.test(makeNotesTrack(chart, 1, axis).headTitle), makeNotesTrack(chart, 1, axis).headTitle);

  // 与 AI 工具的 lineId 同口径：工具的 lineId 就是 chart.lines 的下标
  const aiTools = await import('../src/ai/tools.js');
  const read = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 4 }, { chart }).result;
  check('AI 工具的 lineId=0 读到的就是界面上的「0 号线」', read.line.lineId === 0, `lineId=${read.line.lineId}`);
  check('AI 工具读到的音符带稳定 id（不再用拍数模糊引用）', Number.isFinite(read.notes?.[0]?.id), JSON.stringify(read.notes?.[0]));
}

// ---------------------------------------------------------------- AI 工具：ID 寻址 / 空闲线 / 事件编辑
section('AI 工具：ID 寻址 / 空闲线 / 事件编辑');
{
  const aiTools = await import('../src/ai/tools.js');
  const { applyPlan } = await import('../src/editor/ai-apply.js');
  const { parseRpeChart } = await import('../src/core/parse-rpe.js');
  const { prepareChart } = await import('../src/core/model.js');

  /** 合成谱面：0 号线有音符与事件（下落线），1 号线空闲且透明，2 号线空闲但可见 */
  const mkChart = () =>
    prepareChart(parseRpeChart({
      META: {},
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      judgeLineList: [
        {
          Name: '下落线',
          Texture: 'line.png',
          isCover: 0,
          eventLayers: [
            {
              // RPE 的 alpha 是 0~255（解析后归一到 0~1）
              alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e6, 0, 1], start: 255, end: 255, easingType: 1 }],
              moveXEvents: [{ startTime: [0, 0, 1], endTime: [1e6, 0, 1], start: 0, end: 0, easingType: 1 }],
              speedEvents: [{ startTime: [0, 0, 1], endTime: [1e6, 0, 1], start: 1, end: 1, easingType: 1 }],
            },
          ],
          notes: [
            // RPE 类型码：1 = tap、2 = hold（见 core/units.js 的 RPE_NOTE_TYPE）
            { type: 2, above: 1, startTime: [8, 0, 1], endTime: [12, 0, 1], positionX: 100, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
            { type: 1, above: 1, startTime: [16, 0, 1], endTime: [16, 0, 1], positionX: -100, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 },
          ],
        },
        {
          Name: '空闲透明线',
          Texture: 'line.png',
          isCover: 0,
          eventLayers: [{ alphaEvents: [], moveXEvents: [], speedEvents: [] }],
          notes: [],
        },
        {
          Name: '空闲可见线',
          Texture: 'line.png',
          isCover: 0,
          eventLayers: [
            {
              alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e6, 0, 1], start: 255, end: 255, easingType: 1 }],
              moveXEvents: [],
              speedEvents: [],
            },
          ],
          notes: [],
        },
      ],
    }));

  /** 假时间轴：AI 落地的最小事务桩件（记 touched / added / removed 数，供断言） */
  const fakeTimeline = () => {
    const stat = { touch: 0, added: 0, removed: 0 };
    return {
      stat,
      batch(label) {
        return {
          touch: () => stat.touch++,
          added: () => stat.added++,
          removed: () => stat.removed++,
          commit: () => {},
        };
      },
    };
  };

  const chart = mkChart();
  const ctx = { chart };

  // ── 读取：id 出现且稳定 ──
  const read1 = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 32 }, ctx).result;
  const holdNote = read1.notes.find((n) => n.type === 'hold');
  const speedEv = read1.events.speed?.[0];
  check('读取结果：音符与事件都带 id', Number.isFinite(holdNote?.id) && Number.isFinite(speedEv?.id), `note.id=${holdNote?.id} event.id=${speedEv?.id}`);
  const read2 = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 32 }, ctx).result;
  check('同一对象两次读取 id 相同（会话内稳定）', read2.notes.find((n) => n.type === 'hold')?.id === holdNote.id && read2.events.speed[0].id === speedEv.id);

  // ── edit_notes：ids 寻址 + moveBeats（Hold 首尾一起移）──
  const plan = aiTools.runTool('edit_notes', { lineId: 0, ids: [holdNote.id], changes: { moveBeats: 2 } }, ctx).plan;
  check('edit_notes 按 ids 选择：计划 op 带稳定 noteId', plan.ops.length === 1 && plan.ops[0].noteId === holdNote.id && plan.ops[0].patch.startBeat === 10, JSON.stringify(plan.ops[0]?.patch));
  const tl = fakeTimeline();
  const applied = applyPlan({ plan, chart, timeline: tl });
  check('应用后 Hold 首尾一起位移（8→10 拍、12→14 拍）', applied.applied === 1 && chart.lines[0].rt.notes.find((n) => n.type === 'hold').startBeat === 10, `applied=${applied.applied} ${JSON.stringify(applied.failed)}`);
  check('moveBeats 连源音符时间一起写回（导出口径不丢）', chart.lines[0].rt.notes.find((n) => n.type === 'hold').src.startBeat === 10, `src.startBeat=${chart.lines[0].rt.notes.find((n) => n.type === 'hold').src.startBeat}`);

  // ── edit_notes：容差 refs（模型只看到四舍五入的拍 / 位置，回写也能命中）──
  const chart2 = mkChart();
  chart2.lines[0].rt.notes[1].startBeat = 16 + 1 / 3; // 官方谱常见的无限小数拍
  const ctx2 = { chart: chart2 };
  const read2b = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 16, toBeat: 17 }, ctx2).result;
  const tapRef = read2b.notes[0]; // beat 已被四舍五入到 4 位小数
  const planRef = aiTools.runTool('edit_notes', { lineId: 0, refs: [{ lineId: 0, beat: tapRef.beat, x: tapRef.x, type: 'tap' }], changes: { x: -1.5 } }, ctx2);
  check('refs 容差匹配：四舍五入过的拍数也能命中', planRef.plan?.ops?.length === 1 && planRef.plan.ops[0].noteId === tapRef.id, JSON.stringify(planRef.failed ?? planRef.plan?.ops?.[0]?.patch));

  // ── edit_events：patch 按 id 改值 + 数组重排；delete 按 ids ──
  const evId = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 32 }, ctx).result.events.speed[0].id;
  const planPatch = aiTools.runTool('edit_events', { lineId: 0, mode: 'patch', patches: [{ id: evId, value: 2.5, endValue: 2.5 }] }, ctx).plan;
  const tl2 = fakeTimeline();
  const appliedPatch = applyPlan({ plan: planPatch, chart, timeline: tl2 });
  check('edit_events patch 按 id：应用后事件值更新', appliedPatch.applied === 1 && chart.lines[0].layers[0].speed[0].start === 2.5, `applied=${appliedPatch.applied} ${JSON.stringify(appliedPatch.failed)}`);

  const read3 = aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 32 }, ctx).result;
  const xs = read3.events.x ?? [];
  check('read_chart 能同时读到多层同名键之外的事件（x 有默认事件可删）', Array.isArray(xs), `x 事件 ${xs.length} 条`);
  if (xs.length) {
    const planDel = aiTools.runTool('edit_events', { lineId: 0, mode: 'delete', key: 'x', ids: [xs[0].id] }, ctx).plan;
    const tl3 = fakeTimeline();
    const appliedDel = applyPlan({ plan: planDel, chart, timeline: tl3 });
    check('edit_events delete 按 ids：应用后事件被移除', appliedDel.applied === 1 && !chart.lines[0].layers[0].x.some((e) => e.startBeat === xs[0].beat && e.endBeat === xs[0].endBeat && aiTools.runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 2 }, ctx).result.events.x?.length === 0), `applied=${appliedDel.applied} ${JSON.stringify(appliedDel.failed)}`);
  }

  // ── 空闲判定线查询 ──
  const idle = aiTools.runTool('read_chart', { query: 'idle', fromBeat: 0, toBeat: 16 }, ctx).result;
  check('query=idle：无音符的线排在前、标 idle', idle.lines[0].notes === 0 && idle.lines[0].idle === true && idle.lines[1].notes === 0, JSON.stringify(idle.lines.map((l) => [l.lineId, l.notes, l.idle, l.hidden])));
  check('query=idle：透明线标 hidden、可见线不标', idle.lines[0].hidden === true && idle.lines[1].hidden === false, JSON.stringify(idle.lines.map((l) => [l.lineId, l.hidden])));
  check('query=idle：下落线不标 idle', idle.lines[idle.lines.length - 1].idle === false, JSON.stringify(idle.lines[idle.lines.length - 1]));

  // ── 旧工具名退场 ──
  let threw = '';
  try {
    aiTools.runTool('write_events', { lineId: 0, key: 'x', events: [{ beat: 0, value: 0 }] }, ctx);
  } catch (e) {
    threw = e.message;
  }
  check('write_events / write_camera 已合并为 edit_events（旧名报未知工具）', /未知工具/.test(threw), threw);
}

// ---------------------------------------------------------------- 音乐轨（只读波形）
section('音乐轨：波形包络与只读轨道模型');
{
  const wf = await import('../src/editor/waveform.js');
  const { makeAudioTrack, AUDIO_TRACK_ID, AUDIO_ROW_H, hasAudioTrack } = await import('../src/editor/tracks.js');

  /** 合成一个 AudioBuffer 形状的桩件（waveform.js 只吃这几个字段） */
  const mkBuffer = (channelsData, sampleRate = 100) => ({
    numberOfChannels: channelsData.length,
    length: channelsData[0]?.length ?? 0,
    sampleRate,
    duration: (channelsData[0]?.length ?? 0) / sampleRate,
    getChannelData: (i) => channelsData[i],
  });

  // 方波：前一半 +1、后一半 -1 → 每个桶的峰值都是 1
  // （200 采样 @100Hz = 2 秒 → 每秒 100 桶时正好 200 个桶）
  const square = new Float32Array(200);
  for (let i = 0; i < 200; i++) square[i] = i < 100 ? 1 : -1;
  const sq = wf.computePeaks(mkBuffer([square]), { bucketsPerSecond: 100 });
  const allFull = () => {
    for (let i = 0; i < sq.peaks.length; i += 2) {
      if (Math.abs(sq.peaks[i] + 1) > 1e-6 || Math.abs(sq.peaks[i + 1] - 1) > 1e-6) return false;
    }
    return true;
  };
  check(
    '方波：每个桶都是满幅的 [−1, 1] 对称峰值',
    sq.buckets === 200 && allFull(),
    `${sq.buckets} 桶，前两个桶 = [${sq.peaks[0]}, ${sq.peaks[1]}]`,
  );

  // 正弦：包络逐桶递增到峰值再回落
  const sine = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) sine[i] = Math.sin((i / 1000) * Math.PI);
  const sn = wf.computePeaks(mkBuffer([sine]), { bucketsPerSecond: 100 });
  const maxOf = (info) => {
    let m = 0;
    for (let i = 1; i < info.peaks.length; i += 2) m = Math.max(m, info.peaks[i]);
    return m;
  };
  check('正弦：峰值包络不超过 1 且确实读到内容', maxOf(sn) > 0.3 && maxOf(sn) <= 1, `max=${maxOf(sn).toFixed(3)}`);
  check(
    '桶数 = 时长 × 每秒桶数（1000 采样 @100Hz = 10 秒 → 1000 桶）',
    sn.buckets === 1000 && sn.bucketsPerSecond === 100,
    `${sn.buckets} 桶 @ ${sn.bucketsPerSecond}/s`,
  );
  check(
    '正弦的包络呈「中间高、两端低」（真的按时间取到了内容）',
    sn.peaks[1] < sn.peaks[(500 - 1) * 2 + 1] && sn.peaks[(999 - 1) * 2 + 1] < sn.peaks[(500 - 1) * 2 + 1],
    `首 ${sn.peaks[1].toFixed(2)} / 中 ${sn.peaks[999].toFixed(2)} / 尾 ${sn.peaks[1997].toFixed(2)}`,
  );

  // 立体声：左声道静音、右声道满幅 → 取最大值，包络仍为满幅（不是平均后的 0.5）
  const silent = new Float32Array(100);
  const loud = new Float32Array(100).fill(1);
  const st = wf.computePeaks(mkBuffer([silent, loud]), { bucketsPerSecond: 100 });
  check(
    '立体声取各声道绝对值的最大值（相消不会把响度算小）',
    Math.abs(st.peaks[1] - 1) < 1e-6,
    JSON.stringify([...st.peaks]),
  );

  check('没有音频（null）返回 null', wf.computePeaks(null) === null);
  check('零长度音频返回 null（不建空轨）', wf.computePeaks(mkBuffer([new Float32Array(0)])) === null);
  check('没有声道数据也返回 null（不抛错）', wf.computePeaks({ numberOfChannels: 0, length: 0, sampleRate: 100, duration: 0 }) === null);

  // 超长音频：桶数封顶，bucketsPerSecond 相应下调（保持整段一致，不截断）
  const longSamples = new Float32Array(1000);
  const longBuf = { numberOfChannels: 1, length: 1000, sampleRate: 1, duration: 1000, getChannelData: () => longSamples };
  const capped = wf.computePeaks(longBuf, { bucketsPerSecond: 1e7 });
  check(
    '超长音频的桶数被上限夹住并相应下调每秒桶数',
    capped.buckets === wf.MAX_BUCKETS && capped.bucketsPerSecond < 1e7,
    `${capped.buckets} 桶 @ ${Math.round(capped.bucketsPerSecond)}/s`,
  );

  // 同一 buffer 命中缓存：不重复计算（同一个对象两次调用返回同一个结果对象）
  const sharedBuf = mkBuffer([square]);
  check(
    '同一 AudioBuffer 命中缓存（滚动 / 缩放不重算包络）',
    wf.computePeaks(sharedBuf, { bucketsPerSecond: 100 }) === wf.computePeaks(sharedBuf, { bucketsPerSecond: 100 }),
  );
  check('换了每秒桶数就重算（不是简单返回上一次的结果）', wf.computePeaks(sharedBuf, { bucketsPerSecond: 50 }) !== wf.computePeaks(sharedBuf, { bucketsPerSecond: 100 }));

  // 区间取样（sq 是 2 秒 / 200 桶）
  const seg = wf.peaksForRange(sq, 0, 1);
  check('按区间取桶：返回 [min,max] 交替的切片', seg.length === 200 && seg[0] === -1 && seg[1] === 1, `len=${seg.length}`);
  check('区间越界被夹（负数起点 / 超过时长）', wf.peaksForRange(sq, -10, 999).length === sq.peaks.length);
  check('空区间返回空数组（不抛错）', wf.peaksForRange(sq, 5, 5).length === 0);
  check('没有波形信息时返回空数组', wf.peaksForRange(null, 0, 1).length === 0);
  check('平均响度落在 0..1', wf.rmsForRange(sq, 0, 2) > 0 && wf.rmsForRange(sq, 0, 2) <= 1, `${wf.rmsForRange(sq, 0, 2).toFixed(3)}`);
  check('静音区间的平均响度为 0', wf.rmsForRange(wf.computePeaks(mkBuffer([new Float32Array(100)]), { bucketsPerSecond: 100 }), 0, 1) === 0);

  // ── 纵向映射：整段都很响的音频要能看清起伏，而不是一大块实心 ──
  {
    // 「母带压得很响」：整体在 0.84~1.0 之间（动态只有 0.16），逐桶有强弱
    const loud = new Float32Array(20000);
    for (let i = 0; i < loud.length; i++) {
      const bucket = Math.floor(i / 100);
      const accent = bucket % 10 === 0 ? 1 : bucket % 5 === 0 ? 0.94 : 0.84;
      loud[i] = accent * (i % 7 === 0 ? 1 : 0.97);
    }
    const loudInfo = wf.computePeaks(mkBuffer([loud]), { bucketsPerSecond: 100 });
    const seg = wf.peaksForRange(loudInfo, 0, loudInfo.duration);
    const map = wf.normalizeRange(seg);
    check(
      '顶满型素材会被映射到自己的响度区间（floor / ceil 都取自素材本身）',
      map.floor > 0.5 && map.ceil > map.floor + 0.05,
      JSON.stringify(map),
    );
    /** 映射后 90% 与 10% 分位的差：越大说明起伏越清楚 */
    const spread = (m) => {
      const span = Math.max(1e-6, m.ceil - m.floor);
      const vals = [];
      for (let i = 1; i < seg.length; i += 2) vals.push(Math.min(1, Math.max(0, (seg[i] - m.floor) / span)));
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)];
    };
    check(
      '映射后起伏从「几乎没有」变成很清楚（关键回归：修掉一整块实心）',
      spread(map) > 0.5 && spread({ floor: 0, ceil: 1 }) < 0.2,
      `不映射 ${spread({ floor: 0, ceil: 1 }).toFixed(3)} → 映射后 ${spread(map).toFixed(3)}`,
    );
  }
  {
    // 动态正常的素材：映射后不应被压扁（跨度过小说明算错了）
    const normal = new Float32Array(20000);
    for (let i = 0; i < normal.length; i++) normal[i] = 0.3 + 0.5 * Math.abs(Math.sin(i / 300));
    const info = wf.computePeaks(mkBuffer([normal]), { bucketsPerSecond: 100 });
    const seg = wf.peaksForRange(info, 0, info.duration);
    const vals = [];
    const m = wf.normalizeRange(seg);
    for (let i = 1; i < seg.length; i += 2) vals.push(Math.min(1, (seg[i] - m.floor) / Math.max(1e-6, m.ceil - m.floor)));
    vals.sort((a, b) => a - b);
    const spread = vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)];
    check('动态正常的素材映射后依然舒展', spread > 0.4, `展布 ${spread.toFixed(3)}`);
  }
  {
    // 极轻的音频：地板不能压到 0 以下，也不能把底噪放大成波形
    const quiet = new Float32Array(1000).fill(0.005);
    const info = wf.computePeaks(mkBuffer([quiet]), { bucketsPerSecond: 100 });
    const m = wf.normalizeRange(wf.peaksForRange(info, 0, info.duration));
    check('恒定电平的素材退化为不缩放（floor=0 / ceil=1）', m.floor === 0 && m.ceil === 1, JSON.stringify(m));
  }
  check(
    '全静音 / 空区间返回不缩放',
    (() => {
      const m = wf.normalizeRange(wf.computePeaks(mkBuffer([new Float32Array(100)]), { bucketsPerSecond: 100 }).peaks);
      return m.floor === 0 && m.ceil === 1 && wf.normalizeRange(new Float32Array(0)).ceil === 1 && wf.normalizeRange(null).floor === 0;
    })(),
  );
  check('地板不会是负数（绘制时不会把静音段翻到中线另一侧）', wf.normalizeRange(wf.computePeaks(mkBuffer([new Float32Array(100).fill(0.5)]), { bucketsPerSecond: 100 }).peaks).floor >= 0);

  // 轨道模型
  const chart0 = { meta: { offset: 0.35 }, lines: [], timing: { bpmList: [{ beat: 0, bpm: 120 }] } };
  const track = makeAudioTrack(chart0, sq);
  check('音乐轨 id / kind / 行高正确', track.id === AUDIO_TRACK_ID && track.kind === 'audio' && track.rowHeight === AUDIO_ROW_H, `${track.id}/${track.kind}/${track.rowHeight}`);
  check('音乐轨标为只读', track.readOnly === true);
  check('音乐轨没有 clips（任何按对象的操作都找不到东西可动）', Array.isArray(track.clips) && track.clips.length === 0);
  check('音乐轨的 offset 取自谱面元数据（绘制时据此横向对齐）', track.wave.offsetSec === 0.35, String(track.wave.offsetSec));
  check('没有波形时不建轨（返回 null）', makeAudioTrack(chart0, null) === null);
  check('hasAudioTrack 能认出时间轴里有没有音乐轨', hasAudioTrack([{ kind: 'events' }, track]) && !hasAudioTrack([{ kind: 'events' }]));
  check('音乐轨用主题色 #6B85FF（与普通轨趋势线同一套纯色）', track.color === '#6B85FF', track.color);

  // ── 音符轨：切换线时**即使没有音符也要**放进时间轴 ──
  {
    const { makeLineTracks, makeNotesTrack, defaultTracks } = await import('../src/editor/tracks.js');
    const { prepareChart } = await import('../src/core/model.js');
    const mkChart = (notes) =>
      prepareChart({
        lines: [
          {
            id: 0,
            name: 'A',
            layers: [{ x: [{ startBeat: 0, endBeat: 4, start: 0, end: 1, easingType: 1 }] }],
            notes,
            extended: {},
          },
          { id: 1, name: 'B', layers: [], notes: [], extended: {} },
        ],
        notes: [],
        timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 },
        meta: {},
        warnings: [],
      });
    const emptyChart = mkChart([]);
    const lineTracks = makeLineTracks(emptyChart, 1);
    check(
      '没有音符的线也会带上音符轨（切换线之后能直接往上画）',
      lineTracks.length === 1 && lineTracks[0].kind === 'notes' && lineTracks[0].lineId === 1 && lineTracks[0].clips.length === 0,
      lineTracks.map((t) => `${t.id}:${t.clips.length}`).join(',') || '(空)',
    );
    check('空音符轨仍是宽轨且排在最前', lineTracks[0].rowHeight === 189, String(lineTracks[0].rowHeight));
    check(
      '默认布局同样始终带音符轨',
      defaultTracks(emptyChart).tracks.some((t) => t.kind === 'notes'),
      defaultTracks(emptyChart).tracks.map((t) => t.id).join(','),
    );
    const withNotes = mkChart([{ type: 1, startBeat: 2, endBeat: 2, positionX: 0 }]);
    check(
      '有音符时音符轨内容照常（没有因为改动而丢）',
      makeLineTracks(withNotes, 0).find((t) => t.kind === 'notes')?.clips.length === 1,
    );
    check('makeNotesTrack 对空音符线不抛错', makeNotesTrack(emptyChart, 1).clips.length === 0);
  }
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
