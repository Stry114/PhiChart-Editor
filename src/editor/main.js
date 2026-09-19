/**
 * 编辑器入口：把四个区域接起来
 *   左上 = 多标签工作区（谱面总览 / Note 详情 / Event 详情）
 *   左下 = 多标签工作区（结构树 / 轨道 / 诊断）
 *   右上 = 预览（复用渲染器，指针到哪渲染哪）
 *   右下 = 时间轴（多轨自由组合，主工作区）
 * 说明：这是 UI 骨架，编辑操作（拖放、改数据、保存）按计划在后续阶段实现。
 */
import { createLayout } from './layout.js';
import { createTabs } from './tabs.js';
import { createTimeline } from './timeline.js';
import { createPreview, SAMPLES } from './preview.js';
import { renderTree } from './tree.js';
import { renderNoteDetail } from './note-detail.js';
import { renderEventDetail } from './event-detail.js';
import { renderCurveTab } from './curve-tab.js';
import {
  defaultTracks,
  countClips,
  EVENT_LABELS,
  EVENT_COLORS,
  NOTE_SPRITES,
  POS_LINE_OPTIONS,
  refreshEventClip,
} from './tracks.js';
import { icon, setIcon, on, ICONS } from '../ui/icons.js';
import { takeHandoff } from '../ui/handoff.js';
import { filesFromDataTransfer } from '../core/package.js';

const $ = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);
const goStart = () => {
  globalThis.location.href = 'start.html';
};

/**
 * 载入音符轨用的圆形贴图（assets/notes）。
 * 缺文件时返回空对象，时间轴会退化成画圆点，不影响使用。
 */
async function loadNoteSprites(base = 'assets/notes/') {
  const out = {};
  await Promise.all(
    Object.entries(NOTE_SPRITES).map(
      ([type, file]) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            out[type] = img;
            resolve();
          };
          img.onerror = () => resolve();
          img.src = base + file;
        }),
    ),
  );
  return out;
}

const noteSprites = await loadNoteSprites();

