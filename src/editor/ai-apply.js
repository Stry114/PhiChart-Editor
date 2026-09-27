/**
 * 把 AI 的「待应用计划」落到谱面上（见 docs/LLM辅助写谱方案.md §9.2）。
 *
 * 约束：
 *  - 整批**一步撤销**：所有落地走 `timeline.batch(label, {lines})`；
 *  - 逐条校验：目标不存在 / 引用不唯一 / 越界 → 该条失败，其余照常应用；
 *  - 已切换谱面（计划里的 `planChart` 不是当前 chart）→ 整体拒绝；
 *  - 元数据不进撤销栈（与「谱面总览」页一致）。
 */
import { makeEasing } from '../core/easing.js';
import { makeNote, insertNote, writeSourceTimes, sourceTemplate } from './insert.js';
import { noteLists, eventArrayOf, ensureEventArray } from './clipboard.js';

/** 缓动写法 → 内部缓动函数（与「添加」工具、详情面板同一套） */
function easingOf(spec) {
  if (spec && typeof spec === 'object' && Array.isArray(spec.bezier) && spec.bezier.length === 4) {
    return makeEasing(6, spec.bezier.map(Number), 0, 1);
  }
  const preset = Number.isFinite(Number(spec)) ? Math.min(29, Math.max(1, Math.trunc(Number(spec)))) : 1;
  return makeEasing(preset, null, 0, 1);
}

const roundBeat = (v) => Math.round(Number(v) * 1e6) / 1e6;

/** 用计划里的事件写法造一个源事件对象（字段与时间轴「添加」工具一致） */
function makeEvent(item) {
  const fn = easingOf(item.easing);
  return {
    startBeat: roundBeat(item.startBeat),
    endBeat: roundBeat(item.endBeat ?? item.startBeat),
    start: item.start,
    end: item.end,
    easingType: fn.easingType,
    easingPreset: fn.easingPreset,
    bezierPoints: fn.bezierPoints,
    easingLeft: 0,
    easingRight: 1,
    easingFn: fn,
  };
}

/** 事件数组：先找现成的，缺了再按需建出来（与时间轴「添加」一致） */
function eventTarget(chart, op) {
  const ref =
    op.target === 'camera'
      ? { camera: true, key: op.key }
      : { lineId: op.lineId, layerIndex: op.layerIndex ?? 0, key: op.key };
  const existing = eventArrayOf(chart, ref);
  if (Array.isArray(existing)) return existing;
  const created = ensureEventArray(chart, ref);
  return Array.isArray(created) ? created : null;
}

const inRange = (ev, from, to) => {
  const b = Number(ev?.startBeat);
  const e = Number(ev?.endBeat);
  if (!Number.isFinite(b)) return false;
  const end = Number.isFinite(e) ? e : b;
  return !(end < from - 1e-6 || b > to + 1e-6);
};

/** 音符引用的解析（与 tools.js 的引用定义一致）：唯一命中才返回对象 */
function findNote(line, ref) {
  const notes = line?.rt?.notes ?? [];
  const hit = notes.filter(
    (n) =>
      Math.abs(Number(n.startBeat) - Number(ref.beat)) < 1e-6 &&
      Math.abs(Number(n.positionX) - Number(ref.x)) < 1e-6 &&
      (!ref.type || n.type === ref.type),
  );
  return hit.length === 1 ? hit[0] : hit.length === 0 ? null : { ambiguous: hit.length };
}

/**
 * 应用一份计划。
 * @param {{plan:object, chart:object, timeline:object, preview?:object, refreshAll?:Function}} p
 * @returns {{applied:number, failed:{reason:string, op?:string}[], label:string}}
 */
