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
import { EXTENDED_KEYS, EXTENDED_RPE_FIELD } from '../core/units.js';
import { Diagnostics } from '../core/sanitize.js';
import { parseOfficialChart } from '../core/parse-official.js';
import { parseRpeChart } from '../core/parse-rpe.js';
import { createState, advanceJudging, advancePlayJudging, evaluate, resetState, formatScore } from '../core/state.js';
import { createInput } from '../core/input.js';
import { bindTouchInput, isTouchDevice } from './touch-input.js';
import { createPlayer } from './player.js';
import { loadFilePackage, loadZipPackage } from '../core/package.js';
import { icon, setIcon, ICONS } from '../ui/icons.js';

const el = (id) => document.getElementById(id);
const canvas = el('stage');
const hud = {
  root: el('hud'),
  score: el('hud-score'),
  combo: el('hud-combo'),
  acc: el('hud-acc'),
  name: el('hud-name'),
  level: el('hud-level'),
  time: el('hud-time'),
  fps: el('hud-fps'),
  notes: el('hud-notes'),
  status: el('hud-status'),
  judge: el('hud-judge'),
  pauseBtn: el('btn-pause'),
};
const panel = {
  warnings: el('warnings'),
  info: el('chart-info'),
  fileInput: el('file-input'),
  zipInput: el('zip-input'),
  jsonInput: el('json-input'),
  playBtn: el('btn-play'),
  restartBtn: el('btn-restart'),
  rate: el('rate'),
  rateBtn: el('btn-rate'),
  noteWidth: el('note-width'),
  noteNarrowBtn: el('btn-note-narrow'),
  noteWideBtn: el('btn-note-wide'),
  multiHint: el('multi-hint'),
  showLines: el('show-lines'),
  showNotes: el('show-notes'),
  progress: el('progress'),
  playMode: el('play-mode'),
  playModeHint: el('play-mode-hint'),
  judgeBandBtn: el('judge-band'),
  judgeScreenBtn: el('judge-screen'),
  stageWrap: el('stage-wrap'),
  pauseScreen: el('pause-screen'),
  playResult: el('play-result'),
  resultText: el('play-result-text'),
  againBtn: el('btn-again'),
  backBtn: el('btn-back'),
  fullscreenBtn: el('btn-fullscreen'),
};

/** 给任意元素（按钮 / label）前面塞一个图标：label 里还有 <input>，不能整体替换 innerHTML */
function addIcon(node, name, size = 14) {
  if (!node || typeof node.insertBefore !== 'function') return;
  const ico = icon(name, { size });
  ico.classList.add('ico');
  node.insertBefore(ico, node.firstChild ?? null);
}

let textures = null;
let renderer = null;
let chart = null;
let state = null;
let backgroundImage = null;
let currentAudioUrl = null;
let lastFrame = performance.now();
let fps = 0;
const playback = createPlayer();

// ───────────────────────────── 真实游玩（仅触屏设备） ─────────────────────────────
// 规则见 docs/03 §4.2：垂直判定（只看音符与判定线的时间接近程度）、多指判定、
// Drag 过线即 Perfect、Flick 滑动即 Perfect、Hold 头部判定后可松手。
// 输入缓冲与判定分别放在 core/input.js 与 core/state.js，这里只做「模式切换 + 接线 + 界面」。
// 只在**渲染器页面**（player.html）提供开关：编辑器页面没有这套 UI（见 docs/06）。
const canPlayTouch = () => isTouchDevice(globalThis.window ?? globalThis);
const input = createInput();
let playMode = false; // 真实游玩中
let runStarted = false; // 已经开始（开始浮层已收起）
let runFinished = false; // 本局已结算
let unbindTouch = null;
let judgeShownAt = 0;
let lastCounts = { perfect: 0, good: 0, bad: 0, miss: 0 };
/**
 * 判定范围（**只有触屏游玩用**）：
 *  - `band`（默认）：音符所在的那条「列」——沿判定线方向比音符略宽、沿下落方向不限位置，
 *    只有落在带里的点击 / 经过带里的滑动才算命中（`projection.judgeBand`，见 docs/03 §4.4）；
 *  - `screen`：全屏判定（点屏幕任意位置都算），作为可选模式保留。
 * 记忆在 localStorage 里（换谱面、刷新都保留）。
 */