/** 拍号输入解析：a+b/c（也接受 12、12.5） */
function parseBeatInput(text) {
  const s = String(text).trim();
  if (!s) return null;
  const frac = /^(\d+)\s*\+\s*(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const den = Number(frac[3]);
    return den > 0 ? Number(frac[1]) + Number(frac[2]) / den : null;
  }
  const num = Number(s);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/** 把当前指针拍号写回输入框（a+b/c；整数时写成 a+0/1） */
function formatBeatInput(beat) {
  const whole = Math.floor(beat + 1e-9);
  const frac = beat - whole;
  if (frac < 1e-6) return `${whole}+0/1`;
  // 用当前刻度密度做分母，读起来与刻度一致；不能整除时退回 1/1000 约分
  const div = timeline.tickDiv || 4;
  let num = Math.round(frac * div);
  let den = div;
  if (Math.abs(num / den - frac) > 1e-6) {
    num = Math.round(frac * 1000);
    den = 1000;
    while (num % 2 === 0 && den % 2 === 0) {
      num /= 2;
      den /= 2;
    }
    while (num % 5 === 0 && den % 5 === 0) {
      num /= 5;
      den /= 5;
    }
  }
  return num === 0 ? `${whole}+0/1` : `${whole}+${num}/${den}`;
}

let lastBeatText = '';
// ── 性能诊断：每秒汇总「谁在重绘」，直接显示在预览工具条右侧 ──
const perf = { previewFrames: 0, timelineRedraws: 0, panelRenders: 0, at: 0, text: '' };
function notePanelRender() {
  perf.panelRenders++;
}
function updatePerfHud() {
  const now = globalThis.performance?.now?.() ?? Date.now();
  if (!perf.at) {
    perf.at = now;
    const st = { p: preview.stats.frames, t: timeline.stats.redraws };
    perf.prev = st;
    return;
  }
  if (now - perf.at < 1000) return;
  const st = { p: preview.stats.frames, t: timeline.stats.redraws };
  perf.previewFrames = st.p - (perf.prev?.p ?? st.p);
  perf.timelineRedraws = st.t - (perf.prev?.t ?? st.t);
  perf.prev = st;
  perf.at = now;
  const el = $('ed-fps');
  if (el) {
    el.textContent = `预览 ${perf.previewFrames}/s · 时间轴 ${perf.timelineRedraws}/s · 详情 ${perf.panelRenders}/s`;
  }
  perf.panelRenders = 0;
}

function updateBeatInput(force = false) {
  const input = $('ed-beat');
  if (!input || document.activeElement === input) return;
  const text = formatBeatInput(Math.max(0, timeline.currentBeat));
  if (!force && text === lastBeatText && input.value === text) return; // 每帧都写会导致布局抖动
  lastBeatText = text;
  if (input.value !== text) input.value = text;
}

const layout = createLayout(document);
const preview = await createPreview({
  canvas: $('ed-canvas'),
  emptyEl: $('ed-preview-empty'),
  infoEl: $('ed-preview-info'),
  timeEl: $('ed-time'),
  fpsEl: $('ed-fps'),
});

let status = '就绪：先载入谱面（左侧「谱面总览」里有内置示例）';
let selected = null; // { kind: 'track'|'clip', … }
let currentAxis = null; // 当前时间轴的拍轴（由 tracks.js 的 createBeatAxis 生成）

const timeline = createTimeline({
  heads: $('ed-tl-heads'),
  body: $('ed-tl-body'),
  canvas: $('ed-tl-canvas'),
  noteSprites, // 音符轨用的圆形贴图（缺文件时内部会退化成圆点）
  onSeek: (t) => {
    preview.seek(t);
  },
  onSelect: (track) => {
    selected = track ? { kind: 'track', track } : null;
    setStatus(track ? `已选中轨道：${track.label}` : '已取消选中');
    topTabs.refresh();
  },
  onTracksChanged: (tracks) => {
    const groups = new Set(tracks.filter((t) => t.group).map((t) => t.group));
    setStatus(`轨道 ${tracks.length} 条（${groups.size} 组）· 事件块 ${countClips(tracks)}`);
  },
  onSelectionChange: ({ events, notes, count }) => {
    if (!count) return;
    setStatus(`已选中 ${count} 个对象（事件 ${events.length} / 音符 ${notes.length}）`);
    // 与时间轴同步：选中什么就切到对应的详情页（多选时该页不加载默认值）
    const keepCurve = topTabs.active === 'curve'; // 用户主动停在曲线页时不要抢走
    if (!keepCurve && events.length && !notes.length) topTabs.activate('event');
    else if (!keepCurve && notes.length && !events.length) topTabs.activate('note');
    else topTabs.refresh();
  },
  onClipsChanged: () => {
    // 时间轴里拖动/改完之后，左上详情/曲线页立即反映新数值
    if (topTabs.active === 'note' || topTabs.active === 'event' || topTabs.active === 'curve') topTabs.refresh();
  },
  onAddRequest: () => {
    // 点轨道头下方的「+」→ 切到左下「结构树」标签页
    bottomTabs.activate('tree');
    setStatus('在左下「结构树」里双击事件层（整组）或单个事件/音符即可添加');
  },
});

function setStatus(msg) {
  status = msg;
  // 面板已按需求精简（不再放状态文字）：状态写到窗口标题与控制台
  if (typeof document !== 'undefined') {
    document.title = `PhiChart Editor · ${msg}`;
  }
  console.info('[editor]', msg);
}

// ───────────────────────────── 左上：谱面总览 / Note 详情 / Event 详情 ─────────────────────────────
const topTabs = createTabs(qs('[data-tabs="top"]'), qs('[data-tabbody="top"]'), [
  {
    id: 'overview',
    label: '谱面总览',
    icon: ICONS.menu,
    render(root) {
      const chart = preview.chart;
      const back = document.createElement('div');
      back.className = 'ed-list';
      const home = document.createElement('button');
      home.className = 'ed-btn';
      home.type = 'button';
      setIcon(home, ICONS.backPage, { size: 14, text: '开始页' });
      home.addEventListener('click', goStart);
      back.appendChild(home);
      root.appendChild(back);
      if (!chart) {
        root.appendChild(hint('还没有载入谱面。'));
      } else {
        const kv = document.createElement('div');
        kv.className = 'ed-kv';
        const src = chart.metaSources ?? {};
        const withSrc = (field, value) => (src[field] ? `${value}　（来源：${src[field]}）` : value);
        const rows = [
          ['曲名', withSrc('name', chart.meta.name || '(无)')],
          ['曲师 / 谱师', `${withSrc('composer', chart.meta.composer || '—')} / ${withSrc('charter', chart.meta.charter || '—')}`],
          ['曲绘师 / 难度', `${chart.meta.illustrator || '—'} / ${chart.meta.level || '—'}`],
          [
            '音频',
            `${chart.meta.song || '(未提供)'}　${preview.hasAudio ? `✓ 已加载${preview.audioSource ? `（${preview.audioSource}）` : ''}` : '✗ 未加载'}`,
          ],
          [
            '曲绘',
            `${chart.meta.background || '(未提供)'}　${preview.hasBackground ? `✓ 已加载${preview.backgroundSource ? `（${preview.backgroundSource}）` : ''}` : '✗ 未加载'}`,
          ],
          ['格式', chart.format === 'rpe' ? `RPE v${chart.source.rpeVersion}` : `official v${chart.source.formatVersion}`],
          ['判定线', `${chart.lines.length} 条`],
          ['音符', `${chart.notes.length}（物量 ${chart.noteCount}）`],
          ['时长', `${chart.endTime.toFixed(2)} s`],
          ['offset', `${chart.meta.offset} s`],
          ['诊断', chart.diagnostics?.summary ?? '—'],
        ];
        for (const [k, v] of rows) {
          const kd = document.createElement('div');
          kd.className = 'k';
          kd.textContent = k;
          const vd = document.createElement('div');
          vd.className = 'v';
          vd.textContent = String(v);
          kv.append(kd, vd);
        }
        root.appendChild(kv);
        // 只载入谱面 JSON 时必然缺音频/曲绘：给出下一步该怎么做
        const mediaHint = preview.mediaHint;
        if (mediaHint) {
          const box = document.createElement('div');
          box.className = 'ed-warn';
          box.textContent = `⚠ ${mediaHint}`;
          root.appendChild(box);
        }
        const priority = document.createElement('div');
        priority.className = 'ed-hint';
        priority.textContent = `元数据权威顺序：${preview.META_PRIORITY_HINT}`;
        root.appendChild(priority);
        const exportMeta = document.createElement('button');
        exportMeta.className = 'ed-btn';
        exportMeta.type = 'button';
        setIcon(exportMeta, ICONS.download, { size: 14, text: '导出统一 info.txt' });
        exportMeta.addEventListener('click', () => {
          const text = preview.metaToInfoTxt(chart.meta);
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'info.txt';
          a.click();
          URL.revokeObjectURL(a.href);
          setStatus('已导出统一格式的 info.txt（元数据按权威顺序合并）');
        });
        const metaBar = document.createElement('div');
        metaBar.className = 'ed-list';
        metaBar.appendChild(exportMeta);
        root.appendChild(metaBar);
      }

      const list = document.createElement('div');
      list.className = 'ed-list';
      for (const sample of SAMPLES) {
        const btn = document.createElement('button');
        btn.className = 'ed-chip';
        btn.type = 'button';
        btn.textContent = sample.label;
        btn.addEventListener('click', async () => {
          setStatus(`载入中：${sample.label}…`);
          try {
            await preview.loadSample(sample);
            afterLoad(sample.label);
          } catch (err) {
            setStatus(`载入失败：${err.message}（内置示例需要经 http 打开页面）`);
          }
        });
        list.appendChild(btn);
      }
      root.appendChild(list);
      root.appendChild(hint('也可以用下面的方式载入自己的资源包（与播放器一致）：'));

      const pick = document.createElement('div');
      pick.className = 'ed-list';
      const mk = (label, accept, multiple, handler, dir) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        if (multiple) input.multiple = true;
        if (dir) input.webkitdirectory = true;
        input.style.display = 'none';
        input.addEventListener('change', async () => {
          if (!input.files?.length) return;
          setStatus('载入中…');
          try {
            await handler(input.files);
            afterLoad(input.files[0].name);
          } catch (err) {
            setStatus(`载入失败：${err.message}`);
          }
        });
        const btn = document.createElement('button');
        btn.className = 'ed-btn';
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => input.click());
        root.appendChild(input);
        pick.appendChild(btn);
      };
      mk('选择谱面 JSON', '.json', false, async (files) => preview.loadJson(JSON.parse(await files[0].text()), files[0].name));
      mk('选择 zip 谱面包', '.zip', false, (files) => preview.loadZip(files[0]));
      mk('选择谱面包目录', null, true, (files) => preview.loadFiles(files), true);
      root.appendChild(pick);
    },
  },
  {
    id: 'note',
    label: 'Note 详情',
    icon: ICONS.note,
    render(root) {
      notePanelRender();
      renderNoteDetail(root, { chart: preview.chart, timeline, onStatus: setStatus });
    },
  },
  {
    id: 'event',
    label: 'Event 详情',
    icon: ICONS.rate,
    render(root) {
      notePanelRender();
      renderEventDetail(root, { chart: preview.chart, timeline, axis: currentAxis, onStatus: setStatus });
    },
  },
  {
    id: 'curve',
    label: '事件曲线',
    icon: ICONS.speed,
    render(root) {
      notePanelRender();
      renderCurveTab(root, {
        chart: preview.chart,
        timeline,
        axis: currentAxis,
        onStatus: setStatus,
        refreshClip: (track, index, axis) => refreshEventClip(track, index, axis),
      });
    },
  },
], { ctx: {} });

