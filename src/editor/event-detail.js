/**
 * 「Event 详情」面板：编辑选中事件轨上的事件参数。
 *
 * 与「Note 详情」一致的多选规则：**不加载默认值** —— 所有选中项取值一致就显示该值，
 * 只要有一个不同就留空并显示「多个值（N 项）」；任何修改都应用到全部选中项。
 *
 * 改动直接写进谱面模型里的源事件对象（clip.ev），再用 refreshEventClip() 就地把
 * 时间轴上的派生字段（封面拍坐标、文案、趋势线）刷新，因此不会重排、不会丢选中。
 */
import { EVENT_LABELS, CAMERA_LABELS, refreshEventClip, createBeatAxis } from './tracks.js';
import { makeEasing, EASING_COUNT, EASING_NAMES } from '../core/easing.js';
import {
  commonValue,
  createForm,
  buildHead,
  el,
  parseBeat,
  fmtBeat,
  round4,
  setLastAction,
  actionLine,
  beatStepperRow,
  valueStepper,
} from './detail-common.js';
import { getActiveCurve } from './event-curve.js';
import { renderCurvePanel } from './curve-tab.js';
import { displayUnitFor } from './display-units.js';
import { RPE } from '../core/units.js';
import { setIcon } from '../ui/icons.js';

// 「保持到结束」的哨兵拍值：official 的 endTime = 1e9（1/32 拍单位）÷ 32 = 31250000 拍，
// 与 RPE 的 SENTINEL_BEAT 相同 —— 两种格式在拍空间里收敛到同一个值。
const SENTINEL_BEAT = RPE.SENTINEL_BEAT;

/** 把选中的 key（trackId#index）解析成事件 clip 与源事件对象 */
export function resolveSelectedEvents(timeline) {
  const out = [];
  for (const key of timeline.selection.events) {
    const hash = key.lastIndexOf('#');
    const trackId = key.slice(0, hash);
    const index = Number(key.slice(hash + 1));
    const track = timeline.tracks.find((t) => t.id === trackId);
    const clip = track?.clips?.[index];
    if (!track || !clip) continue;
    if (track.kind !== 'events') continue; // 音符走 Note 详情
    out.push({ key, track, index, clip, ev: clip.ev ?? null });
  }
  return out;
}

/** 一级：缓动类别 */
const EASING_KINDS = [
  { value: 'linear', label: '线性' },
  { value: 'preset', label: '预设缓动' },
  { value: 'bezier', label: '贝塞尔' },
];

/** 二级：预设缓动编号（1..29，含 6 = In Out Sine；1 已归为「线性」类别，这里从 2 开始） */
function presetOptions() {
  const out = [];
  for (let i = 2; i <= EASING_COUNT; i++) {
    out.push({ value: i, label: `缓动#${i} · ${EASING_NAMES[i] ?? ''}`.trim() });
  }
  return out;
}

/** 事件当前属于哪一类（贝塞尔 = 真的带了 4 个控制点） */
function easingKindOf(ev) {
  if (Array.isArray(ev?.bezierPoints) && ev.bezierPoints.length === 4) return 'bezier';
  const t = Number.isFinite(ev?.easingPreset) ? ev.easingPreset : Number.isFinite(ev?.easingType) ? ev.easingType : 1;
  return t === 1 ? 'linear' : 'preset';
}

/** 事件当前的缓动编号（用于二级下拉；线性与贝塞尔都返回 1，仅作占位） */
function easingNumber(ev) {
  const t = Number.isFinite(ev?.easingPreset) ? ev.easingPreset : Number.isFinite(ev?.easingType) ? ev.easingType : 1;
  return Number.isFinite(t) ? t : 1;
}

