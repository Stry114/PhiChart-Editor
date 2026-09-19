// 图标规范化 / 检查：assets/icons/*.svg 是「绝对坐标 + <g transform> 平移到画布」的导出格式，
// 图形在画布里的实际包围盒不一定居中、也不一定贴合画布 → 用 CSS mask 显示时就会看起来偏移。
//
// 做法：递归遍历（支持嵌套 <g transform>）算出图形在渲染坐标系里的包围盒，
// 再把 width/height/viewBox 设成「包围盒 + 描边留白」，于是每个图标都以自身内容为中心、
// 大小一致，mask 居中后不会再有偏移。
//
// 用法：
//   node tools/normalize-icons.mjs          规范化（就地改写）
//   node tools/normalize-icons.mjs --check  只检查（有偏移则退出码 1）
// 也被 tools/editor-smoke.mjs 引用来做回归（measureIcons）。
import fs from 'node:fs';
import path from 'node:path';

export const ICON_DIR = path.join(process.cwd(), 'assets', 'icons');

/** SVG 圆弧按中心参数化采样 */
function arcPoints(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2, steps = 16) {
  if (!rx || !ry) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  let rxAbs = Math.abs(rx);
  let ryAbs = Math.abs(ry);
  const lambda = (x1p * x1p) / (rxAbs * rxAbs) + (y1p * y1p) / (ryAbs * ryAbs);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rxAbs *= s;
    ryAbs *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rxAbs * rxAbs * ryAbs * ryAbs - rxAbs * rxAbs * y1p * y1p - ryAbs * ryAbs * x1p * x1p;
  const den = rxAbs * rxAbs * y1p * y1p + ryAbs * ryAbs * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rxAbs * y1p) / ryAbs;
  const cyp = (-co * ryAbs * x1p) / rxAbs;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rxAbs, (y1p - cyp) / ryAbs);
  let dTheta = angle((x1p - cxp) / rxAbs, (y1p - cyp) / ryAbs, (-x1p - cxp) / rxAbs, (-y1p - cyp) / ryAbs);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = theta1 + (dTheta * i) / steps;
    out.push([
      cos * rxAbs * Math.cos(t) - sin * ryAbs * Math.sin(t) + cx,
      sin * rxAbs * Math.cos(t) + cos * ryAbs * Math.sin(t) + cy,
    ]);
  }
  return out;
}

/** path 的 d → 点集（贝塞尔按 t 采样，圆弧按中心参数化采样） */
function pathPoints(d) {
  const pts = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = null;
  const take = (n) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const v = Number(tokens[i++]);
      if (!Number.isFinite(v)) return null;
      out.push(v);
    }
    return out;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === 'Z') {
      cx = sx;
      cy = sy;
      pts.push([cx, cy]);
      continue;
    }
    const argsPer = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[c];
    if (!argsPer) break;
    let first = true;
    for (;;) {
      if (i >= tokens.length || /[a-zA-Z]/.test(tokens[i])) break;
      const a = take(argsPer);
      if (!a) break;
      if (c === 'H' || c === 'V') {
        const v = a[0];
        if (c === 'H') cx = rel ? cx + v : v;
        else cy = rel ? cy + v : v;
        pts.push([cx, cy]);
      } else if (c === 'A') {
        const [rx, ry, rot, laf, sf, x, y] = a;
        const nx = rel ? cx + x : x;
        const ny = rel ? cy + y : y;
        for (const p of arcPoints(cx, cy, rx, ry, rot, laf === 1, sf === 1, nx, ny)) pts.push(p);
        cx = nx;
        cy = ny;
      } else if (c === 'C' || c === 'Q') {
        const seg = rel ? a.map((v, k) => (k % 2 === 0 ? cx + v : cy + v)) : a;
        for (let t = 0; t <= 1.0001; t += 0.125) {
          const mt = 1 - t;
          if (c === 'C') {
            pts.push([
              mt ** 3 * cx + 3 * mt * mt * t * seg[0] + 3 * mt * t * t * seg[2] + t ** 3 * seg[4],
              mt ** 3 * cy + 3 * mt * mt * t * seg[1] + 3 * mt * t * t * seg[3] + t ** 3 * seg[5],
            ]);
          } else {
            pts.push([mt * mt * cx + 2 * mt * t * seg[0] + t * t * seg[2], mt * mt * cy + 2 * mt * t * seg[1] + t * t * seg[3]]);
          }
        }
        if (c === 'C') {
          cx = seg[4];
          cy = seg[5];
        } else {
          cx = seg[2];
          cy = seg[3];
        }
      } else if (c === 'S' || c === 'T') {
        const lx = a[a.length - 2];
        const ly = a[a.length - 1];
        pts.push([rel ? cx + lx : lx, rel ? cy + ly : ly]);
        cx = rel ? cx + lx : lx;
        cy = rel ? cy + ly : ly;
      } else {
        for (let k = 0; k + 1 < a.length; k += 2) {
          const nx = rel ? cx + a[k] : a[k];
          const ny = rel ? cy + a[k + 1] : a[k + 1];
          pts.push([nx, ny]);
          cx = nx;
          cy = ny;
        }
      }
      if (c === 'M' && first) {
        sx = cx;
        sy = cy;
        first = false;
        cmd = rel ? 'l' : 'L';
      } else {
        first = false;
      }
    }
  }
  return pts;
}

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function parseTransform(str) {
  let out = [1, 0, 0, 1, 0, 0];
  if (!str) return out;
  for (const m of str.matchAll(/(matrix|translate|scale)\(([^)]*)\)/g)) {
    const nums = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (m[1] === 'matrix') out = mul(out, nums);
    else if (m[1] === 'translate') out = mul(out, [1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0]);
    else out = mul(out, [nums[0] ?? 1, 0, 0, nums[1] ?? nums[0] ?? 1, 0, 0]);
  }
  return out;
}