const JUDGE_AREA_KEY = 'phichart.judgeArea';
let judgeArea = 'band';
try {
  const saved = globalThis.localStorage?.getItem(JUDGE_AREA_KEY);
  if (saved === 'screen' || saved === 'band') judgeArea = saved;
} catch {
  /* 隐私模式下忽略 */
}

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
  if (playMode) setPlayMode(false); // 换谱面时退出真实游玩（旧谱的判定状态已无意义）
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

/** 扩展（故事板）事件：本版本渲染 scaleX / scaleY / color，其余保留但不渲染 */
function extendedSummary(chart) {
  const keys = chart?.extendedKeys ?? [];
  if (!keys.length) return '';
  const renderedFields = EXTENDED_KEYS.map((k) => EXTENDED_RPE_FIELD[k]);
  const rendered = keys.filter((f) => renderedFields.includes(f));
  const pending = keys.filter((f) => !renderedFields.includes(f));
  const parts = [];
  if (rendered.length) parts.push(`已渲染 ${rendered.join('/')}`);
  if (pending.length) parts.push(`未渲染 ${pending.join('/')}`);
  return `｜扩展事件：${parts.join('，')}`;
}

function showInfo(label) {
  const n = chart;
  const counts = { tap: 0, drag: 0, hold: 0, flick: 0 };
  for (const note of n.notes) counts[note.type]++;
  const lines = n.lines.length;
  const ext = extendedSummary(n);
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
    const stateText = playback.player.playing ? '▶ 播放中' : '⏸ 暂停';
    hud.status.textContent = playMode ? stateText.replace('播放中', '游玩中').replace('暂停', '暂停（点开始继续）') : stateText;
  }
}

// ───────────────────────── 界面状态：暂停页 / 播放 / 结算 ─────────────────────────
// 播放中屏幕上只剩左上角的暂停键；其余设置全在暂停页里（原来那列侧边栏已移除）。
// 「播放」是**从暂停处继续**（暂停时时钟停在原地），要重来用「重开 / 再来一次」。
const SCREENS = ['pause', 'result', 'play'];
let screen = 'pause';

const show = (node, on) => node?.classList?.toggle('hidden', !on);

/** 切界面：同一时刻只显示一个整屏浮层；HUD 只在播放中显示 */
function showScreen(name) {
  screen = SCREENS.includes(name) ? name : 'pause';
  show(panel.pauseScreen, screen === 'pause');
  show(panel.playResult, screen === 'result');
  show(hud.root, screen === 'play');
  document.body.classList.toggle('paused', screen === 'pause');
}

/** 「播放 / 继续」：从暂停处继续（第一次播放就是从 0 开始） */
function playFromPause() {
  if (!state) return;
  runStarted = true;
  runFinished = false;
  input.clear();
  showScreen('play');
  playback.play();
  updateHud(true);
}

/** 「重开」：回到 0 并立刻开始（触屏游玩 = 重开一局） */
function restartRun() {
  if (!state) return;
  resetState(state);
  playback.player.hitsActive = [];
  playback.seek(0);
  runStarted = true;
  runFinished = false;
  input.clear();
  lastCounts = { perfect: 0, good: 0, bad: 0, miss: 0 };
  showScreen('play');
  playback.play();
  updateHud(true);
}

/** 暂停：打开暂停页并暂停时钟（左上加暂停键 / Esc 都走这里） */
function pauseToScreen() {
  playback.pause();
  input.clear();
  showScreen('pause');
  updateHud(true);
}

/** 结算页「返回」：本局作废，回到暂停页 */
function backToPause() {
  if (state) {
    resetState(state);
    playback.player.hitsActive = [];
    playback.seek(0);
  }
  runStarted = false;
  runFinished = false;
  input.clear();
  playback.pause();
  showScreen('pause');
  updateHud(true);
}

// ───────────────────────── 全屏 ─────────────────────────
function fullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function fullscreenSupported() {
  const root = document.documentElement;
  return typeof root?.requestFullscreen === 'function' || typeof root?.webkitRequestFullscreen === 'function';
}

/** 打开 / 关闭真正的全屏（iPhone 上的 Safari 不提供网页全屏，此时按钮禁用并给出说明） */
async function toggleFullscreen() {
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else {
      const root = document.documentElement;
      if (typeof root.requestFullscreen === 'function') await root.requestFullscreen({ navigationUI: 'hide' });
      else await root.webkitRequestFullscreen?.();
      // 尽力横屏（移动端浏览器支持才生效，失败不影响全屏）
      try {
        await globalThis.screen?.orientation?.lock?.('landscape');
      } catch {
        /* 忽略 */
      }
    }
  } catch (err) {
    if (hud.status) hud.status.textContent = `全屏失败：${err?.message ?? err}`;
    console.warn('[player] 全屏失败：', err);
  }
  syncFullscreenButton();
}

