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
section('扩展事件：scaleX / scaleY / color（合成用例）');
{
  const { serializeRpe } = await import('../src/core/serialize-rpe.js');
  // 扩展事件不分层：每条线每个键一份，直接按缺省值（scale=1、color=白）求值
  const synthetic = {
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }], // 60 BPM：1 拍 = 1 秒
    judgeLineList: [
      {
        Name: 'extended',
        Texture: 'line.png',
        isCover: 0,
        eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }],
        extended: {
          scaleXEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 1, end: 2, easingType: 1 }],
          scaleYEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 1, end: 0.5, easingType: 1 }],
          colorEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: [255, 255, 255], end: [255, 0, 0], easingType: 1 }],
        },
        notes: [],
      },
    ],
  };
  const chart = prepareChart(parseRpeChart(synthetic));
  const line = chart.lines[0];
  const st = createState(chart);

  check('已实现的扩展键进 line.extended（三个键都在）', ['scaleX', 'scaleY', 'color'].every((k) => Array.isArray(line.extended?.[k]) && line.extended[k].length === 1), Object.keys(line.extended ?? {}).join(','));
  check('颜色事件的值是三元组整数', JSON.stringify(line.extended.color[0].start) === '[255,255,255]' && JSON.stringify(line.extended.color[0].end) === '[255,0,0]', JSON.stringify(line.extended.color[0].start));
  check('扩展事件带缓动编号（可与普通事件一样编辑）', line.extended.scaleX[0].easingPreset === 1 && typeof line.extended.scaleX[0].easingFn === 'function');
  check('扩展事件的原始数据原样留在 extendedRaw（导出写回用）', Array.isArray(line.extendedRaw?.scaleXEvents) && Array.isArray(line.extendedRaw?.colorEvents), Object.keys(line.extendedRaw ?? {}).join(','));

  evaluate(st, 0);
  check('扩展事件起点：scale = 1、颜色为白', near(st.lines[0].scaleX, 1, 1e-9) && near(st.lines[0].scaleY, 1, 1e-9) && st.lines[0].extColor.join(',') === '255,255,255', `scaleX=${st.lines[0].scaleX} extColor=${st.lines[0].extColor}`);
  evaluate(st, 1);
  check('扩展事件线性插值（1/4 处）', near(st.lines[0].scaleX, 1.25, 1e-9) && near(st.lines[0].scaleY, 0.875, 1e-9) && st.lines[0].extColor.join(',') === '255,191,191', `scaleX=${st.lines[0].scaleX} scaleY=${st.lines[0].scaleY} extColor=${st.lines[0].extColor}`);
  // 有 color 事件时判定线**完全按事件颜色**着色（不再回退到 AP 金 / FC 蓝 / 白），
  // 同时给出这段区间的两个端点色，供渲染器画渐变（1/2 处：当前 128 → 末端 0）
  evaluate(st, 2);
  check('有 color 事件时判定线改用事件颜色（useExtColor）', st.lines[0].useExtColor === true, `useExtColor=${st.lines[0].useExtColor}`);
  check(
    'color 线段给出两端颜色（供渐变）',
    st.lines[0].extColor.join(',') === '255,128,128' && st.lines[0].extColorEnd.join(',') === '255,0,0',
    `${st.lines[0].extColor} → ${st.lines[0].extColorEnd}`,
  );
  evaluate(st, 4);
  check('扩展事件终点', near(st.lines[0].scaleX, 2, 1e-9) && near(st.lines[0].scaleY, 0.5, 1e-9) && st.lines[0].extColor.join(',') === '255,0,0', `scaleX=${st.lines[0].scaleX} extColor=${st.lines[0].extColor}`);
  evaluate(st, 40);
  check('扩展事件结束后维持终值', near(st.lines[0].scaleX, 2, 1e-9) && st.lines[0].extColor.join(',') === '255,0,0', `scaleX=${st.lines[0].scaleX}`);
  check('颜色不覆盖判定线基准色（state.color 仍由判定结果决定）', st.lines[0].color !== st.lines[0].extColor, `color=${st.lines[0].color} extColor=${st.lines[0].extColor}`);

  // 缺省值：完全没有扩展事件时，缩放为 1、颜色为白（画面不变）
  const plain = prepareChart(parseRpeChart({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [{ Name: 'plain', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
  }));
  const stPlain = createState(plain);
  evaluate(stPlain, 1);
  check('没有扩展事件时取缺省值（scale = 1、extColor = 白）', near(stPlain.lines[0].scaleX, 1, 1e-9) && near(stPlain.lines[0].scaleY, 1, 1e-9) && stPlain.lines[0].extColor.join(',') === '255,255,255', `scaleX=${stPlain.lines[0].scaleX} extColor=${stPlain.lines[0].extColor}`);
  check('没有 color 事件时判定线仍用判定色（useExtColor = false）', stPlain.lines[0].useExtColor === false, `useExtColor=${stPlain.lines[0].useExtColor}`);

  // 未实现的键：解析后原样保留、导出写回，且不影响求值
  const withPending = prepareChart(parseRpeChart({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [
      {
        Name: 'pending',
        eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }],
        extended: { inclineEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 45, easingType: 1 }] },
        notes: [],
      },
    ],
  }));
  check('未实现的扩展键被标为保留：inclineEvents 在 extendedKeys 且不在 extended', withPending.extendedKeys.includes('inclineEvents') && !withPending.lines[0].extended?.incline, withPending.extendedKeys.join(','));
  const pendingOut = serializeRpe(withPending);
  check('未实现的扩展键导出时原样写回', JSON.stringify(pendingOut.json.judgeLineList[0].extended?.inclineEvents) === JSON.stringify(withPending.lines[0].extendedRaw.inclineEvents), JSON.stringify(pendingOut.json.judgeLineList[0].extended?.inclineEvents));
  check('未实现的扩展键有明确告警（保留但不渲染）', pendingOut.warnings.some((w) => /inclineEvents/.test(w)), pendingOut.warnings.find((w) => /inclineEvents/.test(w)) ?? '（没有告警）');
}

