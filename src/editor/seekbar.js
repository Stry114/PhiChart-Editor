/**
 * 全局进度条（预览工作区，Pr 风格）：跨**全曲**跳转，与时间轴指针同步。
 *
 * 与时间轴刻度尺的区别：刻度尺只在当前缩放/滚动的视野内定位，进度条始终映射
 * 全曲时长（0 → max(音频时长, 谱面长度)），拖到哪就跳到哪；跳转后由调用方把
 * 时间轴滚动到指针附近。
 *
 * 纯 DOM 组件：时长由调用方注入（getDuration），跳转通过 onSeek(frac × 时长)
 * 回给调用方（那里再联动 preview / timeline），本组件只管交互与绘制。
 */
export function createSeekbar({ onSeek = null, getDuration = null } = {}) {
  const el = document.createElement('div');
  el.className = 'ed-seekbar';
  el.title = '全曲进度';
  const track = document.createElement('div');
  track.className = 'ed-seekbar-track';
  const fill = document.createElement('div');
  fill.className = 'ed-seekbar-fill';
  const knob = document.createElement('div');
  knob.className = 'ed-seekbar-knob';
  el.append(track, fill, knob);

  let dragging = false;

  const ratioFromEvent = (e) => {
    const rect = el.getBoundingClientRect?.() ?? { left: 0, width: 0 };
    const w = rect.width || el.clientWidth || 1;
    return Math.min(1, Math.max(0, ((e?.clientX ?? 0) - (rect.left ?? 0)) / w));
  };
  const paint = (frac) => {
    const pct = `${(Math.min(1, Math.max(0, frac)) * 100).toFixed(3)}%`;
    fill.style.width = pct;
    knob.style.left = pct;
  };
  const emit = (frac) => {
    const duration = Math.max(0, getDuration?.() ?? 0);
    if (duration > 0) onSeek?.(frac * duration);
  };

  const down = (e) => {
    if (Math.max(0, getDuration?.() ?? 0) <= 0) return; // 没有内容（时长 0）：不可交互
    dragging = true;
    try {
      el.setPointerCapture?.(e.pointerId); // 拖出条外也继续跟随
    } catch {
      /* 合成事件/失效指针会抛 InvalidPointerId，忽略 */
    }
    const frac = ratioFromEvent(e);
    paint(frac);
    emit(frac);
    e?.preventDefault?.();
  };
  const move = (e) => {
    if (!dragging) return;
    const frac = ratioFromEvent(e);
    paint(frac); // 拖动中先给视觉反馈，emit 里时长 ≤ 0 时不会真的跳
    emit(frac);
  };
  const up = () => {
    dragging = false;
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  return {
    el,
    get dragging() {
      return dragging;
    },
    /**
     * 与时间轴指针同步（预览的每帧时间回调里调用）。
     * 拖动中跳过：用户正在控制，别把滑块拽回去。
     */
    sync(t) {
      if (dragging) return;
      const duration = Math.max(0, getDuration?.() ?? 0);
      if (duration <= 0) {
        el.classList.add('disabled');
        paint(0);
        return;
      }
      el.classList.remove('disabled');
      paint(Math.min(1, Math.max(0, t / duration)));
    },
  };
}
