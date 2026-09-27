/**
 * 贴图加载与预处理（Canvas2D 后端）：
 *  - 音符贴图（普通 / HL 高亮两套，见 docs/…§3.2）
 *  - 判定线默认贴图（项目暂缺线贴图原图，默认用纯色矩形绘制）
 *  - 打击特效：hit.png 为 7×6 = 42 帧图集，按 Perfect/Good 两种颜色预着色
 *
 * 贴图元数据（`img.__meta`）：区分「本体（不透明核心）」与「光效外扩」。
 *  - `core`：本体矩形，绘制时以它决定尺寸与对齐 —— 否则 HL 贴图的光效会被当成体量，
 *    导致音符/长条比普通贴图大一圈、长条两端被撑长。
 *  - `content`：含光效的内容矩形（长条两端的光效就靠它补画在体量之外）。
 *  - `capPx`：长条本体两端的卡口高度（源像素，绘制时按同一缩放系数换算）。
 * 数值由 tools/measure-trim.mjs 实测得出；未列出的贴图回退为「整图即本体」。
 */
import { NOTE } from '../core/units.js';

export const TEXTURE_TRIM = {
  // 名称: { core: [x, y, w, h], content: [x, y, w, h], capPx?, segments? }
  tap: { core: [1, 0, 987, 100], content: [0, 0, 989, 100] },
  tapHL: { core: [50, 43, 989, 113], content: [9, 4, 1071, 191] },
  drag: { core: [1, 0, 987, 60], content: [0, 0, 989, 60] },
  dragHL: { core: [50, 43, 989, 73], content: [9, 4, 1070, 151] },
  flick: { core: [1, 1, 987, 198], content: [0, 0, 989, 200] },
  flickHL: { core: [50, 50, 989, 200], content: [9, 10, 1071, 279] },
  // ---- Hold 分段（**硬编码**，不做运行时识别，也不考虑换资源包）----
  // 结构： [48px 光效][48px 尾帽][主体][48px 头帽][48px 光效]
  //  - glowTop/glowBottom：本体之外的纵向光效高度（源像素），补画在体量之外
  //  - capTop/capBottom：头尾帽高度（源像素），按「源像素 × 与宽度相同的缩放」取固定高度
  //  - 主体不需要单独给区间：computeHoldSlices 直接取「core 去掉两端卡口」（capTop ~ core.h - capBottom）
  // 普通版贴图没有外扩光效，故 glow 为 0；HL 版（双押 / 多押）本体外一圈光效，
  // 上下各固定 48px、且在 core **之外**，按「非 HL 贴图 + 48px 光效」切片。
  hold: {
    core: [0, 0, 989, 2000],
    content: [0, 0, 989, 2000],
    segments: { glowTop: 0, capTop: 48, capBottom: 48, glowBottom: 0 },
  },
  holdHL: {
    core: [49, 49, 964, 1950],
    content: [9, 48, 1044, 1991],
    segments: { glowTop: 48, capTop: 48, capBottom: 48, glowBottom: 48 },
  },
};

/**
 * 给贴图挂上本体/光效元数据。
 *
 * 长条分段来自 `TEXTURE_TRIM[key].segments`（**硬编码**，见上表：48px 头尾帽 + 48px 光效）。
 * 这里不做任何运行时识别，也不考虑换资源包：按项目要求，长条一律按这套分段绘制。
 * @param {HTMLImageElement} img
 * @param {string} key 贴图键名（tap/hold/... 或 '__unknown__'）
 */
export function attachTextureMeta(img, key) {
  if (!img) return img;
  const t = TEXTURE_TRIM[key];
  const rect = (a) => ({ x: a[0], y: a[1], w: a[2], h: a[3] });
  const coreArr = t?.core ?? [0, 0, img.width, img.height];
  const contentArr = t?.content ?? coreArr;
  const core = rect(coreArr);
  img.__meta = {
    core,
    content: rect(contentArr),
    capPx: t?.capPx ?? Math.max(1, Math.round(coreArr[3] * 0.02)),
    // 分段已是源像素；body 段缺省由 core 高度推出
    segments: t?.segments ? { ...t.segments } : null,
  };
  return img;
}

/** 取贴图元数据（兼容未挂元数据的贴图，例如用户在包内提供的自定义材质） */
export function textureMeta(img) {
  if (img?.__meta) return img.__meta;
  return attachTextureMeta(img, '__unknown__').__meta;
}

const NOTE_FILES = {
  tap: 'Tap.png',
  tapHL: 'TapHL.png',
  drag: 'Drag.png',
  dragHL: 'DragHL.png',
  flick: 'Flick.png',
  flickHL: 'FlickHL.png',
  hold: 'Hold.png',
  holdHL: 'HoldHL.png',
  hit: 'hit.png',
};