// ---------------------------------------------------------------- （伪）3D：z / theta
section('（伪）3D 扩展事件：z（Z 轴位移）/ theta（下落面倾斜）—— 单位、符号与往返');
{
  const { serializeRpe } = await import('../src/core/serialize-rpe.js');
  const { serializeProject, parseProject } = await import('../src/core/project.js');
  const { createProjection } = await import('../src/render/projection.js');
  const mk = () => ({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }], // 60 BPM：1 拍 = 1 秒
    judgeLineList: [
      {
        Name: 'pseudo3d',
        Texture: 'line.png',
        isCover: 0,
        father: -1,
        eventLayers: [
          {
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 1, end: 1 }],
          },
        ],
        // z：RPE 长度单位（900 = 一个画面高）；theta：角度制（正 = 向屏幕内倾）
        extended: {
          moveZEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 900, easingType: 1 }],
          thetaEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 30, easingType: 1 }],
        },
        notes: [
          { type: 1, startTime: [0, 0, 1], endTime: [0, 0, 1], positionX: 0, above: 1, isFake: 0, speed: 1, size: 1, yOffset: 0, visibleTime: 999999, alpha: 255 },
        ],
      },
    ],
  });

  const chart = prepareChart(parseRpeChart(mk()));
  const line = chart.lines[0];
  const st = createState(chart);
  check('z / theta 进 line.extended（两个键都在）', Array.isArray(line.extended?.z) && Array.isArray(line.extended?.theta), Object.keys(line.extended ?? {}).join(','));
  check('z 的内部单位是「画面高比例」（RPE 900 = 1 屏高）', near(line.extended.z[0].end, 1, 1e-9), `end=${line.extended.z[0].end}`);
  check('theta 的内部单位是弧度（RPE 30° = π/6）', near(line.extended.theta[0].end, Math.PI / 6, 1e-9), `end=${line.extended.theta[0].end}`);
  check('两个键都带缓动（可与普通事件一样编辑）', line.extended.z[0].easingPreset === 1 && typeof line.extended.theta[0].easingFn === 'function');

  evaluate(st, 0);
  check('起点：z = 0、theta = 0（画面与没有 3D 时一致）', near(st.lines[0].z, 0, 1e-9) && near(st.lines[0].theta, 0, 1e-9), `z=${st.lines[0].z} theta=${st.lines[0].theta}`);
  evaluate(st, 2);
  check('线性插值到一半（2 秒 = 2 拍）', near(st.lines[0].z, 0.5, 1e-9) && near(st.lines[0].theta, (Math.PI / 6) * 0.5, 1e-9), `z=${st.lines[0].z} theta=${st.lines[0].theta}`);
  evaluate(st, 4);
  check('终点：z = 1 屏高、theta = 30°', near(st.lines[0].z, 1, 1e-9) && near(st.lines[0].theta, Math.PI / 6, 1e-9), `z=${st.lines[0].z} theta=${st.lines[0].theta}`);
  evaluate(st, 40);
  check('结束后维持终值', near(st.lines[0].z, 1, 1e-9) && near(st.lines[0].theta, Math.PI / 6, 1e-9), `z=${st.lines[0].z}`);

  // 缺省值：完全没有这两个事件时都是 0（画面不变）
  const plain = prepareChart(parseRpeChart({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [{ Name: 'plain', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
  }));
  const stPlain = createState(plain);
  evaluate(stPlain, 2);
  check('没有 z / theta 事件时取缺省值 0', near(stPlain.lines[0].z, 0, 1e-9) && near(stPlain.lines[0].theta, 0, 1e-9), `z=${stPlain.lines[0].z} theta=${stPlain.lines[0].theta}`);

  // RPE 往返：字段名、单位、符号都要原样回去
  const out = serializeRpe(chart);
  const extOut = out.json.judgeLineList[0].extended ?? {};
  check('RPE 写回字段名 moveZEvents / thetaEvents', Array.isArray(extOut.moveZEvents) && Array.isArray(extOut.thetaEvents), Object.keys(extOut).join(','));
  check('RPE 写回 z 用长度单位（1 屏高 → 900）', near(extOut.moveZEvents[0].end, 900, 1e-6), `end=${extOut.moveZEvents[0].end}`);
  check('RPE 写回 theta 用角度制（π/6 → 30）', near(extOut.thetaEvents[0].end, 30, 1e-6), `end=${extOut.thetaEvents[0].end}`);
  const round = prepareChart(parseRpeChart(out.json));
  evaluate(createState(round), 4);
  check(
    'RPE 往返后 z / theta 与原来一致（不取反、不走样）',
    near(round.lines[0].extended.z[0].end, 1, 1e-9) && near(round.lines[0].extended.theta[0].end, Math.PI / 6, 1e-9),
    `z=${round.lines[0].extended.z[0].end} theta=${round.lines[0].extended.theta[0].end}`,
  );

  // 负值（往屏幕外）也要原样保留
  const negJson = mk();
  negJson.judgeLineList[0].extended.moveZEvents[0].end = -450;
  negJson.judgeLineList[0].extended.thetaEvents[0].end = -45;
  const neg = prepareChart(parseRpeChart(negJson));
  check('负值（往屏幕外）合法且保留', near(neg.lines[0].extended.z[0].end, -0.5, 1e-9) && near(neg.lines[0].extended.theta[0].end, -Math.PI / 4, 1e-9), `z=${neg.lines[0].extended.z[0].end} theta=${neg.lines[0].extended.theta[0].end}`);
  const negOut = serializeRpe(neg).json.judgeLineList[0].extended;
  check('负值写回 RPE 也不丢符号', near(negOut.moveZEvents[0].end, -450, 1e-6) && near(negOut.thetaEvents[0].end, -45, 1e-6), `z=${negOut.moveZEvents[0].end} theta=${negOut.thetaEvents[0].end}`);

  // 内部项目格式往返（编辑器的保存 / 打开）
  const proj = serializeProject(chart, { savedAt: '2025-01-01T00:00:00.000Z' });
  const fromProj = prepareChart(parseProject(proj.json));
  const stProj = createState(fromProj);
  evaluate(stProj, 2);
  check(
    '内部项目格式往返：z / theta 的拍值、取值、缓动都在',
    near(fromProj.lines[0].extended.z[0].end, 1, 1e-9) &&
      near(fromProj.lines[0].extended.theta[0].end, Math.PI / 6, 1e-9) &&
      typeof fromProj.lines[0].extended.z[0].easingFn === 'function' &&
      near(stProj.lines[0].z, 0.5, 1e-9),
    `z=${fromProj.lines[0].extended.z[0].end} theta=${fromProj.lines[0].extended.theta[0].end}`,
  );

  // 官谱导出：这两个事件表达不了 → 必须告警（而不是静默丢掉）
  const { serializeOfficial } = await import('../src/core/serialize-official.js');
  const officialOut = serializeOfficial(chart);
  check('导出官方格式时告警：z / theta 无法表达（已丢弃）', (officialOut.warnings ?? []).some((w) => /扩展事件/.test(w)), (officialOut.warnings ?? []).join(' / ') || '（没有告警）');

  // 投影：k = F / (F + z)、倾斜的横向偏移 + 缩小
  const view = createProjection(1280, 720);
  const note = { positionX: 0, above: true, distY: 0, size: 1, speed: 1 };
  const lineAt = (over) => ({ worldX: 0, worldY: 0, worldRotate: 0, z: 0, theta: 0, ...over });
  const o = { noteWidthRatio: 0.125 };
  check('z = 0 时 k = 1（画面不变）', near(view.noteTransform(note, lineAt(), o).depthScale, 1, 1e-12));
  check('z = 1 屏高时 k = 0.5（缩小到一半）', near(view.noteTransform(note, lineAt({ z: 1 }), o).depthScale, 0.5, 1e-12), `k=${view.noteTransform(note, lineAt({ z: 1 }), o).depthScale}`);
  check('z = -0.5 屏高（往屏幕外）时 k = 2（放大一倍）', near(view.noteTransform(note, lineAt({ z: -0.5 }), o).depthScale, 2, 1e-12), `k=${view.noteTransform(note, lineAt({ z: -0.5 }), o).depthScale}`);
  check(
    'z 的缩放同时作用于判定线与拾取（lineCenter 与 noteTransform 用同一个 k）',
    near(view.lineCenter(lineAt({ z: 1 }), o).k, 0.5, 1e-12) && near(view.lineDepthScale(lineAt({ z: 1 }), o), 0.5, 1e-12),
  );

  // 倾斜：屏幕上方（远端）的深度 = distance × sinθ，落到屏幕上的距离 × cosθ
  const far = { positionX: 0, above: true, distY: 1, size: 1, speed: 1 };
  const flat = view.noteTransform(far, lineAt(), o);
  const tilted = view.noteTransform(far, lineAt({ theta: Math.PI / 6 }), o);
  check('倾斜让远处的音符沿下落方向变短（localY × cosθ）', near(tilted.localY, flat.localY * Math.cos(Math.PI / 6), 1e-9), `localY ${flat.localY.toFixed(1)} → ${tilted.localY.toFixed(1)}`);
  check('倾斜让远处的音符按深度缩小（k < 1）', tilted.depthScale < 1 && tilted.depthScale > 0, `k=${tilted.depthScale.toFixed(4)}`);
  check('倾斜给出贴图的纵向压缩比例（squashY = cosθ）', near(tilted.squashY, Math.cos(Math.PI / 6), 1e-12), `squashY=${tilted.squashY}`);
  // Hold 的「逐行投影」需要倾斜前的偏移与 sinθ：检验它们与 localY 自洽（渲染器按这个把长条画成梯形）
  check(
    'noteTransform 给出倾斜前的 localY0（localY = localY0 × cosθ）',
    near(tilted.localY, tilted.localY0 * Math.cos(Math.PI / 6), 1e-9) && near(flat.localY, flat.localY0, 1e-12),
    `localY0=${tilted.localY0.toFixed(1)} localY=${tilted.localY.toFixed(1)}`,
  );
  check(
    'noteTransform 给出 sinθ（= 0 时渲染走单次变换；≠ 0 时逐行投影成梯形）',
    near(tilted.sinT, Math.sin(Math.PI / 6), 1e-12) && near(flat.sinT, 0, 1e-12),
    `sinT=${tilted.sinT.toFixed(4)}（θ=0 时 ${flat.sinT}）`,
  );
  // 逐行投影的深度只取决于「倾斜前的距离」：离判定线越远越深 → 透视缩放越小（长条因此呈梯形）
  const nearFar = (d) => view.noteTransform({ positionX: 0, above: true, distY: d, size: 1, speed: 1 }, lineAt({ theta: Math.PI / 6 }), o);
  check(
    '离判定线越远（倾斜面上越深）→ 透视缩放越小（长条画成梯形的依据）',
    nearFar(2).depthScale < nearFar(1).depthScale && nearFar(1).depthScale < 1,
    `k(1 屏高)=${nearFar(1).depthScale.toFixed(4)} > k(2 屏高)=${nearFar(2).depthScale.toFixed(4)}`,
  );
  // 绕判定线长轴旋转：把线转 90°（长轴竖直）后，「远端」在屏幕上是横向的 → 横向偏移 + 缩小
  const rotLine = lineAt({ theta: Math.PI / 6, worldRotate: Math.PI / 2 });
  const rotFlat = view.noteTransform(far, lineAt({ worldRotate: Math.PI / 2 }), o);
  const rotTilted = view.noteTransform(far, rotLine, o);
  check(
    '绕长轴倾斜：线转 90° 后远端音符横向偏移（同时缩小）',
    Math.abs(rotTilted.x - rotFlat.x) > 1 && rotTilted.depthScale < 1,
    `x ${rotFlat.x.toFixed(1)} → ${rotTilted.x.toFixed(1)}，k=${rotTilted.depthScale.toFixed(4)}`,
  );
  check('倾斜时判定线本身端点跟着投影（lineSegment 用同一个 k）', (() => {
    const [a, b] = view.lineSegment(lineAt({ z: 1 }), 5.76, o);
    const plainSeg = view.lineSegment(lineAt(), 5.76, o);
    return Math.abs(b.x - a.x) < Math.abs(plainSeg[1].x - plainSeg[0].x);
  })());

  // 垂直判定：ignore3D 时相机 / z / 倾斜全部忽略（判定带回到 2D 的那条列）
  const ig = { ...o, ignore3D: true };
  check('ignore3D（垂直判定）：z 不再缩放', near(view.noteTransform(note, lineAt({ z: 1 }), ig).depthScale, 1, 1e-12));
  // 带上的音符（positionX ≠ 0）在 z ≠ 0 时会被投影缩小并向画面中心靠拢：
  // 轨道判定的判定带跟着过来，垂直判定的判定带仍留在 2D 的那条列上
  const sideNote = { positionX: 4, above: true, distY: 0, size: 1, speed: 1 };
  const tilBand = view.judgeBand(sideNote, lineAt({ z: 0.5 }), o);
  const igBand = view.judgeBand(sideNote, lineAt({ z: 0.5 }), ig);
  check(
    '垂直判定的判定带落在 2D 的那条列上（轨道判定则跟着投影走）',
    near(igBand.center.x, view.cx + 4 * 0.05625 * view.areaW, 1e-9) && !near(tilBand.center.x, igBand.center.x, 1e-6),
    `垂直 ${igBand.center.x.toFixed(1)} / 轨道 ${tilBand.center.x.toFixed(1)}`,
  );
  check(
    '轨道判定：点在音符被画到的位置算命中，点在 2D 列上不算',
    view.hitJudgeBand(sideNote, lineAt({ z: 0.5 }), tilBand.center.x, tilBand.center.y, o) === true &&
      view.hitJudgeBand(sideNote, lineAt({ z: 0.5 }), igBand.center.x, igBand.center.y, o) === false,
  );

  // ── 「屏幕点 → 谱面局部坐标」的解析逆：倾斜 / z / 相机 / 线旋转都精确 ──
  {
    const tiltLine = lineAt({ z: 0.35, theta: Math.PI / 6, worldRotate: Math.PI / 5, worldX: 0.2, worldY: -0.15 });
    const cam = { x: 0.18, y: -0.1, z: 0.25, angle: (70 * Math.PI) / 180 };
    const cases = [
      { positionX: 3, above: true },
      { positionX: -5.5, above: false },
      { positionX: 0, above: true },
    ];
    let worst = 0;
    let worstY = 0;
    for (const c of cases) {
      for (const distY of [0, 0.8, 2.4]) {
        const n = { ...c, distY, size: 1, speed: 1 };
        const t = view.noteTransform(n, tiltLine, { ...o, camera: cam });
        const inv = view.toLineChart(n, tiltLine, t.x, t.y, { ...o, camera: cam });
        worst = Math.max(worst, Math.abs(inv.localX - t.localX));
        worstY = Math.max(worstY, Math.abs(inv.localY0 - t.localY0));
      }
    }
    check(
      'toLineChart 是 noteTransform 的解析逆（倾斜 + z + 相机 + 线旋转，误差 < 1e-6）',
      worst < 1e-6 && worstY < 1e-6,
      `localX 误差 ${worst.toExponential(2)} / localY0 误差 ${worstY.toExponential(2)}`,
    );
  }

  // ── 轨道判定：判定范围跟着倾斜（楔形）——音符被画到哪，带子就在哪 ──
  {
    const tiltLine = lineAt({ theta: Math.PI / 6, worldRotate: 0 });
    const farNote = { positionX: -4, above: true, distY: 4, size: 1, speed: 1 };
    const t = view.noteTransform(farNote, tiltLine, o);
    check(
      '轨道判定：点在倾斜面上「音符被画到的位置」算命中',
      view.hitJudgeBand(farNote, tiltLine, t.x, t.y, o) === true,
      `音符屏幕位置 ${t.x.toFixed(1)},${t.y.toFixed(1)}`,
    );
    check(
      '垂直判定：同一个点不算命中（2D 的那条列在别处）',
      view.hitJudgeBand(farNote, tiltLine, t.x, t.y, ig) === false,
    );
    // 判定范围轮廓：倾斜时越远越窄，且远端向线的中心偏移
    const shape = view.judgeBandShape(farNote, tiltLine, o);
    const flatShape = view.judgeBandShape(farNote, tiltLine, ig);
    check(
      '判定范围轮廓：倾斜时远端更窄（楔形），不倾斜时是等宽长条',
      shape.far < shape.near * 0.85 && near(flatShape.far, flatShape.near, 1e-6),
      `轨道 ${shape.near.toFixed(1)} → ${shape.far.toFixed(1)}px；垂直 ${flatShape.near.toFixed(1)} → ${flatShape.far.toFixed(1)}px`,
    );
    const farSide = Math.abs(shape.points[12].x - view.cx);
    const farOther = Math.abs(shape.points[12].y - view.cy);
    const nearSide = Math.abs(shape.points[0].x - view.cx);
    check(
      '判定范围轮廓：远端向画面中心收拢（横向偏移）',
      farSide < nearSide && farOther > 0,
      `近端 |Δx| ${nearSide.toFixed(1)} → 远端 ${farSide.toFixed(1)}`,
    );
    // 轮廓 = 命中区域：多边形每个顶点换算回谱面坐标后，都正好落在「列 ± 半宽」上
    let edgeOk = true;
    for (let i = 0; i < shape.points.length; i++) {
      const p = shape.points[i];
      const local = view.toLineChart(farNote, tiltLine, p.x, p.y, o);
      const d = Math.abs(Math.abs(local.localX - shape.band.localX) - shape.band.halfWidth);
      if (d > 0.5) edgeOk = false;
    }
    check('判定范围轮廓与命中测试严格一致（顶点正好在列 ± 半宽上）', edgeOk);
    // 远端确实「点得到」（楔形内部算命中）
    const mid = shape.points[6]; // 远端附近的内侧点
    check('楔形内部的点算命中', view.hitJudgeBand(farNote, tiltLine, mid.x + 2, mid.y, o) === true);
  }
}

// ---------------------------------------------------------------- 谱面相机
section('谱面相机：可按拍动画的相机（x / y / z / 视角 angle）');
{
  const { serializeRpe } = await import('../src/core/serialize-rpe.js');
  const { serializeProject, parseProject } = await import('../src/core/project.js');
  const { createProjection } = await import('../src/render/projection.js');
  const { CAMERA_DEFAULTS, PSEUDO3D, angleToFocal, focalToAngle, degToRad } = await import('../src/core/units.js');
  const mk = () => ({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }], // 60 BPM：1 拍 = 1 秒
    // 相机是本项目的自有扩展：写在**根节点**的 camera 里（RPE 与其它工具会忽略这个键）
    camera: {
      xEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 675, easingType: 1 }],
      yEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: -450, easingType: 1 }],
      zEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 450, easingType: 1 }],
      // 视角（角度制）：53.13°（默认）→ 90°（广角）
      angleEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 53.13010235, end: 90, easingType: 1 }],
      unknownField: 7, // 不认识的字段：原样保留、导出写回
    },
    judgeLineList: [
      {
        Name: 'L',
        Texture: 'line.png',
        father: -1,
        isCover: 0,
        eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }],
        notes: [
          { type: 1, startTime: [0, 0, 1], endTime: [0, 0, 1], positionX: 0, above: 1, isFake: 0, speed: 1, size: 1, yOffset: 0, visibleTime: 999999, alpha: 255 },
        ],
      },
    ],
  });

  const chart = prepareChart(parseRpeChart(mk()));
  const st = createState(chart);
  check('相机关键帧解析进 chart.camera（四个通道）', ['x', 'y', 'z', 'angle'].every((k) => Array.isArray(chart.camera[k]) && chart.camera[k].length === 1), Object.keys(chart.camera).join(','));
  check('相机 x 的内部单位是「画面宽比例」（RPE 675 = 半个画面宽）', near(chart.camera.x[0].end, 0.5, 1e-9), `x=${chart.camera.x[0].end}`);
  check('相机 y / z 的内部单位是「画面高比例」（RPE 450 = 半个画面高）', near(chart.camera.y[0].end, -0.5, 1e-9) && near(chart.camera.z[0].end, 0.5, 1e-9), `y=${chart.camera.y[0].end} z=${chart.camera.z[0].end}`);
  check('相机视角的内部单位是弧度（RPE 90° = π/2）', near(chart.camera.angle[0].end, Math.PI / 2, 1e-9), `angle=${chart.camera.angle[0].end}`);
  check('默认视角 = 焦距 1 屏高的等价角度（≈53.13°）', near(chart.camera.angle[0].start, PSEUDO3D.ANGLE_DEFAULT, 1e-9) && near(PSEUDO3D.ANGLE_DEFAULT, focalToAngle(1), 1e-12), `${((PSEUDO3D.ANGLE_DEFAULT * 180) / Math.PI).toFixed(4)}°`);
  check('视角 ↔ 焦距换算自洽（F = 1/(2·tan(θ/2))）', near(angleToFocal(PSEUDO3D.ANGLE_DEFAULT), 1, 1e-9) && near(angleToFocal(Math.PI / 2), 0.5, 1e-9), `F(53.13°)=${angleToFocal(PSEUDO3D.ANGLE_DEFAULT).toFixed(4)} F(90°)=${angleToFocal(Math.PI / 2).toFixed(4)}`);
  check('相机关键帧带缓动（可以像可变 BPM 一样按拍调控）', typeof chart.camera.x[0].easingFn === 'function' && chart.camera.x[0].easingPreset === 1);
  check('相机的不明字段原样保留（导出写回用）', chart.cameraRaw?.unknownField === 7);

  evaluate(st, 0);
  check(
    '时间 0：相机是默认视图（画面与没有相机时一致）',
    near(st.camera.x, CAMERA_DEFAULTS.x, 1e-12) &&
      near(st.camera.y, CAMERA_DEFAULTS.y, 1e-12) &&
      near(st.camera.z, CAMERA_DEFAULTS.z, 1e-12) &&
      near(st.camera.angle, CAMERA_DEFAULTS.angle, 1e-6), // 53.13° 写回角度制会有末位误差
    JSON.stringify(st.camera),
  );
  evaluate(st, 2);
  check(
    '时间 2s（2 拍）：四个通道线性插值到一半',
    near(st.camera.x, 0.25, 1e-9) && near(st.camera.y, -0.25, 1e-9) && near(st.camera.z, 0.25, 1e-9) && near(st.camera.angle, degToRad(71.5650512), 1e-6),
    JSON.stringify(st.camera),
  );
  evaluate(st, 4);
  check('时间 4s：到达终值', near(st.camera.x, 0.5, 1e-9) && near(st.camera.angle, Math.PI / 2, 1e-9), JSON.stringify(st.camera));
  evaluate(st, 40);
  check('结束后维持终值（与事件一致的求值规则）', near(st.camera.x, 0.5, 1e-9) && near(st.camera.z, 0.5, 1e-9), JSON.stringify(st.camera));

  // 事件之间的缺口：沿用上一个事件的末值（与普通事件轨一致），只有位于最前方时才用缺省值
  {
    const gapChart = prepareChart(parseRpeChart({
      META: { RPEVersion: 163, offset: 0 },
      BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
      camera: {
        xEvents: [
          { startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 675, easingType: 1 },
          { startTime: [8, 0, 1], endTime: [12, 0, 1], start: 675, end: 1350, easingType: 1 },
        ],
        angleEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 53.13, end: 2, easingType: 1 }],
      },
      judgeLineList: [{ Name: 'gap', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
    }));
    const stGap = createState(gapChart);
    evaluate(stGap, -1);
    check('相机：第一条事件之前用缺省值（最前方）', near(stGap.camera.x, CAMERA_DEFAULTS.x, 1e-12), `x=${stGap.camera.x}`);
    evaluate(stGap, 6);
    check(
      '相机：事件之间的缺口沿用上一个事件的末值（不跳回缺省值）',
      near(stGap.camera.x, 0.5, 1e-9) && near(stGap.camera.angle, (2 * Math.PI) / 180, 1e-6),
      `x=${stGap.camera.x} angle=${((stGap.camera.angle * 180) / Math.PI).toFixed(2)}°`,
    );
    evaluate(stGap, 20);
    check('相机：末值越界时夹到最近的合法视角（不跳回缺省视角）', near(stGap.camera.angle, (2 * Math.PI) / 180, 1e-6), `angle=${((stGap.camera.angle * 180) / Math.PI).toFixed(2)}°`);
    evaluate(stGap, 10);
    check('相机：缺口结束后继续走下一条事件', near(stGap.camera.x, 0.75, 1e-9), `x=${stGap.camera.x}`);
  }

  // 没有相机的谱面：state.camera 恒为默认视图
  const plain = prepareChart(parseRpeChart({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    judgeLineList: [{ Name: 'plain', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
  }));
  const stPlain = createState(plain);
  evaluate(stPlain, 3);
  check('没有相机关键帧时 state.camera = 默认视图', JSON.stringify(stPlain.camera) === JSON.stringify(CAMERA_DEFAULTS), JSON.stringify(stPlain.camera));

  // RPE 往返：字段名与单位、以及不明字段
  const out = serializeRpe(chart).json;
  check('RPE 写回相机到根节点的 camera（xEvents / yEvents / zEvents / angleEvents）', ['xEvents', 'yEvents', 'zEvents', 'angleEvents'].every((f) => Array.isArray(out.camera?.[f])), Object.keys(out.camera ?? {}).join(','));
  check('RPE 写回 x 用长度单位（0.5 画面宽 → 675）', near(out.camera.xEvents[0].end, 675, 1e-6), `x=${out.camera.xEvents[0].end}`);
  check('RPE 写回 y / z 用长度单位（-0.5 / 0.5 画面高 → -450 / 450）', near(out.camera.yEvents[0].end, -450, 1e-6) && near(out.camera.zEvents[0].end, 450, 1e-6), `y=${out.camera.yEvents[0].end} z=${out.camera.zEvents[0].end}`);
  check('RPE 写回视角用角度制（π/2 → 90）', near(out.camera.angleEvents[0].end, 90, 1e-6), `angle=${out.camera.angleEvents[0].end}`);
  check('RPE 写回保留相机里不认识的字段', out.camera.unknownField === 7);
  check('RPE 写回时给出「相机是本项目扩展」的告警', (serializeRpe(chart).warnings ?? []).some((w) => /相机/.test(w)));

  const round = prepareChart(parseRpeChart(out));
  const stRound = createState(round);
  evaluate(stRound, 4);
  check('RPE 往返后相机状态一致', near(stRound.camera.x, 0.5, 1e-9) && near(stRound.camera.angle, Math.PI / 2, 1e-9), JSON.stringify(stRound.camera));

  // 旧版 `focalEvents`（焦距）仍能读进来：换算成等价视角并给出告警
  {
    const legacy = mk();
    delete legacy.camera.angleEvents;
    legacy.camera.focalEvents = [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 900, end: 1800, easingType: 1 }];
    const legacyChart = prepareChart(parseRpeChart(legacy));
    check(
      '旧版焦距通道 focalEvents 能读成等价视角（F=1 → 53.13°，F=2 → 28.07°）',
      near(legacyChart.camera.angle[0].start, focalToAngle(1), 1e-9) && near(legacyChart.camera.angle[0].end, focalToAngle(2), 1e-9),
      `start=${((legacyChart.camera.angle[0].start * 180) / Math.PI).toFixed(2)}° end=${((legacyChart.camera.angle[0].end * 180) / Math.PI).toFixed(2)}°`,
    );
    const legacyOut = serializeRpe(legacyChart).json;
    check('旧版焦距导出时改写成 angleEvents（不再写 focalEvents）', Array.isArray(legacyOut.camera?.angleEvents) && legacyOut.camera.focalEvents === undefined, Object.keys(legacyOut.camera ?? {}).join(','));
  }

  // 内部项目格式往返
  const fromProj = prepareChart(parseProject(serializeProject(chart).json));
  const stProj = createState(fromProj);
  evaluate(stProj, 2);
  check(
    '内部项目格式往返：相机关键帧（拍值 / 取值 / 缓动）都在',
    near(stProj.camera.x, 0.25, 1e-9) && near(stProj.camera.z, 0.25, 1e-9) && typeof fromProj.camera.x[0].easingFn === 'function',
    JSON.stringify(stProj.camera),
  );

  // ── 投影：相机位置 / 视角怎么影响画面 ──
  const view = createProjection(1280, 720);
  const note = { positionX: 0, above: true, distY: 0, size: 1, speed: 1 };
  const line = { worldX: 0, worldY: 0, worldRotate: 0, z: 0, theta: 0 };
  const o = { noteWidthRatio: 0.125 };
  const at = (camera) => view.noteTransform(note, line, { ...o, camera });
  const none = at(null);
  check('没有相机时与默认相机逐像素一致', near(at(CAMERA_DEFAULTS).x, none.x, 1e-12) && near(at(CAMERA_DEFAULTS).y, none.y, 1e-12));
  check('相机往右平移 0.25 屏宽 → 画面整体往左移 0.25 屏宽', near(at({ x: 0.25 }).x, none.x - 0.25 * view.areaW, 1e-9), `${none.x.toFixed(1)} → ${at({ x: 0.25 }).x.toFixed(1)}`);
  check('相机往上平移 0.25 屏高 → 画面整体往下走 0.25 屏高', near(at({ y: 0.25 }).y, none.y + 0.25 * view.areaH, 1e-9), `${none.y.toFixed(1)} → ${at({ y: 0.25 }).y.toFixed(1)}`);
  check('相机推进 0.5 屏高（往屏幕内）→ k = F/(F−0.5F) = 2（整体放大）', near(at({ z: 0.5 }).depthScale, 2, 1e-12), `k=${at({ z: 0.5 }).depthScale}`);
  check(
    '视角只改透视强弱：画面平面上的东西大小不变（k = 1），远处的东西才对视角敏感',
    near(at({ angle: degToRad(90) }).depthScale, 1, 1e-12) &&
      view.depthScaleAt(1, { camera: { angle: degToRad(90) } }) < view.depthScaleAt(1, { camera: { angle: PSEUDO3D.ANGLE_DEFAULT } }),
    `90° 时 z=1 的 k=${view.depthScaleAt(1, { camera: { angle: degToRad(90) } }).toFixed(3)}（默认 53.13° 时 ${view.depthScaleAt(1, { camera: { angle: PSEUDO3D.ANGLE_DEFAULT } }).toFixed(3)}）`,
  );
  check(
    '视角越大 = 广角 = 透视越强（等比于焦距更短）',
    near(view.depthScaleAt(1, { camera: { angle: degToRad(120) } }), angleToFocal(degToRad(120)) / (1 + angleToFocal(degToRad(120))), 1e-9),
    `120° 时 k=${view.depthScaleAt(1, { camera: { angle: degToRad(120) } }).toFixed(4)}`,
  );
  // 相机平移 + 深度 → 视差：远处的音符移动得少
  const farNote = { positionX: 0, above: true, distY: 0, size: 1, speed: 1 };
  const farLine = { worldX: 0, worldY: 0, worldRotate: 0, z: 1, theta: 0 };
  const cam = { x: 0.25 };
  const farShift = Math.abs(view.noteTransform(farNote, farLine, { ...o, camera: cam }).x - view.noteTransform(farNote, farLine, o).x);
  const nearShift = Math.abs(at(cam).x - none.x);
  check('相机平移时产生视差（近处的音符移动得比远处的多）', nearShift > farShift && farShift > 0, `近 ${nearShift.toFixed(1)}px / 远 ${farShift.toFixed(1)}px`);

  // 平移 + 推拉的组合：位置与缩放一起生效
  const combo = at({ x: 0.25, z: 0.5 });
  check(
    '相机位置与推拉叠加：先按 k 缩放，再减掉相机位置',
    near(combo.x, view.cx + (0 - 0.25 * view.areaW) * 2, 1e-9),
    `x=${combo.x.toFixed(1)}（期望 ${(view.cx - 0.5 * view.areaW).toFixed(1)}）`,
  );

  // 判定带：轨道判定跟着相机走；垂直判定忽略相机
  const band = view.judgeBand(note, line, { ...o, camera: { x: 0.25 } });
  check('轨道判定：判定带跟着相机平移（落在音符被画到的位置）', near(band.center.x, none.x - 0.25 * view.areaW, 1e-6), `带中心 ${band.center.x.toFixed(1)}`);
  check(
    '轨道判定：点在画面上音符所在的位置算命中；点在「没有相机时」的位置反而不算',
    view.hitJudgeBand(note, line, band.center.x, band.center.y, { ...o, camera: { x: 0.25 } }) === true &&
      view.hitJudgeBand(note, line, none.x, none.y, { ...o, camera: { x: 0.25 } }) === false,
  );
  const igBand = view.judgeBand(note, line, { ...o, camera: { x: 0.25 }, ignore3D: true });
  check('垂直判定：忽略相机（判定带回到 2D 的那条列）', near(igBand.center.x, view.cx, 1e-9), `带中心 ${igBand.center.x.toFixed(1)}`);

  // 打击特效：按命中时刻的相机快照投影（相机在动时不会飘）
  const hitPos = view.projectLocal(0, 0, 0, 0, 0, { camera: { x: 0.25 } });
  check('打击特效按命中时刻的相机快照定位', near(hitPos.x, view.cx - 0.25 * view.areaW, 1e-9), `x=${hitPos.x.toFixed(1)}`);

  // lint：相机的越界 / 非法视角要能报出来
  const { auditChart } = await import('../src/editor/lint.js');
  const bad = prepareChart(parseRpeChart({
    META: { RPEVersion: 140, offset: 0 },
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    camera: {
      zEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 0, end: 18000, easingType: 1 }],
      angleEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: 53.13, end: 200, easingType: 1 }],
    },
    judgeLineList: [{ Name: 'L', eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [1e9, 0, 1], start: 255, end: 255, easingType: 1 }] }], notes: [] }],
  }));
  const scan = auditChart(bad);
  check('纠错：相机取值越界报警告（camera-value）', (scan.counts['camera-value'] ?? 0) >= 1, JSON.stringify(scan.counts));
  check('纠错：相机视角越界（≥180°）报错误（camera-angle）', (scan.counts['camera-angle'] ?? 0) >= 1, JSON.stringify(scan.counts));
  check('纠错：相机条目带 camera 标记且 where 指向谱面相机', (scan.items ?? []).some((it) => it.camera === true && /谱面相机/.test(it.where)), JSON.stringify((scan.items ?? []).map((it) => it.where)));
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
section('Hold 尾部速度：独立（官方 own） vs 跟随判定线（RPE line，缺省）');
{
  // 官方格式、bpm 60（1 拍 = 1s）：速度事件在 4s 处由 1 变 2，长条 4s~8s
  const mkHoldChart = () => ({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 60,
        notesAbove: [{ type: 3, time: 128, positionX: 0, holdTime: 128, speed: 1, floorPosition: 4 }],
        notesBelow: [],
        speedEvents: [
          { startTime: 0, endTime: 128, value: 1 },
          { startTime: 128, endTime: 1000000000, value: 2 },
        ],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      },
    ],
  });
  /** 取一个 Hold 在 t=4s（头部刚落到线上）时的尾部位置 */
  const tailAt = (holdSpeed) => {
    const chart = prepareChart(parseOfficialChart(mkHoldChart()));
    const note = chart.notes[0];
    if (holdSpeed === null) delete note.holdSpeed;
    else note.holdSpeed = holdSpeed;
    evaluate(createState(chart), 4.0);
    return note;
  };
  const own = tailAt('own');
  check('官方导入的 Hold = 独立尾速度（长度 = speed × 时长 = 4 Y）', own.holdSpeed === 'own' && near(own.headY, 0, 1e-9) && near(own.tailY, 4, 1e-6), `tailY=${own.tailY}`);
  const line = tailAt('line');
  check('「跟随判定线」口径：长度 = 判定线速度积分（PJ(8s) − PJ(4s) = 8 Y）', near(line.tailY, 8, 1e-6), `tailY=${line.tailY}`);
  const dflt = tailAt(null);
  check('缺省（没有 holdSpeed 字段）= 非独立：与 line 一致', near(dflt.tailY, 8, 1e-6), `tailY=${dflt.tailY}`);

  /**
   * 命中瞬间的长度必须连续（用户实测：RPE 的 Hold 一碰到判定线就变短）。
   * 取「头部贴线前一帧 / 后一帧」的长度（尾部 − 头部），中途判定线速度是 2 Y/s ≠ 1 Y/s，
   * 旧的「命中后尾部 = speed × 剩余秒数」会从 8 Y 跳到 4 Y。
   */
  const lenAroundHit = (holdSpeed, speedMul = 1, t = 4.0) => {
    const sample = (when, headHit) => {
      const chart = prepareChart(parseOfficialChart(mkHoldChart()));
      const note = chart.notes[0];
      note.speed = speedMul;
      if (holdSpeed === null) delete note.holdSpeed;
      else note.holdSpeed = holdSpeed;
      const st = createState(chart);
      evaluate(st, when);
      if (headHit) {
        note.judged = true;
        note.judgement = 'perfect';
        evaluate(st, when);
      }
      return { len: note.tailY - note.headY, headY: note.headY, tailY: note.tailY };
    };
    const before = sample(t - 0.001, false);
    const after = sample(t + 0.001, true);
    return { before, after };
  };
  const cont = lenAroundHit('line');
  check(
    'RPE（line）口径：贴线瞬间长度不跳变（前 8.00 → 后 8.00）',
    near(cont.before.len, 8, 0.01) && near(cont.after.len, 8, 0.01),
    `len ${cont.before.len.toFixed(3)} → ${cont.after.len.toFixed(3)}`,
  );
  check('RPE（line）口径：命中后头部贴线、不再下落', near(cont.after.headY, 0, 1e-9), `headY=${cont.after.headY}`);
  // 官方（own）口径：官方 η 本来就是「尾速度」、头速度恒为 1，命中前后也必须连续
  const contOwn = lenAroundHit('own');
  check(
    '官方（own）口径：贴线瞬间长度不跳变（4.00 → 4.00）',
    near(contOwn.before.len, 4, 0.01) && near(contOwn.after.len, 4, 0.01),
    `len ${contOwn.before.len.toFixed(3)} → ${contOwn.after.len.toFixed(3)}`,
  );
  // RPE 的 speed 是整颗音符的流速倍率（Phira `bottom = spd × (height − line_height)`）：
  // 命中前头部也乘 speed，因此长条是刚体（长度 = speed × (PJ(tE) − PJ(tN))，不随下落时间变）
  {
    const chart = prepareChart(parseOfficialChart(mkHoldChart()));
    const note = chart.notes[0];
    note.speed = 2;
    note.holdSpeed = 'line';
    evaluate(createState(chart), 3.5);
    check(
      'RPE（line）口径：命中前头部也乘 speed（t=3.5 时 headY = 2 × 0.5 = 1）',
      near(note.headY, 1, 1e-6) && near(note.tailY - note.headY, 16, 1e-6),
      `headY=${note.headY} 长度=${note.tailY - note.headY}`,
    );
  }
  {
    // 官方（own）口径：头速度恒为 1，不乘 speed
    const chart = prepareChart(parseOfficialChart(mkHoldChart()));
    const note = chart.notes[0];
    note.speed = 2;
    note.holdSpeed = 'own';
    evaluate(createState(chart), 3.5);
    check('官方（own）口径：头速度恒为 1（t=3.5 时 headY = 0.5）', near(note.headY, 0.5, 1e-6), `headY=${note.headY}`);
  }
  {
    // 官谱导出：line 口径的 Hold 写成等价尾速度时**要乘 note.speed**
    // （导出器读的是源音符 `line.notes`：编辑器改的也是源对象，所以两边都要写）
    const { serializeOfficial } = await import('../src/core/serialize-official.js');
    const chart = prepareChart(parseOfficialChart(mkHoldChart()));
    const note = chart.notes[0];
    note.speed = 2;
    note.holdSpeed = 'line';
    note.src.speed = 2;
    note.src.holdSpeed = 'line';
    const { json, warnings } = serializeOfficial(chart);
    const out = json.judgeLineList[0].notesAbove[0];
    check(
      '官谱导出：line 口径的 Hold 尾速度 = speed × (PJ(尾) − PJ(头)) / 时长 = 4',
      near(out.speed, 4, 1e-6) && warnings.some((w) => w.includes('跟随判定线速度')),
      `speed=${out.speed} warn=${warnings.join(' | ') || '（无）'}`,
    );
    check('官谱导出：floorPosition 写出模型里的高度（4）', near(out.floorPosition, 4, 1e-6), `floorPosition=${out.floorPosition}`);
  }
}

