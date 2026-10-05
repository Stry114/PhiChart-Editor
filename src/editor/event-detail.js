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
  dualHeadRow,
  dualUnitRow,
  attachTabCycle,
} from './detail-common.js';
import { getActiveCurve } from './event-curve.js';
import { renderCurvePanel } from './curve-tab.js';
import { displayUnitFor, dualUnitsFor, referenceRangeFor, TIME_DUAL_UNITS } from './display-units.js';

/** 时间行的 RPE 列：拍号 a+b/c 文本（内部值 = 拍） */
const BEAT_TEXT = { to: (v) => fmtBeat(v), parse: (t) => parseBeat(t) };
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

  const { form, select, hint, check: makeCheck } = createForm();
  wrap.appendChild(form);
  form.appendChild(dualHeadRow()); // 列头：官谱 / RPE / 范围

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
  form.appendChild(
    dualUnitRow({
      label: '起始时间（拍）',
      units: TIME_DUAL_UNITS,
      value: startBeatCommon,
      mixedLabel: anySentinelStart ? '从开头起效（哨兵值）' : mixedLabel,
      fixedStep: 1,
      rpeText: BEAT_TEXT,
      onSet: (v) => moveStartTo(v),
    }),
  );
  if (anySentinelStart) hint('含「从开头起效」的哨兵事件：填入数值会把它改成从该拍开始');

  // ── 时长 / 结束时间（拍）：同一件事的两种写法，改哪个都把另一个算出来 ──
  // 哨兵末值（保持到结束）在两栏里都显示占位符，填入具体数值即转成普通区间。
  const isSentinelEnd = (it) => (it.ev?.endBeat ?? it.clip.b1 ?? 0) >= SENTINEL_BEAT;
  const beatsCommon = commonValue(items, (it) => (isSentinelEnd(it) ? undefined : it.clip.beats));
  const endCommon = commonValue(items, (it) => (isSentinelEnd(it) ? undefined : it.ev?.endBeat));
  const anySentinelEnd = items.some(isSentinelEnd);
  const setDuration = (beat) =>
    apply(`时长 → ${fmtBeat(beat)} 拍`, (it) => {
      const ev = it.ev;
      ev.endBeat = ev.startBeat + beat;
      if (ev.src) ev.src.endBeat = ev.endBeat;
      return true;
    });
  form.appendChild(
    dualUnitRow({
      label: '时长（拍）',
      units: TIME_DUAL_UNITS,
      value: beatsCommon,
      mixedLabel: anySentinelEnd ? '保持到结束' : mixedLabel,
      fixedStep: 1,
      rpeText: BEAT_TEXT,
      validate: (v) => (v < 0 ? null : v),
      onInvalid: (msg) => onStatus?.(msg),
      onSet: (v) => setDuration(v),
    }),
  );
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
  const extendBtn = document.createElement('button');
  extendBtn.className = 'ed-mini ed-mini-icon';
  extendBtn.type = 'button';
  extendBtn.title = '延到下一事件（末事件保持到谱面结束）';
  setIcon(extendBtn, 'to_the_end', { size: 14 });
  form.appendChild(
    dualUnitRow({
      label: '结束时间（拍）',
      units: TIME_DUAL_UNITS,
      value: endCommon,
      mixedLabel: anySentinelEnd ? '保持到结束' : mixedLabel,
      fixedStep: 1,
      rpeText: BEAT_TEXT,
      rpeExtra: [extendBtn],
      onSet: (v) => setEndTo(v),
    }),
  );
  if (anySentinelEnd) hint('含「保持到结束」的事件：填入数值会把它改成普通区间');

  // ── 起始值 / 结束值 ──
  // 颜色事件（扩展）的值是 `[r,g,b]`：拆成三个通道行（起始 → 结束），并给出颜色预览。
  const keyCommon = commonValue(items, (it) => it.clip.key);
  const isColorSel = !mixed(keyCommon) && keyCommon === 'color';
  // 钩定（hook）：开启后首末值恒相等、缓动恒为线性。只写内部模型，不影响 play、不导出。
  // 颜色事件是数组值，不参与钩定；混合态按未勾选显示。
  const hookCommon = commonValue(items, (it) => !!it.ev?.hook);
  const hookAll = !isColorSel && hookCommon === true;
  /** 提示只写「确定的取值范围」，范围不确定的通道不写（用户约定） */
  const rangeHint = '';
  /** 显示单位换算表在 display-units.js（事件曲线页共用同一张表，含 ev:rotate 角度制） */
  // 只有「所有选中项都是同一个通道」时才做单位换算（多选混通道时按内部值显示，避免误改）
  const kindSig = new Set(items.map((it) => `${it.clip?.camera ? 'cam' : 'ev'}:${it.clip?.key}`));
  const unit = kindSig.size === 1 ? displayUnitFor(items[0]?.clip ?? null) : null;

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
        input.dataset.unit = 'single';
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
      form.appendChild(dualUnitRow({ label, control: box, value: 0, onSet: () => {}, range: '0..255' }));
      return box;
    };
    form.appendChild(
      dualUnitRow({
        label: '颜色',
        control: (() => {
          syncSwatch();
          const box = el('div', 'v');
          box.appendChild(swatch);
          return box;
        })(),
        value: 0,
        onSet: () => {},
        range: '0..255',
      }),
    );
    channelRow('R 通道', 0);
    channelRow('G 通道', 1);
    channelRow('B 通道', 2);
  } else {
    // 双单位制：官谱格式里有对应物的通道给「官谱 | RPE」两列（改任一列，另一列随重渲染适配）；
    // 官谱没有的通道（扩展事件 / 相机）合并成单列，沿用事件曲线页的显示单位与参考范围。
    const dual = kindSig.size === 1 && !mixed(keyCommon) ? dualUnitsFor(items[0].clip?.camera ? 'cam' : 'ev', keyCommon) : null;
    const units = dual ?? (unit ? { single: unit } : null);
    // 参考范围：混通道多选时不写（口径不明）；合并列用事件曲线页的参考范围（显示单位）
    const ref = kindSig.size === 1 ? referenceRangeFor(items[0]?.clip ?? null) : null;
    const rangeText = dual ? dual.range : ref ? `${ref.min}..${ref.max}` : rangeHint;
    const applyValue = (which, raw) =>
      apply(`${which === 'start' ? '起始值' : '结束值'} → ${round4(raw)}`, (it) => {
        it.ev[which] = raw;
        if (it.ev.src) it.ev.src[which] = raw;
        // 钩定：首末值恒相等——改哪一个，另一个跟着走（一次 apply = 一步撤销）
        if (it.ev.hook) {
          const other = which === 'start' ? 'end' : 'start';
          it.ev[other] = raw;
          if (it.ev.src) it.ev.src[other] = raw;
        }
        return true;
      });
    const valueRow = (label, which) => {
      const common = commonValue(items, (it) => it.clip[which === 'start' ? 'v0' : 'v1']);
      form.appendChild(
        dualUnitRow({
          label,
          units,
          value: common,
          mixedLabel,
          range: rangeText,
          onSet: (v) => applyValue(which, v),
        }),
      );
    };
    valueRow('起始值', 'start');
    valueRow('结束值', 'end');

    // ── 钩定（hook）：开启后首末值恒相等、缓动恒为线性；只写内部模型，不影响 play、不导出 ──
    const hookCheck = makeCheck({
      checked: hookAll,
      hintText: '开启后首末值恒相等、缓动恒为线性；不影响 play、不导出',
      onChange: (on) => {
        apply(`钩定 → ${on ? '开' : '关'}`, (it) => {
          it.ev.hook = on;
          if (on) {
            // 开启瞬间：首末对齐、缓动回线性（贝塞尔点清掉）
            it.ev.end = it.ev.start;
            it.ev.easingType = 1;
            it.ev.bezierPoints = null;
            if (it.ev.src) {
              it.ev.src.end = it.ev.start;
              it.ev.src.easingType = 1;
              it.ev.src.bezierPoints = null;
            }
          }
          return true;
        });
      },
    });
    form.appendChild(
      dualUnitRow({
        label: '钩定',
        control: hookCheck,
        value: 0,
        onSet: () => {},
      }),
    );
    if (hookAll) hint('钩定已开启：首末值恒相等、缓动恒为线性；曲线页只显示中间手柄。');
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

  // 钩定开启时缓动恒为线性：整块缓动 UI（类型 / 编号 / 贝塞尔 / 裁剪）都不出现
  if (!hookAll) {
  form.appendChild(
    dualUnitRow({
      label: '缓动类型',
      control: select({
        options: EASING_KINDS,
        value: mixed(kindCommon) ? undefined : kindCommon,
        emptyLabel: mixed(kindCommon) ? mixedLabel : undefined,
        onChange: (raw) => {
          const want = String(raw);
          apply(`缓动 → ${kindLabel[want] ?? want}`, (it) => writeKind(it, want));
        },
      }),
      value: 0,
      onSet: () => {},
    }),
  );

  // 二级：具体参数
  if (kind === 'preset') {
    const numCommon = commonValue(items, (it) => easingNumber(it.ev));
    form.appendChild(
      dualUnitRow({
        label: '缓动编号',
        control: select({
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
        value: 0,
        onSet: () => {},
      }),
    );
  }
  // 贝塞尔控制点：一级选到「贝塞尔」时才出现
  if (kind === 'bezier') {
    for (let i = 0; i < 4; i++) {
      const label = `贝塞尔 P${i < 2 ? 1 : 2}.${i % 2 === 0 ? 'x' : 'y'}`;
      const common = commonValue(items, (it) => (it.ev?.bezierPoints ?? [])[i]);
      const ci = i;
      form.appendChild(
        dualUnitRow({
          label,
          value: common,
          mixedLabel,
          stepper: true,
          range: ci % 2 === 0 ? '0..1' : '',
          validate: (v) => (ci % 2 === 0 ? (v < 0 || v > 1 ? null : v) : v),
          onInvalid: (msg) => onStatus?.(msg),
          onSet: (v) =>
            apply(`${label} → ${v}`, (it) => {
              const ev = it.ev;
              const pts = Array.isArray(ev.bezierPoints) ? [...ev.bezierPoints] : [0.25, 0.1, 0.25, 1];
              if (ci % 2 === 0) pts[ci] = Math.max(0, Math.min(1, v));
              else pts[ci] = v;
              ev.bezierPoints = pts;
              ev.easingType = 6;
              if (ev.src) ev.src.bezierPoints = pts;
              return true;
            }),
        }),
      );
    }
  }

  // ── 缓动裁剪（RPE 的 easingLeft/easingRight） ──
  const hasClip = items.some((it) => it.ev?.easingLeft !== undefined || it.ev?.easingRight !== undefined);
  if (hasClip) {
    const clipRow = (label, field, fallback) => {
      const common = commonValue(items, (it) => it.ev?.[field] ?? fallback);
      form.appendChild(
        dualUnitRow({
          label,
          value: common,
          mixedLabel,
          stepper: true,
          range: '0..1',
          validate: (v) => (v < 0 || v > 1 ? null : v),
          onInvalid: (msg) => onStatus?.(msg),
          onSet: (v) =>
            apply(`${label} → ${v}`, (it) => {
              it.ev[field] = v;
              if (it.ev.src) it.ev.src[field] = v;
              return true;
            }),
        }),
      );
    };
    clipRow('缓动左裁剪', 'easingLeft', 0);
    clipRow('缓动右裁剪', 'easingRight', 1);
  }
  } // end if (!hookAll) —— 钩定开启时缓动恒为线性，整块缓动 UI 不出现

  // ── linkgroup（RPE） ──
  if (items.some((it) => it.ev?.linkgroup !== undefined)) {
    const lgCommon = commonValue(items, (it) => it.ev?.linkgroup ?? 0);
    form.appendChild(
      dualUnitRow({
        label: 'linkgroup',
        value: lgCommon,
        mixedLabel,
        stepper: true,
        onSet: (v) =>
          apply(`linkgroup → ${v}`, (it) => {
            it.ev.linkgroup = v;
            if (it.ev.src) it.ev.src.linkgroup = v;
            return true;
          }),
      }),
    );
  }

  attachTabCycle(wrap); // Tab：同一单位制的下一项（面板外才是快速切线）

  // 右栏：事件值曲线（与表单同一份选中项）。
  // 颜色事件的取值是 [r,g,b]，画不出标量曲线；多选时曲线也只对第一项有意义 ——
  // 这两种情况整栏隐藏，把空间让给左侧表单。
  const showCurve = !isColorSel && items.length === 1;
  grid.classList.toggle('no-curve', !showCurve);
  if (showCurve) {
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
  }

  void chart;
}

