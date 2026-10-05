/**
 * AI 写扩展事件（theta / z=moveZ）的功能测试：`node tools/ai-ext-events-tests.mjs`。
 *
 * 覆盖：read_chart 读得到 theta/z（带稳定 id）→ edit_events target='ext' 的
 * add / replace / delete / patch 计划 → applyPlan 落地到 line.extended →
 * refreshLine 重编译 → 求值取到新值；以及各类拒绝路径（不可写的扩展键、
 * 跨 target 的 id、越界取值）。
 */
import { createBlankProject, parseProject } from '../src/core/project.js';
import { prepareChart, refreshLine, EXTENDED_KEYS } from '../src/core/model.js';
import { runTool, ToolError, EXT_WRITABLE_KEYS } from '../src/ai/tools.js';
import { applyPlan } from '../src/editor/ai-apply.js';
import { evalExtended } from '../src/core/events.js';
import { ensureId } from '../src/ai/ids.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const expectFail = (name, fn, re) => {
  try {
    fn();
    check(name, false, '没有报错');
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : String(err?.message ?? err);
    check(name, !re || re.test(msg), msg);
  }
};

/** 造一张有一条线、带 theta 与 z 事件的谱面 */
function makeChart() {
  const chart = parseProject(createBlankProject({ lines: 1 }), {});
  prepareChart(chart, {});
  const line = chart.lines[0];
  line.extended = {
    theta: [{ startBeat: 0, endBeat: 8, start: 0, end: 0, easingType: 1, easingPreset: 1 }],
    z: [{ startBeat: 0, endBeat: 8, start: 0.5, end: 0.5, easingType: 1, easingPreset: 1 }],
    color: [{ startBeat: 0, endBeat: 8, start: [255, 255, 255], end: [255, 255, 255], easingType: 1, easingPreset: 1 }],
  };
  refreshLine(chart, 0, { keys: ['theta', 'z', 'color'] });
  return chart;
}

/** 最小 timeline 桩件：batch 的 commit 与真实实现一样做「按线重编译」 */
function makeTimeline(chart) {
  const touched = [];
  return {
    touched,
    batch(label, { lines = [] } = {}) {
      return {
        touch: () => {},
        touchAll: () => {},
        added: () => {},
        removed: () => {},
        abort: () => {},
        commit: () => {
          for (const item of lines) {
            if (!item || !Number.isFinite(item.lineId)) continue;
            refreshLine(chart, item.lineId, { keys: item.keys ?? [], notes: !!item.notes });
            touched.push(item.lineId);
          }
          return true;
        },
      };
    },
  };
}

const ctxOf = (chart) => ({ chart, viewport: { currentBeat: 0 } });
const thetaAt = (chart, t) => evalExtended(chart.lines[0].rt.extended?.theta, 'theta', t, 0);
const zAt = (chart, t) => evalExtended(chart.lines[0].rt.extended?.z, 'z', t, 0);

// ── 1. read_chart 读得到扩展事件（带 id） ──
{
  console.log('read_chart 读扩展事件');
  const chart = makeChart();
  const read = runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 8, events: ['theta', 'z'], notes: false, summary: false }, ctxOf(chart));
  const ev = read.result.events ?? {};
  check('theta 事件可读且带 id', Array.isArray(ev.theta) && ev.theta.length === 1 && Number.isFinite(ev.theta[0].id), JSON.stringify(ev.theta));
  check('z（moveZ）事件可读', Array.isArray(ev.z) && ev.z.length === 1 && Number.isFinite(ev.z[0].id), JSON.stringify(ev.z));
  check('读的是扩展数据（值正确）', ev.z?.[0]?.value === 0.5 && ev.theta?.[0]?.value === 0, JSON.stringify(ev.z?.[0]));

  // 默认读取（不给 events）也带上可写的扩展键
  const read2 = runTool('read_chart', { lineId: 0, fromBeat: 0, toBeat: 8, notes: false, summary: false }, ctxOf(chart));
  check('默认读取包含 theta / z', !!read2.result.events?.theta && !!read2.result.events?.z, Object.keys(read2.result.events ?? {}).join(','));
}