export function applyPlan({ plan, chart, timeline, preview = null, refreshAll = null }) {
  const failed = [];
  const label = plan?.label ?? 'AI 改动';
  if (!plan?.ops?.length) return { applied: 0, failed: [{ reason: '没有改动' }], label };
  if (!chart?.lines?.length) return { applied: 0, failed: [{ reason: '还没有载入谱面' }], label };
  if (plan.planChart && plan.planChart !== chart) {
    return { applied: 0, failed: [{ reason: '谱面已切换，这份改动已作废' }], label };
  }
  if (typeof timeline?.batch !== 'function') return { applied: 0, failed: [{ reason: '时间轴不支持批量事务' }], label };

  // 计划里的 op 自带「影响哪条线的哪些键」，先算出来交给 batch —— 重编译由 commit 统一做，
  // 顺序才能是「改数据 → 提交历史 → 重编译派生数据 → 刷新界面」。
  const lineHints = new Map();
  for (const op of plan.ops) {
    if (!Number.isFinite(op.lineId)) continue;
    const h = lineHints.get(op.lineId) ?? { lineId: op.lineId, keys: new Set(), notes: false };
    if (op.op.startsWith('note.')) h.notes = true;
    else if (op.target === 'line' && op.key) h.keys.add(op.key);
    lineHints.set(op.lineId, h);
  }

  const tx = timeline.batch(label, {
    lines: [...lineHints.values()].map((h) => ({ lineId: h.lineId, keys: [...h.keys], notes: h.notes })),
  });
  let applied = 0;

  try {
    for (const op of plan.ops) {
      try {
        if (op.op === 'meta.set') {
          if (!preview?.setMetaField) throw new Error('编辑器不支持改元数据');
          preview.setMetaField(op.field, op.value);
          applied++;
          continue;
        }
        const line = chart.lines[op.lineId];
        if (!line) throw new Error(`判定线 ${op.lineId} 不存在`);

        if (op.op === 'note.add') {
          const note = makeNote({
            type: op.note.type,
            startBeat: op.note.startBeat,
            endBeat: op.note.endBeat,
            positionX: op.note.positionX,
            above: op.note.above,
            line,
            lineId: op.lineId,
            timeline: line?.rt?.timeline ?? null,
            // 源音符照抄本谱面已有的键名风格（RPE 用 startTime/endTime、官方用 time/holdTime），
            // 否则新音符会把另一套格式的键带进导出结果（与「添加」工具一致）
            template: sourceTemplate(line),
            speed: op.note.speed,
          });
          if (op.note.holdSpeed && note.src) note.src.holdSpeed = op.note.holdSpeed;
          insertNote(chart, line, note);
          for (const it of noteLists(chart, line, note)) tx.added(it.list, it.obj);
          applied++;
        } else if (op.op === 'note.update') {
          const hit = findNote(line, op.ref);
          if (!hit) throw new Error(`找不到音符引用（第 ${op.ref.beat} 拍 x=${op.ref.x} ${op.ref.type ?? ''}）`.trim());
          if (hit.ambiguous) throw new Error(`音符引用不唯一（匹配到 ${hit.ambiguous} 个）`);
          tx.touch(hit);
          const p = op.patch ?? {};
          if (p.positionX !== undefined) hit.positionX = p.positionX;
          if (p.above !== undefined) hit.above = !!p.above;
          if (p.speed !== undefined) hit.speed = p.speed;
          if (p.type !== undefined) hit.type = p.type;
          const startBeat = p.startBeat !== undefined ? p.startBeat : hit.startBeat;
          const endBeat = p.endBeat !== undefined ? p.endBeat : hit.type === 'hold' ? hit.endBeat : startBeat;
          writeSourceTimes(hit.src, startBeat, endBeat);
          hit.startBeat = startBeat;
          hit.endBeat = hit.type === 'hold' ? endBeat : startBeat;
          if (hit.src) {
            if (p.positionX !== undefined) hit.src.positionX = p.positionX;
            if (p.above !== undefined) hit.src.above = p.above ? 1 : 0;
            if (p.speed !== undefined) hit.src.speed = p.speed;
            if (p.type !== undefined) hit.src.type = { tap: 1, drag: 2, hold: 3, flick: 4 }[p.type];
          }
          applied++;
        } else if (op.op === 'note.remove') {
          const hit = findNote(line, op.ref);
          if (!hit) throw new Error(`找不到音符引用（第 ${op.ref.beat} 拍 x=${op.ref.x} ${op.ref.type ?? ''}）`.trim());
          if (hit.ambiguous) throw new Error(`音符引用不唯一（匹配到 ${hit.ambiguous} 个）`);
          const entries = noteLists(chart, line, hit);
          for (const it of entries) {
            tx.removed(it.list, it.obj);
            it.list.splice(it.list.indexOf(it.obj), 1);
          }
          applied++;
        } else if (op.op === 'event.add' || op.op === 'event.replace' || op.op === 'event.delete') {
          const list = eventTarget(chart, op);
          if (!Array.isArray(list)) {
            throw new Error(`找不到事件数组（${op.target === 'camera' ? '谱面相机' : `线 ${op.lineId} 层 ${op.layerIndex}`} 的 ${op.key}）`);
          }
          const from = Number(op.fromBeat);
          const to = Number(op.toBeat);
          if (op.op !== 'event.add') {
            const removed = list.filter((ev) => inRange(ev, from, to));
            for (const ev of removed) {
              tx.removed(list, ev);
              list.splice(list.indexOf(ev), 1);
            }
          }
          if (op.op !== 'event.delete') {
            for (const item of op.events ?? []) {
              const ev = makeEvent(item);
              list.push(ev);
              tx.added(list, ev);
            }
            list.sort((a, b) => (Number(a.startBeat) || 0) - (Number(b.startBeat) || 0));
          }
          applied += op.op === 'event.add' ? (op.events?.length ?? 0) : Math.max(1, op.count ?? 1);
        } else {
          throw new Error(`未知的改动类型 ${op.op}`);
        }
      } catch (err) {
        failed.push({ op: op.op, reason: err?.message ?? String(err) });
      }
    }
  } finally {
    tx.commit();
  }

  refreshAll?.();
  return { applied, failed, label };
}
