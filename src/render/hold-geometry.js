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
 * @param {object} meta 贴图元数据（textures.js）
 * @param {'tailCap'|'gradient'|'uniform'} [preset] 仅当贴图**没有**明确分段时使用的预设取样
 * @returns {{glowTop:number, capTop:number, bodyTop:number, bodyBottom:number, capBottom:number, glowBottom:number}}
 */
export function holdSegments(meta, preset = 'tailCap') {
  if (meta.segments) return meta.segments;
  const { core, content, capPx } = meta;
  const contentTop = content ? content.y : core.y;
  const contentBottom = content ? content.y + content.h : core.y + core.h;
  // 预设（仓库自带贴图用；目标观感：帽很短、主体接近整根且颜色均匀）
  //  - tailCap：帽高 = 尾巴 0.5% / 头 capPx×0.1；主体取贴图最亮的 89%–98% 段
  //  - gradient：整根渐变（对照用，长条上半段会发灰）
  //  - uniform：主体更窄（92%–98%），颜色更均匀
  const table = {
    gradient: { tail: capPx, head: capPx, bodyTop: capPx, bodyBottom: core.h - capPx },
    tailCap: {
      tail: Math.max(1, Math.round(core.h * 0.005)),
      head: Math.max(1, Math.round(capPx * 0.1)),
      bodyTop: Math.round(core.h * 0.89),
      bodyBottom: Math.round(core.h * 0.98),
    },
    uniform: {
      tail: Math.max(1, Math.round(core.h * 0.005)),
      head: Math.max(1, Math.round(capPx * 0.1)),
      bodyTop: Math.round(core.h * 0.92),
      bodyBottom: Math.round(core.h * 0.98),
    },
  };
  const p = table[preset] ?? table.tailCap;
  return {
    glowTop: Math.max(0, core.y - contentTop),
    capTop: p.tail,
    bodyTop: p.bodyTop,
    bodyBottom: p.bodyBottom,
    capBottom: p.head,
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
 * @param {'tailCap'|'gradient'|'uniform'} [p.preset] 无明确分段时的预设
 * @returns {{sx:number,sy:number,sw:number,sh:number,dy:number,dh:number,kind:'glow'|'cap'|'body'}[]}
 */
export function computeHoldSlices({ meta, headLocalY, tailLocalY, texW, scale, preset = 'tailCap' }) {
  const { core } = meta;
  const top = Math.min(headLocalY, tailLocalY); // 尾部（远端）
  const bottom = Math.max(headLocalY, tailLocalY); // 头部（靠线）
  const total = bottom - top;
  if (!(total > 0.5)) return [];

  const seg = holdSegments(meta, preset);
  const clampH = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.min(v, core.h) : fallback);
  const glowTop = clampH(seg.glowTop, 0);
  const capTop = clampH(seg.capTop, Math.max(1, Math.round(core.h * 0.02)));
  const capBottom = clampH(seg.capBottom, capTop);
  const bodyTop = Math.max(0, Math.min(core.h - 1, seg.bodyTop ?? capTop));
  const bodyBottom = Math.max(bodyTop + 1, Math.min(core.h, seg.bodyBottom ?? core.h - capBottom));
  const glowBottom = clampH(seg.glowBottom, 0);

  // 帽/光效：源像素 × 同一缩放系数（固定高度，不随长度放大）；极短时按 total/3 上限收缩
  const capLimit = total / 3;
  const tailDest = Math.min(capTop * scale, capLimit);
  const headDest = Math.min(capBottom * scale, capLimit);
  const glowTopDest = Math.min(glowTop * scale, total / 4);
  const glowBottomDest = Math.min(glowBottom * scale, total / 4);
  const bodyDest = Math.max(0, total - tailDest - headDest);

  const slices = [];
  if (glowTop > 0) slices.push({ sx: 0, sy: core.y - glowTop, sw: texW, sh: glowTop, dy: top - glowTopDest, dh: glowTopDest, kind: 'glow' });
  slices.push({ sx: 0, sy: core.y, sw: texW, sh: capTop, dy: top, dh: tailDest, kind: 'cap' });
  if (bodyDest > 0.5) {
    slices.push({
      sx: 0,
      sy: core.y + bodyTop,
      sw: texW,
      sh: Math.max(1, bodyBottom - bodyTop),
      dy: top + tailDest,
      dh: bodyDest,
      kind: 'body',
    });
  }
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
    slices.push({ sx: 0, sy: core.y + core.h, sw: texW, sh: glowBottom, dy: bottom, dh: glowBottomDest, kind: 'glow' });
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