function hint(text) {
  const box = document.createElement('div');
  box.className = 'ed-hint';
  box.textContent = text;
  return box;
}

// ───────────────────────────── 左下：结构树 / 轨道 / 诊断 ─────────────────────────────
const bottomTabs = createTabs(qs('[data-tabs="bottom"]'), qs('[data-tabbody="bottom"]'), [
  {
    id: 'tree',
    label: '结构树',
    icon: ICONS.fit,
    render(root, ctx) {
      renderTree(root, { chart: preview.chart, timeline, axis: currentAxis, onStatus: setStatus, ...ctx });
    },
  },
  {
    id: 'diag',
    label: '诊断',
    icon: ICONS.config,
    render(root) {
      const wrap = document.createElement('div');
      wrap.className = 'ed-scroll';
      const chart = preview.chart;
      if (!chart) {
        wrap.appendChild(hint('载入谱面后显示解析诊断（脏数据、丢弃计数等）。'));
      } else if (!chart.warnings?.length) {
        wrap.appendChild(hint('没有解析告警。'));
      } else {
        for (const w of chart.warnings.slice(0, 60)) {
          const box = document.createElement('div');
          box.className = 'ed-warn';
          box.textContent = w;
          wrap.appendChild(box);
        }
        if (chart.warnings.length > 60) wrap.appendChild(hint(`…其余 ${chart.warnings.length - 60} 条见控制台`));
      }
      root.appendChild(wrap);
    },
  },
]);

