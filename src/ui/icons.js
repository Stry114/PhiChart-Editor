/**
 * 图标：使用 assets/icons/ 下的矢量图（黑色描边 SVG）。
 * 通过 CSS mask 上色 —— 图标颜色跟随 currentColor，因此悬停/选中/禁用都能自动变色，
 * 与暗色扁平主题一致；不需要为每种颜色各出一套图。
 */

export const ICON_BASE = 'assets/icons/';

const CACHE = new Map();

/** 图标名 → 文件 URL。名字自带 .svg / .png 后缀时按原样用（换图标时不用改代码） */
export function iconUrl(name) {
  return /\.(svg|png)$/i.test(name) ? `${ICON_BASE}${name}` : `${ICON_BASE}${name}.svg`;
}

/**
 * 创建一个图标元素。
 * @param {string} name assets/icons/<name>.svg
 * @param {{size?:number, cls?:string, title?:string}} [opts]
 */
export function icon(name, opts = {}) {
  const node = document.createElement('span');
  node.className = `ic ic-${name}${opts.cls ? ` ${opts.cls}` : ''}`;
  node.style.setProperty('--ic-url', `url("${iconUrl(name)}")`);
  const size = opts.size ?? 16;
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  if (opts.title) node.title = opts.title;
  node.setAttribute('aria-hidden', 'true');
  node.__iconName = name;
  CACHE.set(name, node);
  return node;
}

/** 把已有元素（通常是 <button>）的内容替换成图标（可带文字）；元素不存在时只告警不抛错 */
export function setIcon(button, name, opts = {}) {
  if (!button) {
    // 页面缺少该元素（典型原因：浏览器缓存了旧版 HTML）——这里绝不能抛错，
    // 否则整个编辑器模块会一起挂掉，界面只剩静态骨架。
    console.warn(`[icons] 找不到元素，跳过 setIcon(${name})：页面可能是旧版缓存`);
    return null;
  }
  button.innerHTML = '';
  button.appendChild(icon(name, opts));
  if (opts.text) {
    const span = document.createElement('span');
    span.textContent = opts.text;
    button.appendChild(span);
  }
  return button;
}

/**
 * 安全地绑定事件：元素不存在时只告警不抛错。
 * @returns {boolean} 是否绑定成功
 */
export function on(id, type, handler, target = globalThis.document) {
  const el = target?.getElementById?.(id);
  if (!el?.addEventListener) {
    console.warn(`[editor] 页面缺少元素 #${id}，跳过 ${type} 绑定（页面可能是旧版缓存，请强制刷新）`);
    return false;
  }
  el.addEventListener(type, handler);
  return true;
}

/** 事件类型 → 图标名（时间轴轨道头、结构树、详情面板共用） */
export const EVENT_ICONS = {
  x: 'movement_x',
  y: 'movement_y',
  rotate: 'loop',
  alpha: 'visible',
  speed: 'speed',
  notes: 'note',
};

export const ICONS = {
  play: 'play',
  pause: 'pause',
  back: 'fast_backward',
  forward: 'fast_forward',
  restart: 'return',
  rate: 'speed',
  volume: 'volume',
  zoomIn: 'zoom_in',
  zoomOut: 'zoom_out',
  fit: 'expand',
  snap: 'adsorption_x',
  add: 'add',
  remove: 'remove',
  del: 'delete',
  copy: 'copy',
  cut: 'cut', // assets/icons/cut.svg（剪刀；与剪刀工具同一张图）
  paste: 'paste',
  undo: 'undo',
  redo: 'redu', // 图形待确认，暂作「重做」
  menu: 'menu',
  config: 'configure',
  backPage: 'go_back',
  download: 'download',
  note: 'note',
  visible: 'visible',
  fold: 'fold', // 折叠 / 展开（按状态旋转）
  expandAll: 'expand_all',
  foldAll: 'fold_all',
};