const applyM = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 递归遍历 SVG 内容，按嵌套 transform 计算所有图形点的包围盒 */
function contentPoints(inner) {
  const pts = [];
  let stack = [[1, 0, 0, 1, 0, 0]];
  let maxStroke = 1;
  const tagRe = /<\/?g\b[^>]*>|<path\b[^>]*>/g;
  for (const m of inner.matchAll(tagRe)) {
    const tag = m[0];
    if (tag.startsWith('</g')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (tag.startsWith('<g')) {
      const t = /transform="([^"]*)"/.exec(tag)?.[1];
      stack.push(t ? mul(stack[stack.length - 1], parseTransform(t)) : stack[stack.length - 1]);
      continue;
    }
    // <path .../>
    const d = /\sd="([^"]+)"/.exec(tag)?.[1];
    const own = /transform="([^"]*)"/.exec(tag)?.[1];
    let mtx = stack[stack.length - 1];
    if (own) mtx = mul(mtx, parseTransform(own));
    const sw = Number(/stroke-width="([\d.]+)"/.exec(tag)?.[1]);
    if (Number.isFinite(sw)) maxStroke = Math.max(maxStroke, sw);
    if (d) for (const p of pathPoints(d)) pts.push(applyM(mtx, p));
  }
  return { pts, maxStroke };
}

/** 量出每个图标的包围盒与中心偏移（不写文件） */
export function measureIcons(dir = ICON_DIR) {
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
    const svg = fs.readFileSync(path.join(dir, file), 'utf8');
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1] ?? '';
    const { pts, maxStroke } = contentPoints(inner);
    if (!pts.length) {
      out.push({ file, skipped: true, reason: '没有可用 path' });
      continue;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const vb = /<svg[^>]*\sviewBox="([-\d.\s]+)"/.exec(svg)?.[1];
    const parts = vb ? vb.trim().split(/[\s,]+/).map(Number) : null;
    const oldW = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 0);
    const oldH = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 0);
    const boxW = parts ? parts[2] : oldW;
    const boxH = parts ? parts[3] : oldH;
    const boxCx = parts ? parts[0] + parts[2] / 2 : oldW / 2;
    const boxCy = parts ? parts[1] + parts[3] / 2 : oldH / 2;
    const dx = (minX + maxX) / 2 - boxCx;
    const dy = (minY + maxY) / 2 - boxCy;
    const rel = boxW ? Math.max(Math.abs(dx), Math.abs(dy)) / boxW : 1;
    out.push({ file, svg, minX, maxX, minY, maxY, oldW, oldH, dx, dy, rel, pad: Math.max(0.6, maxStroke), skipped: false });
  }
  return out;
}

/** 规范化：把 width/height/viewBox 设成包围盒 + 描边留白 */
export function normalizeIcons({ checkOnly = false, dir = ICON_DIR } = {}) {
  const rows = [];
  let written = 0;
  let offCenter = 0;
  for (const info of measureIcons(dir)) {
    if (info.skipped) {
      rows.push(`  ${info.file.padEnd(18)} 跳过（${info.reason}）`);
      continue;
    }
    if (info.rel > 0.02) offCenter++;
    const { minX, maxX, minY, maxY, pad } = info;
    const w = Math.max(1, Math.ceil(maxX - minX + pad * 2));
    const h = Math.max(1, Math.ceil(maxY - minY + pad * 2));
    const viewBox = `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${(maxX - minX + pad * 2).toFixed(2)} ${(maxY - minY + pad * 2).toFixed(2)}`;
    const next = info.svg.replace(/<svg[^>]*>/, (tag) => {
      const cleaned = tag.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '').replace(/\sviewBox="[^"]*"/, '');
      return cleaned.replace(/^<svg/, `<svg width="${w}" height="${h}" viewBox="${viewBox}"`);
    });
    if (next !== info.svg) {
      if (!checkOnly) fs.writeFileSync(path.join(dir, info.file), next);
      written++;
    }
    rows.push(
      `  ${info.file.padEnd(18)} 中心偏移 ${info.dx.toFixed(2)}, ${info.dy.toFixed(2)}（${(info.rel * 100).toFixed(1)}%）→ ${w}×${h}`,
    );
  }
  return { rows, written, offCenter, total: rows.length };
}

const isMain = !!process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('normalize-icons.mjs'));
if (isMain) {
  const checkOnly = process.argv.includes('--check');
  const { rows, written, offCenter, total } = normalizeIcons({ checkOnly });
  console.log(rows.join('\n'));
  console.log(`\n${checkOnly ? '检查' : '规范化'}完成：${total} 个图标，${written} 个需要改写，中心偏移 >2% 的有 ${offCenter} 个`);
  if (checkOnly && (written || offCenter)) process.exit(1);
}
