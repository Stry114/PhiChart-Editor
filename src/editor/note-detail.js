// Note 详情面板：查看/编辑选中音符的参数（多选时不加载默认值，任何修改对全部选中项生效）
import {
  commonValue,
  el,
  parseBeat,
  fmtBeat,
  round4 as round,
  setLastAction,
  actionLine,
} from './detail-common.js';

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
      el('div', 'ed-hint', '在右下时间轴里用鼠标工具点选音符（Ctrl 点击可多选），这里就能编辑它的参数。'),
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
    let n = 0;
    for (const it of items) {
      if (fn(it) !== false) n++;
    }
    timeline.redraw();
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
  row('类型', typeSel, mixedType ? '（选中项类型不同）' : '');
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
  const beatInput = document.createElement('input');
  beatInput.className = 'ed-beat';
  beatInput.type = 'text';
  beatInput.placeholder = `多个值（${items.length} 项）`;
  if (beatCommon !== undefined) beatInput.value = fmtBeat(beatCommon);
  row('时间（拍）', beatInput, 'a+b/c 或小数；对所有选中项设为同一时间');
  beatInput.addEventListener('change', () => {
    const beat = parseBeat(beatInput.value);
    if (beat == null) {
      onStatus?.('时间格式应为 a+b/c（如 12+1/4）或小数');
      renderNoteDetail(root, ctx);
      return;
    }
    applyToAll((it) => applyBeat(it, beat, ctx.chart), `时间 → ${fmtBeat(beat)} 拍`);
  });

  // ── positionX ──
  const xCommon = commonValue(items, (it) => it.clip.positionX);
  const xInput = document.createElement('input');
  xInput.className = 'ed-num';
  xInput.type = 'number';
  xInput.step = '0.1';
  xInput.placeholder = `多个值（${items.length} 项）`;
  if (xCommon !== undefined) xInput.value = String(round(xCommon));
  row('positionX', xInput, '官方 X 单位（1 X = 0.05625 W）');
  xInput.addEventListener('change', () => {
    const v = Number(xInput.value);
    if (!Number.isFinite(v)) return;
    applyToAll((it) => {
      it.clip.positionX = v;
      if (it.note) {
        it.note.positionX = v;
        if (it.note.src) it.note.src.positionX = v;
      }
      return true;
    }, `positionX → ${v}`);
  });

  // ── Hold 时长 ──
  const holdCommon = commonValue(items, (it) => it.clip.holdBeats ?? 0);
  const holdInput = document.createElement('input');
  holdInput.className = 'ed-num';
  holdInput.type = 'number';
  holdInput.step = '0.25';
  holdInput.min = '0';
  holdInput.placeholder = `多个值（${items.length} 项）`;
  if (holdCommon !== undefined) holdInput.value = String(round(holdCommon));
  const anyHold = items.some((it) => it.clip.type === 'hold');
  row('Hold 时长（拍）', holdInput, anyHold ? '仅 Hold 生效' : '当前选中项都不是 Hold');
  holdInput.addEventListener('change', () => {
    const v = Number(holdInput.value);
    if (!Number.isFinite(v) || v < 0) return;
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
    }, `Hold 时长 → ${v} 拍`);
  });

  // ── speed ──
  const speedCommon = commonValue(items, (it) => it.clip.speed ?? 1);
  const speedInput = document.createElement('input');
  speedInput.className = 'ed-num';
  speedInput.type = 'number';
  speedInput.step = '0.1';
  speedInput.min = '0';
  speedInput.placeholder = `多个值（${items.length} 项）`;
  if (speedCommon !== undefined) speedInput.value = String(round(speedCommon));
  row('速度倍率 speed', speedInput, '音符自身下落速度倍率（0 表示静止）');
  speedInput.addEventListener('change', () => {
    const v = Number(speedInput.value);
    if (!Number.isFinite(v) || v < 0) return;
    applyToAll((it) => {
      it.clip.speed = v;
      if (it.note) {
        it.note.speed = v;
        if (it.note.src) it.note.src.speed = v;
      }
      return true;
    }, `speed → ${v}`);
  });

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
    const r = el('div', 'ed-note-row');
    r.appendChild(el('label', 'k', label));
    const box = el('div', 'v');
    box.appendChild(input);
    box.appendChild(el('span', 'dim', mixed ? `多个值（${items.length} 项）` : hint ?? ''));
    r.appendChild(box);
    form.appendChild(r);
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

  wrap.appendChild(
    el(
      'div',
      'ed-hint',
      '说明：多选时不显示默认值（显示「多个值」）；任何修改都会应用到全部选中音符。修改会立即写入内存中的谱面模型，导出/保存到文件在后续阶段。',
    ),
  );
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
  if (note.src) {
    note.src.startBeat = beat;
    if (note.src.endBeat !== undefined) note.src.endBeat = beat + len;
  }
  return true;
}
