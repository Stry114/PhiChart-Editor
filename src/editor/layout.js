/**
 * 布局：可拖拽分栏（上/下比例、左右宽度）。
 * 尺寸用 CSS 变量 + localStorage 记住；拖动时用 pointer 事件，松开后落盘。
 */

const STORE_KEY = 'phichart-editor.layout';

const DEFAULTS = {
  topH: 42, // 上半高度（%）
  topLeftW: 380,
  bottomLeftW: 380,
};

export function createLayout(root = document) {
  const top = root.getElementById('ed-top');
  const bottom = root.getElementById('ed-bottom');
  const leftTop = root.getElementById('ed-left-top');
  const leftBottom = root.getElementById('ed-left-bottom');
  const body = root.body ?? root.documentElement;

  let sizes = { ...DEFAULTS };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') sizes = { ...sizes, ...saved };
  } catch {
    /* 忽略损坏的存档 */
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function apply() {
    sizes.topH = clamp(sizes.topH, 15, 80);
    sizes.topLeftW = clamp(sizes.topLeftW, 200, 900);
    sizes.bottomLeftW = clamp(sizes.bottomLeftW, 200, 900);
    if (top) top.style.height = `${sizes.topH}%`;
    if (leftTop) leftTop.style.width = `${sizes.topLeftW}px`;
    if (leftBottom) leftBottom.style.width = `${sizes.bottomLeftW}px`;
  }

  function save() {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(sizes));
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  /** 拖动逻辑：把指针位移换算成比例/像素，clamp 后实时应用 */
  function bindSplitter(el, onDrag) {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      try {
        el.setPointerCapture?.(e.pointerId); // 合成事件/失效指针会抛 InvalidPointerId
      } catch {
        /* 忽略 */
      }
      const startX = e.clientX;
      const startY = e.clientY;
      const snapshot = { ...sizes };
      const move = (ev) => {
        onDrag(snapshot, ev.clientX - startX, ev.clientY - startY);
        apply();
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // 分隔条：优先按 id 取，便于在没有完整选择器支持的环境（含测试桩件）里也能工作
  const pick = (id, fallbackSel) => root.getElementById?.(id) ?? root.querySelector?.(fallbackSel) ?? null;
  const splitTop = pick('ed-split-topleft', '.ed-split[data-split="topLeft"]');
  const splitBottom = pick('ed-split-bottomleft', '.ed-split[data-split="bottomLeft"]');
  const splitMain = pick('ed-split-main', '.ed-split[data-split="main"]');

  bindSplitter(splitTop, (snap, dx) => {
    sizes.topLeftW = snap.topLeftW + dx;
  });
  bindSplitter(splitBottom, (snap, dx) => {
    sizes.bottomLeftW = snap.bottomLeftW + dx;
  });
  bindSplitter(splitMain, (snap, _dx, dy) => {
    const total = body?.clientHeight || globalThis.innerHeight || 720;
    sizes.topH = snap.topH + (dy / Math.max(1, total)) * 100;
  });

  apply();
  return {
    get sizes() {
      return { ...sizes };
    },
    set(patch) {
      sizes = { ...sizes, ...patch };
      apply();
      save();
    },
    reset() {
      sizes = { ...DEFAULTS };
      apply();
      save();
    },
  };
}
