// 开始页的无头冒烟测试：跑真正的 src/start/main.js（用最小 DOM 桩件），
// 检查图标挂载、三个主操作与快速入口写出的交接数据是否有效，
// 并且**生成的项目必须能被解析器 + 编译器吃下去**（否则编辑器打开就是空的）。
// 运行：node tools/start-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseOfficialChart } from '../src/core/parse-official.js';
import { prepareChart } from '../src/core/model.js';

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
  constructor(node) {
    this.set = new Set();
    this.node = node;
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
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new ClassList(this);
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = '';
    this.value = '';
    this.checked = false;
    this.files = [];
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
  set innerHTML(v) {
    this._text = String(v);
    this.children = [];
  }
  get innerHTML() {
    return this._text;
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
  click() {
    this.dispatch('click');
  }
  focus() {}
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
        const key = sel.slice(1, -1);
        if (!key.includes('=')) return node.attributes.has(key);
        const [k, v] = key.split('=');
        return node.getAttribute(k) === v.replace(/["']/g, '');
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

const byId = new Map();
const body = new Node('body');
globalThis.document = {
  body,
  documentElement: body,
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => new Node(tag),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
};

const sessionStore = new Map();
globalThis.sessionStorage = {
  getItem: (k) => sessionStore.get(k) ?? null,
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// 不提供 indexedDB → 走 sessionStorage 兜底路径（浏览器里会走 IndexedDB）
const locationState = { href: 'start.html', protocol: 'http:', search: '', hash: '' };
globalThis.location = locationState;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

// ───────────────────────── 装载 start.html 的 DOM 骨架 ─────────────────────────
section('搭建 start.html 骨架');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 连 class 一起解析，保证桩件里的初始状态与页面一致（例如 st-form 初始带 hidden）
  const tags = [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map((m) => ({
    id: m[1],
    cls: (/class="([^"]*)"/.exec(m[0]) ?? [, ''])[1],
  }));
  const ids = tags.map((t) => t.id);
  const iconHolders = [...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]);
  for (const { id, cls } of tags) {
    const node = new Node(id === 'st-file' ? 'input' : 'div');
    node.id = id;
    if (cls) node.className = cls;
    if (id === 'st-file') node.files = [];
    byId.set(id, node);
    body.appendChild(node);
  }
  // data-icon 占位符（页面里在若干按钮/卡片上）
  for (const name of iconHolders) {
    const holder = new Node('span');
    holder.setAttribute('data-icon', name);
    holder.classList.add('st-card-ico');
    body.appendChild(holder);
  }
  check('页面 id 全部就位', ids.length >= 12, `${ids.length} 个 id`);
  check('页面里有 data-icon 占位符', iconHolders.length >= 3, `${iconHolders.length} 个：${iconHolders.join(',')}`);
}

section('启动 start/main.js');
await import('../src/start/main.js');
{
  const holders = body.querySelectorAll('[data-icon]');
  const mounted = holders.filter((h) => h.children.some((c) => String(c.className).split(/\s+/).some((k) => k.startsWith('ic-') && k !== 'ic')));
  check('data-icon 全部换成了矢量图标', mounted.length === holders.length, `${mounted.length}/${holders.length}`);
  const first = holders[0]?.children[0];
  check('图标用 mask 变量指向 assets/icons', String(first?.style?.['--ic-url'] ?? '').includes('assets/icons/'), first?.style?.['--ic-url']);
  check('状态行有初始提示', ($('st-status').textContent ?? '').length > 0, $('st-status').textContent.slice(0, 40));
}

function $(id) {
  return byId.get(id);
}
function takePayload() {
  const raw = sessionStore.get('phichart-handoff');
  sessionStore.delete('phichart-handoff');
  return raw ? JSON.parse(raw) : null;
}

section('主操作：新建项目 / 测试项目');
{
  $('st-new-project').click();
  check('点「新建项目」展开表单', !$('st-form').classList.contains('hidden'));
  $('st-f-name').value = '冒烟测试项目';
  $('st-f-bpm').value = '150';
  $('st-f-sec').value = '30';
  $('st-f-lines').value = '3';
  $('st-f-demo').checked = false;
  $('st-form-create').click();
  await new Promise((r) => setTimeout(r, 0));
  const payload = takePayload();
  check('「新建项目」写出交接数据', payload?.kind === 'json' && !!payload.json, JSON.stringify({ kind: payload?.kind, label: payload?.label }));
  check('页面向编辑器跳转', String(globalThis.location.href).includes('edit.html'), globalThis.location.href);
  const chart = parseOfficialChart(payload.json);
  const prepared = prepareChart(chart);
  check('生成的项目可被解析并编译', prepared.lines.length === 3 && prepared.lines.every((l) => !!l.rt), `lines=${prepared.lines.length}`);
  check('新建（无示例内容）项目不带音符', prepared.notes.length === 0, `notes=${prepared.notes.length}`);
  check('BPM 与时长按表单生效', prepared.lines[0].bpm === 150 && Math.abs(prepared.endTime) < 1e-9, `bpm=${prepared.lines[0].bpm}`);
}

section('快速入口：测试项目 / 示例包 / 播放器');
{
  globalThis.location.href = 'start.html';
  $('st-open-test').click();
  await new Promise((r) => setTimeout(r, 0));
  const payload = takePayload();
  const prepared = prepareChart(parseOfficialChart(payload.json));
  check('「测试项目」写出交接数据', payload?.kind === 'json', payload?.label);
  check('测试项目带音符与事件', prepared.notes.length > 0 && prepared.lines[0].layers[0].x.length > 0, `notes=${prepared.notes.length}`);
  const types = new Set(prepared.notes.map((n) => n.type));
  check('测试项目包含多种音符类型', types.size >= 3, [...types].join('/'));
  check('测试项目的 hold 有非零时长', prepared.notes.some((n) => n.type === 'hold' && n.durationSec > 0));
  check('全部音符 timeSec 有限', prepared.notes.every((n) => Number.isFinite(n.timeSec)));

  globalThis.location.href = 'start.html';
  $('st-open-test-lines').click();
  await new Promise((r) => setTimeout(r, 0));
  const dense = prepareChart(parseOfficialChart(takePayload().json));
  check('「12 线事件密集」测试项目可用', dense.lines.length === 12 && dense.notes.length > 0, `lines=${dense.lines.length} notes=${dense.notes.length}`);

  globalThis.location.href = 'start.html';
  $('st-open-official').click();
  await new Promise((r) => setTimeout(r, 0));
  const sample = takePayload();
  check('「官方示例包」写出 sample 交接', sample?.kind === 'sample' && sample.id === 'official', JSON.stringify(sample));

  globalThis.location.href = 'start.html';
  $('st-open-rpe').click();
  await new Promise((r) => setTimeout(r, 0));
  check('「RPE 示例包」写出 sample 交接', takePayload()?.id === 'rpe');

  globalThis.location.href = 'start.html';
  $('st-open-package').click();
  await new Promise((r) => setTimeout(r, 0));
  check('「打开谱面包」跳编辑器（在编辑器内选文件夹/zip）', globalThis.location.href === 'edit.html', globalThis.location.href);

  globalThis.location.href = 'start.html';
  $('st-open-player').click();
  await new Promise((r) => setTimeout(r, 0));
  check('「只看播放器」带 ?sample=official 跳播放器', String(globalThis.location.href).includes('player.html?sample=official'), globalThis.location.href);
}

section('打开项目 / 谱面文件');
{
  globalThis.location.href = 'start.html';
  const input = $('st-file');
  const json = JSON.stringify({ formatVersion: 3, offset: 0, judgeLineList: [{ bpm: 120, notesAbove: [], notesBelow: [], speedEvents: [{ startTime: 0, endTime: 320, value: 1 }], judgeLineMoveEvents: [{ startTime: 0, endTime: 320, start: 0.5, end: 0.5, start2: 0.5, end2: 0.5 }], judgeLineRotateEvents: [{ startTime: 0, endTime: 320, start: 0, end: 0 }], judgeLineDisappearEvents: [{ startTime: 0, endTime: 320, start: 1, end: 1 }] }] });
  const file = {
    name: 'my-chart.json',
    size: json.length,
    slice: () => ({ text: async () => json }),
    text: async () => json,
  };
  input.files = [file];
  input.dispatch('change');
  await new Promise((r) => setTimeout(r, 10));
  const payload = takePayload();
  check('选文件后写出 file 交接（Blob）', payload?.kind === 'file' && payload.name === 'my-chart.json', JSON.stringify({ kind: payload?.kind, name: payload?.name }));
  check('非 JSON 文件会被挡下', await (async () => {
    globalThis.location.href = 'start.html';
    const bad = { name: 'x.txt', size: 10, slice: () => ({ text: async () => 'hello' }), text: async () => 'hello' };
    input.files = [bad];
    input.dispatch('change');
    await new Promise((r) => setTimeout(r, 10));
    const leaked = takePayload();
    return leaked === null && !String(globalThis.location.href).includes('edit.html');
  })());
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? `：${failures.join('；')}` : ''}`);
process.exit(failed ? 1 : 0);
