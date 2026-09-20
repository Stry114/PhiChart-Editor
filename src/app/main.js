/**
 * 应用入口：加载贴图与谱面包、驱动主循环、绑定快捷键。
 * 渲染范围：只渲染关卡本体（不含开场/结束动画）。
 *
 * 载入方式只有「自己选」这一种（选择谱面包目录 / zip / 谱面 JSON / 拖放）——
 * 内置示例谱面的快速入口已按需求移除（它们是用于开发自测的第三方包，不应作为产品入口）。
 */
import { loadTextures } from '../render/textures.js';
import { createCanvasRenderer } from '../render/canvas2d.js';
import { detectFormat, prepareChart } from '../core/model.js';
import { Diagnostics } from '../core/sanitize.js';
import { parseOfficialChart } from '../core/parse-official.js';
import { parseRpeChart } from '../core/parse-rpe.js';
import { createState, advanceJudging, evaluate, resetState, formatScore } from '../core/state.js';
import { createPlayer } from './player.js';
import { loadFilePackage, loadZipPackage } from '../core/package.js';

const el = (id) => document.getElementById(id);
const canvas = el('stage');
const hud = {
  score: el('hud-score'),
  combo: el('hud-combo'),
  acc: el('hud-acc'),
  name: el('hud-name'),
  level: el('hud-level'),
  time: el('hud-time'),
  fps: el('hud-fps'),
  notes: el('hud-notes'),
  status: el('hud-status'),
};
const panel = {
  warnings: el('warnings'),
  info: el('chart-info'),
  fileInput: el('file-input'),
  zipInput: el('zip-input'),
  jsonInput: el('json-input'),
  playBtn: el('btn-play'),
  rate: el('rate'),
  noteWidth: el('note-width'),
  multiHint: el('multi-hint'),
  showLines: el('show-lines'),
  showNotes: el('show-notes'),
  progress: el('progress'),
};

let textures = null;
let renderer = null;
let chart = null;
let state = null;
let backgroundImage = null;
let currentAudioUrl = null;
let lastFrame = performance.now();
let fps = 0;
const playback = createPlayer();

function guessFormat(json) {
  return detectFormat(json);
}

function buildChart(json, { file, meta, info, infoCsv, diagnostics } = {}) {
  const format = guessFormat(json);
  if (format === 'rpe') return parseRpeChart(json, { file, meta, diagnostics });
  if (format === 'official') {
    const infoMeta = info
      ? { name: info.Name, composer: info.Composer, charter: info.Charter, illustrator: info.Illustrator, level: info.Level, id: info.Path }
      : undefined;
    const csvMeta = infoCsv
      ? {
          name: infoCsv.name,
          composer: infoCsv.composer,
          charter: infoCsv.charter,
          illustrator: infoCsv.illustrator,
          level: infoCsv.level,
          song: infoCsv.song,
          background: infoCsv.background,
        }
      : undefined;
    return parseOfficialChart(json, { file, meta: { ...csvMeta, ...infoMeta, ...meta }, diagnostics });
  }
  const why = isObjLike(json) && json.judgeLineList ? '有 judgeLineList 但缺少 formatVersion / META' : '缺少 judgeLineList';
  throw new Error(`无法识别的谱面格式（${why}）`);
}

function isObjLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 载入谱面：既可传「原始谱面 JSON」，也可传已经解析好的模型（含 lines 数组）。
 * 原始 JSON 会在这里被解析——**绝不能直接交给 prepareChart**（那样拿不到 chart.lines）。
 */
