/**
 * 「先打开内容」欢迎弹窗（进入编辑器时的醒目提醒）。
 *
 * 需求：开始页已经只留「编辑器 / 播放器」两个入口，打开内容的功能下放到编辑器内 ——
 * 所以编辑器一进来就是**锁住**的：必须先
 *   ① 打开谱面包文件夹  ② 打开 zip 谱包  ③ 创建新项目（填全部元数据 + 上传音频/背景图）
 * 三者之一；也留了一条「打开谱面 / 项目 JSON」的次要入口（.pce.json 与单个谱面 JSON）。
 *
 * 载入成功后弹窗自动消失（主循环检测到 `preview.chart` 就会关，见 main.js），
 * 期间编辑器不响应快捷键。这里是纯 DOM + 既有 API，载入本身仍走 `preview.loadZip/loadFiles/loadJson`。
 */
import { setIcon, ICONS } from '../ui/icons.js';
import { createBlankProject } from '../core/project.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac|flac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** 新建项目表单的字段（全部元数据 + 媒体） */
const META_FIELDS = [
  { key: 'name', label: '曲名', placeholder: '必填', required: true },
  { key: 'composer', label: '曲师', placeholder: '作曲者' },
  { key: 'charter', label: '谱师', placeholder: '谱面作者' },
  { key: 'illustrator', label: '曲绘师', placeholder: '曲绘画师' },
  { key: 'level', label: '难度', placeholder: '如 AT Lv.15' },
  { key: 'id', label: 'ID / Path', placeholder: '如 29519800' },
];

/**
 * @param {{preview:object, autosave?:object, onStatus?:(msg:string)=>void, onAfterLoad?:(label:string)=>void}} ctx
 *        autosave：草稿的读取与丢弃（恢复卡片用）；不传则不显示恢复入口
 */