// ───────────────────────────── 工具列 ─────────────────────────────
// 只保留真正可用的工具：鼠标（点选 / Ctrl 多选 / 框选 / 拖动）
const TOOLS = [
  {
    id: 'mouse',
    icon: 'arrow', // assets/icons/arrow.svg：鼠标指针形状
    title: '鼠标工具：左键点选事件/音符，Ctrl 点击多选，空白处拖动框选，拖动选中项改时间与 positionX',
  },
];

{
  const box = $('ed-tools');
  let activeTool = 'mouse';
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.className = 'ed-tool' + (tool.id === activeTool ? ' active' : '');
    btn.type = 'button';
    btn.title = tool.title;
    btn.appendChild(icon(tool.icon, { size: 17 }));
    btn.addEventListener('click', () => {
      activeTool = tool.id;
      timeline.setTool(tool.id);
      for (const other of box.querySelectorAll('.ed-tool')) other.classList.remove('active');
      btn.classList.add('active');
      setStatus(tool.title);
    });
    box.appendChild(btn);
  }
}

// ───────────────────────────── 预览工具栏 / 视图开关 ─────────────────────────────
// 按钮用 assets/icons 的矢量图标（播放/暂停会随状态切换）
setIcon($('ed-play'), ICONS.play);
setIcon($('ed-back'), ICONS.back);
setIcon($('ed-fwd'), ICONS.forward);
setIcon($('ed-restart'), ICONS.restart);
setIcon($('ed-rate'), ICONS.rate, { text: '1.00×' });
// 自动回滚：开启后暂停时指针回到本次播放的起点
{
  const btn = $('ed-rollback');
  if (btn) {
    setIcon(btn, ICONS.backPage);
    btn.classList.toggle('active', preview.autoRollback);
    btn.addEventListener('click', () => {
      const on = preview.setAutoRollback(!preview.autoRollback);
      btn.classList.toggle('active', on);
      setStatus(`自动回滚：${on ? '开（暂停后回到播放起点）' : '关'}`);
    });
  }
}