async function setChart(input, { audioUrl, backgroundUrl, sourceLabel, pkg, file, info } = {}) {
  // 解析诊断：字段缺失/类型错误/越界/事件不连续都会记录在这里，最后汇总展示（docs/05 §3.5）
  const diagnostics = new Diagnostics();
  const model = Array.isArray(input?.lines)
    ? input
    : buildChart(input, { file: file ?? sourceLabel, meta: pkg?.meta, info: info ?? pkg?.info, infoCsv: pkg?.infoCsv, diagnostics });
  chart = prepareChart(model, { diagnostics });
  diagnostics.info(
    `解析完成：${chart.lines.filter(Boolean).length} 条判定线、${chart.noteCount} 个音符、${chart.notes.length - chart.noteCount} 个假音符`,
  );
  chart.diagnostics = { summary: diagnostics.summary, messages: diagnostics.messages };
  state = createState(chart, { aspect: renderer.view.areaH ? renderer.view.areaW / renderer.view.areaH : 16 / 9 });
  playback.player.offset = chart.meta.offset || 0;
  playback.player.startedAt = 0;
  playback.player.playing = false;
  playback.player.hitsActive = [];

  renderer.opts.lineTexture = null;
  backgroundImage = null;
  if (backgroundUrl) {
    backgroundImage = await loadImageSafe(backgroundUrl);
    renderer.setBackground(backgroundImage);
  }
  await applyLineTexture(pkg);
  if (audioUrl) {
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = audioUrl.startsWith('blob:') ? audioUrl : null;
    try {
      await playback.loadAudio(audioUrl);
    } catch (err) {
      console.warn('音频加载失败，退化为无音频时钟：', err);
      playback.player.audioBuffer = null;
    }
  } else {
    playback.player.audioBuffer = null;
  }

  showInfo(sourceLabel);
  renderWarnings(chart.warnings ?? [], diagnostics);
  updateHud(true);
}

function loadImageSafe(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function showInfo(label) {
  const n = chart;
  const counts = { tap: 0, drag: 0, hold: 0, flick: 0 };
  for (const note of n.notes) counts[note.type]++;
  const lines = n.lines.length;
  const ext = n.format === 'rpe' && n.extendedKeys?.length ? `｜扩展事件（未渲染）：${n.extendedKeys.join(', ')}` : '';
  panel.info.innerHTML = `
    <div><b>${escapeHtml(n.meta.name || '(无曲名)')}</b> <span class="dim">${escapeHtml(n.meta.level || '')}</span></div>
    <div class="dim">${escapeHtml(label)}｜格式：${n.format === 'rpe' ? `RPE (v${n.source.rpeVersion})` : `official (v${n.source.formatVersion})`}</div>
    <div class="dim">曲师：${escapeHtml(n.meta.composer || '—')}｜谱师：${escapeHtml(n.meta.charter || '—')}｜offset：${n.meta.offset}s</div>
    <div class="dim">判定线 ${lines}｜音符 ${n.notes.length}（Tap ${counts.tap} / Drag ${counts.drag} / Hold ${counts.hold} / Flick ${counts.flick}）｜物量 ${n.noteCount}</div>
    <div class="dim">谱面时长 ${n.endTime.toFixed(2)}s${ext}</div>`;
}

function renderWarnings(list, diagnostics) {
  const head = diagnostics
    ? `<div class="dim">诊断：${escapeHtml(diagnostics.summary)}${
        chart.dropped && chart.dropped.notes + chart.dropped.lines + chart.dropped.events
          ? `｜已丢弃 ${chart.dropped.lines} 线 / ${chart.dropped.notes} 音符 / ${chart.dropped.events} 事件`
          : ''
      }</div>`
    : '';
  if (!list.length) {
    panel.warnings.innerHTML = `${head}<div class="ok">没有解析告警</div>`;
    return;
  }
  const shown = list.slice(0, 12);
  panel.warnings.innerHTML =
    head +
    shown.map((w) => `<div class="warn">· ${escapeHtml(w)}</div>`).join('') +
    (list.length > shown.length ? `<div class="dim">…其余 ${list.length - shown.length} 条见控制台</div>` : '');
  for (const w of list) console.info('[chart warning]', w);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function updateHud(force = false) {
  if (!state) return;
  const s = state.stats;
  hud.score.textContent = formatScore(s.score);
  hud.combo.textContent = s.combo > 2 ? `${s.combo}` : '';
  hud.acc.textContent = `${(s.accuracy * 100).toFixed(2)}%`;
  hud.name.textContent = chart.meta.name || '';
  hud.level.textContent = chart.meta.level || '';
  const t = Math.max(0, state.time);
  const dur = playback.duration ?? chart.endTime;
  hud.time.textContent = `${t.toFixed(2)} / ${dur.toFixed(2)}s`;
  if (panel.progress) panel.progress.value = String(Math.min(100, (t / dur) * 100 || 0));
  hud.notes.textContent = `${s.judged} / ${chart.noteCount}`;
  if (force || !hud.status.textContent) {
    hud.status.textContent = playback.player.playing ? '▶ 播放中' : '⏸ 暂停';
  }
}

function togglePlay() {
  if (!state) return;
  if (playback.player.playing) playback.pause();
  else playback.play();
  updateHud(true);
}

function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
  if (state) {
    const hits = playback.update(state, evaluate, advanceJudging);
    renderer.draw(state, playback.hits);
    updateHud();
    hud.fps.textContent = `${fps.toFixed(0)} fps`;
    void hits;
  }
  requestAnimationFrame(frame);
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.resize(rect.width, rect.height);
  // 父子线偏移的旋转依赖画面宽高比
  if (state) state.aspect = renderer.view.areaW / renderer.view.areaH;
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        seekTo(player_chart_time() - 5);
        break;
      case 'ArrowRight':
        seekTo(player_chart_time() + 5);
        break;
      case 'KeyR':
        seekTo(0);
        break;
      case 'BracketLeft':
        setRate(playback.player.rate - 0.25);
        break;
      case 'BracketRight':
        setRate(playback.player.rate + 0.25);
        break;
      case 'KeyN':
        setNoteWidth(renderer.opts.noteWidthRatio - 0.005);
        break;
      case 'KeyM':
        setNoteWidth(renderer.opts.noteWidthRatio + 0.005);
        break;
      default:
        break;
    }
  });
}