// ── 2. add：theta 写入并重编译 ──
{
  console.log('add（theta）');
  const chart = makeChart();
  const timeline = makeTimeline(chart);
  const plan = runTool(
    'edit_events',
    { target: 'ext', lineId: 0, key: 'theta', mode: 'add', events: [{ beat: 16, endBeat: 24, value: 0.5, endValue: -0.5, easing: 2 }], reason: '测试' },
    ctxOf(chart),
  ).plan;
  check('计划产出（event.add / target=ext）', plan.ops[0].op === 'event.add' && plan.ops[0].target === 'ext' && plan.ops[0].key === 'theta', JSON.stringify(plan.ops[0]?.op));
  const res = applyPlan({ plan, chart, timeline });
  check('落地成功', res.applied === 1 && res.failed.length === 0, JSON.stringify(res.failed));
  check('数据写进 line.extended.theta', chart.lines[0].extended.theta.length === 2, String(chart.lines[0].extended.theta.length));
  check('已按线重编译（commit 收到提示）', timeline.touched.includes(0), JSON.stringify(timeline.touched));
  check('求值取到新值（24 拍处 ≈ -0.5）', Math.abs(thetaAt(chart, 24 * (60 / 174)) + 0.5) < 1e-6, String(thetaAt(chart, 24 * (60 / 174))));
}

// ── 3. z（moveZ）写入 ──
{
  console.log('add（z / moveZ）');
  const chart = makeChart();
  const timeline = makeTimeline(chart);
  const plan = runTool('edit_events', { target: 'ext', lineId: 0, key: 'z', mode: 'add', events: [{ beat: 16, endBeat: 20, value: 1, endValue: 1 }] }, ctxOf(chart)).plan;
  const res = applyPlan({ plan, chart, timeline });
  check('z 事件落地', res.applied === 1 && chart.lines[0].extended.z.length === 2, JSON.stringify(res.failed));
  check('求值取到 z 新值（18 拍处 = 1）', Math.abs(zAt(chart, 18 * (60 / 174)) - 1) < 1e-6, String(zAt(chart, 18 * (60 / 174))));
  check('原 z 区间不受影响（4 拍处 = 0.5）', Math.abs(zAt(chart, 4 * (60 / 174)) - 0.5) < 1e-6, String(zAt(chart, 4 * (60 / 174))));
}

// ── 4. patch：按 id 改值与缓动 ──
{
  console.log('patch（按 id）');
  const chart = makeChart();
  const timeline = makeTimeline(chart);
  const id = ensureId(chart.lines[0].extended.theta[0]);
  const plan = runTool('edit_events', { target: 'ext', lineId: 0, key: 'theta', mode: 'patch', patches: [{ id, value: 0.8, endValue: 0.8 }] }, ctxOf(chart)).plan;
  const res = applyPlan({ plan, chart, timeline });
  check('patch 落地', res.applied === 1 && chart.lines[0].extended.theta[0].start === 0.8, JSON.stringify(chart.lines[0].extended.theta[0]));
  check('重编译后求值同步', Math.abs(thetaAt(chart, 2 * (60 / 174)) - 0.8) < 1e-6, String(thetaAt(chart, 2 * (60 / 174))));
}

// ── 5. replace / delete ──
{
  console.log('replace / delete');
  const chart = makeChart();
  const timeline = makeTimeline(chart);
  const rep = runTool('edit_events', { target: 'ext', lineId: 0, key: 'z', mode: 'replace', fromBeat: 0, toBeat: 8, events: [{ beat: 0, endBeat: 8, value: -0.3, endValue: -0.3 }] }, ctxOf(chart)).plan;
  const r1 = applyPlan({ plan: rep, chart, timeline });
  check('replace 覆盖区间', r1.applied >= 1 && chart.lines[0].extended.z.length === 1 && chart.lines[0].extended.z[0].start === -0.3, JSON.stringify(chart.lines[0].extended.z));

  const del = runTool('edit_events', { target: 'ext', lineId: 0, key: 'theta', mode: 'delete', fromBeat: 0, toBeat: 8 }, ctxOf(chart)).plan;
  const r2 = applyPlan({ plan: del, chart, timeline });
  check('按区间删除 theta', r2.applied === 1 && chart.lines[0].extended.theta.length === 0, JSON.stringify(chart.lines[0].extended.theta));

  // 按 id 删除
  const chart2 = makeChart();
  const timeline2 = makeTimeline(chart2);
  const id = ensureId(chart2.lines[0].extended.z[0]);
  const del2 = runTool('edit_events', { target: 'ext', lineId: 0, key: 'z', mode: 'delete', ids: [id] }, ctxOf(chart2)).plan;
  const r3 = applyPlan({ plan: del2, chart: chart2, timeline: timeline2 });
  check('按 id 删除 z', r3.applied === 1 && chart2.lines[0].extended.z.length === 0, JSON.stringify(r3.failed));
}

