/**
 * 左上工作区「导出」页。
 *
 * 三个按钮（用户需求）：
 *  1. **导出为官谱（zip 包）** —— `<曲名>.json`（official v3）+ `info.txt` + 音频 + 曲绘
 *  2. **导出为 RPE 谱（zip 包）** —— 同上，谱面 JSON 换成 RPE 格式（META 带音频/曲绘文件名）
 *  3. **保存项目（内部格式）** —— `.pce.json`，单个文件，存的是**完整模型**（含事件层与缓动的编号参数）
 *
 * 另有「打开项目文件」：项目是编辑器唯一的无损格式，所以**反序列化**入口就放在这一页
 * （也可以把 `.pce.json` 直接拖进编辑器，或用欢迎弹窗的 JSON 入口打开）。
 * 项目文件不含音频/曲绘：选择时**可以多选**，同目录下的音频与曲绘会按 `meta.song` /
 * `meta.background` 的文件名自动挂上。
 *
 * 本页只负责 DOM 与下载动作；打包与序列化全在 `src/core/export-package.js`（纯数据，可单测）。
 */
import { setIcon, ICONS } from '../ui/icons.js';
import { buildExport } from '../core/export-package.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 触发浏览器下载（DOM 桩件环境里失败也不抛错，只影响「有没有真的存下来」） */
export function downloadBlob(blob, fileName) {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body?.appendChild?.(a);
    a.click?.();
    a.remove?.();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* 忽略 */
      }
    }, 2000);
    return true;
  } catch (err) {
    console.warn('[editor] 下载失败：', err);
    return false;
  }
}

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/**
 * 渲染「导出」页。
 * @param {HTMLElement} root 标签页容器（每次切到本页都会清空重渲染）
 * @param {{preview:object, autosave?:object, onStatus?:(msg:string)=>void, onAfterLoad?:(label:string)=>void}} ctx
 */
