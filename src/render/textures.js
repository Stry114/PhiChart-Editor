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

const TEXTURE_TRIM = {
  // 名称: { core: [x, y, w, h], content: [x, y, w, h], capPx }
  tap: { core: [1, 0, 987, 100], content: [0, 0, 989, 100] },
  tapHL: { core: [50, 43, 989, 113], content: [9, 4, 1071, 191] },
  drag: { core: [1, 0, 987, 60], content: [0, 0, 989, 60] },
  dragHL: { core: [50, 43, 989, 73], content: [9, 4, 1070, 151] },
  flick: { core: [1, 1, 987, 198], content: [0, 0, 989, 200] },
  flickHL: { core: [50, 50, 989, 200], content: [9, 10, 1071, 279] },
  // Hold 本体是等宽长条，两端各约 1–2% 收窄（卡口）；HL 版左右与下端各有约 40px 光效外扩
  hold: { core: [0, 0, 989, 2000], content: [0, 0, 989, 2000], capPx: 40 },
  holdHL: { core: [49, 49, 964, 1950], content: [9, 48, 1044, 1991], capPx: 39 },
};

/** 给贴图挂上本体/光效元数据（无实测数据时按整图处理） */
export function attachTextureMeta(img, key) {
  if (!img) return img;
  const t = TEXTURE_TRIM[key];
  const coreArr = t?.core ?? [0, 0, img.width, img.height];
  const contentArr = t?.content ?? coreArr;
  const rect = (a) => ({ x: a[0], y: a[1], w: a[2], h: a[3] });
  img.__meta = {
    core: rect(coreArr),
    content: rect(contentArr),
    capPx: t?.capPx ?? Math.max(1, Math.round(coreArr[3] * 0.02)),
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
 */
export async function loadTextures(baseUrl = 'assets/', overrides = {}) {
  const out = { hit: {} };
  const results = await Promise.allSettled(
    Object.entries(NOTE_FILES).map(async ([key, file]) => {
      const url = overrides[key] ?? baseUrl + file;
      out[key] = attachTextureMeta(await loadImage(url), key);
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
