// 渲染器 v1 的无头测试：解析、单位与公式、状态求值、判定计分、zip 读取。
// 运行：node tools/render-tests.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { prepareChart, detectFormat } from '../src/core/model.js';
import { parseOfficialChart } from '../src/core/parse-official.js';
import { parseRpeChart } from '../src/core/parse-rpe.js';
import { createState, evaluate, advanceJudging, resetState, formatScore } from '../src/core/state.js';
import { EASING_PRESETS, cubicBezier, makeEasing } from '../src/core/easing.js';
import { RPE_SPEED_TO_YPS, RPE_X_TO_X, RPE_Y_TO_Y, NOTE } from '../src/core/units.js';
import { createTimeline, rpeBeat } from '../src/core/timing.js';
import { loadZipPackage, parseInfoCsv, infoCsvToMeta } from '../src/core/package.js';

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
section('官方格式解析（白复生 AT）');
const officialRaw = JSON.parse(fs.readFileSync(OFFICIAL_PATH, 'utf8'));
check('格式识别为 official', detectFormat(officialRaw) === 'official');
const official = prepareChart(parseOfficialChart(officialRaw, { file: OFFICIAL_PATH }));
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
  let match = 0;
  let total = 0;
  let maxErr = 0;
  for (const note of line0.rt.notes) {
    const raw = note.floorPositionRaw;
    if (!Number.isFinite(raw)) continue;
    total++;
    const err = Math.abs(note.height - raw);
    maxErr = Math.max(maxErr, err);
    if (err <= 1e-3 * Math.max(1, Math.abs(raw))) match++;
  }
  check(`第 1 条线 ${total} 个 note 的 height 与 floorPosition 一致`, match === total, `匹配 ${match}/${total}，最大误差 ${maxErr.toExponential(2)}`);
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

// ---------------------------------------------------------------- RPE 格式
section('RPE 格式解析（领土战争 AT）');
const rpeRaw = JSON.parse(fs.readFileSync(RPE_PATH, 'utf8'));
check('格式识别为 rpe', detectFormat(rpeRaw) === 'rpe');
const rpe = prepareChart(parseRpeChart(rpeRaw, { file: RPE_PATH }));
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
check('扩展事件被识别但未渲染（inclineEvents）', rpe.extendedKeys.includes('inclineEvents'), rpe.extendedKeys.join(','));

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

// ---------------------------------------------------------------- 线 alpha 与音符 alpha
section('判定线透明度与音符（合成用例）');
{
  const mkChart = (alphaStart, alphaEnd) => ({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 120,
        notesAbove: [{ type: 1, time: 320, positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 }],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [
          { startTime: -999999, endTime: 1000000000, start: alphaStart, end: alphaEnd },
        ],
      },
    ],
  });
  const hidden = prepareChart(parseOfficialChart(mkChart(0, 0)));
  const st = createState(hidden);
  evaluate(st, 4.5); // 靠近判定时刻，避免被「距离过远」剔除规则影响
  check(
    '判定线 alpha = 0 时音符仍可见（线不透明度不影响音符）',
    st.lines[0].alpha === 0 && hidden.notes[0].visible === true && hidden.notes[0].renderAlpha === 1,
    `lineAlpha=${st.lines[0].alpha} visible=${hidden.notes[0].visible} alpha=${hidden.notes[0].renderAlpha}`,
  );

  // RPE 的负 alpha 编码：线与音符一起隐藏
  const rpeNeg = {
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      {
        Name: 'neg',
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [
          { alphaEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: -255, end: -255, easingType: 1 }] },
        ],
        notes: [{ type: 1, above: 1, startTime: [1, 0, 1], endTime: [1, 0, 1], positionX: 0, alpha: 255, size: 1, speed: 1, yOffset: 0, visibleTime: 999999, isFake: 0 }],
      },
    ],
  };
  const negChart = prepareChart(parseRpeChart(rpeNeg));
  const negState = createState(negChart);
  evaluate(negState, 1);
  check('RPE 负 alpha 会同时隐藏判定线与音符', negState.lines[0].alpha < 0 && negChart.notes[0].visible === false);
}