// 背景图 / 音频开关（默认开启）
{
  const bg = $('ed-bg-toggle');
  if (bg) {
    setIcon(bg, ICONS.visible);
    const syncBg = () => bg.classList.toggle('active', preview.backgroundEnabled);
    syncBg();
    bg.addEventListener('click', () => {
      const on = preview.setBackgroundEnabled(!preview.backgroundEnabled);
      syncBg();
      setStatus(`背景图：${on ? '开' : '关'}`);
    });
  }

  const au = $('ed-audio-toggle');
  if (au) {
    setIcon(au, ICONS.volume);
    const syncAu = () => au.classList.toggle('active', preview.audioEnabled);
    syncAu();
    au.addEventListener('click', () => {
      const on = preview.setAudioEnabled(!preview.audioEnabled);
      syncAu();
      setStatus(`音频：${on ? '开' : '关'}`);
    });
  }
}
on('ed-play', 'click', () => preview.toggle());
on('ed-back', 'click', () => preview.seek(preview.playback.chartTime() - 5));
on('ed-fwd', 'click', () => preview.seek(preview.playback.chartTime() + 5));
on('ed-restart', 'click', () => preview.restart());
on('ed-rate', 'click', () => {
  const rates = [1, 0.5, 1.5, 2, 0.25];
  const next = rates[(rates.indexOf(preview.rate) + 1) % rates.length] ?? 1;
  preview.setRate(next);
  setIcon($('ed-rate'), ICONS.rate, { text: `${next.toFixed(2)}×` });
});
on('ed-show-lines', 'change', (e) => {
  preview.opts.showLines = e.target.checked;
});
on('ed-show-notes', 'change', (e) => {
  preview.opts.showNotes = e.target.checked;
});
on('ed-multi-hint', 'change', (e) => {
  preview.opts.multiHint = e.target.checked;
});

// ───────────────────────────── 时间轴工具栏 ─────────────────────────────
const zoomInput = $('ed-zoom') ?? { value: '', addEventListener() {} };
setIcon($('ed-zoom-in'), ICONS.zoomIn);
setIcon($('ed-zoom-out'), ICONS.zoomOut);

// 刻度密度：1 ~ 1/16 拍（分母为整数）
const TICK_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16];
{
  const sel = $('ed-tick-div');
  if (sel) {
    for (const d of TICK_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = d === 1 ? '1 拍' : `1/${d} 拍`;
      sel.appendChild(opt);
    }
    sel.value = String(timeline.tickDiv);
    sel.addEventListener('change', () => {
      timeline.setTickDiv(Number(sel.value));
      setStatus(`刻度密度：1/${sel.value} 拍`);
      updateBeatInput();
    });
  }
}