function syncFullscreenButton() {
  if (!panel.fullscreenBtn) return;
  const on = !!fullscreenElement();
  setIcon(panel.fullscreenBtn, on ? ICONS.fold : ICONS.fit, { size: 16, text: on ? '退出全屏' : '全屏' });
}


/** 把「最近一次判定」写到 HUD（0.8s 后自动清空） */
function showJudgement(name) {
  if (!hud.judge) return;
  hud.judge.textContent = name;
  hud.judge.dataset.judgement = name.toLowerCase();
  judgeShownAt = performance.now();
}

/** 本帧有没有新判定（对比四个计数器的增量，取「最严重的那个」显示） */
function updateJudgementLabel() {
  const s = state.stats;
  const deltas = { Perfect: s.perfect - lastCounts.perfect, Good: s.good - lastCounts.good, Bad: s.bad - lastCounts.bad, Miss: s.miss - lastCounts.miss };
  lastCounts = { perfect: s.perfect, good: s.good, bad: s.bad, miss: s.miss };
  const hit = ['Miss', 'Bad', 'Good', 'Perfect'].find((k) => deltas[k] > 0);
  if (hit) showJudgement(hit);
  else if (hud.judge?.textContent && performance.now() - judgeShownAt > 800) hud.judge.textContent = '';
}

/** 重开一局（结算页「再来一次」用；与「重开」按钮同一条路径） */
function startRun() {
  restartRun();
}

function finishRun() {
  if (!playMode || runFinished) return;
  runFinished = true;
  playback.pause();
  input.clear();
  const s = state.stats;
  if (panel.resultText) {
    panel.resultText.innerHTML =
      `<div class="big">${formatScore(s.score)}</div>` +
      `<div>ACC ${(s.accuracy * 100).toFixed(2)}%｜最大连击 ${s.maxCombo}</div>` +
      `<div class="dim">Perfect ${s.perfect}｜Good ${s.good}｜Bad ${s.bad}｜Miss ${s.miss}</div>` +
      `<div class="dim">${s.allPerfect ? 'ALL PERFECT' : s.fullCombo ? 'FULL COMBO' : ''}</div>`;
  }
  showScreen('result');
  updateHud(true);
}

/** 全部音符判完（假音符不计入物量）→ 结算 */
function checkRunEnd() {
  if (!playMode || runFinished || !runStarted || !state) return;
  const total = chart.noteCount ?? 0;
  if (total > 0 && state.stats.judged >= total) finishRun();
}

/** 进入 / 退出真实游玩模式。非触屏设备一律拒绝（游玩仅限触屏） */
function setPlayMode(on) {
  const want = !!on && canPlayTouch() && !!state;
  if (want === playMode) {
    if (panel.playMode) panel.playMode.checked = playMode;
    return playMode;
  }
  playMode = want;
  runStarted = false;
  runFinished = false;
  input.clear();
  document.body.classList.toggle('play-mode', playMode);
  if (panel.playMode) panel.playMode.checked = playMode;
  if (panel.progress) panel.progress.disabled = playMode; // 游玩中不允许跳转（跳过去的音符语义不明确）
  if (playMode) {
    state.options.autoplay = false;
    setRate(1); // 计分的一局固定 1.00×（倍速只在自动游玩/预览里用）
    if (panel.rateBtn) panel.rateBtn.disabled = true;
    resetState(state);
    playback.player.hitsActive = [];
    playback.seek(0);
    playback.pause();
    lastCounts = { perfect: 0, good: 0, bad: 0, miss: 0 };
    if (hud.judge) hud.judge.textContent = '';
    showScreen('pause'); // 回暂停页：点「播放」再走「点击开始」
    bindTouch();
  } else {
    if (state) state.options.autoplay = true;
    if (state) resetState(state);
    if (panel.rateBtn) panel.rateBtn.disabled = false;
    playback.player.hitsActive = [];
    playback.seek(0);
    showScreen('pause');
    unbindTouchInput();
  }
  updateHud(true);
  return playMode;
}

/**
 * 判定范围判定函数：`hitTest(note, input) -> boolean`。
 * 全屏模式返回 null（`advancePlayJudging` 见 null 即任意位置都算）。
 * 传入的 input 可能是「按下」（有点坐标）或「滑动」（起点 + 当前点）：
 *  - 按下：点是否落在判定带里；
 *  - 滑动：**是否经过**判定带（起点与当前点之间与带子相交即可）。
 */