/**
 * 打击特效图集的两色着色（与 `src/render/canvas2d.js` 的 `HIT_FX_COLOR` 一致）：
 * Perfect 金色 / Good 蓝色。放在这里是为了让 `loadTextures()` 是唯一的着色处，
 * 绘制时直接用预着色好的 canvas。
 */
export const HIT_TINT = {
  perfect: 'rgba(255,236,160,0.882)',
  good: 'rgba(180,225,255,0.922)',
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`贴图加载失败：${url}`));
    img.src = url;
  });
}

/**
 * 「预热」一张图：**立刻开始下载**，`onload` 一到就把可用的 `HTMLImageElement` 交出去，
 * 失败返回 null（调用方回退到正常加载路径，不会因此拿不到贴图）。
 *
 * ⚠️ 这里**刻意不 `await img.decode()`**：实测 `HTMLImageElement.decode()` 在无头 Chromium
 * 里可以长时间不 settle（同一张图 `onload` 只要 3 ms，`decode()` 等了 30 s 都没返回），
 * 而它换来的只是「把解码再提前一点」。用它挡住启动流程，就会变成「页面永远卡在加载中」。
 * 提前解码的收益因此改为靠「**图早就在内存里**」拿到：解码发生在启动阶段而不是首次绘制那一帧，
 * 而 `preloadNoteTextures()` 会把 `loadTextures()` 的整条链路（含着色）一起在启动时跑完。
 */