// ---------------------------------------------------------------- 全局流速控制（meta.speedMultiplier）
section('全局流速控制：整张谱面（含官谱 Hold）统一按倍率变快，预览与导出结果一致');
{
  const { serializeRpe } = await import('../src/core/serialize-rpe.js');
  const { serializeOfficial } = await import('../src/core/serialize-official.js');
  const { serializeProject, parseProject } = await import('../src/core/project.js');
  const { speedMultiplierOf, GENERATOR_STAMP, DEFAULT_SPEED_MULTIPLIER } = await import('../src/core/meta.js');
  // bpm 60（1 拍 = 1s）：1 个 Tap + 1 个 Hold，都落在 4s；速度事件恒为 1 Y/s
  const mk = () => ({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 60,
        notesAbove: [
          { type: 1, time: 128, positionX: 0, holdTime: 0, speed: 1, floorPosition: 4 },
          { type: 3, time: 128, positionX: 0, holdTime: 128, speed: 1, floorPosition: 4 },
        ],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      },
    ],
  });
  const at = (chart, t = 3) => {
    const st = createState(chart);
    evaluate(st, t);
    return chart.notes.map((n) => ({ headY: n.headY, tailY: n.tailY }));
  };

  check('缺省倍率 = 1（`meta.speedMultiplier` 缺省，导出不放大）', DEFAULT_SPEED_MULTIPLIER === 1 && speedMultiplierOf({}) === 1);
  check(
    '倍率非法时退回 1（0 / 负数 / 非数字）',
    speedMultiplierOf({ speedMultiplier: 0 }) === 1 && speedMultiplierOf({ speedMultiplier: -2 }) === 1 && speedMultiplierOf({ speedMultiplier: 'x' }) === 1,
    `${speedMultiplierOf({ speedMultiplier: 0 })} / ${speedMultiplierOf({ speedMultiplier: -2 })}`,
  );

  const base = prepareChart(parseOfficialChart(mk()));
  check('倍率 1：官谱导出的速度事件与音符 speed 原样', serializeOfficial(base).json.judgeLineList[0].speedEvents[0].value === 1);

  const x2 = prepareChart(parseOfficialChart(mk()));
  x2.meta.speedMultiplier = 2;
  const off = serializeOfficial(x2).json;
  const offNotes = off.judgeLineList[0].notesAbove;
  check(
    '官谱导出：速度事件 ×2；普通音符 speed 原样；官谱口径 Hold 的 speed ×2（长度靠它）',
    near(off.judgeLineList[0].speedEvents[0].value, 2, 1e-9) && near(offNotes[0].speed, 1, 1e-9) && near(offNotes[1].speed, 2, 1e-9),
    `event=${off.judgeLineList[0].speedEvents[0].value} tap=${offNotes[0].speed} hold=${offNotes[1].speed}`,
  );
  const rpeOut = serializeRpe(x2).json;
  check(
    'RPE 导出不烘焙：速度事件只做单位换算（1 Y/s → 4.5），音符 speed 原值，倍率写进 META.speedMultiplier',
    near(rpeOut.judgeLineList[0].eventLayers[0].speedEvents[0].start, 4.5, 1e-6) &&
      near(rpeOut.META.speedMultiplier, 2, 1e-9) &&
      rpeOut.judgeLineList[0].notes.every((n) => near(n.speed, 1, 1e-9)),
    `event=${rpeOut.judgeLineList[0].eventLayers[0].speedEvents[0].start}｜META.speedMultiplier=${rpeOut.META.speedMultiplier}｜notes=${rpeOut.judgeLineList[0].notes.map((n) => n.speed).join(',')}`,
  );
  check('倍率 1 时不写 META.speedMultiplier（保持普通 RPE 文件干净）', serializeRpe(base).json.META.speedMultiplier === undefined);
  check(
    '导出 json 头部有生成器声明（两个格式都是第一个键）',
    off.generator === GENERATOR_STAMP && Object.keys(off)[0] === 'generator' && rpeOut.generator === GENERATOR_STAMP && Object.keys(rpeOut)[0] === 'generator',
    `official=${Object.keys(off)[0]} rpe=${Object.keys(rpeOut)[0]}`,
  );

  // 预览与导出必须一致：倍率 2 → 所有音符（含官谱 Hold）的下落距离与 Hold 长度都是 2 倍
  const preview = at(x2);
  const back = at(prepareChart(parseOfficialChart(off)));
  check(
    '预览：k=2 时音符下落与 Hold 长度都正好 ×2（不再是 k²）',
    near(preview[0].headY, 2, 1e-6) && near(preview[1].headY, 2, 1e-6) && near(preview[1].tailY, 10, 1e-6),
    preview.map((n) => `${n.headY.toFixed(2)}/${n.tailY?.toFixed(2)}`).join(' '),
  );
  check(
    '预览与官谱导出逐值一致（官方口径 Hold 的头部也一致）',
    near(preview[0].headY, back[0].headY, 1e-6) && near(preview[1].headY, back[1].headY, 1e-6) && near(preview[1].tailY, back[1].tailY, 1e-6),
    `预览 ${preview.map((n) => `${n.headY.toFixed(2)}/${n.tailY?.toFixed(2)}`).join(' ')}｜回读 ${back.map((n) => `${n.headY.toFixed(2)}/${n.tailY?.toFixed(2)}`).join(' ')}`,
  );
  // RPE 往返：倍率无损（走 META），音符逐值一致；官谱口径 Hold 换算成 RPE 等效后长度一致
  const rpeBack = prepareChart(parseRpeChart(rpeOut));
  const rpeAt = at(rpeBack);
  check(
    'RPE 往返：倍率从 META 读回（k=2），普通音符逐值一致',
    near(speedMultiplierOf(rpeBack.meta), 2, 1e-9) && near(rpeAt[0].headY, preview[0].headY, 1e-6),
    `k=${rpeBack.meta.speedMultiplier}｜${rpeAt[0].headY?.toFixed(3)} vs ${preview[0].headY?.toFixed(3)}`,
  );

  // 官谱口径 Hold → RPE 等效 Hold：换算 speed 使**长度**一致（头部下落随换算倍率，见导出告警）
  {
    const conv = () => ({
      formatVersion: 3,
      offset: 0,
      judgeLineList: [
        {
          bpm: 60,
          // 线速 2 Y/s：hold 2s~6s（时长 4s）、speed 1.5 → 长度 6 Y；PJ 跨度 = 8 Y → speed' = 0.75
          notesAbove: [{ type: 3, time: 64, positionX: 0, holdTime: 128, speed: 1.5, floorPosition: 4 }],
          notesBelow: [],
          speedEvents: [{ startTime: 0, endTime: 1000000000, value: 2 }],
          judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
          judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
          judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
        },
      ],
    });
    const chart = prepareChart(parseOfficialChart(conv()));
    chart.meta.speedMultiplier = 2;
    const out = serializeRpe(chart);
    const holdOut = out.json.judgeLineList[0].notes.find((n) => n.type === 2);
    check(
      '官谱口径 Hold → RPE：按 speed′ = speed × 时长 / (PJ(尾) − PJ(头)) 换算（1.5 × 4 / 8 = 0.75）',
      near(holdOut.speed, 0.75, 1e-6) && out.warnings.some((w) => w.includes('等效 speed')),
      `speed=${holdOut.speed}｜${out.warnings.filter((w) => w.includes('Hold')).join('；') || '（无告警）'}`,
    );
    const lenAt = (c, t) => {
      const st = createState(c);
      evaluate(st, t);
      const h = c.notes.find((n) => n.type === 'hold');
      return { head: h.headY, len: h.tailY - h.headY };
    };
    const before = lenAt(chart, 3);
    const after = lenAt(prepareChart(parseRpeChart(out.json)), 3);
    check(
      '换算后长度一致（头部下落按 RPE 语义变成 speed′ 倍：3.0 → 2.25）',
      near(before.len, after.len, 1e-6) && near(after.head, before.head * 0.75, 1e-6),
      `长度 ${before.len.toFixed(3)} → ${after.len.toFixed(3)}｜头部 ${before.head.toFixed(3)} → ${after.head.toFixed(3)}`,
    );
    // 判定线在这段时间没有位移 → 换不出来，原样写并告警
    const flat = conv();
    flat.judgeLineList[0].speedEvents = [{ startTime: 0, endTime: 1000000000, value: 0 }];
    const flatChart = prepareChart(parseOfficialChart(flat));
    const flatOut = serializeRpe(flatChart);
    check(
      '判定线在 Hold 期间没位移时无法换算：原样写 speed 并给出告警',
      near(flatOut.json.judgeLineList[0].notes.find((n) => n.type === 2).speed, 1.5, 1e-9) &&
        flatOut.warnings.some((w) => w.includes('无法用 RPE 的 speed 表达长度')),
      flatOut.warnings.filter((w) => w.includes('Hold')).join('；') || '（无告警）',
    );
  }

  // 项目格式：倍率随 meta 往返
  const project = serializeProject(x2).json;
  const restored = prepareChart(parseProject(project));
  check('项目文件往返保留倍率', speedMultiplierOf(restored.meta) === 2, `k=${restored.meta.speedMultiplier}`);
}