// 拍号输入：a+b/c 格式（也接受 12、12.5 这类写法）；回车/失焦生效
{
  const input = $('ed-beat');
  if (input) {
    const commit = () => {
      const beat = parseBeatInput(input.value);
      if (beat == null) {
        updateBeatInput();
        setStatus('拍号格式应为 a+b/c（如 12+1/4）');
        return;
      }
      timeline.seekToBeat(beat);
      timeline.ensureBeatVisible(beat); // 视角跟着跳到该拍
      preview.seek(timeline.time);
      updateBeatInput();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  }
}

// 吸附：图标按钮（开 = 指针与操作只能落在刻度线上）
{
  const btn = $('ed-snap');
  if (btn) {
    setIcon(btn, 'adsorption_x');
    btn.classList.toggle('active', timeline.snap);
    btn.addEventListener('click', () => {
      const on = timeline.setSnap(!timeline.snap);
      btn.classList.toggle('active', on);
      setStatus(`纵向吸附：${on ? '开（按刻度线）' : '关'}`);
    });
  }
}

// 横向（positionX）刻度：吸附开关 + 密度，与上面的纵向刻度放在一起，全局生效
{
  const btn = $('ed-pos-snap');
  if (btn) {
    setIcon(btn, 'adsorption_y');
    btn.classList.toggle('active', timeline.posSnap);
    btn.addEventListener('click', () => {
      const on = timeline.setPosSnap(!timeline.posSnap);
      btn.classList.toggle('active', on);
      setStatus(`横向吸附：${on ? '开（音符按 positionX 刻度线对齐）' : '关'}`);
    });
  }

  const sel = $('ed-pos-lines');
  if (sel) {
    for (const count of POS_LINE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(count);
      opt.textContent = `${count} 线`;
      sel.appendChild(opt);
    }
    sel.value = String(timeline.posLines);
    sel.addEventListener('change', () => {
      timeline.setPosLines(Number(sel.value));
      setStatus(`横向刻度密度：${sel.value} 线`);
    });
  }
}

// 轨道管理已并入时间轴面板；显隐功能按需求移除，移除走每行的移除按钮。
// 「适配」按钮按需求删除，载入谱面时仍会自动适配一次（timeline.fit()）。

on('ed-zoom-in', 'click', () => {
  timeline.setZoom(timeline.pxPerBeat * 1.25);
  zoomInput.value = String(Math.round(timeline.pxPerBeat));
});
on('ed-zoom-out', 'click', () => {
  timeline.setZoom(timeline.pxPerBeat / 1.25);
  zoomInput.value = String(Math.round(timeline.pxPerBeat));
});
zoomInput.addEventListener('input', () => timeline.setZoom(Number(zoomInput.value)));

// ───────────────────────────── 快捷键（与播放器一致） ─────────────────────────────
globalThis.addEventListener?.('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      preview.toggle();
      break;
    case 'ArrowLeft':
      preview.seek(preview.playback.chartTime() - 5);
      timeline.setTime(preview.playback.chartTime());
      timeline.ensureBeatVisible(timeline.currentBeat);
      updateBeatInput();
      break;
    case 'ArrowRight':
      preview.seek(preview.playback.chartTime() + 5);
      timeline.setTime(preview.playback.chartTime());
      timeline.ensureBeatVisible(timeline.currentBeat);
      updateBeatInput();
      break;
    case 'KeyR':
      preview.restart();
      break;
    case 'BracketLeft':
      preview.setRate(Math.max(0.25, preview.rate - 0.25));
      if ($('ed-rate')) $('ed-rate').textContent = `${preview.rate.toFixed(2)}×`;
      break;
    case 'BracketRight':
      preview.setRate(Math.min(3, preview.rate + 0.25));
      if ($('ed-rate')) $('ed-rate').textContent = `${preview.rate.toFixed(2)}×`;
      break;
    default:
      break;
  }
});