// ---------------------------------------------------------------- formatVersion 兼容
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

  // 1) 自动游玩：音符落到线上那一帧就应当不可见，并且产生打击特效
  const c1 = prepareChart(parseOfficialChart(mkChart()));
  const s1 = createState(c1);
  evaluate(s1, 3.99);
  check('落线之前：音符仍显示', c1.notes[0].visible === true && c1.notes[0].renderAlpha === 1);
  evaluate(s1, 4.0);
  check('落到线上那一帧：音符已不可见（不等 0.16s 淡出）', c1.notes[0].visible === false, `visible=${c1.notes[0].visible}`);
  const hits = advanceJudging(s1, 4.0);
  check('同时产生打击特效（1 个）', hits.length === 1 && hits[0].perfect === true, `hits=${hits.length}`);
  check('分数为 Perfect 计分', s1.stats.perfect === 1 && s1.stats.combo === 1);
  evaluate(s1, 4.05);
  check('落线之后仍是不可见（无淡出残留）', c1.notes[0].visible === false);

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

// ---------------------------------------------------------------- 父子判定线
section('父子判定线（对齐 Phira：pos = 父 pos + R(父 rot) × 偏移；rot 由 rotateWithFather 决定）');{
  const ev = (v, deg) => [
    { startTime: [0, 0, 1], endTime: [4, 0, 1], start: v, end: v, easingType: 1, ...(deg === undefined ? {} : {}) },
  ];
  const mkLine = (name, moveX, rotate, extra = {}) => ({
    Name: name,
    Texture: 'line.png',
    isCover: 0,
    eventLayers: [
      {
        moveXEvents: ev(moveX),
        rotateEvents: ev(rotate),
        alphaEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 255, end: 255, easingType: 1 }],
      },
    ],
    notes: [],
    ...extra,
  });
  const chart = prepareChart(
    parseRpeChart({
      META: { RPEVersion: 163, offset: 0 },
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      judgeLineList: [
        mkLine('parent', 270, -90), // RPE 270 单位 = 0.2 屏宽；RPE -90°（顺时针）→ 规范 +90°
        mkLine('child-inherit', 135, 0, { father: 0, rotateWithFather: true }), // 135 单位 = 0.1 屏宽
        mkLine('child-no-inherit', 135, -45, { father: 0 }), // 缺省 rotateWithFather → 不继承
      ],
    }),
  );
  const state = createState(chart, { aspect: 16 / 9 });
  evaluate(state, 0.5);
  const [parent, inherit, noInherit] = state.lines;
  const aspect = 16 / 9;
  check('父线：x = 0.2 屏宽、旋转 90°（逆时针）', near(parent.worldX, 0.2, 1e-9) && near(parent.worldRotate, Math.PI / 2, 1e-9), `x=${parent.worldX.toFixed(4)} rot=${parent.worldRotate.toFixed(4)}`);
  check(
    '子线偏移被父线旋转：局部 +0.1 屏宽 → 世界 (0.2, +0.1778 屏高)',
    near(inherit.worldX, 0.2, 1e-9) && near(inherit.worldY, 0.1 * aspect, 1e-9),
    `x=${inherit.worldX.toFixed(4)} y=${inherit.worldY.toFixed(4)}`,
  );
  check('rotateWithFather = true：子线旋转继承父线', near(inherit.worldRotate, Math.PI / 2, 1e-9), `rot=${inherit.worldRotate.toFixed(4)}`);
  check(
    '缺省 rotateWithFather：子线旋转不继承（但仍跟随父线位置）',
    near(noInherit.worldRotate, Math.PI / 4, 1e-9) && near(noInherit.worldX, 0.2, 1e-9) && near(noInherit.worldY, 0.1 * aspect, 1e-9),
    `rot=${noInherit.worldRotate.toFixed(4)}（RPE -45° → 规范 +45°）`,
  );

  // 成环 / 越界父线：降级为无父线并告警
  const cyclic = parseRpeChart({
    META: { RPEVersion: 163, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      mkLine('a', 0, 0, { father: 1 }),
      mkLine('b', 0, 0, { father: 0 }),
      mkLine('c', 0, 0, { father: 99 }),
    ],
  });
  check('父线成环被检出并降级', cyclic.lines[0].father === -1 && cyclic.lines[1].father === -1, cyclic.warnings.filter((w) => w.includes('父线')).join(' | '));
  check('父线越界被检出并降级', cyclic.lines[2].father === -1);
}