{
  const { createInput } = await import('../src/core/input.js');
  const { JUDGE } = await import('../src/core/units.js');
  const { advancePlayJudging, judgeWindowFor, windowMaxFor } = await import('../src/core/state.js');

  /** 秒 -> RPE Beat（分母 1000，够精确且好读） */
  const beat = (sec) => {
    const whole = Math.floor(sec + 1e-9);
    return [whole, Math.round((sec - whole) * 1000), 1000];
  };
  /** 一个 RPE 音符：type 1 tap / 2 hold / 3 flick / 4 drag */
  const note = (type, at, endAt = at) => ({
    type,
    startTime: beat(at),
    endTime: beat(endAt),
    positionX: 0,
    above: 1,
    isFake: 0,
    speed: 1,
    size: 1,
    yOffset: 0,
    visibleTime: 999999,
    alpha: 255,
  });
  /** 一张单线 RPE 谱：bpm 60 → 1 拍 = 1 秒（判定窗口直接按秒读） */
  const mkChart = (notes, { isFake = false } = {}) => ({
    format: 'rpe',
    META: { RPEVersion: 140, offset: 0, name: 'play-test' },
    BPMList: [{ startTime: [0, 0, 1], bpm: 60 }],
    judgeLineList: [
      {
        Name: 'L',
        Texture: 'line.png',
        bpmfactor: 1,
        isCover: 0,
        father: -1,
        eventLayers: [
          {
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 255, end: 255, easingType: 1 }],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 5, end: 5 }],
          },
        ],
        notes: notes.map((n) => ({ ...n, isFake: isFake ? 1 : n.isFake })),
      },
    ],
  });
  const mkState = (notes, opts = {}) => {
    const chart = prepareChart(parseRpeChart(mkChart(notes, opts), { file: 'play.json' }));
    return createState(chart, { autoplay: false });
  };
  /** 模拟一次触摸：往输入缓冲里塞一个 tap（at = 谱面秒） */
  const tapInput = (...ats) => {
    const input = createInput();
    for (const at of ats) input.tap(at);
    input.down('f0');
    return input;
  };
  const swipeInput = (at) => {
    const input = createInput();
    input.swipe(at);
    input.down('f0');
    return input;
  };
  const noInput = () => createInput();
  /** 按住不放的输入：at 传 null 表示「这一帧不新增点击，只是手还按着」 */
  const holdInput = (at, fingerId = 'f1') => {
    const input = createInput();
    if (at !== null) input.tap(at, 0, 0, fingerId);
    input.down(fingerId);
    return input;
  };
  /** 判定 + 取该音符的判定结果 */
  const judgeAt = (state, time, input) => {
    advancePlayJudging(state, time, input);
    return state;
  };

  // 1) 窗口纯函数
  check('JUDGE 常量与 docs/Phigros文档.md 的判定窗口 一致（Tap ±0.08/0.18/0.22）', JUDGE.TAP.perfect === 0.08 && JUDGE.TAP.good === 0.18 && JUDGE.TAP.bad === 0.22);
  check(
    'judgeWindowFor：Tap 四档边界',
    judgeWindowFor('tap', 0.08) === 'perfect' &&
      judgeWindowFor('tap', 0.081) === 'good' &&
      judgeWindowFor('tap', 0.18) === 'good' &&
      judgeWindowFor('tap', 0.181) === 'bad' &&
      judgeWindowFor('tap', 0.22) === 'bad' &&
      judgeWindowFor('tap', 0.221) === null,
  );
  check('judgeWindowFor：Hold 无 Bad', judgeWindowFor('hold', 0.181) === null && judgeWindowFor('hold', 0.18) === 'good', String(judgeWindowFor('hold', 0.181)));
  check(
    'judgeWindowFor：Drag / Flick 窗口都是 ±0.08（项目口径）',
    judgeWindowFor('drag', 0.08) === 'perfect' &&
      judgeWindowFor('drag', 0.081) === null &&
      judgeWindowFor('flick', 0.08) === 'perfect' &&
      judgeWindowFor('flick', 0.081) === null,
    `drag(0.081)=${judgeWindowFor('drag', 0.081)} flick(0.081)=${judgeWindowFor('flick', 0.081)}`,
  );
  check('windowMaxFor：Tap 0.22 / Hold 0.18 / Drag 0.08 / Flick 0.08', windowMaxFor('tap') === 0.22 && windowMaxFor('hold') === 0.18 && windowMaxFor('drag') === 0.08 && windowMaxFor('flick') === 0.08);

  // 1) Tap：Perfect / Good / Bad / Miss 四档（每次用新谱）
  {
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.0, tapInput(4.0));
    check('Tap 准时点击 → Perfect', s.chart.notes[0].judgement === 'perfect' && s.stats.perfect === 1 && s.stats.combo === 1);
  }
  {
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.1, tapInput(4.1));
    check('Tap 差 0.1s → Good（连击不断）', s.chart.notes[0].judgement === 'good' && s.stats.good === 1 && s.stats.combo === 1);
    check('Good 按 65% 计判定分', Math.abs(s.stats.judgeScore - 0.65 * (900000 / s.chart.noteCount)) < 1e-6, `judgeScore=${s.stats.judgeScore}`);
  }
  {
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.2, tapInput(4.2));
    check('Tap 差 0.2s → Bad（断连、0 分）', s.chart.notes[0].judgement === 'bad' && s.stats.bad === 1 && s.stats.combo === 0);
    // Bad 音符按 docs/Phigros文档.md 的参考实现关键渲染常数 保留 0.5s 的暗红淡出
    evaluate(s, 4.3);
    check('Bad 音符仍在淡出中且标记为 badStyle', s.chart.notes[0].visible === true && s.chart.notes[0].badStyle === true && s.chart.notes[0].renderAlpha < 1, `alpha=${s.chart.notes[0].renderAlpha?.toFixed(2)}`);
    evaluate(s, 4.75);
    check('Bad 淡出结束后消失', s.chart.notes[0].visible === false);
  }
  {
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.1, noInput());
    check('窗口内没有输入时不判定（还没到过期）', s.chart.notes[0].judged === false);
    judgeAt(s, 4.3, noInput());
    check('超过 0.22s 仍无输入 → Miss（断连）', s.chart.notes[0].judgement === 'miss' && s.stats.miss === 1 && s.stats.combo === 0);
  }

  // 2) 多指：一次点击只判一个音符，双押必须两指
  {
    const s = mkState([note(1, 4), note(1, 4)]);
    judgeAt(s, 4.0, tapInput(4.0));
    check('双押只点一下 → 只判一个（多指判定）', s.stats.perfect === 1 && s.chart.notes.filter((n) => n.judged).length === 1, `perfect=${s.stats.perfect}`);
    judgeAt(s, 4.3, noInput());
    check('另一个音符过期 → Miss', s.stats.miss === 1, `miss=${s.stats.miss}`);
  }
  {
    const s = mkState([note(1, 4), note(1, 4)]);
    judgeAt(s, 4.0, tapInput(4.0, 4.0));
    check('双押两指 → 两个 Perfect', s.stats.perfect === 2 && s.stats.combo === 2);
  }
  {
    // 空点不扣分、不吃音符
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.0, tapInput(2.0));
    check('窗口外的点击是空点（不扣分、不消耗音符）', s.stats.judged === 0 && s.chart.notes[0].judged === false);
  }

  // 3) 归属：一次点击判「最早的可判定音符」
  {
    const s = mkState([note(1, 4), note(1, 4.05)]);
    judgeAt(s, 4.06, tapInput(4.06));
    check('同时可判定时归给更早的音符（docs/Phigros文档.md 的判定窗口）', s.chart.notes[0].judged === true && s.chart.notes[1].judged === false);
  }

  // 4) Drag：判定时刻**有手指在判定带里**才 Perfect；没手指 → Miss（不再「过线即满分」）
  {
    const s = mkState([note(4, 5)]);
    judgeAt(s, 4.99, noInput());
    check('Drag 未到时刻不判定', s.chart.notes[0].judged === false);
    judgeAt(s, 5.0, noInput());
    check('Drag 判定时刻没有手指 → 不判定（窗口内还能救）', s.chart.notes[0].judged === false);
    judgeAt(s, 5.11, noInput());
    check('Drag 窗口过了还没手指 → Miss', s.chart.notes[0].judgement === 'miss' && s.stats.miss === 1, String(s.chart.notes[0].judgement));
  }
  {
    // 手指按在带里（不必是新点击）→ Perfect
    const s = mkState([note(4, 5)]);
    const held = createInput();
    held.down('f1', 0, 0); // 一根手指一直按着（位置在「带内」，见 onlyLeftColumn 之外的默认全屏）
    judgeAt(s, 5.0, held);
    check('Drag：判定时刻有手指按着 → Perfect', s.chart.notes[0].judgement === 'perfect' && s.stats.perfect === 1);
  }
  {
    // 全屏判定模式下也一样：只要有手指就过
    const s = mkState([note(4, 5)]);
    const held = createInput();
    held.down('f1', 900, 700);
    judgeAt(s, 5.0, held);
    check('Drag：全屏判定下有手指 → Perfect', s.chart.notes[0].judgement === 'perfect');
  }

  // 5) Flick：窗口内有滑动即 Perfect（简化口径）
  {
    const s = mkState([note(3, 6)]);
    judgeAt(s, 6.0, noInput());
    check('Flick 没有滑动时不判定', s.chart.notes[0].judged === false);
    judgeAt(s, 6.05, swipeInput(6.05));
    check('Flick 窗口内有滑动 → Perfect', s.chart.notes[0].judgement === 'perfect' && s.stats.perfect === 1);
  }
  {
    const s = mkState([note(3, 6)]);
    judgeAt(s, 6.2, noInput());
    check('Flick 无滑动过期 → Miss', s.chart.notes[0].judgement === 'miss');
  }
  {
    // 一次滑动点亮同时刻的多个 Flick
    const s = mkState([note(3, 6), note(3, 6)]);
    judgeAt(s, 6.0, swipeInput(6.0));
    check('一次滑动满足同时刻的所有 Flick', s.stats.perfect === 2);
  }

  // 6) Hold：头部点中 + 持续时间内判定范围里**一直有手指**（可换手、断连 ≤80ms 可救）→ 记分；断连更久 = Miss；无 Bad
  {
    // 头部 7.0 命中，按住到 9.0（尾部）→ 记分
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1')); // 点中头部并按住
    check('Hold 头部命中时不立刻记分（等按到尾部）', s.chart.notes[0].judged === false && s.chart.notes[0].holdPending?.judgement === 'perfect', `judged=${s.chart.notes[0].judged}`);
    check('Hold 头部命中后进入重复打击动画', s.activeHolds.length === 1);
    judgeAt(s, 8.0, holdInput(null, 'f1')); // 按着（同一根手指）
    check('Hold 按住中：还没到尾部就不记分', s.chart.notes[0].judged === false);
    judgeAt(s, 9.0, holdInput(null, 'f1'));
    check('Hold 按到尾部 → 按头部等级记分（Perfect）', s.chart.notes[0].judged === true && s.chart.notes[0].judgement === 'perfect' && s.stats.perfect === 1 && s.stats.combo === 1);
  }
  {
    // 断连超过 80ms → Miss（Hold 无 Bad），并标记成「半透明下落」
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    judgeAt(s, 7.5, noInput()); // 手指抬起了：断连计时开始
    check('Hold 刚松开时还不算 Miss（有 80ms 宽限）', s.chart.notes[0].judged === false);
    judgeAt(s, 7.59, noInput()); // 断连 90ms > 80ms
    check('Hold 断连超过 80ms → Miss（无 Bad）', s.chart.notes[0].judgement === 'miss' && s.stats.miss === 1 && s.stats.bad === 0, String(s.chart.notes[0].judgement));
    check('Hold 断连判 Miss 后标记为「半透明下落」', s.chart.notes[0].holdBroken === true);
    check('Hold 断连后停止重复打击动画', s.activeHolds.length === 0);
  }
  {
    // 断连 ≤80ms 迅速接上 → 不算 Miss（这里只断了 60ms）
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    judgeAt(s, 7.3, noInput());
    judgeAt(s, 7.36, holdInput(null, 'f2')); // 60ms 后换上另一根手指
    judgeAt(s, 9.0, holdInput(null, 'f2'));
    check('Hold 断连 60ms 内接上 → 不算 Miss（按头部等级记分）', s.chart.notes[0].judgement === 'perfect' && s.stats.miss === 0, String(s.chart.notes[0].judgement));
  }
  {
    // **换手**：另一根手指（哪怕它已经判过别的音符）按着就算保持 —— 只看「判定范围里有没有手指」
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    judgeAt(s, 7.5, holdInput(null, 'f2')); // f1 已抬起，f2 在同一帧按着
    judgeAt(s, 8.5, holdInput(null, 'f2'));
    judgeAt(s, 9.0, holdInput(null, 'f2'));
    check('Hold 允许换手：换成另一根手指按着仍然记分', s.chart.notes[0].judgement === 'perfect' && s.stats.miss === 0, String(s.chart.notes[0].judgement));
  }
  {
    // 头部差 0.1s → Good；按到尾部仍记 Good
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.1, holdInput(7.1, 'f1'));
    check('Hold 头部差 0.1s → 待定等级为 Good', s.chart.notes[0].holdPending?.judgement === 'good');
    judgeAt(s, 9.2, holdInput(null, 'f1'));
    check('Hold 收尾按头部的 Good 记分', s.chart.notes[0].judgement === 'good' && s.stats.good === 1);
  }
  {
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.2, tapInput(7.2));
    check('Hold 无 Bad：差 0.2s 的点击不会判成 Bad，而是过期 Miss', s.chart.notes[0].judgement === 'miss' && s.stats.bad === 0, String(s.chart.notes[0].judgement));
  }
  {
    // **小于半拍的 Hold**：不设断连概念 —— 头部点中之后随时松手都算按完
    // （bpm 60 → 1 拍 = 1s，0.5 拍 = 0.5s，所以 0.25s 的 Hold 属于「短 Hold」）
    const s = mkState([note(2, 7, 7.25)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    check('短 Hold：头部点中后进入待定', s.chart.notes[0].judged === false && !!s.chart.notes[0].holdPending);
    judgeAt(s, 7.05, noInput()); // 立刻松手（远早于尾部 - 30%）
    check('短 Hold：立刻松手也不算断连', s.chart.notes[0].judged === false && s.chart.notes[0].holdBroken !== true);
    judgeAt(s, 7.3, noInput()); // 越过尾部
    check('短 Hold：到尾部按头部等级记分（不判 Miss）', s.chart.notes[0].judgement === 'perfect' && s.stats.miss === 0 && s.stats.perfect === 1, String(s.chart.notes[0].judgement));

    // 对照：同样是「立刻松手」，长 Hold（2s，> 半拍）仍然判 Miss
    const s2 = mkState([note(2, 7, 9)]);
    judgeAt(s2, 7.0, holdInput(7.0, 'f1'));
    judgeAt(s2, 7.2, noInput());
    judgeAt(s2, 7.4, noInput());
    check('对照：长 Hold 立刻松手 → 断连判 Miss', s2.chart.notes[0].judgement === 'miss' && s2.chart.notes[0].holdBroken === true, String(s2.chart.notes[0].judgement));

    // 边界：0.5 拍（0.5s）本身不算「小于半拍」，仍按断连规则判
    // （注意要松在「尾部 − min(30% 时长, 1 拍) = 0.15s」之前，否则算在允许窗口内、应当记分）
    const s3 = mkState([note(2, 7, 7.5)]);
    judgeAt(s3, 7.0, holdInput(7.0, 'f1'));
    judgeAt(s3, 7.15, noInput());
    judgeAt(s3, 7.25, noInput()); // 断连 0.1s > 80ms 宽限，且早于 7.35（尾部 − 0.15s）
    check('边界：恰好半拍的 Hold 仍按断连规则判 Miss', s3.chart.notes[0].judgement === 'miss', String(s3.chart.notes[0].judgement));
  }
  {
    // 没点头部 → Miss（窗口 0.18）
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.17, noInput());
    check('Hold 头部窗口内没点 → 还不算 Miss', s.chart.notes[0].judged === false);
    judgeAt(s, 7.25, noInput());
    check('Hold 头部过期 → Miss', s.chart.notes[0].judgement === 'miss');
  }

  // 7) 漏接的表现：继续下落（越过判定线）+ 0.16s 淡出；Hold 漏接是半透明继续下落
  {
    const s = mkState([note(1, 4)]);
    judgeAt(s, 4.25, noInput()); // 过窗口 → Miss
    check('Tap 漏接 → Miss', s.chart.notes[0].judgement === 'miss');
    evaluate(s, 4.3);
    const n = s.chart.notes[0];
    check('Miss 后：位置越过判定线（distY < 0，不再钳制在线上）', n.distY < 0, `distY=${n.distY?.toFixed(3)}`);
    check('Miss 后：正在淡出（alpha 介于 0 与 1）', n.visible === true && n.renderAlpha > 0 && n.renderAlpha < 1, `alpha=${n.renderAlpha?.toFixed(3)}`);
    evaluate(s, 4.42);
    check('Miss 后 0.16s：淡出结束、不再渲染', n.visible === false, `alpha=${n.renderAlpha?.toFixed(3)}`);
    check('Miss 不产生打击特效', s.hits.length === 0);
  }
  {
    // 未判定（还没判）的音符过线后同样继续下落（不再停在线上）
    const s = mkState([note(1, 4)]);
    evaluate(s, 4.05);
    const n = s.chart.notes[0];
    check('未判定音符过线后继续下落（distY < 0）', n.judged === false && n.distY < 0, `distY=${n.distY?.toFixed(3)}`);
  }
  {
    // 没点到的 Hold：**不再半透明** —— 像普通音符一样正常下落，尾部过线后 0.16s 淡出
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.25, noInput()); // 头部窗口 0.18 过了 → Miss
    check('Hold 头部漏接 → Miss', s.chart.notes[0].judgement === 'miss');
    evaluate(s, 7.5);
    const n = s.chart.notes[0];
    check('漏接的 Hold：正常不透明（不再半透明显示）', n.renderAlpha === 1, `alpha=${n.renderAlpha}`);
    check('漏接的 Hold：头部越过判定线继续下落', n.headY < 0, `headY=${n.headY?.toFixed(3)}`);
    // 这条用例是 RPE 谱（缺省 = 跟随判定线口径）：长度 = speed × (PJ(endSec) − PJ(tN))，
    // 不随下落时间变化（speed = 1）
    const holdLen = n.speed * (n.tailHeight - n.height);
    check('漏接的 Hold：尾部跟着一起（长度 = 跟随判定线的长度，且不随时变）', Math.abs(n.tailY - n.headY - holdLen) < 1e-6, `tailY-headY=${(n.tailY - n.headY).toFixed(3)} 期望 ${holdLen.toFixed(3)}`);
    evaluate(s, 8.9);
    check('漏接的 Hold：尾部过线前仍然正常可见', n.visible === true && n.renderAlpha === 1, `visible=${n.visible} alpha=${n.renderAlpha}`);
    evaluate(s, 9.08);
    check(
      '漏接的 Hold：尾部过线后开始淡出（0.16s）',
      n.visible === true && n.renderAlpha > 0 && n.renderAlpha < 1,
      `alpha=${n.renderAlpha?.toFixed(3)}`,
    );
    evaluate(s, 9.2);
    check('漏接的 Hold：淡出结束、不再渲染', n.visible === false, `alpha=${n.renderAlpha?.toFixed(3)}`);
  }
  {
    // 按住过又断了 → 半透明、**按自然位置**继续下落：
    // 头部早就越过判定线了，不能再把它拉回判定线上重画一遍（用户报告的 bug）
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    evaluate(s, 7.4);
    const n = s.chart.notes[0];
    const pinned = n.headY; // 按着时贴线
    judgeAt(s, 7.5, noInput());
    judgeAt(s, 7.6, noInput()); // 断连 >80ms → Miss
    check('按住后断连 → Miss 且标记 holdBroken', n.judgement === 'miss' && n.holdBroken === true);
    evaluate(s, 7.6);
    const atBreak = n.headY;
    evaluate(s, 7.7);
    check(
      '断连的 Hold：半透明（HOLD_MISS_ALPHA）',
      Math.abs(n.renderAlpha - NOTE.HOLD_MISS_ALPHA) < 1e-6,
      `alpha=${n.renderAlpha}`,
    );
    check(
      '断连的 Hold：按自然位置下落（已过线的头部不再回到判定线上）',
      Math.abs(pinned) < 1e-9 && atBreak < -0.1 && n.headY < atBreak,
      `按着 headY=${pinned}／断连帧 headY=${atBreak.toFixed(4)}／之后 headY=${n.headY.toFixed(3)}`,
    );
    // 帧间位移与判定线自己的下落速度一致（0.1s 内下落 ≈ 线速 × 0.1）
    const perFrame = n.headY - atBreak;
    check('断连后按自然速度继续下落（帧间位移与线速一致）', perFrame < 0 && Math.abs(perFrame) < 1, `Δ=${perFrame.toFixed(4)}`);
    // 尾部越过判定线之前一直半透明可见，之后淡出、不再渲染
    evaluate(s, 8.6);
    check(
      '断连的 Hold：尾部过线前一直是半透明下落',
      n.visible === true && Math.abs(n.renderAlpha - NOTE.HOLD_MISS_ALPHA) < 1e-6 && n.tailY > 0,
      `tailY=${n.tailY?.toFixed(2)} alpha=${n.renderAlpha}`,
    );
    evaluate(s, 9.6);
    check('断连的 Hold：尾部过线后淡出结束、不再渲染', n.visible === false, `alpha=${n.renderAlpha}`);
  }
  {
    // 命中并正常按完的 Hold 不受影响：头部贴线、尾巴收回来（不半透明），结尾直接消失
    const s = mkState([note(2, 7, 9)]);
    judgeAt(s, 7.0, holdInput(7.0, 'f1'));
    evaluate(s, 7.5);
    const n = s.chart.notes[0];
    check('命中的 Hold：头部贴线（headY = 0）、尾巴收回来', Math.abs(n.headY) < 1e-9 && n.tailY < 2, `headY=${n.headY} tailY=${n.tailY}`);
    check('命中的 Hold：不是半透明', n.renderAlpha === 1, `alpha=${n.renderAlpha}`);
    evaluate(s, 9.3);
    check('命中的 Hold：按完后直接收掉（不再是半透明下落）', n.visible === false, `visible=${n.visible}`);
  }
  {
    const s = mkState([note(1, 4)], { isFake: true });
    judgeAt(s, 4.5, tapInput(4.5));
    check('假音符不参与判定与计分', s.chart.notes[0].judged === true && s.stats.judged === 0 && s.chart.noteCount === 0);
  }

  // 8) 自动游玩路径不受影响（回归）
  {
    const chart = prepareChart(parseRpeChart(mkChart([note(1, 4)]), { file: 'auto.json' }));
    const auto = createState(chart); // 默认 autoplay
    const hits = advanceJudging(auto, 4.0);
    check('自动游玩：落到线上仍判 Perfect 并出特效', auto.chart.notes[0].judgement === 'perfect' && hits.length === 1);
    const off = createState(prepareChart(parseRpeChart(mkChart([note(1, 4)]), { file: 'auto2.json' })), { autoplay: false });
    check('关掉 autoplay 后 advanceJudging 不再判定', advanceJudging(off, 4.0).length === 0 && off.stats.judged === 0);
  }

  // 8.5) 音效时刻：Drag / Flick 提前判定时等音符真的落线再响；落线后判定立刻响；Tap 不推迟
  {
    // Drag：手指已经按在带里，判定发生在落线前 50ms
    const s = mkState([note(4, 5)]);
    const held = createInput();
    held.down('f1', 0, 0);
    const hits = advancePlayJudging(s, 4.95, held);
    const note5 = s.chart.notes[0];
    check('Drag 提前判定 → Perfect', note5.judgement === 'perfect', String(note5.judgement));
    check(
      'Drag 提前判定：音效时刻推到音符落线时（不等判定帧）',
      hits.length === 1 && Math.abs(hits[0].soundTime - note5.timeSec) < 1e-9 && hits[0].time < note5.timeSec,
      `判定 ${hits[0]?.time} / 音效 ${hits[0]?.soundTime} / 落线 ${note5.timeSec}`,
    );

    // Drag：落线后 50ms 才判定 → 立刻响
    const s2 = mkState([note(4, 5)]);
    const held2 = createInput();
    held2.down('f1', 0, 0);
    const hits2 = advancePlayJudging(s2, 5.05, held2);
    check('Drag 落后判定：音效在判定那一刻就响', hits2.length === 1 && Math.abs(hits2[0].soundTime - hits2[0].time) < 1e-9, `判定 ${hits2[0]?.time} / 音效 ${hits2[0]?.soundTime}`);

    // Flick：提前划过 → 推迟；落后划过 → 立刻
    const mkFlickState2 = () => createState(prepareChart(parseRpeChart(mkChart([note(3, 5)]), { file: 'f.json' })), { autoplay: false });
    const f1 = mkFlickState2();
    const sw1 = createInput();
    sw1.swipe(4.95);
    sw1.down('f0');
    const fHits = advancePlayJudging(f1, 4.95, sw1);
    check('Flick 提前划过：音效时刻 = 落线时刻', fHits.length === 1 && Math.abs(fHits[0].soundTime - f1.chart.notes[0].timeSec) < 1e-9, `音效 ${fHits[0]?.soundTime}`);
    const f2 = mkFlickState2();
    const sw2 = createInput();
    sw2.swipe(5.05);
    sw2.down('f0');
    const fHits2 = advancePlayJudging(f2, 5.05, sw2);
    check('Flick 落后划过：音效立刻响', fHits2.length === 1 && Math.abs(fHits2[0].soundTime - fHits2[0].time) < 1e-9);

    // Tap：玩家主动点出来的，音效就是即时反馈 → 提前判定也立刻响
    const s3 = mkState([note(1, 5)]);
    const t3 = createInput();
    t3.tap(4.95, 0, 0, 'f1');
    t3.down('f1', 0, 0);
    const tHits = advancePlayJudging(s3, 4.95, t3);
    check('Tap 提前判定：音效不推迟（即时反馈）', tHits.length === 1 && Math.abs(tHits[0].soundTime - tHits[0].time) < 1e-9, `音效 ${tHits[0]?.soundTime} / 落线 ${s3.chart.notes[0].timeSec}`);

    // 播放器的待播队列：到点才播，跳转时清空
    const { createPlayer } = await import('../src/app/player.js');
    const player = createPlayer();
    const fakeState = {};
    const fakeHit = { type: 'drag', time: 5.0, soundTime: 5.2, repeat: false };
    player.player.startedAt = 5.0;
    player.update(fakeState, () => {}, () => [fakeHit]);
    check('播放器：未到音效时刻 → 先排队', player.pendingSoundCount === 1, `${player.pendingSoundCount}`);
    player.player.startedAt = 5.1;
    player.update(fakeState, () => {}, () => []);
    check('播放器：还没到点不播', player.pendingSoundCount === 1, `${player.pendingSoundCount}`);
    player.player.startedAt = 5.25;
    player.update(fakeState, () => {}, () => []);
    check('播放器：到点后出队（只播一次）', player.pendingSoundCount === 0, `${player.pendingSoundCount}`);
    player.update(fakeState, () => {}, () => [{ ...fakeHit, soundTime: 9 }]);
    player.seek(0);
    check('播放器：跳转时清空待播音效', player.pendingSoundCount === 0, `${player.pendingSoundCount}`);
  }

  // 9) 整曲跑完：全 Perfect 时满分（与自动游玩同一条计分公式）
  {
    const notes = [];
    for (let i = 0; i < 20; i++) notes.push(note(1, 2 + i * 0.5));
    const s = mkState(notes);
    for (let i = 0; i < 20; i++) {
      const at = 2 + i * 0.5;
      judgeAt(s, at, tapInput(at));
    }
    judgeAt(s, 20, noInput());
    check('整曲全 Perfect → 1000000 分 / 最大连击 = 物量', s.stats.score === 1000000 && s.stats.maxCombo === 20, `score=${s.stats.score} maxCombo=${s.stats.maxCombo}`);
    check('全 Perfect 时 allPerfect 标志成立', s.stats.allPerfect === true && s.stats.fullCombo === true);
  }
  {
    const notes = [];
    for (let i = 0; i < 10; i++) notes.push(note(1, 2 + i * 0.5));
    const s = mkState(notes);
    judgeAt(s, 30, noInput());
    check('一个都不点：全部 Miss、分数 0、最大连击 0', s.stats.miss === 10 && s.stats.score === 0 && s.stats.maxCombo === 0, `miss=${s.stats.miss} score=${s.stats.score}`);
  }
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
section('打击特效：锚在音符落点、Hold 未结束时每 42 帧重放');
{
  const { NOTE } = await import('../src/core/units.js');
  // 一条快速移动的判定线：位置随时间明显变化，便于区分「落线时刻」与「判定时刻」
  const mkChart = () => ({
    formatVersion: 3,
    offset: 0,
    judgeLineList: [
      {
        bpm: 60,
        notesAbove: [
          { type: 1, time: 256, positionX: 0, holdTime: 0, speed: 1, floorPosition: 201 },
          { type: 3, time: 512, positionX: 0, holdTime: 256, speed: 1, floorPosition: 401 }, // 8s 起、4s 长的 hold
        ],
        notesBelow: [],
        speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
        // x 从 0.1 线性扫到 0.9（8 秒内），每秒移动 0.1 屏宽
        judgeLineMoveEvents: [{ startTime: 0, endTime: 640, start: 0.1, end: 0.9, start2: 0.5, end2: 0.5 }],
        judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
        judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
      },
    ],
  });

  // 1) 锚点：判定比落线晚 0.05s（模拟掉帧），特效仍应落在「落线时刻」的线位置
  const c1 = prepareChart(parseOfficialChart(mkChart()));
  const s1 = createState(c1);
  const noteTime = c1.notes[0].timeSec; // 8s
  const ref = createState(prepareChart(parseOfficialChart(mkChart())));
  evaluate(ref, noteTime); // 独立求值：线在落线时刻的位置
  evaluate(s1, noteTime + 0.05);
  const hits1 = advanceJudging(s1, noteTime + 0.05);
  check(
    '特效锚点为「音符落线时刻」的判定线位置（不是判定时刻）',
    hits1.length === 1 &&
      near(hits1[0].lineX, ref.lines[0].worldX, 1e-9) &&
      Math.abs(hits1[0].lineX - s1.lines[0].worldX) > 1e-6,
    `特效 x=${hits1[0]?.lineX?.toFixed(6)}，落线时刻 x=${ref.lines[0].worldX.toFixed(6)}，当前帧 x=${s1.lines[0].worldX.toFixed(6)}`,
  );
  check('特效纵向偏移只含 yOffset（落线时纵向距离为 0）', hits1[0]?.offsetY === 0, `offsetY=${hits1[0]?.offsetY}`);
  check('特效记录的是落线时刻 time', near(hits1[0].time, noteTime, 1e-9), `time=${hits1[0].time}`);

  // 2) 跳转补判：很久以前的音符只计分、不再补特效
  const c2 = prepareChart(parseOfficialChart(mkChart()));
  const s2 = createState(c2);
  evaluate(s2, 30);
  const lateHits = advanceJudging(s2, 30);
  check(
    '跳转后补判的旧音符不补特效（计分照常）',
    lateHits.length === 0 && s2.stats.judged === 2,
    `hits=${lateHits.length} judged=${s2.stats.judged}`,
  );

  // 3) Hold：头部命中后每 10 帧重放一次打击动画，直到结束
  const c3 = prepareChart(parseOfficialChart(mkChart()));
  const s3 = createState(c3);
  const hold = c3.notes[1];
  const holdTime = hold.timeSec; // 16s
  const at = (t) => {
    evaluate(s3, t);
    return advanceJudging(s3, t);
  };
  check('Hold 头部命中：产生首个打击动画', at(holdTime).length === 1, `${holdTime}s`);
  check('Hold 持续中：+10 帧重放第二个', at(holdTime + NOTE.HOLD_FX_INTERVAL).length === 1, `+${NOTE.HOLD_FX_INTERVAL.toFixed(3)}s`);
  check('Hold 持续中：+20 帧重放第三个', at(holdTime + 2 * NOTE.HOLD_FX_INTERVAL + 1e-6).length === 1, `+${(2 * NOTE.HOLD_FX_INTERVAL).toFixed(3)}s`);
  check(
    'Hold 重放间隔 = 10 帧 @60fps',
    near(NOTE.HOLD_FX_INTERVAL, 10 / 60, 1e-9),
    `HOLD_FX_INTERVAL=${NOTE.HOLD_FX_INTERVAL.toFixed(4)}`,
  );
  // 整段 Hold 期间的重放次数 ≈ 1 + floor(时长 / 间隔)
  const repeatCount = (() => {
    const c = prepareChart(parseOfficialChart(mkChart()));
    const st = createState(c);
    const h = c.notes[1];
    let total = 0;
    for (let t = h.timeSec; t < h.timeSec + h.durationSec + 0.3; t += 1 / 60) {
      evaluate(st, t);
      total += advanceJudging(st, t).length;
    }
    return { total, expect: 1 + Math.ceil(h.durationSec / NOTE.HOLD_FX_INTERVAL) - 1, duration: h.durationSec };
  })();
  check(
    '整段 Hold 的重放次数 ≈ 1 + floor(时长 / (10/60))',
    repeatCount.total === repeatCount.expect,
    `共 ${repeatCount.total} 次，期望 ${repeatCount.expect} 次（时长 ${repeatCount.duration}s）`,
  );
  const afterEnd = at(holdTime + hold.durationSec + 0.2);
  check('Hold 结束后不再产生新的打击动画', afterEnd.length === 0, `hits=${afterEnd.length}`);
  check('普通音符不重放（只有一次特效）', (() => {
    const c4 = prepareChart(parseOfficialChart(mkChart()));
    const s4 = createState(c4);
    const t0 = c4.notes[0].timeSec;
    evaluate(s4, t0);
    const first = advanceJudging(s4, t0).length;
    let repeats = 0;
    for (const dt of [0.5, 1.0, 1.5, 2.0]) {
      evaluate(s4, t0 + dt);
      repeats += advanceJudging(s4, t0 + dt).length;
    }
    return first === 1 && repeats === 0;
  })());
}

