// 开始页的无头冒烟测试：跑真正的 src/start/main.js（最小 DOM 桩件）。
// 开始页按需求**只剩两个入口**（编辑器 / 播放器），打开内容的功能全部在编辑器内完成，
// 所以这里同时做一条静态回归：确认两个页面里都不再有「内置示例谱面 / 测试项目」的入口。
// 运行：node tools/start-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
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
const section = (t) => console.log(`\n== ${t} ==`);

// ───────────────────────── 迷你 DOM ─────────────────────────
class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) this.set.add(x);
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
  }
  contains(c) {
    return this.set.has(c);
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Node {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new ClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = '';
    this.id = '';
    this.style = new Proxy(
      {},
      {
        set: (t, k, v) => ((t[k] = v), true),
        get: (t, k) =>
          k === 'setProperty'
            ? (name, value) => {
                t[name] = value;
              }
            : (t[k] ?? ''),
      },
    );
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.classList.toString();
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? Object.assign(new Node('#text'), { textContent: n }) : n);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  setAttribute(k, v) {
    this.attributes.set(k, v);
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const out = [];
    const match = (node) => {
      if (sel.startsWith('[') && sel.endsWith(']')) {
        const body = sel.slice(1, -1);
        const [k, v] = body.split('=');
        return v === undefined ? node.attributes.has(k) : node.getAttribute(k) === v.replace(/["']/g, '');
      }
      if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return true;
      if (/^[a-z]+$/i.test(sel) && node.tagName === sel.toUpperCase()) return true;
      return false;
    };
    const walk = (n) => {
      for (const c of n.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const body = new Node('body');
globalThis.document = {
  body,
  documentElement: body,
  getElementById: (id) => body.querySelector(`#${id}`) ?? byId.get(id) ?? null,
  createElement: (tag) => new Node(tag),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
};
const byId = new Map();
globalThis.location = { href: 'index.html', protocol: 'http:', search: '', hash: '' };
globalThis.window = globalThis;

// ───────────────────────── 页面骨架与入口 ─────────────────────────
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
section('开始页只留两个入口');
{
  const cards = [...html.matchAll(/<a[^>]*class="[^"]*st-card[^"]*"[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)];
  const hrefs = [...html.matchAll(/href="(edit\.html|player\.html)"/g)].map((m) => m[1]);
  check('页面里只有编辑器和播放器两个入口', cards.length === 2 && hrefs.length === 2, `${cards.length} 个卡片 / href=${hrefs.join(',')}`);
  check('入口指向 edit.html 与 player.html', hrefs.includes('edit.html') && hrefs.includes('player.html'), hrefs.join(','));
  check('入口用上了新增的图标', /data-icon="editor_icon"/.test(html) && /data-icon="player_icon"/.test(html));
  check('开始页不再有「新建项目 / 打开谱面包 / 快速打开」等窗体', !/st-new-project|st-open-package|st-open-project|st-quick|st-form/.test(html));
}

section('开始页的文档入口指向 GitHub');
{
  // 文档在仓库的 docs/ 下维护，开始页只放 GitHub 链接：这里校验链接可达（路径与文件名都对得上）
  const links = [...html.matchAll(/href="(https:\/\/github\.com\/Stry114\/PhiChart-Editor\/blob\/main\/docs\/[^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
  check('开始页有 3 个文档链接（谱师 / Phigros / 项目）', links.length === 3, links.join(' | ') || '（没有链接）');
  const missing = links
    .map((u) => u.split('/docs/')[1])
    .filter((name) => name && !fs.existsSync(path.join(ROOT, 'docs', name)));
  check('文档链接指向的文件都存在于 docs/', links.length === 3 && missing.length === 0, missing.join(',') || '全部存在');
  check('文档链接指向本仓库', links.every((u) => u.startsWith('https://github.com/Stry114/PhiChart-Editor/blob/main/docs/')));
}
{
  // 用页面里的 id / data-icon 生成桩件（与真实 DOM 结构一致）
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Node('div');
    node.id = m[1];
    byId.set(m[1], node);
    body.appendChild(node);
  }
  for (const m of html.matchAll(/data-icon="([^"]+)"/g)) {
    const holder = new Node('span');
    holder.setAttribute('data-icon', m[1]);
    holder.classList.add('st-card-ico');
    body.appendChild(holder);
  }
}

section('启动 start/main.js');
await import('../src/start/main.js');
{
  const holders = body.querySelectorAll('[data-icon]');
  const names = holders.map((h) => h.getAttribute('data-icon'));
  check('图标占位符全部挂上了矢量图标', holders.length === 2 && holders.every((h) => h.children.length === 1), names.join(','));
  check(
    '两个图标分别指向 editor_icon / player_icon',
    names.includes('editor_icon') && names.includes('player_icon') && holders.every((h) => String(h.children[0]?.style?.['--ic-url'] ?? '').includes('assets/icons/')),
    names.join(' | '),
  );
  check('副标题已从「正在加载脚本…」换成正常文案', !/正在加载脚本/.test(byId.get('st-subtitle')?.textContent ?? ''), byId.get('st-subtitle')?.textContent);
}

section('编辑器 / 播放器里不再有内置示例谱面的入口');
{
  const playerHtml = fs.readFileSync(path.join(ROOT, 'player.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/app/main.js'), 'utf8');
  const editorSrc = fs.readFileSync(path.join(ROOT, 'src/editor/main.js'), 'utf8');
  check('播放器页面去掉了示例按钮容器', !/id="samples"/.test(playerHtml), 'player.html');
  check('播放器不再内置示例包与快速载入', !/SAMPLES/.test(appSrc) && !/loadSample/.test(appSrc) && !/sample=/.test(appSrc), 'src/app/main.js');
  check('编辑器不再渲染内置示例标签', !/SAMPLES/.test(editorSrc) && !/preview\.loadSample/.test(editorSrc), 'src/editor/main.js');
  check('编辑器入口改为欢迎弹窗（文件夹包 / zip 包 / 新建项目）', /createWelcome/.test(editorSrc) && fs.existsSync(path.join(ROOT, 'src/editor/welcome.js')));
}

section('文档：Markdown 表格完整性（防止误改脚本把表格管道符删掉）');
{
  // 表格行都以 `|` 开头；曾经有一次批量文本替换把整份 docs/项目文档.md 的 `|` 换成了空格，
  // 表格在 GitHub 上直接变成普通文本 —— 这里加一条自动守卫。
  const docs = ['README.md', 'docs/谱师文档.md', 'docs/Phigros文档.md', 'docs/项目文档.md'];
  for (const file of docs) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    let tableRows = 0;
    let broken = 0;
    let inFence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) continue;
      if (/^\s*\|/.test(line)) {
        tableRows++;
        if (!/\|\s*$/.test(line)) broken++; // 缺少结尾管道符
      }
    }
    check(`${file} 的表格行都以 | 开头且以 | 结尾`, tableRows > 0 && broken === 0, `${tableRows} 行表格，${broken} 行缺少结尾 |`);
  }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