export function renderEventDetail(root, ctx) {
  const { timeline, chart, onStatus } = ctx;
  // 面板会随选中项/拖动频繁重建：先销毁上一个曲线图（断开它的 ResizeObserver），
  // 否则观察者会越积越多，页面越来越卡。
  getActiveCurve()?.destroy?.();
  // ctx 没给拍轴时自建一个（例如页面刚载入、外部还没准备好），否则刷新会静默失败
  const axis = ctx.axis ?? (chart ? createBeatAxis(chart) : null);
  root.innerHTML = '';
  const grid = el('div', 'ed-event-grid');
  const wrap = el('div', 'ed-event-form ed-scroll');
  const curveCol = el('div', 'ed-event-curve');
  grid.append(wrap, curveCol);
  root.appendChild(grid);

  const items = resolveSelectedEvents(timeline);
  if (!items.length) {
    wrap.appendChild(
      el('div', 'ed-hint', '在时间轴中选中事件块后可编辑参数。'),
    );
    return;
  }

  // 提示行只在「选中项没变」时显示，换选中就消失
  const selectionSig = [...timeline.selection.events].sort().join(',');
  /** 事件的中文名：相机的键名与普通事件的 x / y 同名，必须按轨道类型分开取 */
  const clipLabel = (clip) => (clip?.camera ? CAMERA_LABELS[clip.key] : EVENT_LABELS[clip.key]) ?? clip?.key ?? '';
  const kinds = new Map();
  for (const it of items) {
    const k = `${it.track.label}${it.clip.key ? ` · ${clipLabel(it.clip)}` : ''}`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  wrap.appendChild(buildHead(items.length, '事件', [...kinds.entries()].map(([k, v]) => `${k}×${v}`).join('　')));
  const line = actionLine(selectionSig);
  if (line) wrap.appendChild(line);

  const { form, row, number, check, select, hint } = createForm();
  wrap.appendChild(form);

  const mixed = (v) => v === undefined;
  const mixedLabel = `多个值（${items.length} 项）`;

  /**
   * 重渲染面板：**不能在下拉/输入框自己的事件处理器里同步重建 DOM**。
   * 浏览器在关掉原生下拉之后还会补一次选中项写回，如果这时旧的下拉已经被删掉、
   * 新的下拉已经按同步读到（还没写回的）值建好，用户就会看到「提示成功但下拉还是旧选项」。
   * 因此把重建推迟一帧，让原生交互先结束。
   */
  const rerender = () => {
    const run = () => renderEventDetail(root, ctx);
    // 用 setTimeout 而不是 rAF：后台标签页里 rAF 会被暂停，面板就永远不刷新了
    setTimeout(run, 0);
  };

  /** 应用一次修改：写源事件 → 刷新派生字段 → 重绘 → 重渲染面板 */
  const apply = (labelText, mutate) => {
    // 面板是按「渲染时的选中项」建的：选中项若已变化，绝不能把改动写到现在选中的别的事件上
    const nowSig = [...timeline.selection.events].sort().join(',');
    if (nowSig !== selectionSig) {
      setLastAction('选中项已变化，未应用。', { bad: true, sig: nowSig });
      onStatus?.('选中项已变化，已忽略本次修改。');
      rerender();
      return;
    }
    try {
      applyInner(labelText, mutate);
    } catch (err) {
      // 以前这里抛错会静默失败，看起来就是“改了没反应”
      console.error('[Event 详情] 应用失败：', err);
      setLastAction(`${labelText} 应用失败：${err?.message ?? err}`, { bad: true, sig: selectionSig });
      onStatus?.(`${labelText} 应用失败：${err?.message ?? err}`);
    }
  };
  const applyInner = (labelText, mutate) => {
    // 撤销记录：先记下改动前的字段（事件对象是就地改的）
    const finishEdit = timeline.recordEdit?.(
      labelText,
      items.map((it) => it.ev).filter(Boolean),
      {
        lineIds: [...new Set(items.map((it) => it.track?.lineId).filter((v) => Number.isFinite(v)))],
        keys: [...new Set(items.map((it) => it.clip?.key).filter(Boolean))],
      },
    );
    let count = 0;
    for (const it of items) {
      if (!it.ev) continue;
      if (mutate(it) === false) continue;
      count++;
    }
    finishEdit?.();
    for (const it of items) {
      if (!it.ev) continue;
      // 改完参数统一重建缓动函数（速度事件没有缓动，跳过）
      if (it.clip.key !== 'speed') {
        const t = Number.isFinite(it.ev.easingType) ? it.ev.easingType : 1;
        const fn = makeEasing(t, it.ev.bezierPoints ?? null, it.ev.easingLeft ?? 0, it.ev.easingRight ?? 1);
        it.ev.easingFn = fn;
        it.ev.easingType = fn.easingType;
        it.ev.easingPreset = fn.easingPreset;
        it.ev.bezierPoints = fn.bezierPoints;
      }
      refreshEventClip(it.track, it.index, axis);
    }
    timeline.redraw();
    // 事件的时间/取值/缓动都改在源对象上，而预览用的是编译后的列表（连缓动函数都是编译时抓的引用）
    // → 必须重编译这条线的对应事件类型，否则预览看不出改动
    timeline.notifyChanged?.({
      lineIds: [...new Set(items.map((it) => it.track?.lineId).filter((v) => Number.isFinite(v)))],
      keys: [...new Set(items.map((it) => it.clip?.key).filter(Boolean))],
    });
    const editable = items.filter((it) => it.ev).length;
    if (!editable) {
      // 静默失败的老问题：没有任何一项被改动时必须说出来
      setLastAction('选中的事件没有可编辑的源数据，未改动。', {
        bad: true,
        sig: selectionSig,
      });
    } else if (labelText.startsWith('缓动')) {
      // 复读一次：写进去的缓动读不回来，说明模型/脚本不是同一份（最常见的原因是浏览器缓存了旧谱面）
      const now = resolveSelectedEvents(timeline)
        .map((it) => it.ev)
        .filter(Boolean);
      const missing = now.filter((e) => !Number.isFinite(e.easingType) && !Number.isFinite(e.easingPreset));
      if (missing.length) {
        setLastAction('写入后读不到缓动字段，请强制刷新页面。', {
          bad: true,
          sig: selectionSig,
        });
      } else {
        setLastAction(null);
      }
    } else {
      setLastAction(null);
    }
    onStatus?.(`${labelText}：已应用 ${count} 个。`);
    rerender();
  };

  // ── 起始时间（拍）：保持各自时长，只挪起点 ──
  const isSentinelStart = (it) => (it.ev?.startBeat ?? it.clip.b0) < -1000; // 官方「从开头就生效」的哨兵
  const startBeatCommon = commonValue(items, (it) => (isSentinelStart(it) ? undefined : it.clip.b0));
  const anySentinelStart = items.some(isSentinelStart);
  const moveStartTo = (beat) =>
    apply(`起始时间 → ${fmtBeat(beat)} 拍`, (it) => {
      const ev = it.ev;
      const len = ev.endBeat >= SENTINEL_BEAT ? 0 : Math.max(0, ev.endBeat - ev.startBeat);
      ev.startBeat = beat;
      if (ev.endBeat < SENTINEL_BEAT) ev.endBeat = beat + len;
      if (ev.src) {
        ev.src.startBeat = beat;
        if (ev.src.endBeat < SENTINEL_BEAT) ev.src.endBeat = beat + len;
      }
      return true;
    });
  const startInput = createBeatInput(
    mixed(startBeatCommon) ? '' : fmtBeat(startBeatCommon),
    anySentinelStart ? '从开头起效（哨兵值）' : mixed(startBeatCommon) ? mixedLabel : '',
    (text) => {
      const beat = parseBeat(text);
      if (beat == null) {
        onStatus?.('时间格式应为 a+b/c（如 12+1/4）或小数');
        rerender();
        return;
      }
      moveStartTo(beat);
    },
  );
  row(
    '起始时间（拍）',
    beatStepperRow(startInput, (d) =>
      apply(`起始时间 ${d > 0 ? '+' : ''}${fmtBeat(d)} 拍`, (it) => {
        const ev = it.ev;
        const len = ev.endBeat >= SENTINEL_BEAT ? 0 : Math.max(0, ev.endBeat - ev.startBeat);
        ev.startBeat += d;
        if (ev.endBeat < SENTINEL_BEAT) ev.endBeat = ev.startBeat + len;
        if (ev.src) {
          ev.src.startBeat = ev.startBeat;
          if (ev.src.endBeat < SENTINEL_BEAT) ev.src.endBeat = ev.endBeat;
        }
        return true;
      }),
    ),
    anySentinelStart ? '含「从开头起效」的哨兵事件：填入数值会把它改成从该拍开始' : '',
  );

  // ── 时长 / 结束时间（拍）：同一件事的两种写法，改哪个都把另一个算出来 ──
  // 哨兵末值（保持到结束）在两栏里都显示占位符，填入具体数值即转成普通区间。
  const isSentinelEnd = (it) => (it.ev?.endBeat ?? it.clip.b1 ?? 0) >= SENTINEL_BEAT;
  const beatsCommon = commonValue(items, (it) => (isSentinelEnd(it) ? undefined : it.clip.beats));
  const setDuration = (beat) =>
    apply(`时长 → ${fmtBeat(beat)} 拍`, (it) => {
      const ev = it.ev;
      ev.endBeat = ev.startBeat + beat;
      if (ev.src) ev.src.endBeat = ev.endBeat;
      return true;
    });
  const durInput = createBeatInput(
    mixed(beatsCommon) ? '' : fmtBeat(beatsCommon),
    mixed(beatsCommon) ? mixedLabel : '',
    (text) => {
      const beat = parseBeat(text);
      if (beat == null || beat < 0) {
        onStatus?.('时长格式应为 a+b/c（如 2+1/2）或非负小数');
        rerender();
        return;
      }
      setDuration(beat);
    },
  );
  row(
    '时长（拍）',
    beatStepperRow(durInput, (d) =>
      apply(`时长 ${d > 0 ? '+' : ''}${fmtBeat(d)} 拍`, (it) => {
        const ev = it.ev;
        const dur = Math.max(0, (ev.endBeat >= SENTINEL_BEAT ? 1 : ev.endBeat - ev.startBeat) + d);
        ev.endBeat = ev.startBeat + dur;
        if (ev.src) ev.src.endBeat = ev.endBeat;
        return true;
      }),
    ),
    '',
  );
  const endCommon = commonValue(items, (it) => (isSentinelEnd(it) ? undefined : it.ev?.endBeat));
  const anySentinelEnd = items.some(isSentinelEnd);
  /** 结束拍 = 同轨下一个事件的起点；已是末事件 → 写「保持到结束」哨兵 */
  const extendToNext = () =>
    apply('结束 → 下一事件起点', (it) => {
      const clips = Array.isArray(it.track?.clips) ? it.track.clips : [];
      const at = clips.indexOf(it.clip);
      const next = at >= 0 ? clips[at + 1] : null;
      const ev = it.ev;
      ev.endBeat = next ? Math.max(ev.startBeat, next.b0) : SENTINEL_BEAT;
      if (ev.src) ev.src.endBeat = ev.endBeat;
      return true;
    });
  const setEndTo = (beat) =>
    apply(`结束时间 → ${fmtBeat(beat)} 拍`, (it) => {
      const ev = it.ev;
      ev.endBeat = Math.max(ev.startBeat, beat); // 结束不得早于起始
      if (ev.src) ev.src.endBeat = ev.endBeat;
      return true;
    });
  const endInput = createBeatInput(
    mixed(endCommon) ? '' : fmtBeat(endCommon),
    anySentinelEnd ? '保持到结束' : mixed(endCommon) ? mixedLabel : '',
    (text) => {
      const beat = parseBeat(text);
      if (beat == null) {
        onStatus?.('时间格式应为 a+b/c（如 12+1/4）或小数');
        rerender();
        return;
      }
      setEndTo(beat);
    },
  );
  const extendBtn = document.createElement('button');
  extendBtn.className = 'ed-mini ed-mini-icon';
  extendBtn.type = 'button';
  extendBtn.title = '延到下一事件（末事件保持到谱面结束）';
  setIcon(extendBtn, 'to_the_end', { size: 14 });
  extendBtn.addEventListener('click', extendToNext);
  row(
    '结束时间（拍）',
    beatStepperRow(
      endInput,
      (d) =>
        apply(`结束时间 ${d > 0 ? '+' : ''}${fmtBeat(d)} 拍`, (it) => {
          const ev = it.ev;
          const cur = ev.endBeat >= SENTINEL_BEAT ? ev.startBeat + 1 : ev.endBeat;
          ev.endBeat = Math.max(ev.startBeat, cur + d);
          if (ev.src) ev.src.endBeat = ev.endBeat;
          return true;
        }),
      [extendBtn],
    ),
    anySentinelEnd ? '含「保持到结束」的事件：填入数值会把它改成普通区间' : '',
  );

  // ── 起始值 / 结束值 ──
  // 颜色事件（扩展）的值是 `[r,g,b]`：拆成三个通道行（起始 → 结束），并给出颜色预览。
  const keyCommon = commonValue(items, (it) => it.clip.key);
  const isColorSel = !mixed(keyCommon) && keyCommon === 'color';
  const isScaleSel = !mixed(keyCommon) && (keyCommon === 'scaleX' || keyCommon === 'scaleY');
  /** 提示只写「确定的取值范围」，范围不确定的通道不写（用户约定） */
  const RANGE_HINTS = { alpha: '0..1' };
  const rangeHint = !mixed(keyCommon) ? RANGE_HINTS[keyCommon] ?? '' : '';
  /** 显示单位换算表在 display-units.js（事件曲线页共用同一张表，含 ev:rotate 角度制） */
  // 只有「所有选中项都是同一个通道」时才做单位换算（多选混通道时按内部值显示，避免误改）
  const kindSig = new Set(items.map((it) => `${it.clip?.camera ? 'cam' : 'ev'}:${it.clip?.key}`));
  const unit = kindSig.size === 1 ? displayUnitFor(items[0]?.clip ?? null) : null;
  const toDisplay = (v) => (unit && Number.isFinite(v) ? unit.to(v) : v);
  const fromDisplay = (v) => (unit ? unit.from(v) : v);

  if (isColorSel) {
    const swatch = el('div', 'ed-color-swatch');
    const readCh = (it, which, ci) => {
      const arr = Array.isArray(it.clip?.[which]) ? it.clip[which] : null;
      return arr && Number.isFinite(arr[ci]) ? arr[ci] : undefined;
    };
    const syncSwatch = () => {
      const a = commonValue(items, (it) => readCh(it, 'v0', 0));
      const b = commonValue(items, (it) => readCh(it, 'v0', 1));
      const c = commonValue(items, (it) => readCh(it, 'v0', 2));
      const d = commonValue(items, (it) => readCh(it, 'v1', 0));
      const e = commonValue(items, (it) => readCh(it, 'v1', 1));
      const f = commonValue(items, (it) => readCh(it, 'v1', 2));
      swatch.style.background =
        [a, b, c, d, e, f].every((v) => Number.isFinite(v))
          ? `linear-gradient(90deg, rgb(${a},${b},${c}), rgb(${d},${e},${f}))`
          : 'transparent';
    };
    const channelRow = (label, ci) => {
      const box = el('div', 'ed-inline');
      const mk = (which) => {
        const common = commonValue(items, (it) => readCh(it, which, ci));
        const input = document.createElement('input');
        input.className = 'ed-num';
        input.type = 'number';
        input.min = '0';
        input.max = '255';
        input.step = '1';
        if (!mixed(common)) input.value = String(Math.round(common));
        input.placeholder = mixed(common) ? mixedLabel : '';
        input.addEventListener('change', () => {
          const v = Math.round(Number(input.value));
          if (!Number.isFinite(v)) return;
          apply(`${label} ${which === 'v0' ? '起始' : '结束'} → ${v}`, (it) => {
            const field = which === 'v0' ? 'start' : 'end';
            const arr = Array.isArray(it.ev[field]) ? [...it.ev[field]] : [255, 255, 255];
            arr[ci] = Math.min(255, Math.max(0, v));
            it.ev[field] = arr;
            return true;
          });
        });
        return input;
      };
      box.append(mk('v0'), el('span', 'dim', '→'), mk('v1'));
      row(label, box);
      return box;
    };
    row('颜色', (() => {
      syncSwatch();
      return swatch;
    })(), '0..255');
    channelRow('R 通道', 0);
    channelRow('G 通道', 1);
    channelRow('B 通道', 2);
  } else {
    const v0Common = commonValue(items, (it) => it.clip.v0);
    const v0Step = Number(unit?.step ?? (isScaleSel ? 0.05 : 0.1)) || 0.1;
    const v0Input = number({
      value: mixed(v0Common) ? undefined : toDisplay(v0Common),
      placeholder: mixed(v0Common) ? mixedLabel : '',
      step: String(v0Step),
      onChange: (v) => {
        if (!Number.isFinite(v)) return;
        const raw = fromDisplay(v);
        apply(`起始值 → ${v}`, (it) => {
          it.ev.start = raw;
          if (it.ev.src) it.ev.src.start = raw;
          return true;
        });
      },
    });
    row(
      '起始值',
      valueStepper(v0Input, (dir) => {
        const base = mixed(v0Common) ? null : toDisplay(v0Common);
        if (base === null) {
          onStatus?.('多个值不同：请先填一个统一值，再用 +/− 微调');
          return;
        }
        const v = base + dir * v0Step;
        const raw = fromDisplay(v);
        apply(`起始值 ${dir > 0 ? '+' : '−'}${v0Step}`, (it) => {
          it.ev.start = raw;
          if (it.ev.src) it.ev.src.start = raw;
          return true;
        });
      }),
      rangeHint,
    );
    const v1Common = commonValue(items, (it) => it.clip.v1);
    const v1Input = number({
      value: mixed(v1Common) ? undefined : toDisplay(v1Common),
      placeholder: mixed(v1Common) ? mixedLabel : '',
      step: String(v0Step),
      onChange: (v) => {
        if (!Number.isFinite(v)) return;
        const raw = fromDisplay(v);
        apply(`结束值 → ${v}`, (it) => {
          it.ev.end = raw;
          if (it.ev.src) it.ev.src.end = raw;
          return true;
        });
      },
    });
    row(
      '结束值',
      valueStepper(v1Input, (dir) => {
        const base = mixed(v1Common) ? null : toDisplay(v1Common);
        if (base === null) {
          onStatus?.('多个值不同：请先填一个统一值，再用 +/− 微调');
          return;
        }
        const v = base + dir * v0Step;
        const raw = fromDisplay(v);
        apply(`结束值 ${dir > 0 ? '+' : '−'}${v0Step}`, (it) => {
          it.ev.end = raw;
          if (it.ev.src) it.ev.src.end = raw;
          return true;
        });
      }),
      rangeHint,
    );
  }

  // ── 缓动 ──
  const isOfficial = chart?.format !== 'rpe';
  // 一级：类别（线性 / 预设缓动 / 贝塞尔）
  const kindCommon = commonValue(items, (it) => easingKindOf(it.ev));
  const kind = mixed(kindCommon) ? null : kindCommon; // 多选混类别时不展开二级
  const writeKind = (it, want) => {
    const ev = it.ev;
    const prevNum = easingNumber(ev);
    if (want === 'linear') {
      ev.easingType = 1;
      ev.bezierPoints = null;
    } else if (want === 'bezier') {
      ev.easingType = 6;
      if (!(Array.isArray(ev.bezierPoints) && ev.bezierPoints.length === 4)) ev.bezierPoints = [0.25, 0.1, 0.25, 1];
    } else {
      // 切到预设：保留原来的编号；原来是线性/贝塞尔就用 2（Out Sine）打底
      ev.easingType = prevNum > 1 && prevNum !== 6 ? prevNum : 2;
      ev.bezierPoints = null;
    }
    if (ev.src) {
      ev.src.easingType = ev.easingType;
      ev.src.bezierPoints = ev.bezierPoints;
    }
    return true;
  };
  const kindLabel = { linear: '线性', preset: '预设缓动', bezier: '贝塞尔' };

  row(
    '缓动类型',
    select({
      options: EASING_KINDS,
      value: mixed(kindCommon) ? undefined : kindCommon,
      emptyLabel: mixed(kindCommon) ? mixedLabel : undefined,
      onChange: (raw) => {
        const want = String(raw);
        apply(`缓动 → ${kindLabel[want] ?? want}`, (it) => writeKind(it, want));
      },
    }),
    '',
  );

  // 二级：具体参数
  if (kind === 'preset') {
    const numCommon = commonValue(items, (it) => easingNumber(it.ev));
    row(
      '缓动编号',
      select({
        options: presetOptions(),
        value: mixed(numCommon) ? undefined : numCommon,
        emptyLabel: mixed(numCommon) ? mixedLabel : undefined,
        onChange: (raw) => {
          const num = Number(raw);
          apply(`缓动编号 → ${num}（${EASING_NAMES[num] ?? ''}）`, (it) => {
            const ev = it.ev;
            ev.easingType = num;
            ev.bezierPoints = null;
            if (ev.src) {
              ev.src.easingType = num;
              ev.src.bezierPoints = null;
            }
            return true;
          });
        },
      }),
      '',
    );
  }
  // 贝塞尔控制点：一级选到「贝塞尔」时才出现
  if (kind === 'bezier') {
    for (let i = 0; i < 4; i++) {
      const label = `贝塞尔 P${i < 2 ? 1 : 2}.${i % 2 === 0 ? 'x' : 'y'}`;
      const common = commonValue(items, (it) => (it.ev?.bezierPoints ?? [])[i]);
      row(
        label,
        number({
          value: mixed(common) ? undefined : common,
          placeholder: mixed(common) ? mixedLabel : '',
          step: '0.05',
          onChange: (v) => {
            if (!Number.isFinite(v)) return;
            apply(`${label} → ${v}`, (it) => {
              const ev = it.ev;
              const pts = Array.isArray(ev.bezierPoints) ? [...ev.bezierPoints] : [0.25, 0.1, 0.25, 1];
              if (i % 2 === 0) pts[i] = Math.max(0, Math.min(1, v));
              else pts[i] = v;
              ev.bezierPoints = pts;
              ev.easingType = 6;
              if (ev.src) ev.src.bezierPoints = pts;
              return true;
            });
          },
        }),
        i % 2 === 0 ? '0..1' : '',
      );
    }
  }

  // ── 缓动裁剪（RPE 的 easingLeft/easingRight） ──
  const hasClip = items.some((it) => it.ev?.easingLeft !== undefined || it.ev?.easingRight !== undefined);
  if (hasClip) {
    const leftCommon = commonValue(items, (it) => it.ev?.easingLeft ?? 0);
    row(
      '缓动左裁剪',
      number({
        value: mixed(leftCommon) ? undefined : leftCommon,
        placeholder: mixed(leftCommon) ? mixedLabel : '',
        step: '0.05',
        min: 0,
        onChange: (v) => {
          if (!Number.isFinite(v)) return;
          apply(`缓动左裁剪 → ${v}`, (it) => {
            it.ev.easingLeft = v;
            if (it.ev.src) it.ev.src.easingLeft = v;
            return true;
          });
        },
      }),
      '0..1',
    );
    const rightCommon = commonValue(items, (it) => it.ev?.easingRight ?? 1);
    row(
      '缓动右裁剪',
      number({
        value: mixed(rightCommon) ? undefined : rightCommon,
        placeholder: mixed(rightCommon) ? mixedLabel : '',
        step: '0.05',
        min: 0,
        onChange: (v) => {
          if (!Number.isFinite(v)) return;
          apply(`缓动右裁剪 → ${v}`, (it) => {
            it.ev.easingRight = v;
            if (it.ev.src) it.ev.src.easingRight = v;
            return true;
          });
        },
      }),
      '0..1',
    );
  }

  // ── linkgroup（RPE） ──
  if (items.some((it) => it.ev?.linkgroup !== undefined)) {
    const lgCommon = commonValue(items, (it) => it.ev?.linkgroup ?? 0);
    row(
      'linkgroup',
      number({
        value: mixed(lgCommon) ? undefined : lgCommon,
        placeholder: mixed(lgCommon) ? mixedLabel : '',
        step: '1',
        onChange: (v) => {
          if (!Number.isFinite(v)) return;
          apply(`linkgroup → ${v}`, (it) => {
            it.ev.linkgroup = v;
            if (it.ev.src) it.ev.src.linkgroup = v;
            return true;
          });
        },
      }),
      '',
    );
  }

  // 右栏：事件值曲线（与表单同一份选中项；颜色等非标量事件由它自己给提示）
  renderCurvePanel(curveCol, {
    chart,
    timeline,
    axis,
    onStatus,
    refreshClip: (track, index, ax) => {
      const it = items.find((x) => x.track === track && x.index === index) ?? null;
      if (it) refreshEventClip(track, index, ax ?? axis);
    },
    // 拖完手柄后整页重建：表单的起止值 / 结束时间要跟上，且必须落到当前活的根节点
    rerenderPage: () => renderEventDetail(root, ctx),
  });

  void chart;
}

/** 简单的拍号输入框（与 Note 面板一致的外观） */
function createBeatInput(value, placeholder, onChange) {
  const input = document.createElement('input');
  input.className = 'ed-beat';
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

