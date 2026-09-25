/**
 * 「事件曲线」标签页：把曲线编辑器从 Event 详情里独立出来。
 *
 * 显示当前选中事件的取值曲线：
 *   - 纵轴刻度固定为「该类事件的最小值 ~ 最大值」（取整条轨道的历史范围），所以拖动/切换事件时刻度不变
 *   - 线条颜色 = 该类事件的主题色
 *   - 两个手柄改起始值 / 结束值；缓动为贝塞尔时额外两个手柄 P1/P2（真实控制点）
 * 改动规则与其它面板一致：多选时应用到全部选中事件。
 */
import { EVENT_LABELS, CAMERA_LABELS, createBeatAxis } from './tracks.js';
import { makeEasing } from '../core/easing.js';
import { el, round4, setLastAction } from './detail-common.js';
import { createEventCurve, getActiveCurve } from './event-curve.js';
import { resolveSelectedEvents } from './event-detail.js';
import { displayUnitFor, referenceRangeFor, curveRangeFor } from './display-units.js';

export function renderCurveTab(root, ctx) {
  const { timeline, chart, onStatus } = ctx;
  // ctx 没给拍轴时自建（否则刷新事件会静默失败）
  const axis = ctx.axis ?? (chart ? createBeatAxis(chart) : null);
  getActiveCurve()?.destroy?.();
  root.innerHTML = '';
  const wrap = el('div', 'ed-scroll ed-curve-page');
  root.appendChild(wrap);

  const items = resolveSelectedEvents(timeline);
  if (!items.length) {
    wrap.appendChild(
      el('div', 'ed-hint', '选中单个事件块后显示取值曲线。'),
    );
    return;
  }

  const first = items[0];
  const track = first.track;
  const unit = displayUnitFor(first.clip); // 显示单位（z / theta / rotate / 相机按谱面单位显示）
  const toDisplay = (v) => (unit && Number.isFinite(v) ? unit.to(v) : v);
  /**
   * 相邻事件的取值：前一个的**末值**、后一个的**起值**（曲线在这里要接上）。
   * 纵轴范围要包含它们，拖动时也会向它们吸附（见 createEventCurve 的 neighbors）。
   */
  const clips = Array.isArray(track?.clips) ? track.clips : [];
  const at = clips.indexOf(first.clip);
  const neighbors = [];
  const prevClip = at > 0 ? clips[at - 1] : null;
  const nextClip = at >= 0 && at + 1 < clips.length ? clips[at + 1] : null;
  if (prevClip && Number.isFinite(prevClip.v1)) neighbors.push({ id: "prev", label: "前一个末值", value: prevClip.v1 });
  if (nextClip && Number.isFinite(nextClip.v0)) neighbors.push({ id: "next", label: "后一个起值", value: nextClip.v0 });
  // 固定刻度 = 参考范围（显示单位）∪ 轨道实际范围 ∪ 本次与相邻事件的取值（内部单位）
  const range = curveRangeFor({
    reference: referenceRangeFor(first.clip),
    unit,
    trackRange: track?.range ?? null,
    extra: [first.ev?.start, first.ev?.end, ...neighbors.map((n) => n.value)],
  });
  /** 事件名：相机的键名与普通事件同名（x / y / z），按轨道类型分开取 */
  const labelOf = (clip) => (clip?.camera ? CAMERA_LABELS[clip.key] : EVENT_LABELS[clip.key]) ?? clip?.key ?? '';

  // 颜色事件的取值是 [r,g,b]：没有单一标量，曲线无从画起（趋势线才会取最大通道）。
  if (Array.isArray(first.ev?.start) || Array.isArray(first.ev?.end)) {
    const head = el('div', 'ed-note-head');
    head.appendChild(el('span', 'count', `${labelOf(first.clip)}`));
    head.appendChild(el('span', 'dim', `选中 ${items.length} 个事件　${track?.label ?? ''}`));
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'ed-hint', '颜色事件按 R/G/B 编辑，请在「Event 详情」页改起止颜色。'));
    return;
  }

  const selectionSig = [...timeline.selection.events].sort().join(',');
  // 曲线页只画曲线本身：标题 / 选中摘要 / 图例 / 操作提示都不显示（详见 docs/谱师文档.md §3.8），
  // 于是曲线可以铺满整块面板；数值反馈走状态栏（onStatus）。

  const box = el('div', 'ed-curve-box wide');
  wrap.appendChild(box);
  const curve = createEventCurve();
  box.appendChild(curve.el);

  /** 一次「拖手柄」算一步撤销：第一次实时改动时开记录，松手（onCommit）时提交 */
  let liveEditDone = null;
  const beginLiveEdit = () => {
    if (liveEditDone !== null) return;
    liveEditDone =
      timeline.recordEdit?.(
        '改曲线取值',
        items.map((it) => it.ev).filter(Boolean),
        {
          lineIds: [...new Set(items.map((it) => it.track?.lineId).filter((v) => Number.isFinite(v)))],
          keys: [...new Set(items.map((it) => it.clip?.key).filter(Boolean))],
        },
      ) ?? null;
  };

  /** 与 Event 详情同一套“实时应用”逻辑：写全部选中项 + 刷时间轴（不重建面板，避免拖动中断） */
  const applyLive = (kind, value, bezier) => {
    beginLiveEdit();
    for (const it of items) {
      if (!it.ev) continue;
      if (kind === 'start') it.ev.start = value;
      else if (kind === 'end') it.ev.end = value;
      else if (kind === 'bezier') {
        it.ev.bezierPoints = Array.isArray(bezier) ? [...bezier] : it.ev.bezierPoints;
        it.ev.easingType = 6;
      }
      if (it.clip.key !== 'speed') {
        const t = Number.isFinite(it.ev.easingType) ? it.ev.easingType : 1;
        const fn = makeEasing(t, it.ev.bezierPoints ?? null, it.ev.easingLeft ?? 0, it.ev.easingRight ?? 1);
        it.ev.easingFn = fn;
        it.ev.easingPreset = fn.easingPreset;
        it.ev.bezierPoints = fn.bezierPoints;
      }
      ctx.refreshClip?.(it.track, it.index, axis);
    }
    // 曲线拖手柄是连续动作：交给时间轴按 120ms 节流重编译派生数据（预览跟着改，又不会每帧重编译大列表）
    const byLine = new Map();
    for (const it of items) {
      const lineId = it.track?.lineId;
      if (!Number.isFinite(lineId)) continue;
      let keys = byLine.get(lineId);
      if (!keys) byLine.set(lineId, (keys = new Set()));
      if (it.clip?.key) keys.add(it.clip.key);
    }
    for (const [lineId, keys] of byLine) timeline.refreshModel?.(lineId, { keys: [...keys] });
    timeline.redraw();
  };

  curve.setData({
    ev: first.ev,
    clip: first.clip,
    label: labelOf(first.clip),
    color: track?.color, // 主题色
    range, // 固定刻度（内部单位）
    neighbors, // 相邻事件的取值（标记 + 吸附）
    toDisplay, // 纵轴 / 图例按谱面单位显示
    onLive: applyLive,
    onHint: (msg) => onStatus?.(msg),
    onCommit: () => {
      liveEditDone?.();
      liveEditDone = null;
      const text = `曲线：起 ${round4(toDisplay(first.ev.start))} → 止 ${round4(toDisplay(first.ev.end))}（已应用到 ${items.length} 个事件${Array.isArray(first.ev.bezierPoints) ? `，贝塞尔 ${first.ev.bezierPoints.map((v) => round4(v)).join(', ')}` : ''}）`;
      setLastAction(text, { sig: selectionSig });
      onStatus?.(text);
      // 延后一帧重建：避免在指针事件处理器里同步换掉 DOM
      const run = () => renderCurveTab(root, ctx);
      // 用 setTimeout 而不是 rAF：后台标签页里 rAF 会被暂停，面板就永远不刷新了
      setTimeout(run, 0);
    },
  });

}
