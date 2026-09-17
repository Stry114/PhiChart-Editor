// HTTP 冒烟测试：验证静态服务器下页面、模块、贴图与示例包 URL 都可访问
// （含文件名带空格与 '#' 的编码场景）。运行前需在本目录启动静态服务器。
// 用法：node tools/http-smoke.mjs http://127.0.0.1:8099
const base = (process.argv[2] || 'http://127.0.0.1:8099').replace(/\/$/, '');
const enc = (...parts) => parts.map((p) => encodeURIComponent(p)).join('/');

const SAMPLES = [
  {
    name: 'official 示例包',
    dir: 'packages/白复生 AT（official格式）',
    chart: 'Chart_AT #3649.json',
    audio: 'music #1988.wav',
    background: 'Illustration #4286.png',
  },
  {
    name: 'RPE 示例包',
    dir: 'packages/领土战争AT（RPE格式）',
    chart: '29519800.json',
    audio: '29519800.wav',
    background: '29519800.png',
    info: 'info.txt',
  },
];

const targets = [
  ['页面', '/index.html'],
  ['样式', '/styles.css'],
  ['入口模块', '/src/app/main.js'],
  ['核心模块', '/src/core/model.js'],
  ['核心模块', '/src/core/parse-official.js'],
  ['核心模块', '/src/core/parse-rpe.js'],
  ['核心模块', '/src/core/state.js'],
  ['核心模块', '/src/core/events.js'],
  ['核心模块', '/src/core/easing.js'],
  ['核心模块', '/src/core/timing.js'],
  ['核心模块', '/src/core/units.js'],
  ['核心模块', '/src/core/package.js'],
  ['渲染模块', '/src/render/canvas2d.js'],
  ['渲染模块', '/src/render/textures.js'],
  ['播放模块', '/src/app/player.js'],
  ['贴图', '/assets/Tap.png'],
  ['贴图', '/assets/hit.png'],
  ['音效', '/assets/click.wav'],
];

let failed = 0;
for (const [kind, path] of targets) {
  const res = await fetch(base + path);
  const ok = res.ok;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${kind.padEnd(6)} ${path}  → ${res.status} ${res.headers.get('content-length') ?? ''}`);
}

console.log('\n-- 示例包（文件名含空格与 # 的编码路径） --');
for (const s of SAMPLES) {
  const dir = enc(...s.dir.split('/'));
  for (const [kind, file] of [
    ['谱面', s.chart],
    ['音频', s.audio],
    ['曲绘', s.background],
    ...(s.info ? [['元数据', s.info]] : []),
  ]) {
    const url = `${base}/${dir}/${enc(file)}`;
    const res = await fetch(url, kind === '谱面' || kind === '元数据' ? {} : { headers: { range: 'bytes=0-64' } });
    const ok = res.ok || res.status === 206;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${s.name} ${kind.padEnd(4)} ${res.status} ${res.headers.get('content-length') ?? ''}  ${decodeURIComponent(url.slice(base.length))}`);
  }
}

console.log(`\n失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