function makeJudgeHitTest() {
  if (judgeArea === 'screen') return null;
  return (note, p) => {
    if (!state || !renderer) return true;
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.x0) && Number.isFinite(p?.y0)) {
      return renderer.hitJudgeBandSegment(state, note, p.x0, p.y0, p.x, p.y);
    }
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return renderer.hitJudgeBand(state, note, p.x, p.y);
    return true; // 没有坐标信息（例如合成事件/测试桩件）→ 当作全屏，别把判定卡死
  };
}

/** 切换判定范围（暂停页里的两个选项） */
function setJudgeArea(area) {
  judgeArea = area === 'screen' ? 'screen' : 'band';
  try {
    globalThis.localStorage?.setItem(JUDGE_AREA_KEY, judgeArea);
  } catch {
    /* 忽略 */
  }
  syncJudgeAreaButtons();
  updateHud(true);
}

function syncJudgeAreaButtons() {
  for (const [el2, area] of [
    [panel.judgeBandBtn, 'band'],
    [panel.judgeScreenBtn, 'screen'],
  ]) {
    if (el2) el2.classList.toggle('active', judgeArea === area);
  }
}

function bindTouch() {
  if (unbindTouch || !canvas) return;
  // 监听绑在**画布**上：暂停页/结算页的浮层是画布的兄弟节点，事件不会冒泡到画布，
  // 界面控件因此天生不参与判定；坐标也直接是画布 CSS 像素（判定带用它）。
  unbindTouch = bindTouchInput(canvas, input, {
    getChartTime: () => playback.chartTime(),
    getRate: () => playback.player.rate,
    getRect: () => canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 },
    // 暂停中 / 未开始 / 已结算都不接受输入（否则手指会「预存」到恢复播放那一帧）
    isActive: () => playMode && runStarted && !runFinished && playback.player.playing,
  });
}

function unbindTouchInput() {
  unbindTouch?.();
  unbindTouch = null;
  input.clear();
}

