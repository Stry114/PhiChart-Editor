/**
 * 布局：可拖拽分栏（上/下比例、左右宽度）。
 * 尺寸用 CSS 变量 + localStorage 记住；拖动时用 pointer 事件，松开后落盘。
 *
 * **默认比例**（只在没有存档 / 重置时用）：
 *  - 左上 : 右上 = 3 : 2（左上工作区 = 顶行宽度的 3/5）
 *  - 左下 : 右下 = 1 : 3（左下工作区 = 底行去掉两列工具栏后宽度的 1/4）
 *  - 上 : 下 = 1 : 1（顶行高度 = 50%）
 * 因为是**比例**，不同窗口宽度下都成立，所以要按当前宽度换算成像素再落盘。
 */

const STORE_KEY = 'phichart-editor.layout';
/** 存档版本：默认比例改过一次，旧版本存档直接忽略一次（否则用户永远看不到新默认） */
const STORE_VERSION = 2;

/** 两列工具栏的固定宽度之和（--tools-w × 2，底行减去它才是「右下」） */
const TOOLS_TOTAL = 92;

export const DEFAULT_RATIOS = {
  /** 左上工作区占顶行的比例 */
  topLeft: 3 / 5,
  /** 左下工作区占「底行去掉工具栏」的比例 */
  bottomLeft: 1 / 4,
  /** 顶行高度（%） */
  topH: 50,
};

export function createLayout(root = document) {
  const top = root.getElementById('ed-top');
  const bottom = root.getElementById('ed-bottom');
  const leftTop = root.getElementById('ed-left-top');
  const leftBottom = root.getElementById('ed-left-bottom');
  const body = root.body ?? root.documentElement;

  const rowWidth = () => Math.max(320, body?.clientWidth || globalThis.innerWidth || 1280);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  /** 宽度上限：右侧（预览 / 时间轴）至少留 240px，低于这个数就挤没了 */
  const maxWidth = () => Math.max(320, rowWidth() - 240);

  /** 按比例算出默认尺寸（像素） */
  function ratioDefaults() {
    const w = rowWidth();
    return {
      topH: DEFAULT_RATIOS.topH,
      topLeftW: Math.round(w * DEFAULT_RATIOS.topLeft),
      bottomLeftW: Math.round(Math.max(200, w - TOOLS_TOTAL) * DEFAULT_RATIOS.bottomLeft),
    };
  }

  let sizes = ratioDefaults();
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? 'null');
    if (saved && typeof saved === 'object' && saved.v === STORE_VERSION) sizes = { ...sizes, ...saved };
  } catch {
    /* 忽略损坏的存档 */
  }

  function apply() {
    sizes.topH = clamp(sizes.topH, 15, 80);
    sizes.topLeftW = clamp(sizes.topLeftW, 200, maxWidth());
    sizes.bottomLeftW = clamp(sizes.bottomLeftW, 200, maxWidth());
    if (top) top.style.height = `${sizes.topH}%`;
    if (leftTop) leftTop.style.width = `${sizes.topLeftW}px`;
    if (leftBottom) leftBottom.style.width = `${sizes.bottomLeftW}px`;
  }

  function save() {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify({ ...sizes, v: STORE_VERSION }));
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
      sizes = ratioDefaults(); // 重新按比例算（窗口宽度可能已经变了）
      apply();
      save();
    },
  };
}
