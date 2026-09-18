/**
 * Hold（长条）绘制几何：把「源贴图切片 → 目标矩形」的计算抽成纯函数，
 * 供 Canvas2D 后端、软件光栅化预览（tools/hold-preview.mjs）与测试共用。
 *
 * 关键规则（修复「头尾被拉长」「HL 光效被当成本体」两个问题）：
 *  1. 尺寸与对齐都以**本体（core）**为准，而不是整张贴图 —— HL 贴图的左右/下端光效外扩不计入本体。
 *  2. 两端卡口高度 = `capPx`（源像素）× 与宽度**相同**的缩放系数，因此不随长条长度放大。
 *  3. 光效（本体之外的外扩）单独按固定尺寸画在本体之外，不参与长条长度。
 */

/**
 * @param {object} p
 * @param {{core:{x,y,w,h}, content:{x,y,w,h}, capPx:number}} p.meta 贴图元数据（textures.js）
 * @param {number} p.headLocalY 头部（靠判定线一端）在判定线局部坐标里的 y
 * @param {number} p.tailLocalY 尾部（远端）在判定线局部坐标里的 y
 * @param {number} p.texW 贴图宽（源像素）
 * @param {number} p.texH 贴图高（源像素）
 * @param {number} p.scale 源像素 → 目标像素的缩放系数（= 目标本体宽 / core.w）
 * @returns {{sx:number,sy:number,sw:number,sh:number,dy:number,dh:number,kind:'body'|'glow'}[]}
 */
export function computeHoldSlices({ meta, headLocalY, tailLocalY, texW, texH, scale }) {
  const { core, content, capPx } = meta;
  const top = Math.min(headLocalY, tailLocalY); // 尾部（远端）
  const bottom = Math.max(headLocalY, tailLocalY); // 头部（靠线）
  const total = bottom - top;
  if (!(total > 0.5)) return [];

  const capSrc = Math.min(capPx, core.h / 2);
  const capDest = Math.min(capSrc * scale, total / 2);
  const slices = [];

  // 尾部光效（本体之外，固定尺寸）
  const padTop = Math.max(0, core.y - content.y);
  if (padTop > 0) {
    const dh = Math.min(padTop * scale, total / 2);
    slices.push({ sx: 0, sy: content.y, sw: texW, sh: padTop, dy: top - dh, dh, kind: 'glow' });
  }
  // 尾部卡口
  slices.push({ sx: 0, sy: core.y, sw: texW, sh: capSrc, dy: top, dh: capDest, kind: 'body' });
  // 中段（可拉伸）
  if (total > capDest * 2) {
    slices.push({
      sx: 0,
      sy: core.y + capSrc,
      sw: texW,
      sh: Math.max(1, core.h - capSrc * 2),
      dy: top + capDest,
      dh: total - capDest * 2,
      kind: 'body',
    });
  }
  // 头部卡口
  slices.push({
    sx: 0,
    sy: core.y + core.h - capSrc,
    sw: texW,
    sh: capSrc,
    dy: bottom - capDest,
    dh: capDest,
    kind: 'body',
  });
  // 头部光效（本体之外，固定尺寸）
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
