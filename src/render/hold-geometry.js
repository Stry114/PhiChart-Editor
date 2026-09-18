/**
 * Hold（长条）绘制几何：把「源贴图切片 → 目标矩形」的计算抽成纯函数，
 * 供 Canvas2D 后端、软件光栅化预览与测试共用。
 *
 * 关键规则（对应实际反馈的问题）：
 *  1. 长条的分段是**源像素**（不是百分比）：典型资源包结构为
 *     [尾部光效][尾部帽][主体][头部帽][头部光效]（例如 48px / 48px / 主体 / 48px / 48px）。
 *     分段可由加载时的自动识别得出（textures.js 的 detectHoldStructure），也可显式指定
 *     （renderer.opts.holdAtlas，或 URL 参数 holdCap / holdGlow）。
 *  2. 帽与光效按「源像素 × 与宽度相同的缩放系数」取**固定高度**，因此不随长条长度放大。
 *  3. 剩余长度全部给主体；长条极短时按 total/3 上限等比缩小。
 *  4. 尺寸与对齐以**本体（core）**为准，不是整张贴图 —— HL 贴图左右/下端的光效外扩不计入。
 */

/**
 * 由元数据得到源像素分段。
 * 分段来自 `meta.segments`（贴图表里**硬编码**，见 textures.js：48px 头尾帽 + 48px 光效）。
 * 只有「未登记的表外贴图」才回退到按 `capPx` 推出的近似分段。
 * @returns {{glowTop:number, capTop:number, bodyTop:number, bodyBottom:number, capBottom:number, glowBottom:number}}
 */
export function holdSegments(meta) {
  if (meta.segments) return meta.segments;
  const { core, content, capPx = Math.max(1, Math.round(core.h * 0.02)) } = meta;
  const contentTop = content ? content.y : core.y;
  const contentBottom = content ? content.y + content.h : core.y + core.h;
  return {
    glowTop: Math.max(0, core.y - contentTop),
    capTop: capPx,
    bodyTop: capPx,
    bodyBottom: Math.max(capPx + 1, core.h - capPx),
    capBottom: capPx,
    glowBottom: Math.max(0, contentBottom - (core.y + core.h)),
  };
}

/**
 * @param {object} p
 * @param {object} p.meta 贴图元数据（含 core / content / capPx / segments?）
 * @param {number} p.headLocalY 头部（靠判定线一端）在判定线局部坐标里的 y
 * @param {number} p.tailLocalY 尾部（远端）在判定线局部坐标里的 y
 * @param {number} p.texW 贴图宽（源像素）
 * @param {number} p.texH 贴图高（源像素）
 * @param {number} p.scale 源像素 → 目标像素的缩放系数（= 目标本体宽 / core.w）
 * @returns {{sx:number,sy:number,sw:number,sh:number,dy:number,dh:number,kind:'glow'|'cap'|'body'}[]}
 */
export function computeHoldSlices({ meta, headLocalY, tailLocalY, texW, scale }) {
  const { core } = meta;
  const top = Math.min(headLocalY, tailLocalY); // 尾部（远端）
  const bottom = Math.max(headLocalY, tailLocalY); // 头部（靠线）
  const total = bottom - top;
  if (!(total > 0.5)) return [];

  const seg = holdSegments(meta);
  const clampH = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.min(v, core.h) : fallback);
  const glowTop = clampH(seg.glowTop, 0);
  const capTop = clampH(seg.capTop, Math.max(1, Math.round(core.h * 0.02)));
  const capBottom = clampH(seg.capBottom, capTop);
  const bodyTop = Math.max(0, Math.min(core.h - 1, seg.bodyTop ?? capTop));
  const bodyBottom = Math.max(bodyTop + 1, Math.min(core.h, seg.bodyBottom ?? core.h - capBottom));
  const glowBottom = clampH(seg.glowBottom, 0);

  // 帽/光效：源像素 × 同一缩放系数（固定高度，不随长度放大）；极短时按 total/3 上限收缩
  const capLimit = total / 3;
  const tailDestRaw = Math.min(capTop * scale, capLimit);
  const headDestRaw = Math.min(capBottom * scale, capLimit);
  const glowTopDest = Math.min(glowTop * scale, total / 4);
  const glowBottomDest = Math.min(glowBottom * scale, total / 4);
  // 取整（并让主体与帽重叠 1px）：否则相邻切片的目标矩形边界落在小数上，
  // 各自抗锯齿后会露出 1px 的背景缝（实际反馈过的问题）。
  const tailDest = Math.round(tailDestRaw);
  const headDest = Math.round(headDestRaw);
  const bodyStart = top + tailDest - (tailDest > 0 ? 1 : 0);
  const bodyEnd = bottom - headDest + (headDest > 0 ? 1 : 0);
  const bodyDest = Math.max(0, bodyEnd - bodyStart);

  const slices = [];
  // 本体之外的光效（HL 贴图的上下端外扩）按固定尺寸补画在体量之外
  if (glowTop > 0) {
    const dh = Math.min(glowTop * scale, total / 4);
    slices.push({ sx: 0, sy: core.y - glowTop, sw: texW, sh: glowTop, dy: top - dh, dh, kind: 'glow' });
  }
  // 顺序：主体先画，头尾帽后画 —— 帽盖住主体两端各 1px 的重叠，接缝因此不可见
  if (bodyDest > 0.5) {
    slices.push({
      sx: 0,
      sy: core.y + bodyTop,
      sw: texW,
      sh: Math.max(1, bodyBottom - bodyTop),
      dy: bodyStart,
      dh: bodyDest,
      kind: 'body',
    });
  }
  slices.push({ sx: 0, sy: core.y, sw: texW, sh: capTop, dy: top, dh: tailDest, kind: 'cap' });
  slices.push({
    sx: 0,
    sy: core.y + core.h - capBottom,
    sw: texW,
    sh: capBottom,
    dy: bottom - headDest,
    dh: headDest,
    kind: 'cap',
  });
  if (glowBottom > 0) {
    const dh = Math.min(glowBottom * scale, total / 4);
    slices.push({ sx: 0, sy: core.y + core.h, sw: texW, sh: glowBottom, dy: bottom, dh, kind: 'glow' });
  }
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
