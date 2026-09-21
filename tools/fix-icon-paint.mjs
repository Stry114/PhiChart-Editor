// 图标上色清理：assets/icons/*.svg 里硬编码的黑色（stroke="#000000" / fill="#000000"）
// 在部分设备上会让图标显示成深灰（mask 合成差异），统一改成 white。
// CSS 仍然用 mask + currentColor 上色，所以颜色本来就不该写死在文件里。
// 运行：node tools/fix-icon-paint.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'assets', 'icons');
const checkOnly = process.argv.includes('--check');
const DARK = [
  [/stroke="#000000"/g, 'stroke="#ffffff"'],
  [/stroke="#000"/g, 'stroke="#ffffff"'],
  [/fill="#000000"/g, 'fill="#ffffff"'],
  [/fill="#000"/g, 'fill="#ffffff"'],
  [/stroke: ?#000000/g, 'stroke: #ffffff'],
  [/fill: ?#000000/g, 'fill: #ffffff'],
];

let changed = 0;
const files = [];
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).sort()) {
  const full = path.join(DIR, file);
  const before = fs.readFileSync(full, 'utf8');
  let after = before;
  for (const [re, to] of DARK) after = after.replace(re, to);
  if (after === before) continue;
  changed++;
  files.push(file);
  if (!checkOnly) fs.writeFileSync(full, after, 'utf8');
}
console.log(`${checkOnly ? '待修' : '已改'} ${changed} 个图标：${files.join(', ') || '（无）'}`);
process.exitCode = checkOnly && changed ? 1 : 0;
