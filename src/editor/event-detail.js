/**
 * 「Event 详情」面板：编辑选中事件轨上的事件参数。
 *
 * 与「Note 详情」一致的多选规则：**不加载默认值** —— 所有选中项取值一致就显示该值，
 * 只要有一个不同就留空并显示「多个值（N 项）」；任何修改都应用到全部选中项。
 *
 * 改动直接写进谱面模型里的源事件对象（clip.ev），再用 refreshEventClip() 就地把
 * 时间轴上的派生字段（封面拍坐标、文案、趋势线）刷新，因此不会重排、不会丢选中。
 */
import { EVENT_LABELS, refreshEventClip, createBeatAxis } from './tracks.js';
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
} from './detail-common.js';
import { getActiveCurve } from './event-curve.js';

const SENTINEL_BEAT = 1e9; // 官方/引擎里表示「保持到结束」的哨兵拍值

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
  const wrap = el('div', 'ed-scroll');
  root.appendChild(wrap);

  const items = resolveSelectedEvents(timeline);
  if (!items.length) {
    wrap.appendChild(
      el('div', 'ed-hint', '在时间轴中选中事件块后可编辑参数。'),
    );
    return;
  }

  // 提示行只在「选中项没变」时显示，换选中就消失
  const selectionSig = [...timeline.selection.events].sort().join(',');
  const kinds = new Map();
  for (const it of items) {
    const k = `${it.track.label}${it.clip.key ? ` · ${EVENT_LABELS[it.clip.key] ?? it.clip.key}` : ''}`;
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
  row(
    '起始时间（拍）',
    createBeatInput(
      mixed(startBeatCommon) ? '' : fmtBeat(startBeatCommon),
      anySentinelStart ? '从开头起效（哨兵值）' : mixed(startBeatCommon) ? mixedLabel : '',
      (text) => {
      const beat = parseBeat(text);
      if (beat == null) {
        onStatus?.('时间格式应为 a+b/c（如 12+1/4）或小数');
        rerender();
        return;
      }
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
      },
    ),
    anySentinelStart ? '含「从开头起效」的哨兵事件：填入数值会把它改成从该拍开始' : '保持各自时长，只移动起点',
  );

  // ── 时长（拍） ──
  const beatsCommon = commonValue(items, (it) => it.clip.beats);
  row(
    '时长（拍）',
    number({
      value: mixed(beatsCommon) ? undefined : beatsCommon,
      placeholder: mixed(beatsCommon) ? mixedLabel : '',
      step: '0.25',
      min: 0,
      onChange: (v) => {
        if (!Number.isFinite(v) || v < 0) return;
        apply(`时长 → ${round4(v)} 拍`, (it) => {
          const ev = it.ev;
          ev.endBeat = ev.startBeat + v;
          if (ev.src) ev.src.endBeat = ev.endBeat;
          return true;
        });
      },
    }),
    '对所有选中项设为同一时长',
  );

  // ── 保持到结束 ──
  const holdsCommon = commonValue(items, (it) => it.clip.holds);
  row(
    '保持到结束',
    check({
      checked: holdsCommon,
      mixed: mixed(holdsCommon),
      hintText: mixed(holdsCommon) ? mixedLabel : holdsCommon ? '结束拍为哨兵值' : '普通区间事件',
      onChange: (on) =>
        apply(on ? '保持到结束 → 是' : '保持到结束 → 否', (it) => {
          const ev = it.ev;
          if (on) ev.endBeat = SENTINEL_BEAT;
          else if (ev.endBeat >= SENTINEL_BEAT) ev.endBeat = ev.startBeat + 1;
          if (ev.src) ev.src.endBeat = ev.endBeat;
          return true;
        }),
    }),
    '',
  );

  // ── 起始值 / 结束值 ──
  const v0Common = commonValue(items, (it) => it.clip.v0);
  row(
    '起始值',
    number({
      value: mixed(v0Common) ? undefined : v0Common,
      placeholder: mixed(v0Common) ? mixedLabel : '',
      onChange: (v) => {
        if (!Number.isFinite(v)) return;
        apply(`起始值 → ${v}`, (it) => {
          it.ev.start = v;
          if (it.ev.src) it.ev.src.start = v;
          return true;
        });
      },
    }),
    '',
  );
  const v1Common = commonValue(items, (it) => it.clip.v1);
  row(
    '结束值',
    number({
      value: mixed(v1Common) ? undefined : v1Common,
      placeholder: mixed(v1Common) ? mixedLabel : '',
      onChange: (v) => {
        if (!Number.isFinite(v)) return;
        apply(`结束值 → ${v}`, (it) => {
          it.ev.end = v;
          if (it.ev.src) it.ev.src.end = v;
          return true;
        });
      },
    }),
    '',
  );

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
    kind === 'preset'
      ? '二级：下面是具体缓动编号'
      : kind === 'bezier'
        ? '二级：下面填 4 个贝塞尔控制点'
        : kind === 'linear'
          ? '恒为线性'
          : '线性 / 预设缓动 / 贝塞尔',
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
      EASING_NAMES[numCommon] ?? '',
    );
  }
  if (isOfficial) {
    // 官方格式**没有**缓动字段（docs/04：官谱只有线性）：官谱的曲线是「相邻小线段」拼出来的，
    // 所以每个事件的缓动类型本来就是线性 —— 这里说清楚，免得以为「标签坏了」。
    // 只留一句：官方格式没有缓动字段（docs/04）
    hint('官方格式不含缓动字段（恒为线性）');
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
        i % 2 === 0 ? 'x 需在 0..1' : '',
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
      'easingLeft，0..1',
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
      'easingRight，0..1',
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
      'RPE 的事件关联组',
    );
  }

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