export function createWelcome(ctx) {
  const { preview, autosave, onStatus, onAfterLoad } = ctx;
  let open = true;
  let busy = false;
  let draftSummary = null; // 启动时读到的草稿概要（恢复卡片用）

  const overlay = el('div', 'ed-welcome');
  const box = el('div', 'ed-welcome-box');

  const title = el('div', 'ed-welcome-title', '打开谱面');
  const sub = el('div', 'ed-welcome-sub', '选择载入方式后开始编辑。本页面不把文件写入磁盘，编辑后请在「导出」页保存项目。');

  // ── 草稿恢复卡片（启动时若浏览器本地有未保存的草稿才显示）──
  const draftCard = el('div', 'ed-welcome-card ed-welcome-draft hidden');
  const draftBtn = el('button', 'ed-welcome-draft-main');
  draftBtn.type = 'button';
  draftBtn.setAttribute('data-welcome', 'draft');
  setIcon(draftBtn, ICONS.backPage, { size: 22 });
  const draftText = el('div');
  draftText.appendChild(el('span', 'ed-welcome-card-title', '恢复未保存的草稿'));
  const draftMeta = el('span', 'ed-welcome-card-desc', '');
  draftText.appendChild(draftMeta);
  draftBtn.appendChild(draftText);
  const draftDiscard = el('button', 'ed-welcome-link', '丢弃草稿');
  draftDiscard.type = 'button';
  draftDiscard.setAttribute('data-welcome', 'discard-draft');
  draftCard.append(draftBtn, draftDiscard);

  // ── 三个主要入口 ──
  const actions = el('div', 'ed-welcome-actions');
  const folderInput = el('input');
  folderInput.type = 'file';
  folderInput.webkitdirectory = true;
  folderInput.multiple = true;
  folderInput.style.display = 'none';
  const zipInput = el('input');
  zipInput.type = 'file';
  zipInput.accept = '.zip';
  zipInput.style.display = 'none';
  const jsonInput = el('input');
  jsonInput.type = 'file';
  jsonInput.accept = '.json';
  jsonInput.multiple = true;
  jsonInput.style.display = 'none';

  const mkButton = (kind, iconName, text, desc, primary) => {
    const btn = el('button', `ed-welcome-card${primary ? ' primary' : ''}`);
    btn.type = 'button';
    btn.setAttribute('data-welcome', kind);
    setIcon(btn, iconName, { size: 22 });
    btn.appendChild(el('span', 'ed-welcome-card-title', text));
    btn.appendChild(el('span', 'ed-welcome-card-desc', desc));
    actions.appendChild(btn);
    return btn;
  };
  const folderBtn = mkButton('folder', ICONS.openFolder, '打开文件夹包', '含音频与曲绘的谱面包目录', true);
  const zipBtn = mkButton('zip', ICONS.download, '打开 zip 谱包', '谱面包 zip 或 .pce.zip 项目包', false);
  const newBtn = mkButton('new', ICONS.add, '创建新项目', '填写元数据，上传音频与背景图', false);

  // ── 次要入口：单个 JSON ──
  const altRow = el('div', 'ed-welcome-alt');
  const jsonBtn = el('button', 'ed-welcome-link', '打开谱面 / 项目 JSON');
  jsonBtn.type = 'button';
  jsonBtn.setAttribute('data-welcome', 'json');
  altRow.appendChild(jsonBtn);
  const back = el('a', 'ed-welcome-link', '返回开始页');
  back.href = 'index.html';
  back.style.marginLeft = '14px';
  altRow.appendChild(back);

  const statusEl = el('div', 'ed-welcome-status');

  // ── 新建项目表单 ──
  const form = el('div', 'ed-newproj hidden');
  const formTitle = el('div', 'ed-newproj-title', '创建新项目');
  const grid = el('div', 'ed-newproj-grid');
  const inputs = {};
  for (const field of META_FIELDS) {
    const label = el('label', 'ed-newproj-field');
    label.appendChild(el('span', null, field.label));
    const input = el('input');
    input.type = 'text';
    input.placeholder = field.placeholder ?? '';
    input.setAttribute('data-meta', field.key);
    inputs[field.key] = input;
    label.appendChild(input);
    grid.appendChild(label);
  }
  const numField = (key, labelText, value, min, max) => {
    const label = el('label', 'ed-newproj-field');
    label.appendChild(el('span', null, labelText));
    const input = el('input');
    input.type = 'number';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.setAttribute('data-meta', key);
    inputs[key] = input;
    label.appendChild(input);
    grid.appendChild(label);
  };
  numField('bpm', 'BPM', 174, 1, 1000);
  numField('lines', '判定线数', 4, 1, 200);

  // 媒体：音频 + 背景图（必需）
  const mediaRow = el('div', 'ed-newproj-media');
  const songInput = el('input');
  songInput.type = 'file';
  songInput.accept = 'audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac';
  songInput.style.display = 'none';
  const bgInput = el('input');
  bgInput.type = 'file';
  bgInput.accept = 'image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif';
  bgInput.style.display = 'none';
  const mkPick = (labelText, input, hint) => {
    const wrap = el('div', 'ed-newproj-pick');
    wrap.appendChild(el('div', 'k', labelText));
    const btn = el('button', 'ed-btn');
    btn.type = 'button';
    setIcon(btn, ICONS.openFolder, { size: 14, text: '选择文件…' });
    const name = el('span', 'v dim', hint);
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      name.textContent = file ? `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）` : hint;
    });
    wrap.append(btn, name);
    mediaRow.appendChild(wrap);
    return name;
  };
  const songName = mkPick('音频（必填）', songInput, 'wav / mp3 / ogg');
  const bgName = mkPick('背景图（必填）', bgInput, 'png / jpg / webp');

  const formActions = el('div', 'ed-newproj-actions');
  const createBtn = el('button', 'ed-btn primary', '创建并开始制谱');
  createBtn.type = 'button';
  createBtn.setAttribute('data-welcome', 'create');
  const cancelBtn = el('button', 'ed-btn', '返回');
  cancelBtn.type = 'button';
  cancelBtn.setAttribute('data-welcome', 'cancel');
  formActions.append(createBtn, cancelBtn);
  const formHint = el(
    'div',
    'ed-hint',
    '新项目含 N 条判定线与默认事件，音符用时间轴的「添加」工具放置；资源会打进项目 zip。',
  );
  form.append(formTitle, grid, mediaRow, formActions, formHint);

  box.append(title, sub, draftCard, actions, altRow, statusEl, form);
  overlay.appendChild(box);
  overlay.append(folderInput, zipInput, jsonInput, songInput, bgInput);

  function setStatus(text, kind = '') {
    statusEl.className = `ed-welcome-status${kind ? ` ${kind}` : ''}`;
    statusEl.textContent = text ?? '';
  }

  /** 草稿概要是异步读的：卡片先建好，有草稿时才显示 */
  const fmtSavedAt = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '—';
  };
  async function refreshDraftCard() {
    if (!autosave) return null;
    const index = await autosave.loadDraftIndex().catch(() => null);
    draftSummary = index;
    if (!index) {
      draftCard.classList.add('hidden');
      return null;
    }
    const source = index.sourceFormat === 'rpe' ? 'RPE' : index.sourceFormat === 'official' ? '官方' : '项目';
    const missing = (index.resources ?? []).filter((r) => !r.key).length;
    draftMeta.textContent = `${index.label || '未命名'} · ${source} · ${fmtSavedAt(index.savedAt)}${missing ? ` · ${missing} 个资源需重新选择` : ''}`;
    draftCard.classList.remove('hidden');
    return index;
  }
  void refreshDraftCard();

  draftBtn.addEventListener('click', () => {
    void loadAndClose(draftSummary?.label || '草稿', async () => {
      const rec = await autosave.readDraft();
      if (!rec) throw new Error('草稿已不存在');
      await preview.loadJson(rec.json, rec.label || '草稿', rec.files);
      autosave.markEdited('恢复草稿');
    });
  });
  draftDiscard.addEventListener('click', async () => {
    await autosave.discardDraft();
    draftSummary = null;
    draftCard.classList.add('hidden');
    setStatus('草稿已丢弃。');
  });

  function show() {
    open = true;
    overlay.classList.remove('hidden');
  }

  function hide() {
    open = false;
    overlay.classList.add('hidden');
  }

  /** 载入期间的忙碌态：按钮禁用，避免重复触发 */
  async function run(fn) {
    if (busy) return false;
    busy = true;
    for (const b of [folderBtn, zipBtn, newBtn, jsonBtn, createBtn]) b.disabled = true;
    setStatus('载入中…');
    try {
      await fn();
      return true;
    } catch (err) {
      setStatus(`载入失败：${err?.message ?? err}`, 'error');
      onStatus?.(`载入失败：${err?.message ?? err}`);
      return false;
    } finally {
      busy = false;
      for (const b of [folderBtn, zipBtn, newBtn, jsonBtn, createBtn]) b.disabled = false;
    }
  }

  async function loadAndClose(label, fn) {
    const ok = await run(fn);
    if (ok) {
      onAfterLoad?.(label);
      hide();
      onStatus?.(`已载入：${label}`);
    }
  }

  folderBtn.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    const files = [...(folderInput.files ?? [])];
    folderInput.value = '';
    if (files.length) void loadAndClose(files[0].webkitRelativePath?.split('/')[0] || '谱面包', () => preview.loadFiles(files));
  });

  zipBtn.addEventListener('click', () => zipInput.click());
  zipInput.addEventListener('change', () => {
    const file = zipInput.files?.[0];
    zipInput.value = '';
    if (file) void loadAndClose(file.name, () => preview.loadZip(file));
  });

  jsonBtn.addEventListener('click', () => jsonInput.click());
  jsonInput.addEventListener('change', async () => {
    const files = [...(jsonInput.files ?? [])];
    jsonInput.value = '';
    if (!files.length) return;
    const jsonFile = files.find((f) => /\.json$/i.test(f.name)) ?? files[0];
    const others = files.filter((f) => f !== jsonFile);
    void loadAndClose(jsonFile.name, async () => {
      const json = JSON.parse(await jsonFile.text());
      await preview.loadJson(json, jsonFile.name, others);
    });
  });

  newBtn.addEventListener('click', () => {
    form.classList.remove('hidden');
    actions.classList.add('hidden');
    altRow.classList.add('hidden');
    setStatus('');
    inputs.name.focus?.();
  });
  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    actions.classList.remove('hidden');
    altRow.classList.remove('hidden');
    setStatus('');
  });

  createBtn.addEventListener('click', async () => {
    const songFile = songInput.files?.[0] ?? null;
    const bgFile = bgInput.files?.[0] ?? null;
    const name = inputs.name.value.trim();
    const missing = [];
    if (!name) missing.push('曲名');
    if (!songFile) missing.push('音频');
    if (!bgFile) missing.push('背景图');
    if (missing.length) {
      setStatus(`还缺：${missing.join('、')}`, 'error');
      return;
    }
    if (!AUDIO_EXT.test(songFile.name)) setStatus(`音频格式异常：${songFile.name}`, 'error');
    if (!IMAGE_EXT.test(bgFile.name)) setStatus(`背景图格式异常：${bgFile.name}`, 'error');
    const meta = { name };
    for (const field of META_FIELDS) if (field.key !== 'name') meta[field.key] = inputs[field.key].value.trim();
    meta.song = songFile.name;
    meta.background = bgFile.name;
    const bpm = Number(inputs.bpm.value) || 174;
    const lines = Number(inputs.lines.value) || 4;
    const model = createBlankProject({ meta, bpm, lines });
    await loadAndClose(name, () => preview.loadJson(model, name, [songFile, bgFile]));
  });

  return {
    el: overlay,
    get isOpen() {
      return open;
    },
    show,
    hide,
    /** 重新检查有没有草稿（自动保存之后可以再调） */
    refreshDraftCard,
  };
}
