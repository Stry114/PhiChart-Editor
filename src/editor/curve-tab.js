/**
 * 「事件曲线」标签页：把曲线编辑器从 Event 详情里独立出来。
 *
 * 显示当前选中事件的取值曲线：
 *   - 纵轴刻度固定为「该类事件的最小值 ~ 最大值」（取整条轨道的历史范围），所以拖动/切换事件时刻度不变
 *   - 线条颜色 = 该类事件的主题色
 *   - 两个手柄改起始值 / 结束值；缓动为贝塞尔时额外两个手柄 P1/P2（真实控制点）
 * 改动规则与其它面板一致：多选时应用到全部选中事件。
 */
import { EVENT_LABELS, createBeatAxis } from './tracks.js';
import { makeEasing } from '../core/easing.js';
import { el, round4, setLastAction, actionLine } from './detail-common.js';
import { createEventCurve, getActiveCurve } from './event-curve.js';
import { resolveSelectedEvents } from './event-detail.js';

export function renderCurveTab(root, ctx) {
  const { timeline, chart, onStatus } = ctx;
  // ctx 没给拍轴时自建（否则刷新事件会静默失败）
  const axis = ctx.axis ?? (chart ? createBeatAxis(chart) : null);
  getActiveCurve()?.destroy?.();
  root.innerHTML = '';
  const wrap = el('div', 'ed-scroll');
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
  const range = track?.range ?? null; // 该类事件的取值范围（整条轨道）：刻度固定用它

  const selectionSig = [...timeline.selection.events].sort().join(',');
  const head = el('div', 'ed-note-head');
  head.appendChild(el('span', 'count', `${EVENT_LABELS[first.clip.key] ?? first.clip.key}`));
  head.appendChild(
    el(
      'span',
      'dim',
      `选中 ${items.length} 个事件　刻度 ${range ? `${round4(range.min)} ~ ${round4(range.max)}` : '（无）'}　${first.track?.label ?? ''}`,
    ),
  );
  wrap.appendChild(head);
  const line = actionLine(selectionSig);
  if (line) wrap.appendChild(line);

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
    label: EVENT_LABELS[first.clip.key] ?? first.clip.key,
    color: track?.color, // 主题色
    range, // 固定刻度
    onLive: applyLive,
    onHint: (msg) => onStatus?.(msg),
    onCommit: () => {
      liveEditDone?.();
      liveEditDone = null;
      const text = `曲线：起 ${round4(first.ev.start)} → 止 ${round4(first.ev.end)}（已应用到 ${items.length} 个事件${Array.isArray(first.ev.bezierPoints) ? `，贝塞尔 ${first.ev.bezierPoints.map((v) => round4(v)).join(', ')}` : ''}）`;
      setLastAction(text, { sig: selectionSig });
      onStatus?.(text);
      // 延后一帧重建：避免在指针事件处理器里同步换掉 DOM
      const run = () => renderCurveTab(root, ctx);
      // 用 setTimeout 而不是 rAF：后台标签页里 rAF 会被暂停，面板就永远不刷新了
      setTimeout(run, 0);
    },
  });

  wrap.appendChild(el('div', 'ed-hint', '拖动圆点改取值；贝塞尔使用 P1 / P2 控制点。'));
}
