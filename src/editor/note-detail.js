// Note 详情面板：查看/编辑选中音符的参数（多选时不加载默认值，任何修改对全部选中项生效）
import {
  commonValue,
  el,
  parseBeat,
  fmtBeat,
  round4 as round,
  setLastAction,
  actionLine,
  dualHeadRow,
  dualUnitRow,
  attachTabCycle,
} from './detail-common.js';
import { LIMITS } from './lint.js';
import { DUAL_UNITS, TIME_DUAL_UNITS } from './display-units.js';
import { RPE_SPEED_TO_YPS } from '../core/units.js';
import { writeSourceTimes } from './insert.js';

/** 时间行的 RPE 列：拍号 a+b/c 文本（内部值 = 拍） */
const BEAT_TEXT = { to: (v) => fmtBeat(v), parse: (t) => parseBeat(t) };

const NOTE_TYPES = [
  { value: 'tap', label: 'Tap（点击）' },
  { value: 'drag', label: 'Drag（拖动）' },
  { value: 'hold', label: 'Hold（长按）' },
  { value: 'flick', label: 'Flick（滑动）' },
];

/** 把选中的 key（trackId#index）解析成音符 clip 与其渲染器音符对象 */
export function resolveSelectedNotes(timeline) {
  const out = [];
  for (const key of timeline.selection.notes) {
    const hash = key.lastIndexOf('#');
    const trackId = key.slice(0, hash);
    const index = Number(key.slice(hash + 1));
    const track = timeline.tracks.find((t) => t.id === trackId);
    const clip = track?.clips?.[index];
    if (!track || !clip) continue;
    out.push({ key, track, index, clip, note: clip.note ?? null });
  }
  return out;
}

