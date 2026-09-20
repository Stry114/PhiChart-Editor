/**
 * 开始页：引导「打开项目 / 打开包 / 新建项目」+ 测试用快速入口。
 *
 * 跨页交接：把要打开的内容写进 IndexedDB（src/ui/handoff.js），再跳到编辑器 edit.html；
 * 编辑器启动时取走并载入。内置示例包只传一个 id（编辑器自己 fetch），
 * 用户选的文件传 Blob（40MB 的 RPE 谱面也能过，localStorage 存不下）。
 */
import { icon, ICONS } from '../ui/icons.js';
import { saveHandoff } from '../ui/handoff.js';
import { makeProject, projectStats } from '../ui/project.js';

const $ = (id) => document.getElementById(id);
const EDITOR_URL = 'edit.html';
const PLAYER_URL = 'player.html';

// 页面里静态写的是「正在加载脚本…」：脚本跑到这里就说明加载完成，换回正常副标题
const subtitleEl = $('st-subtitle');
if (subtitleEl) subtitleEl.textContent = 'Phigros 谱面渲染器 / 制谱器 · 选择一种方式开始';

const SAMPLES = [
  { id: 'official', label: '白复生 AT（official）' },
  { id: 'rpe', label: '领土战争 AT（RPE）' },
];

function setStatus(text, kind = '') {
  const box = $('st-status');
  if (!box) return;
  box.className = `st-status${kind ? ` ${kind}` : ''}`;
  box.textContent = text;
}

/** 页面上 data-icon 占位符换成真图标 */
function mountIcons() {
  for (const holder of document.querySelectorAll('[data-icon]')) {
    const name = holder.getAttribute('data-icon');
    const size = Number(holder.getAttribute('data-icon-size')) || (holder.classList.contains('st-card-ico') ? 18 : 15);
    holder.appendChild(icon(name, { size }));
  }
}

async function goEditor(payload, statusText) {
  setStatus(`${statusText}，正在打开编辑器…`, 'ok');
  const where = await saveHandoff(payload);
  if (!where) {
    setStatus('无法把内容交给编辑器（浏览器禁用了本地存储），请改用「打开谱面包」在编辑器内载入。', 'error');
    return;
  }
  globalThis.location.href = EDITOR_URL;
}

function wireOpenProject() {
  const input = $('st-file');
  $('st-open-project').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`);
    // 先粗检一下是不是 JSON，避免把明显不是谱面的文件丢给编辑器
    try {
      const head = (await file.slice(0, 4096).text()).trim();
      if (!head.startsWith('{') && !head.startsWith('[')) {
        setStatus('这个文件看起来不是 JSON 谱面/项目文件。', 'error');
        return;
      }
    } catch {
      /* 读取失败就交给编辑器报错 */
    }
    await goEditor({ kind: 'file', blob: file, name: file.name }, `准备打开 ${file.name}`);
  });
}

function wireOpenPackage() {
  // 包（文件夹 / zip）必须在编辑器页内选，才能拿到文件并把音频/曲绘一起读进来
  $('st-open-package').addEventListener('click', async () => {
    setStatus('进入编辑器：用左上「谱面总览」里的「选择谱面包目录 / 选择 zip 谱面包」载入。', 'ok');
    globalThis.location.href = EDITOR_URL;
  });
}

function wireNewProject() {
  const form = $('st-form');
  const open = () => {
    form.classList.remove('hidden');
    $('st-f-name').focus();
  };
  $('st-new-project').addEventListener('click', () => (form.classList.contains('hidden') ? open() : form.classList.add('hidden')));
  $('st-form-cancel').addEventListener('click', () => form.classList.add('hidden'));

  const readForm = () => ({
    name: $('st-f-name').value.trim() || '未命名项目',
    bpm: Number($('st-f-bpm').value) || 174,
    seconds: Number($('st-f-sec').value) || 60,
    lines: Number($('st-f-lines').value) || 4,
    withDemoNotes: $('st-f-demo').checked,
  });

  $('st-form-create').addEventListener('click', async () => {
    const opts = readForm();
    const chart = makeProject(opts);
    const stats = projectStats(chart);
    await goEditor({ kind: 'json', json: chart, label: opts.name }, `已生成项目「${opts.name}」（${stats.lines} 线 / ${stats.notes} 音符）`);
  });
  $('st-form-test').addEventListener('click', async () => {
    const opts = { ...readForm(), name: `${readForm().name}（测试）`, withDemoNotes: true };
    const chart = makeProject(opts);
    const stats = projectStats(chart);
    await goEditor(
      { kind: 'json', json: chart, label: opts.name },
      `已生成测试项目（${stats.lines} 线 / ${stats.notes} 音符 / ${stats.events} 事件）`,
    );
  });
}

function wireQuickOpen() {
  const openSample = (id) => {
    const sample = SAMPLES.find((s) => s.id === id);
    void goEditor({ kind: 'sample', id }, `准备载入示例包：${sample?.label ?? id}`);
  };
  $('st-open-official').addEventListener('click', () => openSample('official'));
  $('st-open-rpe').addEventListener('click', () => openSample('rpe'));

  const openTestProject = (lines, label) => {
    const chart = makeProject({ name: label, bpm: 174, seconds: lines > 8 ? 120 : 45, lines, withDemoNotes: true });
    const stats = projectStats(chart);
    void goEditor(
      { kind: 'json', json: chart, label },
      `已生成测试项目「${label}」（${stats.lines} 线 / ${stats.notes} 音符 / ${stats.events} 事件）`,
    );
  };
  $('st-open-test').addEventListener('click', () => openTestProject(4, '测试项目 · 4 线'));
  $('st-open-test-lines').addEventListener('click', () => openTestProject(12, '测试项目 · 12 线事件密集'));

  $('st-open-player').addEventListener('click', async () => {
    // 播放器页自带示例按钮，这里直接把示例 id 放进去让它自动载入
    await saveHandoff({ kind: 'sample', id: 'official' });
    setStatus('正在打开播放器…', 'ok');
    globalThis.location.href = `${PLAYER_URL}?sample=official`;
  });
}

mountIcons();
wireOpenProject();
wireOpenPackage();
wireNewProject();
wireQuickOpen();
setStatus(
  globalThis.location?.protocol === 'file:'
    ? '提示：当前是 file:// 打开，内置示例包不可用；「测试项目」「新建项目」以及「打开项目/谱面」都能正常用。'
    : '选择一种方式开始；内置示例包与测试项目都可直接打开。',
);

void ICONS;
