/**
 * Hold（长条）绘制几何：把「源贴图切片 → 目标矩形」的计算抽成纯函数，
 * 供 Canvas2D 后端、软件光栅化预览（tools/hold-preview.mjs / hold-variants.mjs）与测试共用。
 *
 * 三条规则（对应实际反馈的三个问题）：
 *  1. 尺寸与对齐都以**本体（core）**为准，而不是整张贴图 —— HL 贴图的左右/下端光效外扩不计入本体。
 *  2. 两端卡口高度 = `capPx`（源像素）× 与宽度**相同**的缩放系数，因此不随长条长度放大。
 *  3. 取样段可切换（`mode`）：纹理整根是「尾部发白+低不透明度 → 头部青色」的渐变，
 *     直接整根拉伸会让长条上半段发灰，因此默认 `tailCap`（短灰白尾帽 + 青色主体）。
 */

/** 取样方案：返回相对 core 高度的 [from, to] 三段比例 */
export function holdSampleSegments(meta, mode = 'tailCap') {
  const coreH = meta.core.h;
  const fallback = {
    tail: [0, meta.capPx / coreH],
    body: [meta.capPx / coreH, 1 - meta.capPx / coreH],
    head: [1 - meta.capPx / coreH, 1],
  };
  const table = meta.samples ?? null;
  if (!table) return fallback;
  return table[mode] ?? table.tailCap ?? table.gradient ?? fallback;
}

/** 可用的取样方案名（供 UI 循环切换） */
export function holdSampleModes(meta) {
  const names = Object.keys(meta.samples ?? {});
  return names.length ? names : ['gradient'];
}

/**
 * @param {object} p
 * @param {{core:object, content:object, capPx:number, samples?:object}} p.meta 贴图元数据（textures.js）
 * @param {number} p.headLocalY 头部（靠判定线一端）在判定线局部坐标里的 y
 * @param {number} p.tailLocalY 尾部（远端）在判定线局部坐标里的 y
 * @param {number} p.texW 贴图宽（源像素）
 * @param {number} p.texH 贴图高（源像素）
 * @param {number} p.scale 源像素 → 目标像素的缩放系数（= 目标本体宽 / core.w）
 * @param {'gradient'|'tailCap'|'uniform'} [p.mode] 取样方案
 * @returns {{sx:number,sy:number,sw:number,sh:number,dy:number,dh:number,kind:'body'|'glow'|'cap'}[]}
 */
export function computeHoldSlices({ meta, headLocalY, tailLocalY, texW, texH, scale, mode = 'tailCap' }) {
  const { core, content } = meta;
  const top = Math.min(headLocalY, tailLocalY); // 尾部（远端）
  const bottom = Math.max(headLocalY, tailLocalY); // 头部（靠线）
  const total = bottom - top;
  if (!(total > 0.5)) return [];

  const seg = holdSampleSegments(meta, mode);
  const px = (pct) => Math.max(0, Math.min(core.h, Math.round(core.h * pct)));
  const tailSh = Math.max(1, px(seg.tail[1]) - px(seg.tail[0]));
  const bodySh = Math.max(1, px(seg.body[1]) - px(seg.body[0]));
  const headSh = Math.max(1, px(seg.head[1]) - px(seg.head[0]));

  // 卡口按「源像素 × 与宽度相同的缩放」取固定高度（不随长条长度放大）；
  // 长条极短时按 total/3 上限等比缩小，剩余长度全部给主体。
  const capLimit = total / 3;
  const tailDest = Math.min(tailSh * scale, capLimit);
  const headDest = Math.min(headSh * scale, capLimit);
  const bodyDest = Math.max(0, total - tailDest - headDest);

  const slices = [];
  // 本体之外的光效（HL 贴图的左右/下端外扩）按固定尺寸补画在体量之外
  const padTop = Math.max(0, core.y - content.y);
  if (padTop > 0) {
    const dh = Math.min(padTop * scale, total / 2);
    slices.push({ sx: 0, sy: content.y, sw: texW, sh: padTop, dy: top - dh, dh, kind: 'glow' });
  }
  slices.push({ sx: 0, sy: core.y + px(seg.tail[0]), sw: texW, sh: tailSh, dy: top, dh: tailDest, kind: 'cap' });
  if (bodyDest > 0.5) {
    slices.push({ sx: 0, sy: core.y + px(seg.body[0]), sw: texW, sh: bodySh, dy: top + tailDest, dh: bodyDest, kind: 'body' });
  }
  slices.push({
    sx: 0,
    sy: core.y + px(seg.head[0]),
    sw: texW,
    sh: headSh,
    dy: bottom - headDest,
    dh: headDest,
    kind: 'cap',
  });
  const padBottom = Math.max(0, content.y + content.h - (core.y + core.h));
  if (padBottom > 0) {
    const dh = Math.min(padBottom * scale, total / 2);
    slices.push({ sx: 0, sy: core.y + core.h, sw: texW, sh: padBottom, dy: bottom, dh, kind: 'glow' });
  }
  void texH;
  return slices;
}

/**
 * 音符（非 Hold）的绘制矩形：整张贴图按本体缩放，本体中心对齐落点。
 * @returns {{dx:number,dy:number,dw:number,dh:number}} 相对落点的目标矩形
 */
export function computeNoteRect({ meta, texW, texH, scale }) {
  const { core } = meta;
  return {
    dx: -(core.x + core.w / 2) * scale,
    dy: -(core.y + core.h / 2) * scale,
    dw: texW * scale,
    dh: texH * scale,
  };
}
