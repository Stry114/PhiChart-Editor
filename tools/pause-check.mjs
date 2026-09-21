// 真浏览器自检：暂停页（图标是否真的画出来 + 结构与文案约定）。
// 用 chrome/edge 的 `--dump-dom`（与 tools/browser-check.mjs 同一套机制），页面里注入一段检查脚本，
// 结果写进 #__pause_check_result，再从这里解析。
// 运行：node tools/pause-check.mjs [outDir]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const OUT = process.argv[2] ?? path.join('tools', 'out');
fs.mkdirSync(OUT, { recursive: true });
const TEMP_PAGE = path.join(ROOT, '.pause-check-page.html');
const TEMP_PAGE_SHOT = path.join(ROOT, '.pause-check-shot.html');
const PROFILE = path.join(ROOT, 'tools', '.pause-check-profile');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
];

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

// ── 极小谱面：随页面一起塞进去，检查脚本自己触发载入 ──
const TINY_CHART = {
  formatVersion: 3,
  offset: 0,
  judgeLineList: [
    {
      bpm: 120,
      notesAbove: [{ type: 1, time: 64, positionX: 0, holdTime: 0, speed: 1, floorPosition: 1 }],
      notesBelow: [],
      speedEvents: [{ startTime: 0, endTime: 1000000000, value: 1 }],
      judgeLineMoveEvents: [{ startTime: -999999, endTime: 1000000000, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }],
      judgeLineRotateEvents: [{ startTime: -999999, endTime: 1000000000, start: 0, end: 0 }],
      judgeLineDisappearEvents: [{ startTime: -999999, endTime: 1000000000, start: 1, end: 1 }],
    },
  ],
};