// ---------------------------------------------------------------- 缓动元数据
section('缓动：预设编号 / 贝塞尔标记（供时间轴显示「线性 / 缓动#N / 贝塞尔」）');
{
  const { makeEasing } = await import('../src/core/easing.js');
  const lin = makeEasing(1);
  check('线性（type 1）标记正确', lin.easingType === 1 && lin.easingPreset === 1 && lin.isBezier === false);
  const quad = makeEasing(5);
  check('预设 5 号保留编号', quad.easingType === 5 && quad.easingPreset === 5 && quad.isBezier === false, `easingType=${quad.easingType}`);
  const preset6 = makeEasing(6);
  // docs/Phigros文档.md 的 RPE easingType 对照表：6 号预设本身是 In Out Sine；「贝塞尔」由 bezier 开关 + bezierPoints 决定
  check(
    '预设 6 号是 In Out Sine（没给控制点就不算贝塞尔）',
    preset6.isBezier === false && preset6.easingType === 6 && preset6.easingPreset === 6 && preset6.bezierPoints === null,
    `isBezier=${preset6.isBezier} type=${preset6.easingType}`,
  );
  const bez6 = makeEasing(6, [0.25, 0.1, 0.25, 1]);
  check('6 号 + 控制点才是贝塞尔', bez6.isBezier === true && bez6.bezierPoints.length === 4);
  const custom = makeEasing(1, [0.1, 0.2, 0.3, 0.4]);
  check('自定义贝塞尔控制点被保留', custom.isBezier === true && Array.isArray(custom.bezierPoints) && custom.bezierPoints.length === 4);
  check('裁剪参数也带在函数上', makeEasing(5, null, 0.2, 0.8).easingLeft === 0.2 && makeEasing(5, null, 0.2, 0.8).easingRight === 0.8);
  check(
    '缓动函数本身仍然可用（值在 0..1 区间端点处正确）',
    Math.abs(lin(0)) < 1e-9 && Math.abs(lin(1) - 1) < 1e-9 && Math.abs(quad(0)) < 1e-9 && Math.abs(quad(1) - 1) < 1e-9,
  );
}