function warmImage(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (img) => {
      if (done) return;
      done = true;
      resolve(img ?? null);
    };
    const img = new Image();
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** 用指定颜色给（白色）图集着色：source-in 合成，一次性完成 */
function tintImage(img, color) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * 加载全部贴图（音符 6 种 × 普通 / HL，加打击特效图集）。
 *
 * @param {string} baseUrl 贴图目录（默认 assets/）
 * @param {Record<string,string>} [overrides] 额外贴图（如 RPE 包的判定线材质）
 * @param {Record<string, HTMLImageElement>} [preloaded] 已下载/解码好的图（来自 `preloadNoteTextures`），
 *   命中就不再发请求 —— 每张图只取一次。
 */
export async function loadTextures(baseUrl = 'assets/', overrides = {}, preloaded = null) {
  const out = {};
  const results = await Promise.allSettled(
    Object.entries(NOTE_FILES).map(async ([key, file]) => {
      const url = overrides[key] ?? baseUrl + file;
      const cached = preloaded?.[key];
      out[key] = attachTextureMeta(cached ?? (await loadImage(url)), key);
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.warn('部分贴图加载失败：', failed.map((f) => f.reason?.message));

  // 着色后的派生贴图（打击特效两色 + Bad 判定的 Tap）：
  // 一次性算完缓存起来，避免「第一次判定时才做一次全图 source-in」造成的掉帧。
  if (out.hit) {
    out.hitPerfect = tintImage(out.hit, HIT_TINT.perfect);
    out.hitGood = tintImage(out.hit, HIT_TINT.good);
  }
  // Bad 判定的音符：Tap 贴图整体着色（docs/Phigros文档.md 的参考实现关键渲染常数，sim-phi 口径）
  if (out.tap) out.tapBad = tintImage(out.tap, NOTE.BAD_COLOR);
  return out;
}

/**
 * **贴图预热**：页面一启动就把音符与打击特效贴图取好、并完成全部派生着色，
 * 不等第一次显示才加载。
 *
 * 为什么需要它：过去播放器/预览是在启动时 `await loadTextures()`，但那只保证「请求发出去了」；
 * 真正在首次显示时才发生的还有两件事：
 *  1. `drawImage` 触发的**懒解码** —— 第一根音符落线、首次命中那一帧要现场解码
 *     Hold(989×2000) 与 hit 图集(2520×2160)；
 *  2. 命中特效的**两色着色**与 Bad 判定 Tap 的着色（各是一次全图 `source-in`，hit 图集尤其大）。
 * 这个函数把这两件事都提到启动阶段：下载 → 复用同一批图片对象 → 一次性算完着色，
 * 于是首次显示时贴图已经在内存里、派生图也备好了。
 *
 * **每张图只取一次**：`warmImage()` 拿到的图片对象直接交给 `loadTextures()` 复用，不重复请求。
 *
 * @param {string} baseUrl 贴图目录（默认 assets/）
 * @param {Record<string,string>} [overrides] 额外贴图（如 RPE 包的判定线材质）
 * @returns {Promise<object>} 与 `loadTextures` 相同的贴图表
 */
export async function preloadNoteTextures(baseUrl = 'assets/', overrides = {}) {
  const entries = Object.entries(NOTE_FILES);
  const loaded = await Promise.all(
    entries.map(async ([key, file]) => [key, await warmImage(overrides[key] ?? baseUrl + file)]),
  );
  const preloaded = {};
  for (const [key, img] of loaded) if (img) preloaded[key] = img;
  return loadTextures(baseUrl, overrides, preloaded);
}

/**
 * 检测 Canvas2D 的 `ctx.filter` 是否真的生效。
 *
 * **iOS Safari（WebKit）至今没有实现 `CanvasRenderingContext2D.filter`**：
 * 赋值被直接忽略、读回来还是 `'none'`。以前背景的「高斯模糊 + 压暗」都写在这一个
 * filter 串里（`blur(…) brightness(…)`），于是在 iPhone/iPad 上两个效果一起消失。
 * 标准检测方式就是「写进去再读回来」。
 */
export function supportsCanvasFilter(ctx) {
  try {
    if (!ctx) return false;
    ctx.filter = 'blur(1px)';
    const ok = ctx.filter === 'blur(1px)';
    ctx.filter = 'none';
    return ok;
  } catch {
    return false;
  }
}

/**
 * 没有 `ctx.filter` 时的近似高斯模糊：把图**缩小 → 再缩小 → 双线性放大**。
 * 缩放插值本身就是一种低通滤波，多级缩小能让结果接近真正的模糊（代价是细节损失）。
 */
function drawApproxBlur(g, img, dx, dy, dw, dh, radius) {
  const W = Math.max(1, g.canvas.width);
  const H = Math.max(1, g.canvas.height);
  // 模糊半径越大，缩得越小；半径 ~120px 时缩 ~1/30，视觉上已是一片柔和的底图
  const shrink = Math.max(2, Math.min(64, Math.round(radius / 4) || 2));
  const mid = document.createElement('canvas');
  mid.width = Math.max(1, Math.round(W / shrink));
  mid.height = Math.max(1, Math.round(H / shrink));
  const mc = mid.getContext('2d');
  mc.imageSmoothingEnabled = true;
  mc.drawImage(img, dx / shrink, dy / shrink, dw / shrink, dh / shrink);

  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(mid.width / 2));
  small.height = Math.max(1, Math.round(mid.height / 2));
  const sc = small.getContext('2d');
  sc.imageSmoothingEnabled = true;
  sc.drawImage(mid, 0, 0, mid.width, mid.height, 0, 0, small.width, small.height);

  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, small.width, small.height, 0, 0, W, H);
}

/**
 * 背景预处理：cover 铺满 + 高斯模糊 + 压暗（docs/Phigros文档.md 的参考实现关键渲染常数），结果缓存。
 *
 * 与旧版的区别（**为 iOS 修的两个问题**）：
 *  1. 模糊只在 `ctx.filter` 可用时用 filter；不可用（iOS Safari）时走「缩小再放大」的近似模糊，
 *     因此 iPhone/iPad 上也有模糊效果；
 *  2. **压暗不再依赖 filter**：改为在所有平台都叠加一层黑色半透明（= sim-phi 的 `backgroundDim` 口径），
 *     所以即使模糊最终不可用，画面也一定会被压暗。
 *
 * @param {HTMLImageElement|{width:number,height:number}} img
 * @param {number} width 目标宽（CSS 像素）
 * @param {number} height 目标高
 * @param {{blur?:number, brightness?:number}} [opts] brightness = 保留的亮度（0.4 = 压暗到四成）
 */
export function makeBackground(img, width, height, { blur = 120, brightness = 0.4 } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d');
  const scale = Math.max(c.width / img.width, c.height / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = (c.width - dw) / 2;
  const dy = (c.height - dh) / 2;
  const radius = Math.max(0, Number(blur) || 0);
  // 边界外多画一圈：blur 会采样到透明边缘，不补边会出现暗边
  const pad = radius;

  if (radius > 0 && supportsCanvasFilter(ctx)) {
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(img, dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
    ctx.filter = 'none';
  } else if (radius > 0) {
    drawApproxBlur(ctx, img, dx, dy, dw, dh, radius);
  } else {
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // 压暗：不依赖 filter，任何平台都生效
  const dim = Math.min(1, Math.max(0, 1 - (Number(brightness) || 0)));
  if (dim > 0) {
    ctx.globalAlpha = dim;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalAlpha = 1;
  }
  return c;
}