function player_chart_time() {
  return playback.chartTime();
}

function setRate(rate) {
  const r = Math.min(3, Math.max(0.25, Math.round(rate * 100) / 100));
  playback.setRate(r);
  if (panel.rate) panel.rate.textContent = `${r.toFixed(2)}×`;
}

/**
 * 跳转（进度条 / ←→ / R）：**重建判定状态**到目标时刻后再跳时钟。
 * 只挪时钟而不重建的话：往后跳会漏判一段（补判时不补特效），
 * 往前跳则所有音符都已是「已判定」状态 → 音符不显示、特效也不再产生。
 */
function seekTo(t) {
  if (state) {
    const target = Math.max(0, t);
    resetState(state);
    advanceJudging(state, target); // 重建到目标时刻（不产生音效：音效只走 player.update）
    state.hits.length = 0; // 重建过程不残留特效
    evaluate(state, target);
  }
  playback.player.hitsActive = [];
  playback.seek(t);
}

function setNoteWidth(ratio) {
  const r = Math.min(1.2, Math.max(0.02, Math.round(ratio * 1000) / 1000));
  renderer.opts.noteWidthRatio = r;
  if (panel.noteWidth) panel.noteWidth.textContent = `音符宽度 ${(r * 100).toFixed(1)}%`;
}

function updateHoldSampleLabel() {
  const tag = el('hold-sample');
  if (!tag) return;
  const seg = textures?.hold?.__meta?.segments;
  tag.textContent = seg ? `长条分段 ${seg.capTop}+${seg.glowBottom || seg.glowTop || 0}px` : '长条分段未登记';
}

async function loadPackage(pkg) {
  hud.status.textContent = '载入中…';
  try {
    if (!pkg.chartJson) throw new Error('包内没有可用谱面 JSON');
    const audioUrl = pkg.songPath ? pkg.urlFor(pkg.songPath) : null;
    const backgroundUrl = pkg.backgroundPath ? pkg.urlFor(pkg.backgroundPath) : null;
    await setChart(pkg.chartJson, { audioUrl, backgroundUrl, sourceLabel: pkg.name, pkg });
    hud.status.textContent = '▶ 按空格播放';
  } catch (err) {
    hud.status.textContent = `载入失败：${err.message}`;
    console.error(err);
  }
}