// ── 6. 拒绝路径 ──
{
  console.log('拒绝路径');
  const chart = makeChart();
  const ctx = ctxOf(chart);
  check('可写扩展键就是 theta / z', EXT_WRITABLE_KEYS.join(',') === 'theta,z', EXT_WRITABLE_KEYS.join(','));
  check('theta 是已识别扩展键', EXTENDED_KEYS.includes('theta') && EXTENDED_KEYS.includes('z'));

  expectFail('不可写的扩展键（color）被拒', () => runTool('edit_events', { target: 'ext', lineId: 0, key: 'color', mode: 'add', events: [{ beat: 0, endBeat: 1, value: 1 }] }, ctx), /只能写 theta \/ z|收到 color/);
  expectFail('不可写的扩展键（scaleX）被拒', () => runTool('edit_events', { target: 'ext', lineId: 0, key: 'scaleX', mode: 'add', events: [{ beat: 0, endBeat: 1, value: 1 }] }, ctx), /只能写/);
  expectFail('target 非法值被拒', () => runTool('edit_events', { target: 'scale', lineId: 0, key: 'x' }, ctx), /target 只能是/);

  // 用普通事件（x）的 id 去 ext patch → 拒绝
  const xId = ensureId({});
  const layerEv = { startBeat: 0, endBeat: 4, start: 0, end: 0 };
  chart.lines[0].layers = [{ x: [layerEv] }];
  refreshLine(chart, 0, { keys: ['x'] });
  expectFail('ext patch 指向普通事件 id 被拒', () => runTool('edit_events', { target: 'ext', lineId: 0, key: 'theta', mode: 'patch', patches: [{ id: ensureId(layerEv) }] }, ctx), /不是 AI 可写的扩展事件/);
  void xId;

  // 用扩展事件（theta）的 id 去 line patch → 提示改用 target='ext'
  expectFail('line patch 指向扩展事件 id 被拒（提示 target=ext）', () => runTool('edit_events', { target: 'line', lineId: 0, key: 'x', mode: 'patch', patches: [{ id: ensureId(chart.lines[0].extended.theta[0]) }] }, ctx), /target='ext'/);

  // 取值越界：theta 超过 90°，z 大到离谱
  expectFail('theta 超过 90° 被拒', () => runTool('edit_events', { target: 'ext', lineId: 0, key: 'theta', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 2.5 }] }, ctx), /弧度|90°/);
  expectFail('z 量级异常被拒', () => runTool('edit_events', { target: 'ext', lineId: 0, key: 'z', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 900 }] }, ctx), /过大|900/);
  check('合法边界值可以通过（theta=1.5，接近 90°）', runTool('edit_events', { target: 'ext', lineId: 0, key: 'theta', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 1.5 }] }, ctx).plan.ops.length === 1);
}

// ── 7. 扩展键与普通键互不污染 ──
{
  console.log('互不污染');
  const chart = makeChart();
  const timeline = makeTimeline(chart);
  const plan = runTool('edit_events', { target: 'line', lineId: 0, key: 'x', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 0.2 }] }, ctxOf(chart)).plan;
  const res = applyPlan({ plan, chart, timeline });
  check('普通 x 事件照常写入', res.applied === 1 && chart.lines[0].layers[0].x.length === 2, JSON.stringify(res.failed));
  check('扩展数据未被改动（color 还在）', chart.lines[0].extended.color.length === 1 && chart.lines[0].extended.theta.length === 1);
}