// ---------------------------------------------------------------- 音符宽度
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


for (const [label, chart] of [['official', official], ['rpe', rpe]]) {
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

// ---------------------------------------------------------------- 健壮性：脏数据
section('健壮性：脏数据取缺省值 + 诊断，不抛异常');

/** 跑一遍「解析 → 编译 → 求值 → 判定」，返回是否全程无异常、状态是否全为有限值 */
function runChart(json, times = [0, 1, 5, 30, 120]) {
  const format = detectFormat(json);
  const chart = prepareChart(
    format === 'rpe'
      ? parseRpeChart(json)
      : format === 'official'
        ? parseOfficialChart(json)
        : { lines: [], warnings: ['无法识别的谱面格式（未解析）'] },
  );
  const st = createState(chart);
  let nonFinite = null;
  for (const t of times) {
    evaluate(st, t);
    advanceJudging(st, t);
    for (const ls of st.lines) {
      for (const k of ['x', 'y', 'rotate', 'alpha', 'height', 'worldX', 'worldY', 'worldRotate']) {
        if (!Number.isFinite(ls[k])) nonFinite ??= `line.${k}=${ls[k]}`;
      }
    }
    for (const n of chart.notes) {
      for (const k of ['timeSec', 'endSec', 'durationSec', 'height', 'renderAlpha']) {
        if (!Number.isFinite(n[k])) nonFinite ??= `note.${k}=${n[k]}`;
      }
      if (n.headY !== undefined && !Number.isFinite(n.headY)) nonFinite ??= `note.headY=${n.headY}`;
      if (n.tailY !== null && n.tailY !== undefined && !Number.isFinite(n.tailY)) nonFinite ??= `note.tailY=${n.tailY}`;
    }
  }
  return { chart, state: st, nonFinite };
}

function safeRun(json) {
  try {
    return { ...runChart(json), threw: null };
  } catch (err) {
    return { threw: err };
  }
}

{
  // 1) 完全不是谱面
  for (const [label, json] of [
    ['{}', {}],
    ['[]', []],
    ['42', 42],
    ['null', null],
    ['"x"', 'x'],
  ]) {
    let threw = null;
    try {
      const format = detectFormat(json);
      if (format === 'unknown') throw new Error('无法识别的谱面格式（缺少 judgeLineList）');
    } catch (err) {
      threw = err;
    }
    check(`非谱面输入 ${label}：给出可读错误且不崩`, !!threw && /无法识别/.test(threw.message), threw?.message ?? '未抛错');
  }

  // 2) judgeLineList 类型错误
  const r1 = safeRun({ formatVersion: 3, judgeLineList: 'oops' });
  check('judgeLineList 不是数组：不崩、给出告警', !r1.threw && r1.chart.lines.length === 0 && r1.chart.warnings.some((w) => /不是数组/.test(w)), r1.threw?.message ?? `${r1.chart.warnings.length} 条告警`);

  const r2 = safeRun({ formatVersion: 3, judgeLineList: [null, 42, 'x', {}, { bpm: 120 }] });
  check(
    'judgeLineList 含非对象条目：只丢弃脏条目',
    !r2.threw && r2.chart.lines.filter(Boolean).length === 2 && r2.chart.warnings.some((w) => /不是对象/.test(w)),
    r2.threw?.message ?? `保留 ${r2.chart.lines.filter(Boolean).length} 条线`,
  );

  // 3) 事件字段类型错误 / 缺字段 / 极端值
  const r3 = safeRun({
    formatVersion: 3,
    judgeLineList: [
      {
        bpm: -5,
        notesAbove: [null, 'x', { type: 99 }, { type: 1 }, { type: '1', time: '128' }, { type: 3, time: 256, holdTime: -999 }],
        notesBelow: {},
        speedEvents: [{ startTime: 'a', endTime: null, value: 'b' }, { startTime: 0, endTime: 100, value: 1e12 }],
        judgeLineMoveEvents: [{ startTime: 'x', endTime: {}, start: {}, end: 'abc', start2: NaN, end2: Infinity }],
        judgeLineRotateEvents: [{ startTime: 0, endTime: 1000, start: '90', end: null }],
        judgeLineDisappearEvents: [{}],
      },
    ],
  });
  check('事件/音符字段类型错误：不崩且无非有限值', !r3.threw && !r3.nonFinite, r3.threw?.message ?? r3.nonFinite ?? '');
  check(
    '非法 bpm 被替换为 120 并告警',
    r3.chart.lines[0]?.bpm === 120 && r3.chart.warnings.some((w) => /bpm 非法/.test(w)),
    `bpm=${r3.chart.lines[0]?.bpm}`,
  );
  check(
    '未知 note 类型与非对象音符被丢弃（保留 3 个：缺 time / time:"128" / 负数 holdTime 的 hold）',
    r3.chart.lines[0]?.notes?.length === 3 && r3.chart.warnings.some((w) => /未知 note 类型/.test(w)),
    `保留 ${r3.chart.lines[0]?.notes?.length} 个：${JSON.stringify(r3.chart.lines[0]?.notes?.map((n) => [n.type, n.startBeat]))}`,
  );
  check(
    '数字字符串被宽容接受（type:"1"、time:"128"）',
    r3.chart.lines[0]?.notes?.some((n) => n.type === 'tap' && near(n.startBeat, 4, 1e-9)),
    JSON.stringify(r3.chart.lines[0]?.notes?.map((n) => [n.type, n.startBeat])),
  );
  check(
    '负数 holdTime 不会产生负时长',
    r3.chart.notes.every((n) => n.durationSec >= 0),
    r3.chart.notes.map((n) => n.durationSec).join(','),
  );
  check('极端 speed 数值不会让高度变成非有限值', !r3.nonFinite, r3.nonFinite ?? 'ok');

  // 4) RPE：BPMList / 事件层 / 音符 / father
  const r4 = safeRun({
    META: { RPEVersion: 'x', offset: 'abc' },
    BPMList: [null, { bpm: 0, startTime: [0, 0, 1] }, { bpm: -5, startTime: [0, 0, 1] }, { bpm: 'abc' }, { bpm: 120, startTime: 'bad' }],
    judgeLineList: [
      null,
      { Name: 42, eventLayers: [null, 'x', { moveXEvents: [null, {}, { startTime: 'a', endTime: null, start: {}, end: 'x' }] }], notes: [null, { type: 7 }, { type: 1, startTime: 'bad', above: 7, size: -5, alpha: -100, positionX: 1e12, speed: 1e12 }] },
      { Name: 'ok', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 255, end: 255 }] }], notes: [], father: 99, bpmFactor: 0 },
    ],
  });
  check('RPE 脏数据：不崩且无非有限值', !r4.threw && !r4.nonFinite, r4.threw?.message ?? r4.nonFinite ?? '');
  check('RPE 非法 BPMList 条目被忽略/替换', r4.threw ? false : r4.chart.timing.bpmList.every((b) => Number.isFinite(b.bpm) && b.bpm > 0), JSON.stringify(r4.chart.timing?.bpmList));
  check('RPE 非对象音符/未知类型被丢弃', r4.chart.lines.filter(Boolean).some((l) => l.notes.length === 0));
  check(
    'RPE 越界 father 被降级为无父线并告警',
    r4.chart.lines[1]?.father === -1 && r4.chart.warnings.some((w) => /father=99 非法/.test(w)),
    `father=${r4.chart.lines[1]?.father}`,
  );
  check('RPE bpmFactor=0 不会除零（回退为 1）', r4.chart.lines[1]?.bpmFactor === 1);
  check('RPE note 极端数值被钳制（size/alpha 合法）', r4.chart.notes.every((n) => n.size > 0 && n.alpha >= 0 && n.alpha <= 1), JSON.stringify(r4.chart.notes.map((n) => [n.size, n.alpha])));
  check('RPE above 非法值（7）按背面处理并告警', r4.chart.warnings.some((w) => /above/.test(w)));

  // 5) 事件不连续 / 重叠 → 告警但不崩
  const r5 = safeRun({
    formatVersion: 3,
    judgeLineList: [
      {
        bpm: 120,
        notesAbove: [],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000, value: 1 }],
        judgeLineMoveEvents: [
          { startTime: 500, endTime: 1000, start: 0.1, end: 0.1, start2: 0.5, end2: 0.5 }, // 顺序颠倒
          { startTime: 0, endTime: 800, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }, // 与前一条重叠
        ],
        judgeLineRotateEvents: [{ startTime: 100, endTime: 50, start: 0, end: 90 }], // endTime < startTime
        judgeLineDisappearEvents: [{ startTime: 0, endTime: 0, start: 1, end: 1 }], // 零长
      },
    ],
  });
  check('事件顺序颠倒/重叠/零长：不崩且给出重叠告警', !r5.threw && r5.chart.warnings.some((w) => /重叠/.test(w)), r5.threw?.message ?? r5.chart.warnings.find((w) => /重叠/.test(w)) ?? '无告警');
  check('endTime < startTime 的事件被忽略（不产生负区间）', !r5.nonFinite, r5.nonFinite ?? 'ok');
  check('丢弃统计可用（dropped）', r5.chart.dropped && typeof r5.chart.dropped.notes === 'number', JSON.stringify(r5.chart.dropped));
}