// ---------------------------------------------------------------- 元数据权威顺序
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
if (!(hasSample('official') && hasSample('rpe'))) {
  skipSample('健壮性：对真实样本随机变异（模糊测试）');
} else {
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
    ['official', official ?? { lines: [], notes: [] }],
    ['rpe', rpe ?? { lines: [], notes: [] }],
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

// ---------------------------------------------------------------- 序列化 / 导出
// 说明：这一节同时是「导出」功能的回归测试 —— 编辑器左上「导出」页做的三件事，
// 底层就是 serialize-official / serialize-rpe / project（序列化 + 反序列化）+ zip 写出。
const { serializeOfficial } = await import('../src/core/serialize-official.js');
const { serializeRpe } = await import('../src/core/serialize-rpe.js');
const { serializeProject, parseProject } = await import('../src/core/project.js');
const { createZip } = await import('../src/core/zip.js');
const { buildChartZip, buildProjectJson, buildProjectZip } = await import('../src/core/export-package.js');
const { findProjectFile, unzipToFiles, buildPackage } = await import('../src/core/package.js');

/** 逐帧对比两个模型：判定线变换与音符纵向位置的最大偏差 */
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
section('判定范围：音符判定带（屏幕投影）与全屏选项');
{
  const { createProjection } = await import('../src/render/projection.js');
  const view = createProjection(1280, 720); // 16:9，areaW = 1280
  const lineState = { worldX: 0, worldY: 0, worldRotate: 0, alpha: 1 };
  const mkNote = (over = {}) => ({ positionX: 0, distY: 0, yOffset: 0, speed: 1, size: 1, above: true, ...over });
  const band = view.judgeBand(mkNote(), lineState);
  // 默认音符宽 W/8 = 160px → 判定带**两边各 80% 音符宽**（总宽 = 音符宽的 160%）：半宽 = 128
  check('判定带半宽 = 音符宽 × 0.8（两边各 80%，总宽 160%）', Math.abs(band.halfWidth - 128) < 1e-6 && Math.abs(band.width - 160) < 1e-6, `half=${band.halfWidth} note=${band.width}`);
  check('判定带中心落在判定线的音符落点上', Math.abs(band.center.x - view.toScreenX(0)) < 1e-6 && Math.abs(band.center.y - view.toScreenY(0)) < 1e-6);

  // 沿判定线方向：带内 / 带外（边界就是 ±80% 音符宽 = 128px）
  check('带内（偏移 127px）算命中', view.hitJudgeBand(mkNote(), lineState, band.center.x + 127, band.center.y) === true);
  check('带外（偏移 129px）不算命中', view.hitJudgeBand(mkNote(), lineState, band.center.x + 129, band.center.y) === false);
  // 沿下落方向：**两端无限延伸**（判定线上下都很远也算）—— 这就是「垂直判定」
  check('同一列但远离判定线（上方 300px）仍算命中', view.hitJudgeBand(mkNote(), lineState, band.center.x, band.center.y - 300) === true);
  check('同一列越过判定线（下方 300px）也算命中', view.hitJudgeBand(mkNote(), lineState, band.center.x, band.center.y + 300) === true);
  check(
    '沿下落方向无限延伸（上下各 5000px 仍算命中）',
    view.hitJudgeBand(mkNote(), lineState, band.center.x, band.center.y - 5000) === true && view.hitJudgeBand(mkNote(), lineState, band.center.x, band.center.y + 5000) === true,
  );
  // 背面音符（above=false）：从判定线另一侧落下来，但**所在列与同 positionX 的正面音符相同**
  {
    const above2 = view.judgeBand(mkNote({ positionX: 2 }), lineState);
    const below2 = view.judgeBand(mkNote({ above: false, positionX: 2 }), lineState);
    check('背面音符判定带的中心与正面同 positionX 的音符重合', Math.abs(below2.center.x - above2.center.x) < 1e-9 && Math.abs(below2.lineX - above2.lineX) < 1e-9, `below=${below2.center.x} above=${above2.center.x}`);
    check(
      '背面音符：点它自己的列算命中、点镜像位置不算',
      view.hitJudgeBand(mkNote({ above: false, positionX: 2 }), lineState, above2.center.x, above2.center.y) === true &&
        view.hitJudgeBand(mkNote({ above: false, positionX: 2 }), lineState, above2.center.x + 200, above2.center.y) === false,
    );
    check(
      '背面音符：沿下落方向的另一侧（越过判定线）也算命中',
      view.hitJudgeBand(mkNote({ above: false, positionX: 2 }), lineState, above2.center.x, above2.center.y - 400) === true &&
        view.hitJudgeBand(mkNote({ above: false, positionX: 2 }), lineState, above2.center.x, above2.center.y + 400) === true,
    );
    // 判定线的局部坐标（toLineLocal）与判定带用的是同一套坐标系
    const localOfBand = view.toLineLocal(lineState, above2.center.x, above2.center.y);
    check('判定带中心与 toLineLocal 的自洽（局部坐标 x 相同）', Math.abs(localOfBand.x - above2.lineX) < 1e-9, `local=${localOfBand.x} band=${above2.lineX}`);
    // 旋转的判定线上同样成立
    const rot2 = { worldX: 0, worldY: 0, worldRotate: 0.5, alpha: 1 };
    const aboveRot = view.judgeBand(mkNote({ positionX: 2 }), rot2);
    const belowRot = view.judgeBand(mkNote({ above: false, positionX: 2 }), rot2);
    check('旋转判定线上：背面音符的判定带同样与正面重合', Math.abs(belowRot.center.x - aboveRot.center.x) < 1e-9 && Math.abs(belowRot.center.y - aboveRot.center.y) < 1e-9);
    check('旋转判定线上：背面音符点自己的列命中', view.hitJudgeBand(mkNote({ above: false, positionX: 2 }), rot2, aboveRot.center.x, aboveRot.center.y) === true);
  }
  // positionX 偏移的音符：带跟着音符走
  const shifted = view.judgeBand(mkNote({ positionX: 2 }), lineState); // 2X = 2 × 0.05625 × 1280 = 144px
  check('判定带跟随音符的 positionX', Math.abs(shifted.center.x - (band.center.x + 144)) < 1e-6, `${shifted.center.x} vs ${band.center.x}`);
  // 旋转的判定线：带子跟着转（沿法线方向仍不限位置、横向仍受限）
  // 屏幕方向约定：局部 → 屏幕的旋转角 theta = −worldRotate（画布 y 向下、顺时针为正），
  //   沿判定线方向 = (cosθ, sinθ)，沿法线方向 = (−sinθ, cosθ)
  const rot = { worldX: 0, worldY: 0, worldRotate: 0.5, alpha: 1 };
  const theta = -0.5;
  const dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const nrm = { x: -Math.sin(theta), y: Math.cos(theta) };
  const rBand = view.judgeBand(mkNote(), rot);
  const alongLine = { x: rBand.center.x + 100 * dir.x, y: rBand.center.y + 100 * dir.y };
  const alongNormal = { x: rBand.center.x + 300 * nrm.x, y: rBand.center.y + 300 * nrm.y };
  check('判定线旋转后：沿判定线方向 100px 仍算命中', view.hitJudgeBand(mkNote(), rot, alongLine.x, alongLine.y) === true, `${alongLine.x.toFixed(1)},${alongLine.y.toFixed(1)}`);
  check('判定线旋转后：沿法线方向 300px 也算命中（下落方向不限）', view.hitJudgeBand(mkNote(), rot, alongNormal.x, alongNormal.y) === true, `localX=${view.toLineLocal(rot, alongNormal.x, alongNormal.y).x.toFixed(1)}`);
  check('判定线旋转后：沿判定线方向 130px 不算命中', view.hitJudgeBand(mkNote(), rot, rBand.center.x + 130 * dir.x, rBand.center.y + 130 * dir.y) === false);

  // 滑动（Flick）：看线段是否「经过」判定带
  check('滑动穿过判定带算命中', view.hitJudgeBandSegment(mkNote(), lineState, band.center.x - 300, band.center.y, band.center.x + 300, band.center.y) === true);
  check('滑动完全在带外不算命中', view.hitJudgeBandSegment(mkNote(), lineState, band.center.x + 200, band.center.y, band.center.x + 400, band.center.y) === false);
  check('滑动终点落在带内算命中', view.hitJudgeBandSegment(mkNote(), lineState, band.center.x + 400, band.center.y, band.center.x + 60, band.center.y) === true);
}

section('判定范围接进真实游玩判定（判定带 / 全屏）');
{
  const { createInput } = await import('../src/core/input.js');
  const { advancePlayJudging } = await import('../src/core/state.js');
  const beat = (sec) => [Math.floor(sec + 1e-9), Math.round((sec - Math.floor(sec)) * 1000), 1000];
  const mk = (notes) => ({
    format: 'rpe',
    META: { RPEVersion: 140, offset: 0, name: 'band-test' },
    BPMList: [{ startTime: [0, 0, 1], bpm: 60 }],
    judgeLineList: [
      {
        Name: 'L',
        Texture: 'line.png',
        bpmfactor: 1,
        isCover: 0,
        father: -1,
        eventLayers: [{ alphaEvents: [{ startTime: [0, 0, 1], endTime: [31250000, 0, 1], start: 255, end: 255, easingType: 1 }] }],
        notes: notes.map((n) => ({ type: 1, startTime: beat(n.at), endTime: beat(n.at), positionX: n.x ?? 0, above: 1, isFake: 0, speed: 1, size: 1, yOffset: 0, visibleTime: 999999, alpha: 255 })),
      },
    ],
  });
  const mkState = (notes) => createState(prepareChart(parseRpeChart(mk(notes), { file: 'band.json' })), { autoplay: false });
  /** 命中测试：只认 x 落在 [x0, x1] 的输入（模拟「只有某一列才算」的判定带） */
  const onlyLeftColumn = (note, p) => {
    const lo = Math.min(p.x ?? 0, p.x0 ?? p.x ?? 0);
    const hi = Math.max(p.x ?? 0, p.x0 ?? p.x ?? 0);
    return hi >= 0 && lo <= 100;
  };

  // 1) 判定带模式：点在带外 → 不判它（最终 Miss）；点在带内 → Perfect
  {
    const s = mkState([{ at: 4 }]);
    const input = createInput();
    input.tap(4.0, 600, 300); // 带外
    advancePlayJudging(s, 4.0, input, { hitTest: onlyLeftColumn });
    check('判定带模式：带外的点击不判该音符', s.stats.judged === 0 && s.chart.notes[0].judged === false);
    advancePlayJudging(s, 4.3, createInput(), { hitTest: onlyLeftColumn });
    check('判定带模式：带外的点击过后按 Miss 结算', s.stats.miss === 1 && s.chart.notes[0].judgement === 'miss');
  }
  {
    const s = mkState([{ at: 4 }]);
    const input = createInput();
    input.tap(4.0, 50, 300); // 带内
    advancePlayJudging(s, 4.0, input, { hitTest: onlyLeftColumn });
    check('判定带模式：带内的点击 → Perfect', s.stats.perfect === 1 && s.chart.notes[0].judgement === 'perfect');
  }
  {
    // 两个音符分处两列：点左边只判左边那个
    const s = mkState([{ at: 4, x: 0 }, { at: 4, x: 4 }]);
    const input = createInput();
    input.tap(4.0, 50, 300);
    advancePlayJudging(s, 4.0, input, { hitTest: onlyLeftColumn });
    check('同一时刻两列：按位置各判各的（点左边只判左边）', s.stats.perfect === 1 && s.chart.notes[0].judged === true && s.chart.notes[1].judged === false);
  }

  // 2) 全屏模式：不传 hitTest（app 的「全屏判定」选项）→ 任意位置都算
  {
    const s = mkState([{ at: 4 }]);
    const input = createInput();
    input.tap(4.0, 600, 300);
    advancePlayJudging(s, 4.0, input);
    check('全屏判定：屏幕任意位置的点击都算命中', s.stats.perfect === 1);
  }

  // 2.5) 判定带宽度：两边各 80% 音符宽（总宽 = 音符宽的 160%）
  {
    const { createProjection } = await import('../src/render/projection.js');
    const { JUDGE } = await import('../src/core/units.js');
    const proj = createProjection(1280, 720);
    const noteWidthRatio = 0.125;
    const line = { worldX: 0, worldY: 0, worldRotate: 0 };
    const n = { positionX: 0, above: true, distY: 0, size: 1 };
    const band = proj.judgeBand(n, line, { noteWidthRatio });
    const noteWidth = noteWidthRatio * proj.areaW;
    check(
      '判定带半宽 = 音符宽的 80%（判定宽度 = 音符宽的 160%）',
      Math.abs(band.halfWidth - noteWidth * 0.8) < 1e-6,
      `半宽=${band.halfWidth.toFixed(2)}px 音符宽=${noteWidth.toFixed(2)}px`,
    );
    const cx = proj.toScreenX(0);
    const cy = proj.toScreenY(0);
    check('判定带内 79% 处算命中', proj.hitJudgeBand(n, line, cx + noteWidth * 0.79, cy, { noteWidthRatio }) === true);
    check('判定带外 81% 处不算命中', proj.hitJudgeBand(n, line, cx + noteWidth * 0.81, cy, { noteWidthRatio }) === false);
    check('JUDE.BAND_HALF_RATIO 常量与实测一致', JUDGE.BAND_HALF_RATIO === 0.8, String(JUDGE.BAND_HALF_RATIO));
  }

  // 3) Flick 的滑动也要经过判定带（全屏模式下任意滑动都算）
  {
    const mkFlick = (notes) => {
      const chart = mk(notes);
      chart.judgeLineList[0].notes = notes.map((n) => ({ type: 3, startTime: beat(n.at), endTime: beat(n.at), positionX: n.x ?? 0, above: 1, isFake: 0, speed: 1, size: 1, yOffset: 0, visibleTime: 999999, alpha: 255 }));
      return chart;
    };
    const mkFlickState = (notes) => createState(prepareChart(parseRpeChart(mkFlick(notes), { file: 'flick.json' })), { autoplay: false });
    const s1 = mkFlickState([{ at: 4 }]);
    const i1 = createInput();
    i1.swipe(4.0, 600, 300, 700, 300); // 整段都在带外
    advancePlayJudging(s1, 4.0, i1, { hitTest: onlyLeftColumn });
    check('Flick：滑动完全在判定带外 → 不判（最后 Miss）', s1.stats.judged === 0);
    const s2 = mkFlickState([{ at: 4 }]);
    const i2 = createInput();
    i2.swipe(4.0, 30, 300, 400, 300); // 起点在带内、滑出带外 → 经过带
    advancePlayJudging(s2, 4.0, i2, { hitTest: onlyLeftColumn });
    check('Flick：滑动经过判定带 → Perfect', s2.stats.perfect === 1 && s2.chart.notes[0].judgement === 'perfect');
    const s3 = mkFlickState([{ at: 4 }]);
    const i3 = createInput();
    i3.swipe(4.0, 600, 300, 700, 300);
    advancePlayJudging(s3, 4.0, i3); // 全屏判定
    check('Flick：全屏判定下任意滑动都算', s3.stats.perfect === 1);

    // 简单判定（用户要求）的两条宽松点：① 滑动起点不必在带里（只看线段是否穿带）；
    // ② 同一根手指可以同时判掉别的音符（输入不被消耗）。
    // ⚠️ 但 Flick **必须有位移**：按住不动 / 纯点击不算（曾经用「带里有手指就算」的写法，等于点一下就算划）
    const s4 = mkFlickState([{ at: 4 }]);
    const i4 = createInput();
    i4.swipe(4.0, 600, 300, 30, 300); // 起点在带外，路径扫过带
    advancePlayJudging(s4, 4.0, i4, { hitTest: onlyLeftColumn });
    check('Flick：起点在带外、路径经过 → Perfect（不看起点）', s4.stats.perfect === 1);

    const s5 = mkFlickState([{ at: 4 }]);
    const i5 = createInput();
    i5.down(7, 50, 300); // 手指按在带里，但没有位移（没有 swipe）
    advancePlayJudging(s5, 4.0, i5, { hitTest: onlyLeftColumn });
    check('Flick：只按住不动（无位移）→ 不判', s5.stats.judged === 0 && s5.chart.notes[0].judged === false);
    advancePlayJudging(s5, 4.2, createInput(), { hitTest: onlyLeftColumn });
    check('Flick：按住不动到最后 → Miss', s5.chart.notes[0].judgement === 'miss');

    const s6 = mkState([{ at: 4, x: 0 }, { at: 4, x: 0 }]);
    s6.chart.notes[1].type = 'flick';
    const i6 = createInput();
    i6.down(3, 50, 300);
    i6.tap(4.0, 50, 300, 3); // 同一根手指的这次按下：判掉 Tap
    i6.swipe(4.0, 50, 300, 90, 300); // 同一根手指的这次滑动：判掉 Flick
    advancePlayJudging(s6, 4.0, i6, { hitTest: onlyLeftColumn });
    check(
      'Flick：同一根手指可以同时判掉一个 Tap 与一个 Flick（不互相消耗）',
      s6.stats.perfect === 2,
      `perfect=${s6.stats.perfect}（tap ${s6.chart.notes[0].judgement} / flick ${s6.chart.notes[1].judgement}）`,
    );

    const s7 = mkFlickState([{ at: 4 }, { at: 4 }]);
    const i7 = createInput();
    i7.swipe(4.0, 40, 300, 70, 300);
    advancePlayJudging(s7, 4.0, i7, { hitTest: onlyLeftColumn });
    check('Flick：一次滑动点亮窗口内全部 Flick（不按手指数限制）', s7.stats.perfect === 2, `perfect=${s7.stats.perfect}`);
  }

  // 5) 多指触控接线：三指各自记账、控件上的手指不拖累别的手指、丢失的 touchend 能靠 touches 对账
  {
    const { bindTouchInput } = await import('../src/app/touch-input.js');
    const listeners = new Map();
    const target = {
      addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const fire = (type, ev) => {
      for (const fn of listeners.get(type) ?? []) fn({ type, preventDefault() {}, timeStamp: 0, touches: ev.touches, changedTouches: ev.changedTouches, target: ev.target });
    };
    const buffer = createInput();
    const unbind = bindTouchInput(target, buffer, { getChartTime: () => 4, isActive: () => true, now: () => 0 });
    const t = (identifier, x, targetEl = null) => ({ identifier, clientX: x, clientY: 300, target: targetEl });
    fire('touchstart', { touches: [t(1, 10), t(2, 20), t(3, 30)], changedTouches: [t(1, 10), t(2, 20), t(3, 30)] });
    check('触摸接线：三指同时按下都记账（不再只认两指）', buffer.fingerCount === 3 && buffer.positions.size === 3, `fingers=${buffer.fingerCount} positions=${buffer.positions.size}`);
    fire('touchstart', { touches: [t(1, 10), t(2, 20), t(3, 30), t(4, 40)], changedTouches: [t(4, 40)] });
    check('触摸接线：第 4 根手指单独按下也立刻记账', buffer.fingerCount === 4, `fingers=${buffer.fingerCount}`);
    // 一根手指落在界面控件上：只跳过它自己，其余手指照常
    const uiEl = { closest: (sel) => (/button/.test(sel) ? {} : null) };
    fire('touchstart', { touches: [t(1, 10), t(2, 20), t(3, 30), t(4, 40), t(5, 50, uiEl)], changedTouches: [t(5, 50, uiEl)] });
    check('触摸接线：落在界面控件上的手指不参与判定（也不影响别的手指）', buffer.fingerCount === 4 && !buffer.fingers.has(5), `fingers=${buffer.fingerCount}`);
    // 少收一个 touchend：靠 touches 对账
    fire('touchend', { touches: [t(1, 10), t(2, 20)], changedTouches: [t(3, 30)] });
    check('触摸接线：靠 touches 对账，幽灵手指被清掉', buffer.fingerCount === 2 && !buffer.fingers.has(4) && !buffer.fingers.has(3), `fingers=${[...buffer.fingers].join(',')}`);
    unbind();
    check('触摸接线：解绑时清空手指状态', buffer.fingerCount === 0);

    // 滑动的**位移阈值**：Flick 判定靠这条例（`JUDGE.SWIPE_MIN_PX`）
    const listeners2 = new Map();
    const target2 = {
      addEventListener: (type, fn) => listeners2.set(type, [...(listeners2.get(type) ?? []), fn]),
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const fire2 = (type, ev) => {
      for (const fn of listeners2.get(type) ?? []) fn({ type, preventDefault() {}, timeStamp: 0, touches: ev.touches, changedTouches: ev.changedTouches, target: ev.target });
    };
    const buf2 = createInput();
    bindTouchInput(target2, buf2, { getChartTime: () => 4, isActive: () => true, now: () => 0 });
    const p = (identifier, x) => ({ identifier, clientX: x, clientY: 300, target: null });
    fire2('touchstart', { touches: [p(1, 100)], changedTouches: [p(1, 100)] });
    fire2('touchmove', { touches: [p(1, 115)], changedTouches: [p(1, 115)] }); // 15px
    check('位移 15px（< SWIPE_MIN_PX=16）不产生滑动 → Flick 不会因手指轻微抖动命中', buf2.swipes.length === 0, `${buf2.swipes.length} 条`);
    fire2('touchmove', { touches: [p(1, 116)], changedTouches: [p(1, 116)] }); // 距上次上报 16px
    check(
      '位移 16px（= SWIPE_MIN_PX）产生一条滑动，线段 = 上次上报点 → 当前点',
      buf2.swipes.length === 1 && buf2.swipes[0].x0 === 100 && buf2.swipes[0].x === 116,
      JSON.stringify(buf2.swipes[0] ?? null),
    );
  }

  // 4) 没有坐标的输入（合成事件/旧调用）不会被判定带挡掉
  {
    const s = mkState([{ at: 4 }]);
    const input = createInput();
    input.tap(4.0); // 不带坐标
    advancePlayJudging(s, 4.0, input, { hitTest: onlyLeftColumn });
    check('输入没有坐标信息时按全屏处理（不会把判定卡死）', s.stats.perfect === 1);
  }
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