// ───────────────────────────── 拖放载入谱面包 ─────────────────────────────
// 直接拖文件夹/zip/JSON 到页面上即可；拖文件夹时会连音频与曲绘一起读进来。
{
  const over = document.createElement('div');
  over.className = 'ed-drop-overlay hidden';
  over.textContent = '松开以载入谱面包（文件夹 / zip / 谱面 JSON）';
  document.body.appendChild(over);

  const show = (on) => over.classList.toggle('hidden', !on);
  globalThis.addEventListener?.('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    show(true);
  });
  globalThis.addEventListener?.('dragleave', (e) => {
    if (!e.relatedTarget) show(false);
  });
  globalThis.addEventListener?.('drop', async (e) => {
    e.preventDefault();
    show(false);
    const files = await filesFromDataTransfer(e.dataTransfer).catch(() => []);
    if (!files.length) return;
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    const json = files.find((f) => /\.json$/i.test(f.name));
    try {
      if (files.length > 1 || (!zip && !json)) {
        // 多个文件 / 文件夹 → 当谱面包处理（音频、曲绘一起进来）
        setStatus(`载入谱面包：${files.length} 个文件…`);
        await preview.loadFiles(files);
        afterLoad(files[0].webkitRelativePath?.split('/')[0] || '谱面包');
      } else if (zip) {
        setStatus(`载入 zip 谱面包：${zip.name}…`);
        await preview.loadZip(zip);
        afterLoad(zip.name);
      } else {
        setStatus(`载入谱面：${json.name}（不带音频/曲绘，建议改拖整个包目录）…`);
        await preview.loadJson(JSON.parse(await json.text()), json.name);
        afterLoad(json.name);
      }
    } catch (err) {
      setStatus(`拖放载入失败：${err.message}`);
    }
  });
}

// ───────────────────────────── 载入完成后的联动 ─────────────────────────────
function afterLoad(label) {
  const chart = preview.chart;
  // 默认只放「1 号线第 1 个事件层」的 5 条事件轨（整组绑定），其余由用户从结构树加
  const { axis, tracks } = defaultTracks(chart);
  currentAxis = axis;
  timeline.setChart(chart, axis);
  timeline.setTracks(tracks);
  timeline.resetView(); // 初始缩放：约 4 拍可见
  zoomInput.value = String(Math.round(timeline.pxPerBeat));
  setStatus(`已载入：${label}｜${chart.lines.length} 线 / ${chart.notes.length} 音符｜已导入 ${tracks.length} 条事件轨（1 号线第 1 层）`);
  refreshAll();
}

function refreshAll() {
  topTabs.refresh();
  bottomTabs.refresh();
}

let playing = preview.playing;
let lastBeatSyncAt = 0;
preview.onTime((t) => {
  updatePerfHud();
  // 播放中：指针在可见范围内时时间轴跟着滚动
  if (preview.playing) timeline.syncTime(t, true);
  // 播放/暂停图标跟随状态
  if (playing !== preview.playing) {
    playing = preview.playing;
    setIcon($('ed-play'), playing ? ICONS.pause : ICONS.play);
    updateBeatInput(true);
  }
  // 拍号输入框最多每 ~100ms 同步一次（每帧写 DOM 会明显拖慢页面）
  const now = globalThis.performance?.now?.() ?? Date.now();
  if (now - lastBeatSyncAt > 100) {
    lastBeatSyncAt = now;
    updateBeatInput();
  }
});

setStatus(status);
layout.set(layout.sizes); // 应用一次存档里的尺寸
void EVENT_COLORS;

// ───────────────────────────── 开始页交接：自动打开目标内容 ─────────────────────────────
async function openHandoff() {
  const payload = await takeHandoff();
  if (!payload) return false;
  try {
    if (payload.kind === 'sample') {
      const sample = SAMPLES.find((s) => s.id === payload.id) ?? SAMPLES[0];
      setStatus(`载入示例包：${sample.label}…`);
      await preview.loadSample(sample);
      afterLoad(sample.label);
      return true;
    }
    if (payload.kind === 'json') {
      await preview.loadJson(payload.json, payload.label);
      afterLoad(payload.label ?? '新建项目');
      return true;
    }
    if (payload.kind === 'file') {
      const text = await payload.blob.text();
      await preview.loadJson(JSON.parse(text), payload.name);
      afterLoad(payload.name ?? '已打开的文件');
      return true;
    }
    setStatus(`暂不支持的交接类型：${payload.kind}`);
  } catch (err) {
    setStatus(`打开失败：${err.message}`);
  }
  return false;
}

await openHandoff();

// 暴露到控制台，方便后续阶段调试（编辑器骨架期）
globalThis.PhiChartEditor = { preview, timeline, layout, topTabs, bottomTabs, setStatus, refreshAll, refreshTabs: refreshAll };
