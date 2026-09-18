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

export const TEXTURE_TRIM = {
  // 名称: { core: [x, y, w, h], content: [x, y, w, h], capPx?, segments? }
  tap: { core: [1, 0, 987, 100], content: [0, 0, 989, 100] },
  tapHL: { core: [50, 43, 989, 113], content: [9, 4, 1071, 191] },
  drag: { core: [1, 0, 987, 60], content: [0, 0, 989, 60] },
  dragHL: { core: [50, 43, 989, 73], content: [9, 4, 1070, 151] },
  flick: { core: [1, 1, 987, 198], content: [0, 0, 989, 200] },
  flickHL: { core: [50, 50, 989, 200], content: [9, 10, 1071, 279] },
  // 仓库自带 Hold 贴图：两端各约 40px 收窄（卡口），整根是「尾部 白+alpha101 → 头部 青+alpha241」
  // 的平滑渐变（无硬分界，见 tools/measure-hold-structure.mjs）。因此不给 segments，
  // 由预设取样处理（默认 tailCap）。**换用其它资源包时，建议依赖自动识别或显式指定 holdAtlas。**
  hold: { core: [0, 0, 989, 2000], content: [0, 0, 989, 2000], capPx: 40 },
  holdHL: { core: [49, 49, 964, 1950], content: [9, 48, 1044, 1991], capPx: 39 },
};

/**
 * 纯函数版：从 RGBA 像素数据里识别长条的 [光效|帽|主体|帽|光效] 分段。
 * 与 detectHoldStructure 共用同一套逻辑，便于用 tools/detect-hold.mjs 离线核对。
 * @param {{width:number, height:number, data:ArrayLike<number>}} px
 * @param {{minAlphaJump?:number, minWidthJump?:number, maxCapRatio?:number, minBodyRatio?:number}} [options]
 */
export function detectHoldStructureFromPixels(px, options = {}) {
  const w = px?.width ?? 0;
  const h = px?.height ?? 0;
  const data = px?.data;
  if (!w || !h || !data || data.length < w * h * 4) return null;
  const stride = Math.max(1, Math.floor(w / 256));
  const width = new Array(h);
  const alpha = new Array(h);
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  let samplesPerRow = 0;
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    let sum = 0;
    const base = y * w * 4;
    for (let x = 0; x < w; x += stride) {
      const a = data[base + x * 4 + 3];
      sum += a;
      cnt += a >= 8 ? 1 : 0;
      if (a >= 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    samplesPerRow = Math.ceil(w / stride);
    width[y] = (cnt / samplesPerRow) * w;
    alpha[y] = sum / samplesPerRow;
  }
  const content = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const maxWidth = Math.max(1, ...width);
  const minAlphaJump = options.minAlphaJump ?? 12;
  const minWidthJump = options.minWidthJump ?? 0.03;
  const steps = [];
  for (let y = 1; y < h; y++) {
    const dA = Math.abs(alpha[y] - alpha[y - 1]);
    const dW = Math.abs(width[y] - width[y - 1]) / maxWidth;
    if (dA >= minAlphaJump || dW >= minWidthJump) steps.push(y);
  }
  // 合并相邻台阶（边界通常有 1–3 行过渡）
  const merged = [];
  for (const y of steps) {
    if (merged.length && y - merged[merged.length - 1] <= 3) merged[merged.length - 1] = y;
    else merged.push(y);
  }
  if (merged.length < 2) return null;
  const first = merged[0];
  const last = merged[merged.length - 1];
  const mid = merged.filter((y) => y > first && y < last);
  if (mid.length < 2) return null;
  const [capTopEnd, capBottomStart] = [mid[0], mid[mid.length - 1]];
  const segments = {
    glowTop: first,
    capTop: Math.max(1, capTopEnd - first),
    bodyTop: capTopEnd,
    bodyBottom: capBottomStart,
    capBottom: Math.max(1, last - capBottomStart),
    glowBottom: Math.max(0, h - last),
  };
  // 合理性校验：帽/光效不可能占掉大半张贴图。平滑渐变贴图会因噪声产生大量伪台阶，
  // 若不加校验就会把「帽」算成几百像素，导致长条只剩一小截主体（实际出现过的 bug）。
  const maxCapRatio = options.maxCapRatio ?? 0.25;
  const minBodyRatio = options.minBodyRatio ?? 0.4;
  const capOk = segments.capTop <= h * maxCapRatio && segments.capBottom <= h * maxCapRatio;
  const glowOk = segments.glowTop <= h * maxCapRatio && segments.glowBottom <= h * maxCapRatio;
  const bodyOk = segments.bodyBottom - segments.bodyTop >= h * minBodyRatio;
  if (!capOk || !glowOk || !bodyOk) {
    return { segments: null, steps: merged, content, profile: { width, alpha }, rejected: true };
  }
  return { segments, steps: merged, content, profile: { width, alpha }, rejected: false };
}

/**
 * 自动识别长条的「光效 / 帽 / 主体」分段（源像素）。
 * 适用于结构化的资源包，例如 [48 光效][48 帽][主体][48 帽][48 光效]。
 * 平滑渐变贴图（本仓库自带的那套）识别不出合法分段，返回 null，由调用方回退到预设取样。
 * @returns {{segments:object, steps:number[], profile:object}|null}
 */
export function detectHoldStructure(img, options = {}) {
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h || typeof document === 'undefined') return null;
  let data;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h); // 跨域贴图会抛错 → 上层回退
    data = imgData?.data;
  } catch {
    return null;
  }
  const result = detectHoldStructureFromPixels({ width: w, height: h, data }, options);
  if (!result || result.rejected) {
    if (result?.rejected) {
      console.info(`长条贴图自动识别被否决（帽/光效占比过大）：台阶 y=${result.steps.slice(0, 6).join(',')}… → 回退预设取样`);
    }
    return null;
  }
  return result;
}