function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
  if (state) {
    const judging = screen === 'play'; // 暂停页 / 结算页挂着时不再判定（时钟本来就停着，这里只是保险）
    const judge = playMode ? (st, t) => advancePlayJudging(st, t, input, { hitTest: makeJudgeHitTest() }) : judging ? advanceJudging : () => state.hits;
    const hits = playback.update(state, evaluate, judge);
    // 输入缓冲只在本帧被消费掉；暂停 / 未开始时直接丢弃，避免「攒着一堆手指」在恢复那一帧炸开
    if (playMode && runStarted && !runFinished && playback.player.playing) input.endFrame();
    else input.clear();
    renderer.draw(state, playback.hits);
    if (playMode && judging) {
      updateJudgementLabel();
      checkRunEnd();
    }
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
        if (screen === 'play') pauseToScreen();
        else playFromPause();
        break;
      case 'Escape':
        e.preventDefault();
        if (screen === 'play') pauseToScreen();
        else if (screen === 'pause') playFromPause();
        else backToPause(); // 开始 / 结算浮层 → 回暂停页
        break;
      case 'KeyF':
        if (fullscreenSupported()) toggleFullscreen();
        break;
      case 'ArrowLeft':
        seekTo(player_chart_time() - 5);
        break;
      case 'ArrowRight':
        seekTo(player_chart_time() + 5);
        break;
      case 'KeyR':
        restartRun(); // 游玩中 = 重新开始一局；自动游玩 = 回到 0 并开始播放
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
 *
 * 真实游玩（触屏）里跳转没有意义（跳过去的音符该判 Miss 还是跳过没有定义），
 * 因此游玩模式下直接忽略；要重开请按「重开」。
 */
function seekTo(t) {
  if (playMode) return;
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

  // ── 暂停页里的按钮（原来那列侧边栏已移除，全部设置搬到这里）──
  panel.playBtn?.addEventListener('click', playFromPause);
  panel.restartBtn?.addEventListener('click', restartRun);
  panel.rateBtn?.addEventListener('click', () => setRate(playback.player.rate >= 1.5 ? 0.5 : playback.player.rate + 0.25));
  panel.noteNarrowBtn?.addEventListener('click', () => setNoteWidth(renderer.opts.noteWidthRatio - 0.005));
  panel.noteWideBtn?.addEventListener('click', () => setNoteWidth(renderer.opts.noteWidthRatio + 0.005));
  panel.fullscreenBtn?.addEventListener('click', toggleFullscreen);
  hud.pauseBtn?.addEventListener('click', pauseToScreen);
  panel.againBtn?.addEventListener('click', startRun);
  panel.backBtn?.addEventListener('click', backToPause);
  panel.judgeBandBtn?.addEventListener('click', () => setJudgeArea('band'));
  panel.judgeScreenBtn?.addEventListener('click', () => setJudgeArea('screen'));
  panel.multiHint.addEventListener('change', () => {
    renderer.opts.multiHint = panel.multiHint.checked;
    panel.multiHint.closest?.('.check')?.classList.toggle('active', panel.multiHint.checked);
  });
  panel.showLines.addEventListener('change', () => {
    renderer.opts.showLines = panel.showLines.checked;
    panel.showLines.closest?.('.check')?.classList.toggle('active', panel.showLines.checked);
  });
  panel.showNotes.addEventListener('change', () => {
    renderer.opts.showNotes = panel.showNotes.checked;
    panel.showNotes.closest?.('.check')?.classList.toggle('active', panel.showNotes.checked);
  });
  panel.progress.addEventListener('input', () => {
    if (!state) return;
    const dur = playback.duration ?? chart.endTime;
    seekTo((Number(panel.progress.value) / 100) * dur);
  });

  // ── 触屏游玩（仅触屏设备可开启；桌面端开关禁用）──
  if (panel.playMode) {
    const touchNow = canPlayTouch();
    panel.playMode.disabled = !touchNow;
    panel.playMode.checked = false;
    if (panel.playModeHint) {
      panel.playModeHint.textContent = touchNow
        ? '开启后进入真实游玩：点「播放」立刻开始，手指点 / 滑判定（判定范围见下）'
        : '仅触屏设备可游玩；桌面端只能自动游玩 / 预览';
    }
    panel.playMode.addEventListener('change', () => setPlayMode(panel.playMode.checked));
  }
  playback.player.onEnded = () => {
    if (playMode) finishRun();
  };

  // 全屏按钮状态跟随真实的 fullscreenchange（含 Safari 的 webkit 前缀）
  document.addEventListener?.('fullscreenchange', syncFullscreenButton);
  document.addEventListener?.('webkitfullscreenchange', syncFullscreenButton);

  // 暂停页的图标（按钮用 setIcon，label 里有 <input> 的用 addIcon）
  setIcon(panel.playBtn, ICONS.play, { size: 16, text: '播放' });
  setIcon(panel.restartBtn, ICONS.restart, { size: 16, text: '重开' });
  setIcon(panel.rateBtn, ICONS.rate, { size: 14, text: '1.00×' });
  setIcon(panel.noteNarrowBtn, ICONS.zoomOut, { size: 14, text: '音符 −' });
  setIcon(panel.noteWideBtn, ICONS.zoomIn, { size: 14, text: '音符 +' });
  setIcon(panel.againBtn, ICONS.restart, { size: 16, text: '再来一次' });
  setIcon(panel.backBtn, ICONS.backPage, { size: 16, text: '返回' });
  setIcon(hud.pauseBtn, ICONS.pause, { size: 16 });
  setIcon(panel.judgeBandBtn, ICONS.note, { size: 14, text: '音符判定带' });
  setIcon(panel.judgeScreenBtn, ICONS.fit, { size: 14, text: '全屏判定' });
  addIcon(panel.playMode?.closest?.('.check') ?? panel.playMode, 'hand');
  addIcon(panel.multiHint?.closest?.('.check') ?? panel.multiHint, 'adsorption_x');
  addIcon(panel.showLines?.closest?.('.check') ?? panel.showLines, 'visible');
  addIcon(panel.showNotes?.closest?.('.check') ?? panel.showNotes, 'note');
  for (const [input, name] of [
    [panel.fileInput, ICONS.openFolder],
    [panel.zipInput, ICONS.download],
    [panel.jsonInput, ICONS.note],
  ]) {
    addIcon(input?.parentElement, name);
  }
  const touchNow = canPlayTouch();
  if (panel.fullscreenBtn) {
    panel.fullscreenBtn.disabled = !fullscreenSupported();
    panel.fullscreenBtn.title = fullscreenSupported()
      ? '打开 / 关闭全屏'
      : '这台设备（如 iPhone 的 Safari）不提供网页全屏，可用「添加到主屏幕」后打开';
  }
  void touchNow;

  showScreen('pause');
  syncFullscreenButton();
  syncJudgeAreaButtons();
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