// ── 8. 钩定（hook）：不变式 + 创建/导入缺省 + AI patch 同步 ──
{
  console.log('钩定（hook）');
  const chart = makeChart();

  // ① speed 事件首末相同 → 计划自动带 hook，落地后源上有标记
  const p1 = runTool('edit_events', { target: 'line', lineId: 0, key: 'speed', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 2 }] }, ctxOf(chart)).plan;
  check('speed 事件首末相同 → 计划自动钩定', p1.ops[0].events[0].hook === true, JSON.stringify(p1.ops[0].events[0]));
  applyPlan({ plan: p1, chart, timeline: makeTimeline(chart) });
  const spd = chart.lines[0].layers[0].speed.find((e) => e.startBeat === 32);
  check('落地后 speed 事件带 hook 标记', spd?.hook === true, JSON.stringify(spd));

  // ② speed 首末不同 → 不钩定
  const p2 = runTool('edit_events', { target: 'line', lineId: 0, key: 'speed', mode: 'add', events: [{ beat: 48, endBeat: 56, value: 1, endValue: 3 }] }, ctxOf(chart)).plan;
  check('speed 首末不同 → 不钩定', p2.ops[0].events[0].hook === false, JSON.stringify(p2.ops[0].events[0]));

  // ③ 非速度事件不钩定
  const p3 = runTool('edit_events', { target: 'line', lineId: 0, key: 'x', mode: 'add', events: [{ beat: 32, endBeat: 40, value: 0.2 }] }, ctxOf(chart)).plan;
  check('非速度事件不钩定', p3.ops[0].events[0].hook === false, JSON.stringify(p3.ops[0].events[0]));

  // ④ patch 钩定事件：改一侧两侧一起动
  const id = ensureId(spd);
  const p4 = runTool('edit_events', { target: 'line', lineId: 0, key: 'speed', mode: 'patch', patches: [{ id, value: 3 }] }, ctxOf(chart)).plan;
  check('patch 钩定事件自动首末同步', p4.ops[0].patches[0].patch.start === 3 && p4.ops[0].patches[0].patch.end === 3, JSON.stringify(p4.ops[0].patches[0].patch));
  applyPlan({ plan: p4, chart, timeline: makeTimeline(chart) });
  check('落地后 speed 首末仍相等', spd.start === 3 && spd.end === 3, JSON.stringify({ s: spd.start, e: spd.end }));

  // ⑤ patch 钩定事件的缓动被拒
  expectFail('钩定事件的缓动修改被拒', () => runTool('edit_events', { target: 'line', lineId: 0, key: 'speed', mode: 'patch', patches: [{ id, easing: 2 }] }, ctxOf(chart)), /钩定|线性/);

  // ⑥ 解析器缺省：official 速度事件（首末恒同值）全部钩定；RPE 首末不同的不钩定
  const { parseOfficialChart: parseOfficial } = await import('../src/core/parse-official.js');
  const { parseRpeChart: parseRpe } = await import('../src/core/parse-rpe.js');
  const officialJson = { META: { name: 't' }, judgeLineList: [{ judgeLineGroup: 0, speedEvents: [{ startTime: 0, endTime: 32, value: 1.5 }, { startTime: 32, endTime: 64, value: 1 }] }] };
  const offChart = parseOfficial(officialJson, {});
  prepareChart(offChart, {});
  const offSpd = offChart.lines[0].layers[0].speed;
  check('official 导入：速度事件自动钩定', offSpd.length === 2 && offSpd.every((e) => e.hook === true), JSON.stringify(offSpd.map((e) => e.hook)));
  const rpeJson = { META: { name: 'r' }, judgeLineList: [{ judgeLineGroup: 0, eventLayers: [{ speedEvents: [{ startTime: 0, endTime: 32, start: 1, end: 1 }, { startTime: 32, endTime: 64, start: 1, end: 3 }] }] }] };
  const rpeChart = parseRpe(rpeJson, {});
  prepareChart(rpeChart, {});
  const rpeSpd = rpeChart.lines[0].layers[0].speed;
  check('RPE 导入：首末相同钩定、不同不钩定', rpeSpd[0]?.hook === true && rpeSpd[1]?.hook === undefined, JSON.stringify(rpeSpd.map((e) => e.hook)));

  // ⑦ 项目格式往返保留 hook（不勾的保持不勾）
  const { serializeProject } = await import('../src/core/project.js');
  offSpd[1].hook = false;
  const { json } = serializeProject(offChart, {});
  const back = parseProject(JSON.parse(JSON.stringify(json)), {});
  const backSpd = back.lines[0].layers[0].speed;
  check('项目格式保留/读取 hook', backSpd.length === 2 && backSpd[0].hook === true && backSpd[1].hook === undefined, JSON.stringify(backSpd.map((e) => e.hook)));

  // ⑧ 官谱导出不带 hook（内部专用字段）
  const { serializeOfficial } = await import('../src/core/serialize-official.js');
  const off = serializeOfficial(back, {});
  const offSpeed = off.json.judgeLineList[0].speedEvents ?? [];
  check('官谱导出不含 hook 字段', offSpeed.every((e) => !('hook' in e)), JSON.stringify(offSpeed[0]));
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