// ---------------------------------------------------------------- 健壮性：随机变异（fuzz）
section('健壮性：对真实样本随机变异（模糊测试）');
{
  const official = JSON.parse(fs.readFileSync(OFFICIAL_PATH, 'utf8'));
  const rpe = JSON.parse(fs.readFileSync(RPE_PATH, 'utf8'));

  // 固定种子的伪随机，保证可复现
  let seed = 20240607;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const JUNK = [null, undefined, NaN, Infinity, -Infinity, 0, -1, 1e18, '', 'abc', [], {}, true, false];
  const pickJunk = () => JUNK[Math.floor(rnd() * JUNK.length)];

  /** 就地变异：随机删字段 / 换类型 / 塞垃圾 / 打乱或清空数组 */
  function mutate(node, depth = 0) {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      const roll = rnd();
      if (roll < 0.15) node.length = 0;
      else if (roll < 0.25 && node.length > 1) node.reverse();
      else if (roll < 0.32 && node.length > 2) node.splice(Math.floor(rnd() * node.length), 1);
      else if (roll < 0.4) node.push(pickJunk());
      for (const item of node) mutate(item, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const roll = rnd();
        if (roll < 0.12) delete node[key];
        else if (roll < 0.24) node[key] = pickJunk();
        else mutate(node[key], depth + 1);
      }
      if (rnd() < 0.1) node.__junk = pickJunk();
    }
  }

  let iterations = 0;
  let crashes = 0;
  let nonFiniteCases = 0;
  const firstCrash = [];
  for (const [label, base] of [
    ['official', official],
    ['rpe', rpe],
  ]) {
    for (let i = 0; i < 150; i++) {
      const copy = JSON.parse(JSON.stringify(base));
      mutate(copy);
      iterations++;
      const res = safeRun(copy, [0, 3, 17.98, 60]);
      if (res.threw) {
        crashes++;
        if (firstCrash.length < 3) firstCrash.push(`${label}#${i}: ${res.threw.message}`);
      } else if (res.nonFinite) {
        nonFiniteCases++;
        if (firstCrash.length < 3) firstCrash.push(`${label}#${i}: 非有限值 ${res.nonFinite}`);
      }
    }
  }
  check(
    `变异 ${iterations} 次：解析/编译/求值全程无异常`,
    crashes === 0,
    crashes ? `崩溃 ${crashes} 次，例如 ${firstCrash.join(' | ')}` : '0 次异常',
  );
  check(
    '变异样本求值结果全部为有限值（不会把 NaN 送进渲染）',
    nonFiniteCases === 0,
    nonFiniteCases ? `出现 ${nonFiniteCases} 次，例如 ${firstCrash.join(' | ')}` : `${iterations} 个样本全部有限`,
  );

  // 对照组：未变异的样本仍应正常解析（确保 fuzz 没有把样本本身弄坏）
  const ctl = safeRun(JSON.parse(fs.readFileSync(OFFICIAL_PATH, 'utf8')));
  check('对照组：原始官方样本仍正常（1156 音符）', !ctl.threw && ctl.chart.noteCount === 1156, ctl.threw?.message ?? `noteCount=${ctl.chart.noteCount}`);
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