export function renderExportTab(root, ctx = {}) {
  const { preview, autosave, onStatus, onAfterLoad } = ctx;
  const chart = preview?.chart ?? null;
  const wrap = el('div', 'ed-export');
  root.appendChild(wrap);

  // ── 第一行：三种导出 ──
  const bar = el('div', 'ed-list ed-export-bar');
  const buttons = [];
  // 顺序按用途：内部格式（唯一的「保存」，放最前）→ RPE → 官谱
  const kinds = [
    {
      kind: 'project',
      icon: ICONS.download,
      text: '保存项目（内部格式，zip 包）',
      primary: true,
      title: 'project.json + info.txt + 全部资源文件',
    },
    { kind: 'rpe', icon: ICONS.download, text: '导出为 RPE 谱（zip 包）', primary: false, title: 'RPE 格式（保留事件层与缓动）' },
    { kind: 'official', icon: ICONS.download, text: '导出为官谱（zip 包）', primary: false, title: '官方格式 + info.txt + 音频 + 曲绘' },
  ];
  for (const spec of kinds) {
    const btn = el('button', `ed-btn${spec.primary ? ' primary' : ''}`);
    btn.type = 'button';
    btn.setAttribute('data-export', spec.kind); // 用 setAttribute：CSS/测试选择器都能命中
    btn.title = spec.title;
    setIcon(btn, spec.icon, { size: 14, text: spec.text });
    btn.addEventListener('click', () => runExport(spec.kind));
    bar.appendChild(btn);
    buttons.push(btn);
  }
  wrap.appendChild(bar);

  // ── 第二行：打开项目（反序列化）──
  const openBar = el('div', 'ed-list ed-export-bar');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true; // 项目 + 音频 + 曲绘可以一起选
  input.accept = '.zip,.json,.wav,.mp3,.ogg,.m4a,.aac,.flac,.png,.jpg,.jpeg,.webp';
  input.style.display = 'none';
  const openBtn = el('button', 'ed-btn');
  openBtn.type = 'button';
  openBtn.title = '读取 .pce.zip / .pce.json（可同时选中音频与曲绘）';
  setIcon(openBtn, ICONS.openFolder, { size: 14, text: '打开项目文件…' });
  openBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = ''; // 同一个文件再选一次也要触发
    if (!files.length) return;
    const zipFile = files.find((f) => /\.zip$/i.test(f.name ?? ''));
    const projectFile = files.find((f) => /\.json$/i.test(f.name ?? '')) ?? (zipFile ? null : files[0]);
    const label = zipFile?.name ?? projectFile?.name ?? files[0].name;
    try {
      onStatus?.(`正在打开项目：${label}…`);
      if (zipFile && !projectFile) {
        // 项目 zip（.pce.zip）：项目 JSON 与资源都在包里，载入时自动认领
        await preview.loadZip(zipFile);
      } else {
        const json = JSON.parse(await projectFile.text());
        await preview.loadProject(json, projectFile.name, files.filter((f) => f !== projectFile));
      }
      onAfterLoad?.(label);
      onStatus?.(`已打开项目：${label}`);
    } catch (err) {
      showResult('bad', '打开项目失败', [String(err?.message ?? err)]);
      onStatus?.(`打开项目失败：${err?.message ?? err}`);
    }
  });
  openBar.append(openBtn, input);
  wrap.appendChild(openBar);

  // ── 当前谱面摘要 ──
  const kv = el('div', 'ed-kv');
  if (!chart) {
    wrap.appendChild(el('div', 'ed-hint', '尚未载入谱面。'));
    return { buttons, open: openBtn, kind: 'empty' };
  }
  const eventCount = chart.lines.reduce(
    (n, line) => n + (line?.layers ?? []).reduce((m, layer) => m + Object.values(layer ?? {}).reduce((k, arr) => k + (Array.isArray(arr) ? arr.length : 0), 0), 0),
    0,
  );
  const rows = [
    ['曲名', chart.meta.name || '(无)'],
    ['格式', preview?.formatLabel?.(chart) ?? chart.format],
    ['判定线 / 音符', `${chart.lines.length} / ${chart.notes.length}（物量 ${chart.noteCount}）`],
    ['事件', `${eventCount} 条 / ${chart.lines.reduce((n, l) => n + (l?.layers?.length ?? 0), 0)} 层`],
    ['时长 / offset', `${chart.endTime.toFixed(2)} s / ${chart.meta.offset} s`],
    ['音频', `${chart.meta.song || '(无)'}${preview?.hasAudio ? '　✓' : '　✗ 未载入'}`],
    ['曲绘', `${chart.meta.background || '(无)'}${preview?.hasBackground ? '　✓' : '　✗ 未载入'}`],
    ['项目文件名', `${(chart.meta.name || 'chart').replace(/[\\/:*?"<>|]/g, '_').replace(/\.(json|pce)$/i, '')}.pce.zip`],
  ];
  for (const [k, v] of rows) {
    kv.append(el('div', 'k', k), el('div', 'v', String(v)));
  }
  // 会一起打进项目 zip 的资源（异步统计：包文件表在 preview 里）
  const resKey = el('div', 'k', '包内资源');
  const resVal = el('div', 'v', '统计中…');
  kv.append(resKey, resVal);
  Promise.resolve(preview?.resources?.() ?? [])
    .then((list) => {
      resVal.textContent = list.length ? `${list.length} 个：${list.map((r) => r.name).slice(0, 4).join('、')}${list.length > 4 ? ' 等' : ''}` : '无';
    })
    .catch(() => {
      resVal.textContent = '统计失败';
    });
  // 本地草稿：意外关闭后的补救，明确说明它不能替代保存
  const draftKey = el('div', 'k', '本地草稿');
  const draftVal = el('div', 'v', autosave?.savedAtLabel?.() ? `${autosave.savedAtLabel()}（不能替代保存）` : '无');
  kv.append(draftKey, draftVal);
  wrap.appendChild(kv);

  wrap.appendChild(
    el('div', 'ed-hint', '官谱 / RPE zip 解压后即为可直接载入的谱面包；项目 zip 含全部资源，用于无损存回。只有「保存项目」会写入文件。'),
  );

  const resultBox = el('div', 'ed-export-result');
  wrap.appendChild(resultBox);

  /**
   * 把一次导出的结果画到页面上。
   *  - `details`：这次导出的客观信息（文件名/大小/包内文件/条数），灰字
   *  - `warnings`：序列化的告警（有损的地方），黄块 + 控制台
   */
  function showResult(level, title, details = [], warnings = []) {
    resultBox.innerHTML = '';
    resultBox.appendChild(el('div', level === 'ok' ? 'ed-ok' : level === 'info' ? 'ed-hint' : 'ed-warn', title));
    const list = (items, cls) => {
      if (!items.length) return;
      const ul = el('ul', cls);
      for (const item of items) ul.appendChild(el('li', null, String(item)));
      resultBox.appendChild(ul);
    };
    list(details, 'ed-export-detail');
    list(
      warnings.length > 12 ? [...warnings.slice(0, 12), `…其余 ${warnings.length - 12} 条见控制台`] : warnings,
      'ed-export-warns',
    );
    for (const w of warnings) console.warn('[editor] 导出告警：', w);
  }

  async function runExport(kind) {
    if (!preview?.chart) return;
    for (const b of buttons) b.disabled = true;
    const label = kinds.find((k) => k.kind === kind)?.text ?? kind;
    onStatus?.(`${label}：正在打包…`);
    try {
      const media = preview.media ? await preview.media() : {};
      const resources = preview.resources ? await preview.resources() : [];
      const out = await buildExport(preview.chart, kind, { media, resources });
      const size = out.blob?.size ?? out.text?.length ?? 0;
      const saved = downloadBlob(out.blob, out.fileName);
      const stats = out.stats ?? {};
      const details = [
        `${out.fileName}　${fmtSize(size)}`,
        out.entries ? `包含：${out.entries.join('、')}` : '',
        stats.lines !== undefined ? `判定线 ${stats.lines} / 音符 ${stats.notes}${stats.events !== undefined ? ` / 事件 ${stats.events}` : ''}` : '',
        saved ? '已触发下载。' : '已生成，但当前环境不支持自动下载。',
      ].filter(Boolean);
      showResult(out.warnings?.length ? 'warn' : 'ok', `${label}完成`, details, out.warnings ?? []);
      if (kind === 'project') {
        // 只有「保存项目」才算真的保存：清掉未保存状态与草稿；官谱 / RPE 导出是有损互操作，不算
        autosave?.markSaved?.();
        onStatus?.(`项目已保存：${out.fileName}`);
      } else {
        onStatus?.(`已导出：${out.fileName}（项目仍未保存）`);
      }
    } catch (err) {
      showResult('bad', `导出失败：${err?.message ?? err}`);
      onStatus?.(`导出失败：${err?.message ?? err}`);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  return { buttons, open: openBtn, runExport, kind: 'ready' };
}
