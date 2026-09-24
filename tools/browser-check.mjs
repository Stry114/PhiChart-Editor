/**
 * 真实浏览器自检（Edge / Chrome 无头模式）。
 *
 * 为什么需要它：Node 里的迷你 DOM 桩件查不出「浏览器里才算数」的问题 ——
 * 控件被布局挤到点不到、画布/SVG 被拉伸变形、窗口宽度变化后不重排、脚本被缓存成旧版。
 * 这类问题这个项目已经踩过好几次，所以留一个能在真浏览器里跑一遍的检查。
 *
 * 用法：node tools/browser-check.mjs
 * 做法：起一个临时静态服务器 → 用 edit.html 的副本（+ tools/browser-checks.js）跑检查 → 打印结果 → 清理。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const TEMP_PAGE = path.join(ROOT, '_browser-check.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  // 渲染器全局字体（@font-face）：给正确的 MIME，避免个别浏览器拒绝按字体加载
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel || 'index.html');
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        // no-store：绝不能让浏览器缓存住模块，否则检查跑的是新旧混搭的代码
        'cache-control': 'no-store',
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

function runBrowser(exe, url, profileDir, size) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--enable-logging=stderr',
    '--log-level=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${size ?? '1440,900'}`,
    '--virtual-time-budget=30000',
    '--dump-dom',
    url,
  ];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('error', (err) => resolve({ text: `SPAWN_ERROR ${err.message}`, code: -1 }));
    child.on('close', (code) => resolve({ text, code }));
  });
}

// ── 主流程 ──
const exe = findBrowser();
if (!exe) {
  console.error('找不到 Edge / Chrome，跳过浏览器自检。');
  process.exit(0);
}

const html = fs
  .readFileSync(path.join(ROOT, 'edit.html'), 'utf8')
  .replace('</body>', '    <script type="module" src="./tools/browser-checks.js"></script>\n  </body>');
fs.writeFileSync(TEMP_PAGE, html);

const { server, port } = await startServer();
const profileDir = path.join(ROOT, 'tools', '.browser-check-profile');

// 两种窗口尺寸：宽窗口看正常布局，窄窗口看自适应（左栏不能把右侧挤没）
const SIZES = [
  [1440, 900],
  [1000, 640],
];
const lines = [];
for (const [w, h] of SIZES) {
  // 编辑器启动偏慢（要解贴图），无头环境下偶尔超时：重试一次，避免假失败
  let got = [];
  for (let attempt = 0; attempt < 2 && !got.length; attempt++) {
    const { text } = await runBrowser(
      exe,
      `http://127.0.0.1:${port}/_browser-check.html?size=${w}x${h}`,
      profileDir,
      `${w},${h}`,
    );
    got = text
      .split(/\r?\n/)
      .filter((l) => l.includes('STCHK|') || l.includes('STDONE|'))
      .map((l) => l.slice(l.indexOf(l.includes('STDONE|') ? 'STDONE|' : 'STCHK|')).replace(/", source:.*$/, ''));
    if (!got.length || got.some((l) => l.includes('编辑器没启动'))) {
      if (attempt === 0) {
        console.log(`  · ${w}×${h} 首次运行编辑器没起来，重试一次`);
        got = [];
      }
    }
  }
  if (!got.length) {
    lines.push(`STCHK|FAIL | ${w}×${h} 窗口：浏览器没有回传结果`);
    continue;
  }
  const tail = got.find((l) => l.startsWith('STDONE|')) ?? 'STDONE|?';
  lines.push(...got.filter((l) => l.startsWith('STCHK|')).map((l) => `${l}  [${w}×${h}]`));
  lines.push(`STDONE|[${w}×${h}] ${tail.slice('STDONE|'.length)}`);
}

server.close();
try {
  fs.rmSync(TEMP_PAGE, { force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结果 */
}

if (!lines.length) {
  console.error('浏览器没有回传结果 —— 可能启动失败或页面报错：');
  console.error(text.split(/\r?\n/).filter((l) => /CONSOLE|Uncaught|ERROR:/.test(l)).slice(0, 10).join('\n'));
  process.exit(1);
}

let fails = 0;
let skips = 0;
for (const l of lines) {
  if (l.startsWith('STDONE|')) continue;
  const isSkip = l.startsWith('STCHK|SKIP');
  const ok = l.startsWith('STCHK|PASS');
  if (isSkip) skips++;
  else if (!ok) fails++;
  console.log(`${isSkip ? '  –' : ok ? '  ✓' : '  ✗'} ${l.replace(/^STCHK\|\w+ \| /, '')}`);
}
console.log('='.repeat(52));
console.log(`浏览器自检：通过 ${lines.length - 1 - fails - skips} 项，跳过 ${skips} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
