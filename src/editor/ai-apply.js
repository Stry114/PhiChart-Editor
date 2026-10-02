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
import { findById, findEventInLine, findEventInCamera } from '../ai/ids.js';

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

/**
 * 音符寻址：**id 优先**（会话内稳定，撤销 / 重做 / 拖动都不换对象），没有 id 再按引用容差匹配
 * （与 tools.js 的引用定义一致）。返回对象、null（没找到）或 { ambiguous }（引用命中多个）。
 */
function findNote(line, op) {
  const notes = line?.rt?.notes ?? [];
  if (op.noteId !== undefined && op.noteId !== null) {
    return findById(notes, op.noteId);
  }
  const ref = op.ref ?? {};
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
  const hintOf = (lineId) => {
    const h = lineHints.get(lineId) ?? { lineId, keys: new Set(), notes: false };
    lineHints.set(lineId, h);
    return h;
  };
  for (const op of plan.ops) {
    if (op.op === 'event.patch') {
      // patch 按 id 跨键寻址：预解析一遍，把真正碰到的「线 × 键」补进事务提示
      for (const item of op.patches ?? []) {
        const found =
          op.target === 'camera'
            ? findEventInCamera(chart, item?.id)
            : findEventInLine(chart.lines[op.lineId], item?.id);
        if (!found) continue; // 真正的报错留给应用循环
        if (op.target !== 'camera') hintOf(op.lineId).keys.add(found.key);
        // 相机事件不属于任何线：事务只按线记账，相机刷新由 refreshAll 兜底（与旧行为一致）
      }
      continue;
    }
    if (!Number.isFinite(op.lineId)) continue;
    const h = hintOf(op.lineId);
    if (op.op.startsWith('note.')) h.notes = true;
    else if (op.target === 'line' && op.key) h.keys.add(op.key);
  }

  const tx = timeline.batch(label, {
    lines: [...lineHints.values()]
      .filter((h) => h.lineId >= 0)
      .map((h) => ({ lineId: h.lineId, keys: [...h.keys], notes: h.notes })),
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
          const hit = findNote(line, op);
          if (!hit) throw new Error(`找不到音符（id=${op.noteId ?? '无'}，第 ${op.ref?.beat ?? '?'} 拍 x=${op.ref?.x ?? '?'} ${op.ref?.type ?? ''}）`.trim());
          if (hit.ambiguous) throw new Error(`音符引用不唯一（匹配到 ${hit.ambiguous} 个）：请先 read_chart 拿 id`);
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
          const hit = findNote(line, op);
          if (!hit) throw new Error(`找不到音符（id=${op.noteId ?? '无'}，第 ${op.ref?.beat ?? '?'} 拍 x=${op.ref?.x ?? '?'} ${op.ref?.type ?? ''}）`.trim());
          if (hit.ambiguous) throw new Error(`音符引用不唯一（匹配到 ${hit.ambiguous} 个）：请先 read_chart 拿 id`);
          const entries = noteLists(chart, line, hit);
          for (const it of entries) {
            tx.removed(it.list, it.obj);
            it.list.splice(it.list.indexOf(it.obj), 1);
          }
          applied++;
        } else if (op.op === 'event.patch') {
          // 按 id 逐条改字段：每个 id 解析回「事件对象 + 所在数组」，touch 后改、改完统一重排
          const touched = new Map(); // list -> key（同数组只排一次序）
          for (const item of op.patches ?? []) {
            const found =
              op.target === 'camera' ? findEventInCamera(chart, item.id) : findEventInLine(line, item.id);
            if (!found) throw new Error(`找不到事件 id=${item?.id}（可能已被删除）`);
            tx.touch(found.ev);
            const p = item.patch ?? {};
            if (p.startBeat !== undefined) found.ev.startBeat = p.startBeat;
            if (p.endBeat !== undefined) found.ev.endBeat = p.endBeat;
            if (p.start !== undefined) found.ev.start = p.start;
            if (p.end !== undefined) found.ev.end = p.end;
            if (p.easing !== undefined) {
              const fn = easingOf(p.easing);
              found.ev.easingType = fn.easingType;
              found.ev.easingPreset = fn.easingPreset;
              found.ev.bezierPoints = fn.bezierPoints;
              found.ev.easingLeft = 0;
              found.ev.easingRight = 1;
              found.ev.easingFn = fn;
            }
            touched.set(found.list, found.key);
          }
          for (const [list, key] of touched) {
            if (key !== 'speed') list.sort((a, b) => (Number(a.startBeat) || 0) - (Number(b.startBeat) || 0));
          }
          applied += op.patches?.length ?? 0;
        } else if (op.op === 'event.add' || op.op === 'event.replace' || op.op === 'event.delete') {
          const list = eventTarget(chart, op);
          if (!Array.isArray(list)) {
            throw new Error(`找不到事件数组（${op.target === 'camera' ? '谱面相机' : `线 ${op.lineId} 层 ${op.layerIndex}`} 的 ${op.key}）`);
          }
          const from = Number(op.fromBeat);
          const to = Number(op.toBeat);
          if (op.op === 'event.delete' && Array.isArray(op.ids) && op.ids.length) {
            // 按 id 删：对象身份 / id 精确匹配，不经过区间
            for (const id of op.ids) {
              const found = op.target === 'camera' ? findEventInCamera(chart, id) : findEventInLine(line, id);
              if (!found) throw new Error(`找不到事件 id=${id}（可能已被删除）`);
              tx.removed(found.list, found.ev);
              found.list.splice(found.list.indexOf(found.ev), 1);
            }
          } else if (op.op !== 'event.add') {
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