/**
 * 给贴图挂上本体/光效元数据。
 * 分段（segments）优先级：显式 holdAtlas 参数 > 自动识别 > 声明值/预设取样。
 * @param {HTMLImageElement} img
 * @param {string} key 贴图键名（tap/hold/... 或 '__unknown__'）
 * @param {{holdAtlas?: {cap?:number, glow?:number, capTop?:number, capBottom?:number}, auto?: boolean}} [options]
 *   holdAtlas：显式指定长条帽/光效高度（源像素），用于自动识别不可用或不准确的资源包；
 *   auto：是否尝试自动识别（默认开启）。
 */
export function attachTextureMeta(img, key, options = {}) {
  if (!img) return img;
  const t = TEXTURE_TRIM[key];
  const rect = (a) => ({ x: a[0], y: a[1], w: a[2], h: a[3] });
  // 声明值只在**尺寸吻合**时采用：换了资源包（贴图尺寸不同）时自动回退为「整图即本体」，
  // 否则会拿旧贴图的 rect 去切新贴图，导致帽取到主体的行、主体取到帽的行。
  const fits = (a) => !!a && a[0] >= 0 && a[1] >= 0 && a[0] + a[2] <= img.width && a[1] + a[3] <= img.height;
  const declaredCore = t?.core && fits(t.core) ? t.core : null;
  const declaredContent = t?.content && fits(t.content) ? t.content : null;
  if (t?.core && !declaredCore) {
    console.warn(`贴图 ${key} 尺寸（${img.width}x${img.height}）与内置元数据不符，已按整图处理（换用资源包时属正常）`);
  }
  const coreArr = declaredCore ?? [0, 0, img.width, img.height];
  const contentArr = declaredContent ?? coreArr;
  const meta = {
    core: rect(coreArr),
    content: rect(contentArr),
    capPx: t?.capPx ?? Math.max(1, Math.round(coreArr[3] * 0.02)),
    segments: declaredCore ? (t?.segments ?? null) : null,
    detected: null,
  };

  const isHold = /hold/i.test(key);
  if (isHold) {
    // 1) 显式指定（优先级最高）
    const atlas = options.holdAtlas;
    if (atlas) {
      const capTop = Number(atlas.capTop ?? atlas.cap);
      const capBottom = Number(atlas.capBottom ?? atlas.cap);
      const glow = Number(atlas.glow ?? 0);
      if (Number.isFinite(capTop) && Number.isFinite(capBottom)) {
        meta.segments = {
          glowTop: Number.isFinite(glow) ? glow : 0,
          capTop: Math.max(1, capTop),
          bodyTop: Math.max(1, capTop),
          bodyBottom: meta.core.h - Math.max(1, capBottom),
          capBottom: Math.max(1, capBottom),
          glowBottom: Number.isFinite(glow) ? glow : 0,
        };
      }
    }
    // 2) 自动识别（识别到台阶就采用；平滑渐变贴图会返回 null）
    if (!meta.segments && options.auto !== false) {
      const detected = detectHoldStructure(img);
      if (detected) {
        meta.detected = { steps: detected.steps };
        meta.segments = detected.segments;
        // 声明值与贴图尺寸不符时（换了资源包），用识别出的内容框当本体
        if (!declaredCore && detected.content) {
          meta.core = { ...detected.content };
          meta.content = { ...detected.content };
          console.info(`贴图 ${key}：按自动识别的内容框 ${JSON.stringify(detected.content)} 作为本体，识别到的台阶 ${detected.steps.length} 处`);
        }
      }
    }
  }
  img.__meta = meta;
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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`贴图加载失败：${url}`));
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
 * @param {string} baseUrl 贴图目录（默认 assets/）
 * @param {Record<string,string>} [overrides] 额外贴图（如 RPE 包的判定线材质）
 * @param {{holdAtlas?: object, auto?: boolean}} [options] 长条分段选项（透传给 attachTextureMeta）
 */
export async function loadTextures(baseUrl = 'assets/', overrides = {}, options = {}) {
  const out = { hit: {} };
  const results = await Promise.allSettled(
    Object.entries(NOTE_FILES).map(async ([key, file]) => {
      const url = overrides[key] ?? baseUrl + file;
      out[key] = attachTextureMeta(await loadImage(url), key, options);
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.warn('部分贴图加载失败：', failed.map((f) => f.reason?.message));

  if (out.hit) {
    out.hitPerfect = tintImage(out.hit, 'rgba(255,236,160,0.882)');
    out.hitGood = tintImage(out.hit, 'rgba(180,225,255,0.922)');
  }
  return out;
}

/** 背景预处理：cover 铺满 + 高斯模糊 + 压暗（docs/…§6），结果缓存 */
export function makeBackground(img, width, height, { blur = 120, brightness = 0.4 } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d');
  const scale = Math.max(c.width / img.width, c.height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.filter = `blur(${blur}px) brightness(${brightness})`;
  // 模糊会让边缘透明，先放大一点再画
  const pad = blur * 2;
  ctx.drawImage(img, (c.width - w) / 2 - pad, (c.height - h) / 2 - pad, w + pad * 2, h + pad * 2);
  ctx.filter = 'none';
  return c;
}