/** RPE 允许自定义判定线材质：包内找到第一个非默认材质就用它（找不到则退回纯色线） */
async function applyLineTexture(pkg) {
  if (!pkg || !chart) return;
  const wanted = chart.lines.map((l) => l.texture).filter((t) => t && t !== 'line.png');
  for (const name of wanted) {
    const target = name.replace(/\\/g, '/').toLowerCase();
    const path = [...pkg.files.keys()].find((p) => p.toLowerCase() === target || p.toLowerCase().endsWith('/' + target));
    if (!path) continue;
    const img = await loadImageSafe(pkg.urlFor(path));
    if (img) {
      renderer.opts.lineTexture = img;
      console.info(`使用自定义判定线材质：${path}`);
      return;
    }
  }
}

function boot() {
  renderer = createCanvasRenderer(canvas, textures);
  resize();
  window.addEventListener('resize', resize);
  bindKeys();
  // 让运行期错误直接显示在 HUD 上（否则只会出现在控制台）
  window.addEventListener('error', (e) => {
    hud.status.textContent = `运行出错：${e.message}`;
    console.error(e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    hud.status.textContent = `运行出错：${e.reason?.message ?? e.reason}`;
    console.error(e.reason);
  });

  panel.fileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    hud.status.textContent = '解析包中…';
    const pkg = await loadFilePackage(files);
    await loadPackage(pkg);
  });
  panel.zipInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    hud.status.textContent = '解压中…';
    try {
      const pkg = await loadZipPackage(await file.arrayBuffer(), file.name.replace(/\.zip$/i, ''));
      await loadPackage(pkg);
    } catch (err) {
      hud.status.textContent = `解压失败：${err.message}`;
    }
  });
  panel.jsonInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      await setChart(json, { audioUrl: null, backgroundUrl: null, sourceLabel: file.name });
    } catch (err) {
      hud.status.textContent = `载入失败：${err.message}`;
    }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const items = [...(e.dataTransfer?.items ?? [])];
    const files = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) files.push(...(await collectEntry(entry)));
      else if (item.getAsFile()) files.push(item.getAsFile());
    }
    if (!files.length) return;
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    hud.status.textContent = '解析包中…';
    if (zip && files.length === 1) {
      const pkg = await loadZipPackage(await zip.arrayBuffer(), zip.name.replace(/\.zip$/i, ''));
      await loadPackage(pkg);
    } else {
      await loadPackage(await loadFilePackage(files));
    }
  });

  el('btn-play').addEventListener('click', togglePlay);
  el('btn-restart').addEventListener('click', () => {
    if (!state) return;
    resetState(state);
    playback.player.hitsActive = [];
    playback.seek(0);
  });
  el('btn-rate').addEventListener('click', () => setRate(playback.player.rate >= 1.5 ? 0.5 : playback.player.rate + 0.25));
  panel.multiHint.addEventListener('change', () => {
    renderer.opts.multiHint = panel.multiHint.checked;
  });
  panel.showLines.addEventListener('change', () => {
    renderer.opts.showLines = panel.showLines.checked;
  });
  panel.showNotes.addEventListener('change', () => {
    renderer.opts.showNotes = panel.showNotes.checked;
  });
  panel.progress.addEventListener('input', () => {
    if (!state) return;
    const dur = playback.duration ?? chart.endTime;
    seekTo((Number(panel.progress.value) / 100) * dur);
  });

  setNoteWidth(renderer.opts.noteWidthRatio);
  updateHoldSampleLabel();
  setRate(1);
  requestAnimationFrame(frame);
}

/** 递归读取拖拽的目录 */
async function collectEntry(entry) {
  if (entry.isFile) {
    return await new Promise((resolve) => entry.file((f) => resolve([f]), () => resolve([])));
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const out = [];
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const child of batch) out.push(...(await collectEntry(child)));
    }
    return out;
  }
  return [];
}

(async function start() {
  hud.status.textContent = '加载贴图中…';
  // 长条分段按 TEXTURE_TRIM 里的硬编码（48px 头尾帽 + 48px 光效），不做运行时识别
  textures = await loadTextures('assets/');
  // 打击音效：tap/hold 共用 click.wav，drag/flick 各自一个（加载失败不影响渲染）
  await playback.loadHitSounds('assets/');
  boot();
  el('boot').classList.add('hidden');
  hud.status.textContent = '载入谱面包目录 / zip / 谱面 JSON';
})();