export function renderNoteDetail(root, ctx) {
  const { timeline, onStatus } = ctx;
  root.innerHTML = '';
  const wrap = el('div', 'ed-scroll');
  root.appendChild(wrap);

  const items = resolveSelectedNotes(timeline);
  // 提示行只在「选中项没变」时显示，换选中就消失
  const selectionSig = [...timeline.selection.notes].sort().join(',');
  if (!items.length) {
    wrap.appendChild(
      el('div', 'ed-hint', '在时间轴中选中音符后可编辑参数。'),
    );
    return;
  }

  // 头部：数量 + 所在轨道的汇总
  const head = el('div', 'ed-note-head');
  head.appendChild(el('span', 'count', `已选中 ${items.length} 个音符`));
  const kinds = new Map();
  for (const it of items) {
    const key = `${it.track.label}${it.clip.type ? ` · ${it.clip.type}` : ''}`;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  head.appendChild(el('span', 'dim', [...kinds.entries()].map(([k, v]) => `${k}×${v}`).join('　')));
  wrap.appendChild(head);
  const line = actionLine(selectionSig);
  if (line) wrap.appendChild(line);

  const form = el('div', 'ed-note-form');
  wrap.appendChild(form);
  // 列头（官谱 / RPE / 范围）：positionX 与速度行是双单位制，先给列名
  form.appendChild(dualHeadRow());

  /** 重渲染延后一帧：避免在下拉/输入框自己的处理器里同步重建 DOM（见 event-detail.js 注释） */
  const rerender = () => {
    const run = () => renderNoteDetail(root, ctx);
    // 用 setTimeout 而不是 rAF：后台标签页里 rAF 会被暂停，面板就永远不刷新了
    setTimeout(run, 0);
  };

  const applyToAll = (fn, label) => {
    // 同 Event 详情：选中项变了就不再按旧面板写（否则会改到别的音符上）
    const nowSig = [...timeline.selection.notes].sort().join(',');
    if (nowSig !== selectionSig) {
      setLastAction(`选中项已变化，本次「${label}」没有应用，请重新操作`, { bad: true, sig: nowSig });
      onStatus?.('选中项已变化，已忽略本次修改');
      rerender();
      return;
    }
    // 撤销记录：先记下改动前的字段（详情面板改的是 note 与它的 src）
    const finishEdit = timeline.recordEdit?.(
      label,
      items.map((it) => it.note).filter(Boolean),
      {
        lineIds: [...new Set(items.map((it) => it.note?.lineId).filter((v) => Number.isFinite(v)))],
        notes: true,
      },
    );
    let n = 0;
    for (const it of items) {
      if (fn(it) !== false) n++;
    }
    finishEdit?.();
    timeline.redraw();
    // 音符时间变了 → 让时间轴重编译这条线的派生数据（预览/纠错都跟着走）
    timeline.notifyChanged?.({
      lineIds: [...new Set(items.map((it) => it.note?.lineId).filter((v) => Number.isFinite(v)))],
      notes: true,
    });
    setLastAction(`${label}：已应用到 ${n} / ${items.length} 个音符`, { sig: selectionSig });
    onStatus?.(`${label}：已应用到 ${n} 个音符`);
    rerender(); // 重新渲染，刷新「混合」状态
  };

  const row = (label, control, hint) => {
    const r = el('div', 'ed-note-row');
    r.appendChild(el('label', 'k', label));
    const box = el('div', 'v');
    box.appendChild(control);
    if (hint) box.appendChild(el('span', 'dim', hint));
    r.appendChild(box);
    form.appendChild(r);
    return r;
  };

  // ── 类型 ──
  const typeCommon = commonValue(items, (it) => it.clip.type);
  const typeSel = document.createElement('select');
  typeSel.className = 'ed-select';
  const mixedType = typeCommon === undefined;
  if (mixedType) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `多个值（${items.length} 项）`;
    typeSel.appendChild(opt);
    typeSel.value = '';
  }
  for (const t of NOTE_TYPES) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    typeSel.appendChild(opt);
  }
  if (!mixedType) typeSel.value = typeCommon;
  form.appendChild(
    dualUnitRow({
      label: '类型',
      control: typeSel,
      value: 0,
      onSet: () => {},
    }),
  );
  typeSel.addEventListener('change', () => {
    const v = typeSel.value;
    if (!v) return;
    applyToAll((it) => {
      it.clip.type = v;
      if (it.note) it.note.type = v;
      if (it.note?.src) it.note.src.type = v;
      return true;
    }, `类型 → ${v}`);
  });

  // ── 时间（拍） ──
  const beatOf = (it) => it.clip.b0;
  const beatCommon = commonValue(items, beatOf);
  const moveBeatTo = (beat) => {
    if (!Number.isFinite(beat)) {
      onStatus?.('时间格式应为 a+b/c（如 12+1/4）或小数');
      renderNoteDetail(root, ctx);
      return;
    }
    applyToAll((it) => applyBeat(it, beat, ctx.chart), `时间 → ${fmtBeat(beat)} 拍`);
  };
  const beatInput = document.createElement('input');
  beatInput.className = 'ed-beat';
  beatInput.type = 'text';
  beatInput.placeholder = `多个值（${items.length} 项）`;
  if (beatCommon !== undefined) beatInput.value = fmtBeat(beatCommon);
  form.appendChild(
    dualUnitRow({
      label: '时间（拍）',
      units: TIME_DUAL_UNITS,
      value: beatCommon,
      mixedLabel: `多个值（${items.length} 项）`,
      fixedStep: 1,
      rpeText: BEAT_TEXT,
      onSet: (v) => moveBeatTo(v),
    }),
  );

  // ── positionX（双单位：官谱 X 单位 ↔ RPE positionX）──
  const xCommon = commonValue(items, (it) => it.clip.positionX);
  const setX = (v) =>
    applyToAll((it) => {
      it.clip.positionX = v;
      if (it.note) {
        it.note.positionX = v;
        if (it.note.src) it.note.src.positionX = v;
      }
      return true;
    }, `positionX → ${round(v)}`);
  form.appendChild(
    dualUnitRow({
      label: 'positionX',
      units: DUAL_UNITS['note:x'],
      value: xCommon,
      mixedLabel: `多个值（${items.length} 项）`,
      range: DUAL_UNITS['note:x'].range,
      validate: (v) => (Math.abs(v) > LIMITS.positionX ? null : v),
      onInvalid: (msg) => {
        onStatus?.(`${msg}（官谱 ±${round(LIMITS.positionX, 2)} / RPE ±${round(LIMITS.positionX * 75.9375, 1)}）`);
      },
      onSet: (v) => setX(v),
    }),
  );

  // ── Hold 时长 ──
  const holdCommon = commonValue(items, (it) => it.clip.holdBeats ?? 0);
  const anyHold = items.some((it) => it.clip.type === 'hold');
  const setHoldLen = (v) =>
    applyToAll((it) => {
      if (it.clip.type !== 'hold') return false;
      const len = Math.max(0, v);
      it.clip.b1 = it.clip.b0 + len;
      it.clip.holdBeats = len;
      if (it.note) {
        const timelineOf = ctx.chart?.lines?.[it.note.lineId]?.rt?.timeline ?? null;
        const startBeat = timelineOf ? timelineOf.secondsToBeat(it.note.timeSec) : it.clip.b0;
        it.note.endBeat = startBeat + len;
        it.note.endSec = (it.note.timeSec ?? 0) + (timelineOf ? timelineOf.beatToSeconds(it.note.endBeat) - timelineOf.beatToSeconds(startBeat) : len);
        it.note.durationSec = Math.max(0, it.note.endSec - (it.note.timeSec ?? 0));
        if (it.note.src) it.note.src.endBeat = it.note.endBeat;
      }
      return true;
    }, `Hold 时长 → ${round(v)} 拍`);
  const holdInput = document.createElement('input');
  holdInput.className = 'ed-beat';
  holdInput.type = 'text';
  holdInput.placeholder = `多个值（${items.length} 项）`;
  if (holdCommon !== undefined) holdInput.value = fmtBeat(holdCommon);
  form.appendChild(
    dualUnitRow({
      label: 'Hold 时长（拍）',
      units: TIME_DUAL_UNITS,
      value: holdCommon,
      mixedLabel: `多个值（${items.length} 项）`,
      fixedStep: 1,
      rpeText: BEAT_TEXT,
      validate: (v) => (v < 0 ? null : v),
      onInvalid: (msg) => onStatus?.(msg),
      range: anyHold ? '≥ 0' : '',
      onSet: (v) => setHoldLen(v),
    }),
  );

  // ── speed（双单位：官谱 Y/s ↔ RPE 流速倍率）──
  const speedCommon = commonValue(items, (it) => it.clip.speed ?? 1);
  const setSpeed = (v) =>
    applyToAll((it) => {
      it.clip.speed = v;
      if (it.note) {
        it.note.speed = v;
        if (it.note.src) it.note.src.speed = v;
      }
      return true;
    }, `speed → ${round(v)}`);
  // RPE 谱面的 note.speed 是流速倍率（1 = 2/9 Y/s），官谱是 Y/s：按谱面格式决定换算方向
  const isRpeChart = ctx.chart?.format === 'rpe';
  const speedUnits = isRpeChart
    ? {
        official: { to: (v) => v * RPE_SPEED_TO_YPS, from: (v) => v / RPE_SPEED_TO_YPS },
        rpe: { to: (v) => v, from: (v) => v },
      }
    : {
        official: { to: (v) => v, from: (v) => v },
        rpe: { to: (v) => v / RPE_SPEED_TO_YPS, from: (v) => v * RPE_SPEED_TO_YPS },
      };
  form.appendChild(
    dualUnitRow({
      label: isRpeChart ? '速度倍率 speed' : 'speed（Y/s）',
      units: speedUnits,
      value: speedCommon,
      mixedLabel: `多个值（${items.length} 项）`,
      range: '≥ 0',
      validate: (v) => (v < 0 ? null : v),
      onInvalid: (msg) => onStatus?.(msg),
      onSet: (v) => setSpeed(v),
    }),
  );

  // ── Hold 尾部速度口径（仅 Hold）：跟随判定线速度（非独立，RPE 口径，缺省） / 独立尾速度（官方） ──
  {
    const common = commonValue(items, (it) => (it.clip.type === 'hold' ? (it.note?.src?.holdSpeed ?? 'line') : 'line'));
    const sel = document.createElement('select');
    sel.className = 'ed-select';
    for (const [value, label] of [
      ['line', '跟随判定线速度（非独立）'],
      ['own', '独立尾速度（官方）'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (common === undefined) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = `多个值（${items.length} 项）`;
      sel.appendChild(opt); // 桩件没有 insertBefore，用 append（选项值已选中，顺序无碍）
      sel.value = '';
    } else sel.value = common;
    sel.addEventListener('change', () => {
      const v = sel.value === 'own' ? 'own' : 'line';
      applyToAll((it) => {
        if (it.clip.type !== 'hold' || !it.note) return false;
        if (it.note.src) it.note.src.holdSpeed = v; // 渲染读的是源对象（line.notes → 编译时展开）
        if (it.note.src) it.note.holdSpeed = v;
        return true;
      }, `Hold 速度口径 → ${v === 'own' ? '独立' : '跟随判定线'}`);
    });
    form.appendChild(
      dualUnitRow({
        label: 'Hold 速度口径',
        control: sel,
        value: 0,
        onSet: () => {},
      }),
    );
  }

  // ── above / fake ──
  const mkCheck = (label, read, write, hint) => {
    const common = commonValue(items, read);
    const input = document.createElement('input');
    input.type = 'checkbox';
    const mixed = common === undefined;
    if (!mixed) input.checked = !!common;
    else {
      input.indeterminate = true;
      input.checked = false;
    }
    input.addEventListener('change', () => write(input.checked));
    const box = el('div', 'v');
    box.appendChild(input);
    box.appendChild(el('span', 'dim', mixed ? `多个值（${items.length} 项）` : hint ?? ''));
    form.appendChild(
      dualUnitRow({
        label,
        control: box,
        value: 0,
        onSet: () => {},
      }),
    );
  };
  mkCheck(
    '在判定线上方',
    (it) => !!it.clip.above,
    (checked) =>
      applyToAll((it) => {
        it.clip.above = checked;
        if (it.note) {
          it.note.above = checked;
          if (it.note.src) it.note.src.above = checked;
        }
        return true;
      }, `在判定线上方 → ${checked ? '是' : '否'}`),
    'above',
  );
  mkCheck(
    'Fake（不计数）',
    (it) => !!it.clip.isFake,
    (checked) =>
      applyToAll((it) => {
        it.clip.isFake = checked;
        if (it.note) {
          it.note.isFake = checked;
          if (it.note.src) it.note.src.isFake = checked;
        }
        return true;
      }, `Fake → ${checked ? '是' : '否'}`),
    'isFake',
  );

  wrap.appendChild(el('div', 'ed-hint', '修改会应用到全部选中对象。'));
  attachTabCycle(wrap); // Tab：同一单位制的下一项（面板外才是快速切线）
}

// ── 工具（parseBeat / fmtBeat / round / commonValue / el 来自 detail-common.js）──

/** 改音符时间：同时更新谱面模型（拍 → 秒 → 高度）与时间轴 clip */
function applyBeat(item, beat, chart) {
  const { clip, note } = item;
  const len = clip.holdBeats ?? Math.max(0, clip.b1 - clip.b0);
  clip.b0 = beat;
  clip.b1 = beat + len;
  if (!note) return true;
  const line = chart?.lines?.[note.lineId] ?? null;
  const timeline = line?.rt?.timeline ?? null;
  if (timeline) {
    note.startBeat = beat;
    note.timeSec = timeline.beatToSeconds(beat);
    if (note.endBeat !== undefined) {
      note.endBeat = beat + len;
      note.endSec = timeline.beatToSeconds(note.endBeat);
      note.durationSec = Math.max(0, note.endSec - note.timeSec);
    }
    note.height = line.rt.heightAt ? line.rt.heightAt(note.timeSec) : note.height;
  } else {
    note.startBeat = beat;
  }
  writeSourceTimes(note.src, note.startBeat, note.endBeat);
  return true;
}