const CHECK_SCRIPT = `
<script type="module">
const TINY = ${JSON.stringify(TINY_CHART)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (id) => document.getElementById(id);
const out = { icons: [], text: {}, flags: {} };

function iconReport(ids) {
  return ids.map((id) => {
    const btn = q(id);
    const ico = btn?.querySelector('span.ic') ?? null;
    const cs = ico ? getComputedStyle(ico) : null;
    const mask = cs ? String(cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage) : '';
    const rect = ico?.getBoundingClientRect();
    const bcs = btn ? getComputedStyle(btn) : null;
    return {
      id,
      has: !!ico,
      w: rect ? Math.round(rect.width) : 0,
      h: rect ? Math.round(rect.height) : 0,
      off: ico ? ico.offsetWidth : -1,
      inline: ico ? ico.getAttribute('style') : '',
      parentDisplay: ico ? getComputedStyle(ico.parentElement).display : '',
      pageHidden: btn ? !!btn.closest('.pause-page.hidden') : null,
      bg: cs ? cs.backgroundColor : '',
      mask: /url\\(/.test(mask),
      color: ico ? getComputedStyle(btn).color : '',
      border: bcs ? bcs.borderTopWidth : '',
      btnBg: bcs ? bcs.backgroundColor : '',
      text: (btn?.textContent ?? '').trim(),
    };
  });
}

async function run() {
  try {
    // 等 boot 结束（贴图加载耗时与机器有关）：最多轮询 6 秒
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (q('boot')?.classList.contains('hidden')) break;
    }
    out.flags.bootHidden = q('boot')?.classList.contains('hidden') === true;
    out.flags.openVisibleFirst = !q('pause-open').classList.contains('hidden');
    await sleep(800); // 图标是 setIcon 注入的，等一帧再量
    out.icons = iconReport(['btn-open-folder', 'btn-open-zip']);

    // 载入随页面带来的极小谱面 → 回到主层
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(TINY)], 'tiny.json', { type: 'application/json' }));
    const input = q('json-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await sleep(900);

    out.flags.mainVisible = !q('pause-main').classList.contains('hidden');
    out.text.title = q('pause-title-text').textContent.trim();
    out.flags.infoInSettings = !!document.querySelector('#pause-settings #chart-info');
    out.flags.mainHasNoInfo = !document.querySelector('#pause-main #chart-info');
    out.flags.autoplayPressed = q('btn-autoplay').getAttribute('aria-pressed');
    // 主层现在可见了，这时候再量图标尺寸（隐藏时量到 0）
    await sleep(200);
    out.mainIcons = iconReport(['btn-open', 'btn-restart', 'btn-autoplay', 'btn-fullscreen-main', 'btn-settings', 'btn-play']);
    out.text.hint = q('pause-open-status').textContent.trim();
    out.text.judgeBand = q('judge-band').textContent.trim();
    out.text.judgeScreen = q('judge-screen').textContent.trim();
    out.flags.fullscreenEnabled = q('btn-fullscreen-main').disabled === false;

    // 二级页面
    q('btn-settings').click();
    await sleep(150);
    out.flags.settingsVisible = !q('pause-settings').classList.contains('hidden');
    out.flags.backVisible = !q('pause-back').classList.contains('hidden');
    out.flags.settingsIcons = iconReport(['btn-fullscreen', 'btn-rate', 'btn-note-narrow', 'btn-note-wide']).map((r) => r.id + ':' + r.w + 'x' + r.h);
    q('pause-back').click();
    await sleep(120);
    out.flags.backToMain = !q('pause-main').classList.contains('hidden');
    q('btn-open').click();
    await sleep(120);
    out.flags.openVisible = !q('pause-open').classList.contains('hidden');
    q('pause-back').click();
  } catch (err) {
    out.error = String(err?.message ?? err);
  }
  const node = document.createElement('div');
  node.id = '__pause_check_result';
  node.textContent = JSON.stringify(out);
  document.body.appendChild(node);
  document.title = 'PAUSE_CHECK_DONE';
}
void run();
</script>
`;

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(ROOT, urlPath.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function runBrowser(exe, url, extraArgs = []) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,900',
    '--virtual-time-budget=30000',
    ...extraArgs,
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

const exe = findBrowser();
if (!exe) {
  console.error('找不到 Edge / Chrome，跳过真浏览器自检。');
  process.exit(0);
}
fs.rmSync(PROFILE, { recursive: true, force: true });

const html = fs.readFileSync(path.join(ROOT, 'player.html'), 'utf8');
fs.writeFileSync(TEMP_PAGE, html.replace('</body>', `${CHECK_SCRIPT}\n  </body>`));
// 出图用：载入极小谱面后停在主层
fs.writeFileSync(
  TEMP_PAGE_SHOT,
  html.replace(
    '</body>',
    `<script type="module">
const TINY = ${JSON.stringify(TINY_CHART)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1600);
const dt = new DataTransfer();
dt.items.add(new File([JSON.stringify(TINY)], 'tiny.json', { type: 'application/json' }));
const input = document.getElementById('json-input');
input.files = dt.files;
input.dispatchEvent(new Event('change'));
if (location.search.includes('settings')) { await sleep(600); document.getElementById('btn-settings').click(); }
if (location.search.includes('open')) { await sleep(600); document.getElementById('btn-open').click(); }
</script>
  </body>`,
  ),
);

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

console.log('\n== 暂停页（真浏览器）==');
const res = await runBrowser(exe, `${base}/.pause-check-page.html`, ['--dump-dom']);
const m = /<div id="__pause_check_result">([\s\S]*?)<\/div>/.exec(res.text);
if (!m) {
  console.error('页面没有回传检查结果（可能启动失败）。浏览器输出片段：');
  console.error(res.text.slice(-1500));
  server.close();
  process.exit(1);
}
const report = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
if (report.error) console.error('页面内检查脚本报错：', report.error);

check('页面启动完成（boot 已隐藏）', report.flags.bootHidden === true);
check('没有谱面时直接停在「打开」页', report.flags.openVisibleFirst === true);
const bad = report.icons.filter((r) => !r.has || r.w === 0 || r.h === 0 || !r.mask || /rgba\(0, 0, 0, 0\)/.test(r.bg));
const badMain = (report.mainIcons ?? []).filter((r) => !r.has || r.w === 0 || r.h === 0 || !r.mask);
check(
  '打开页的两个图标入口画得出来（有尺寸 + mask）',
  bad.length === 0,
  bad.map((r) => `${r.id}:${r.w}x${r.h}|mask=${r.mask}`).join('  ') || report.icons.map((r) => `${r.id}:${r.w}px`).join(' '),
);
check(
  '主层 6 个图标按钮画得出来（有尺寸 + mask）',
  badMain.length === 0,
  badMain.map((r) => `${r.id}:${r.w}x${r.h}|hidden=${r.pageHidden}`).join('  ') || (report.mainIcons ?? []).map((r) => `${r.id}:${r.w}px`).join(' '),
);
check(
  '图标为白色（自动游玩开关按开启态着强调色）',
  report.icons.every((r) => /255,\s*255,\s*255/.test(r.color)) && (report.mainIcons ?? []).every((r) => (r.id === 'btn-autoplay' ? /204,\s*204,\s*204/.test(r.color) : /255,\s*255,\s*255/.test(r.color))),
  [...(report.icons ?? []), ...(report.mainIcons ?? [])].map((r) => `${r.id}=${r.color}`).join(' '),
);
check(
  '图标按钮无外框、无背景',
  [...(report.icons ?? []), ...(report.mainIcons ?? [])].every((r) => parseFloat(r.border || '0') === 0 && /rgba\(0, 0, 0, 0\)/.test(r.btnBg)),
  [...(report.icons ?? []), ...(report.mainIcons ?? [])].map((r) => `${r.id}:border=${r.border}`).join(' '),
);
check('图标按钮里没有文字', [...(report.icons ?? []), ...(report.mainIcons ?? [])].every((r) => r.text === ''), [...(report.icons ?? []), ...(report.mainIcons ?? [])].map((r) => `${r.id}="${r.text}"`).join(' '));
check('设置页的图标也画得出来', report.flags.settingsIcons.every((s) => !/:0x0$/.test(s)), report.flags.settingsIcons.join(' '));
check('载入后停在主层并显示曲名', report.flags.mainVisible === true && !!report.text.title, `title="${report.text.title}"`);
check('谱面详情只出现在设置页（主层没有长文字块）', report.flags.infoInSettings === true && report.flags.mainHasNoInfo === true);
check('判定范围文案为「垂直判定 / 全屏判定」', report.text.judgeBand === '垂直判定' && report.text.judgeScreen === '全屏判定', `${report.text.judgeBand} / ${report.text.judgeScreen}`);
check('自动游玩开关处于按下态（默认自动游玩）', report.flags.autoplayPressed === 'true');
check('主层全屏按钮可用', report.flags.fullscreenEnabled === true);
check('设置页可进入 / 可返回', report.flags.settingsVisible === true && report.flags.backVisible === true && report.flags.backToMain === true);
check('打开页可进入', report.flags.openVisible === true);

// 出图（三种状态）供人工核对
for (const [name, query] of [
  ['pause-main.png', ''],
  ['pause-settings.png', '?settings'],
  ['pause-open.png', '?open'],
]) {
  const shot = await runBrowser(exe, `${base}/.pause-check-shot.html${query}`, [`--screenshot=${path.join(ROOT, OUT, name)}`]);
  const file = path.join(ROOT, OUT, name);
  check(`出图 ${name}`, fs.existsSync(file) && fs.statSync(file).size > 2000, fs.existsSync(file) ? `${Math.round(fs.statSync(file).size / 1024)} KB` : shot.text.slice(-200));
}

server.close();
fs.rmSync(TEMP_PAGE, { force: true });
fs.rmSync(TEMP_PAGE_SHOT, { force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exitCode = failed ? 1 : 0;
