/**
 * 编辑器入口：把四个区域接起来
 *   左上 = 多标签工作区（谱面总览 / Note 详情 / Event 详情 / 事件曲线 / 导出）
 *   左下 = 多标签工作区（结构树 / 纠错）
 *   右上 = 预览（复用渲染器，指针到哪渲染哪）
 *   右下 = 时间轴（多轨自由组合，主工作区）
 */
import { createLayout } from './layout.js';
import { createTabs } from './tabs.js';
import { createTimeline } from './timeline.js';
import { createPreview } from './preview.js';
import { createWelcome } from './welcome.js';
import { createAutosave } from './autosave.js';
import { renderTree, loadLineIntoTimeline, loadedLineInTimeline } from './tree.js';
import { createQuickLine } from './quick-line.js';
import { renderNoteDetail } from './note-detail.js';
import { renderEventDetail } from './event-detail.js';
import { renderCurveTab } from './curve-tab.js';
import { createForm, el } from './detail-common.js';
import { renderExportTab } from './export-tab.js';
import { createLintController, renderLint } from './lint-tab.js';
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
import { isProject } from '../core/model.js';

const $ = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);

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
// ── 性能诊断：每秒汇总「谁在重绘」，作为预览工具条帧率的后缀显示 ──
// ⚠️ 这个函数**不写 DOM**：`#ed-fps` 的唯一写入方是 preview 的渲染循环（每 500ms 一次），
// 两边都写会让元素文字每秒被覆盖一次，看起来就是「帧数每秒抽搐一下」（已修的 bug）。
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
  perf.text = `时间轴 ${perf.timelineRedraws}/s`;
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

// ───────────────────────────── 工作区焦点：点哪块哪块亮 ─────────────────────────────
// 四个工作区：左上（标签页）/ 右上（预览）/ 左下（标签页）/ 右下（时间轴）。
// 工具栏是「第五个工作区」，但里面全是按钮 —— 点按钮不该抢走当前工作区的高亮，所以不参与。
const WORKSPACES = ['ed-left-top', 'ed-preview', 'ed-left-bottom', 'ed-timeline'];
function focusWorkspace(id) {
  for (const w of WORKSPACES) $(w)?.classList.toggle('focused', w === id);
}
for (const id of WORKSPACES) {
  $(id)?.addEventListener('pointerdown', () => focusWorkspace(id), true); // 捕获阶段：内层 stopPropagation 也不影响
}
const preview = await createPreview({
  canvas: $('ed-canvas'),
  emptyEl: $('ed-preview-empty'),
  timeEl: $('ed-time'),
  fpsEl: $('ed-fps'),
  // 帧率后缀里的「时间轴 N/s」由 updatePerfHud 每秒算一次（它自己不写 DOM）
  statsExtra: () => perf.text,
  // 换文档（打开包 / 项目 / 恢复草稿）→ 未保存状态归零；草稿由 autosave 自己管理
  onDocumentLoaded: () => autosave?.markClean(),
});

let status = '就绪：先打开谱面包，或创建一个新项目（见欢迎弹窗）';
let selected = null; // { kind: 'track'|'clip', … }
let currentAxis = null; // 当前时间轴的拍轴（由 tracks.js 的 createBeatAxis 生成）

// ───────────────────────────── 未保存状态与草稿（自动保存） ─────────────────────────────
// 网页不把文件写进磁盘：真正的保存只有「导出」页的「保存项目」。这里做两件事：
//  ① `dirty` 状态 → 导出标签页的「未保存」角标 + 关闭标签页时拦截提醒；
//  ② 去抖把项目格式写进浏览器本地草稿，下次进入编辑器可在欢迎弹窗里恢复。
const autosave = createAutosave({
  preview,
  onStatus: setStatus,
  onDirtyChange: (dirty) => {
    topTabs.setBadge(
      'export',
      dirty ? { text: '未保存', kind: 'unsaved', title: '有未保存的修改：请用「保存项目」写入文件' } : null,
    );
  },
  onNotice: (msg) => showToast('记得保存项目', [msg]),
});

// ───────────────────────────── 欢迎弹窗：没载入谱面前锁住编辑器 ─────────────────────────────
// 开始页只留「编辑器 / 播放器」两个入口，打开内容的功能都下放到了这里：
// 进入编辑器先要求「打开文件夹包 / 打开 zip 包 / 创建新项目」（另留 JSON 入口 + 草稿恢复）。
const welcome = createWelcome({
  preview,
  autosave,
  onStatus: setStatus,
  onAfterLoad: (label) => afterLoad(label),
});
document.body.appendChild(welcome.el);
welcome.show();

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
    updateEditButtons(); // 复制/剪切/删除的可用性跟着选中项走
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
    // 音符时间可能变了（拖动写回会重排 chart.notes）→ 判定游标重新定位，免得重复判定/漏判
    preview.resyncJudging?.();
    lint.markDirty(); // 「纠错」页：标脏 + 防抖重扫（不在前台就等切回去再扫）
    autosave.markEdited(); // 未保存状态 + 草稿自动保存
    updateEditButtons(); // 撤销/剪贴板状态都变了，刷新那一列按钮
  },
  onModelChanged: () => autosave.markEdited(), // 曲线页拖手柄 / 节流写回：只重编译、不走 onClipsChanged
  onAddRequest: () => {
    // 点轨道头下方的「+」→ 切到左下「结构树」标签页
    bottomTabs.activate('tree');
    setStatus('在结构树中单击事件层或单个对象以添加。');
  },
});

// ───────────────────────────── 快速切线：按住 Tab 的全屏圆环选线菜单 ─────────────────────────────
// 行为与「在结构树里单击判定线行」完全一致（清空时间轴 → 放入该线的全部轨道）：
// 两个入口共用 tree.js 的 loadLineIntoTimeline，所以不会出现两套行为。
const quickLine = createQuickLine({
  host: globalThis.document.body, // 全屏覆盖层：挂在 body 上，避免被面板的 transform/filter 影响
  getChart: () => preview.chart,
  getAxis: () => currentAxis,
  getLoadedLine: () => loadedLineInTimeline({ chart: preview.chart, timeline, axis: currentAxis }),
  onPick: (lineId) => loadLineIntoTimeline({ chart: preview.chart, timeline, axis: currentAxis, lineId, onStatus: setStatus }),
  onStatus: setStatus,
});

/**
 * 快速切线的按键接线：按住 `Tab` 展开、松开载入。
 * 长按时的重复 keydown（`e.repeat`）忽略；输入框里不劫持 Tab（那是焦点切换）。
 */
function isTextField(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement;
}

/** 最近一次指针位置：按下 Tab 时以它为「总位移」的原点（键盘事件里没有坐标） */
let lastPointer = null;

function quickLineKey(e, down) {
  if (e.code !== 'Tab') return false;
  if (isTextField(e.target)) return false;
  if (welcome.isOpen) return false;
  e.preventDefault?.();
  if (down) {
    if (!e.repeat) quickLine.show(lastPointer);
  } else {
    quickLine.commit();
  }
  return true;
}
globalThis.addEventListener?.('keydown', (e) => quickLineKey(e, true));
globalThis.addEventListener?.('keyup', (e) => quickLineKey(e, false));
globalThis.addEventListener?.('pointermove', (e) => {
  lastPointer = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
  if (quickLine.isOpen) quickLine.move(lastPointer.x, lastPointer.y);
});
globalThis.addEventListener?.('wheel', (e) => {
  if (!quickLine.isOpen) return;
  e.preventDefault?.();
  quickLine.turnPage(e.deltaY);
}, { passive: false });
globalThis.addEventListener?.('blur', () => quickLine.hide('快速切线：已取消'));
globalThis.addEventListener?.('keydown', (e) => {
  if (e.code === 'Escape' && quickLine.isOpen) {
    e.preventDefault?.();
    quickLine.hide('快速切线：已取消');
  }
});

function setStatus(msg) {
  status = msg;
  // 面板已按需求精简（不再放状态文字）：状态写到窗口标题与控制台
  if (typeof document !== 'undefined') {
    document.title = `PhiChart Editor · ${msg}`;
  }
  console.info('[editor]', msg);
}

// ───────────────────────────── 纠错：检查调度（左下「纠错」页） ─────────────────────────────
/**
 * 什么时候检查、检查多少，都交给这个控制器（策略见 src/editor/lint-tab.js 顶部注释）：
 *  - 载入谱面后自动扫一次（分片进行，角标立刻有数）
 *  - 谱面数据变动后只「标脏 + 防抖 900ms」，且只有该页在前台时才真的重扫
 *  - 未变动的判定线按签名复用上一次结果
 */
function lintBadge(info) {
  const s = info.summary;
  if (!s) return info.state === 'scanning' ? { text: '…', kind: 'warn', title: '纠错：检查中' } : null;
  // 解析告警不进角标、也不常驻在页面里：载入时提醒一次就够了（见 notifyParseWarnings）
  if (!s.total) return { text: '✓', kind: 'ok', title: '纠错：没有发现问题' };
  if (s.error) {
    return { text: s.error > 99 ? '99+' : String(s.error), kind: 'bad', title: `纠错：${s.error} 个错误 / ${s.warn} 个警告` };
  }
  return { text: s.warn > 99 ? '99+' : String(s.warn), kind: 'warn', title: `纠错：${s.warn} 个警告` };
}

const lint = createLintController({
  getChart: () => preview.chart,
  getAxis: () => currentAxis,
  timeline,
  preview,
  onStatus: setStatus,
  isVisible: () => bottomTabs.active === 'lint',
  onUpdate(info, { full } = {}) {
    bottomTabs.setBadge('lint', lintBadge(info));
    // 扫描中的进度只改状态行（full=false），不必整页重绘
    if (full !== false && bottomTabs.active === 'lint') bottomTabs.refresh();
  },
});

// ───────────────────────────── 左上：谱面总览 / Note 详情 / Event 详情 ─────────────────────────────
const topTabs = createTabs(qs('[data-tabs="top"]'), qs('[data-tabbody="top"]'), [
  {
    // 谱面总览 = **元数据编辑页**：全部元数据可改，音频与曲绘可更换或补齐。
    // 载入新存档不放在这里：刷新页面即回到欢迎弹窗。
    id: 'overview',
    label: '谱面总览',
    icon: ICONS.menu,
    render(root) {
      const chart = preview.chart;
      const wrap = document.createElement('div');
      wrap.className = 'ed-scroll';
      root.appendChild(wrap);
      if (!chart) {
        wrap.appendChild(hint('尚未载入谱面。'));
        return;
      }

      const form = createForm();
      const srcOf = (field) => (chart.metaSources?.[field] ? `来源：${chart.metaSources[field]}` : undefined);
      const field = (key, label, placeholder) => {
        const input = document.createElement('input');
        input.className = 'ed-text';
        input.type = 'text';
        input.placeholder = placeholder ?? '';
        input.value = chart.meta[key] ?? '';
        input.addEventListener('change', () => {
          preview.setMetaField(key, input.value.trim());
          autosave.markEdited();
          setStatus(`${label}已更新。`);
        });
        form.row(label, input, srcOf(key));
      };
      field('name', '曲名');
      field('composer', '曲师');
      field('charter', '谱师');
      field('illustrator', '曲绘师');
      field('level', '难度');
      field('id', 'ID / Path');

      const offsetInput = document.createElement('input');
      offsetInput.className = 'ed-num';
      offsetInput.type = 'number';
      offsetInput.step = '0.001';
      offsetInput.value = String(chart.meta.offset ?? 0);
      offsetInput.addEventListener('change', () => {
        preview.setMetaField('offset', Number(offsetInput.value) || 0);
        autosave.markEdited();
        setStatus('offset 已更新。');
      });
      form.row('offset（秒）', offsetInput, srcOf('offset'));

      // 全局流速控制：整张谱面的下落速度与 Hold 长度都乘该倍率（判定线速度事件 + 官谱口径 Hold 的 speed）；
      // 预览同步应用（state.js 的 evaluate），所以所见即导出结果。见 docs/谱师文档.md 的谱面总览一节。
      const speedInput = document.createElement('input');
      speedInput.className = 'ed-num';
      speedInput.type = 'number';
      speedInput.step = '0.1';
      speedInput.min = '0.1';
      speedInput.max = '100';
      speedInput.value = String(chart.meta.speedMultiplier ?? 1);
      speedInput.title = '全局流速控制：整张谱面（含 Hold 长度）按该倍率变快，导出与预览一致';
      speedInput.addEventListener('change', () => {
        const v = Number(speedInput.value);
        const next = Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 1;
        preview.setMetaField('speedMultiplier', next);
        speedInput.value = String(next);
        autosave.markEdited();
        setStatus(`全局流速已设为 ${next}×（整张谱面含 Hold 统一变快）。`);
      });
      form.row('全局流速控制', speedInput, '默认 1.0');

      // 音频 / 曲绘：包内缺资源时可以在这里补齐
      const mediaRow = (label, kind) => {
        const row = document.createElement('div');
        row.className = 'ed-note-row';
        row.appendChild(el('label', 'k', label));
        const box = document.createElement('div');
        box.className = 'v';
        const loaded = kind === 'song' ? preview.hasAudio : preview.hasBackground;
        const name = (kind === 'song' ? chart.meta.song : chart.meta.background) || '未设置';
        box.appendChild(el('span', 'dim', `${name}${loaded ? ' ✓' : ' ✗'}`));
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = kind === 'song' ? 'audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac' : 'image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif';
        input.style.display = 'none';
        const btn = document.createElement('button');
        btn.className = 'ed-btn small';
        btn.type = 'button';
        btn.textContent = loaded ? '更换…' : '上传…';
        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          input.value = '';
          if (!file) return;
          btn.disabled = true;
          try {
            await (kind === 'song' ? preview.setAudioFile(file) : preview.setBackgroundFile(file));
            autosave.markEdited();
            setStatus(`已更新${label}：${file.name}`);
          } catch (err) {
            setStatus(`更新${label}失败：${err.message}`);
          } finally {
            refreshAll();
          }
        });
        box.append(btn, input);
        row.appendChild(box);
        form.form.appendChild(row);
      };
      mediaRow('音频', 'song');
      mediaRow('曲绘', 'background');

      wrap.appendChild(form.form);
      wrap.appendChild(hint('元数据即时写入内存，导出或保存项目时写入文件。'));

      const kv = document.createElement('div');
      kv.className = 'ed-kv';
      const facts = [
        ['格式', preview.formatLabel(chart)],
        ['判定线 / 音符', `${chart.lines.length} / ${chart.notes.length}（物量 ${chart.noteCount}）`],
        ['时长', `${chart.endTime.toFixed(2)} s`],
      ];
      for (const [k, v] of facts) {
        kv.append(el('div', 'k', k), el('div', 'v', String(v)));
      }
      wrap.appendChild(kv);
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
  {
    // 导出：官谱 zip / RPE zip / 内部项目文件 + 打开项目（反序列化）。
    // 打包与序列化在 src/core/export-package.js（纯数据），本页只做 DOM 与下载。
    id: 'export',
    label: '导出',
    icon: ICONS.download,
    render(root) {
      notePanelRender();
      renderExportTab(root, {
        preview,
        autosave,
        onStatus: setStatus,
        onAfterLoad: (label) => afterLoad(label), // 打开项目后重建时间轴/结构树/纠错
      });
    },
  },
], { ctx: {} });

/**
 * 载入后的一次性提醒（toast）：几秒后自动消失，也能点掉。
 * 用途见 notifyParseWarnings —— 现阶段「告知一次」就够了，不需要常驻面板。
 */
let toastTimer = 0;
function showToast(title, lines = [], foot = '') {
  const host = $('ed-toast');
  if (!host) return false;
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'title';
  head.appendChild(icon('warn', { size: 14 }));
  const label = document.createElement('span');
  label.textContent = title;
  head.appendChild(label);
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.title = '关闭';
  close.addEventListener('click', () => host.classList.add('hidden'));
  head.appendChild(close);
  host.appendChild(head);
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }
  if (foot) {
    const f = document.createElement('div');
    f.className = 'foot';
    f.textContent = foot;
    host.appendChild(f);
  }
  host.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.add('hidden'), 9000);
  return true;
}

/**
 * 解析告警只在**载入时提醒一次**（原来「诊断」页的内容，现在不再常驻）。
 * 为什么不常驻、不放进纠错页：这些告警说的是「文件里有东西被本编辑器忽略或丢弃了」
 * （未实现的扩展字段、被丢掉的脏数据），现阶段作者改不了、也不该天天看见；
 * 缺的功能以后补上，届时有内容的告警自然会变少。细节全部打到控制台备查。
 */
function notifyParseWarnings(chart, label = '') {
  const list = Array.isArray(chart?.warnings) ? chart.warnings : [];
  if (!list.length) return 0;
  for (const w of list) console.warn('[editor] 解析告警：', w);
  showToast(
    `${label ? `${label}：` : ''}${list.length} 条解析告警`,
    list.slice(0, 3).map((w) => String(w)),
    list.length > 3 ? `其余见控制台。` : '相关内容本版本忽略。',
  );
  return list.length;
}

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
    id: 'lint',
    label: '纠错',
    icon: 'warn', // assets/icons/warn.svg：警告三角
    render(root) {
      renderLint(root, {
        lint,
        chart: preview.chart,
        axis: currentAxis,
        timeline,
        preview,
        onStatus: setStatus,
      });
    },
  },
  // 「诊断」页已并入「纠错」页：这些内容不该藏在第二个标签页里，
  // 而且纠错页本来就是「这张谱面有什么问题」的唯一去处。
]);

// ───────────────────────────── 编辑操作列：撤销 / 重做 / 复制 / 剪切 / 粘贴 / 删除 ─────────────────────────────
// 与左侧「工具」列分开：左边的一列是**模式**（鼠标 / 移动 / 添加 / 剪刀），这一列是**一次性动作**。
const EDIT_ACTIONS = [
  { id: 'undo', icon: ICONS.undo, title: '撤销（Ctrl+Z）', run: () => timeline.undo(), enabled: () => timeline.canUndo },
  {
    id: 'redo',
    icon: ICONS.redo,
    title: '重做（Ctrl+Y）',
    run: () => timeline.redo(),
    enabled: () => timeline.canRedo,
  },
  { sep: true },
  { id: 'copy', icon: ICONS.copy, title: '复制（Ctrl+C）', run: () => timeline.copy(), enabled: () => timeline.selectedCount > 0 },
  {
    id: 'cut',
    icon: ICONS.cut,
    title: '剪切（Ctrl+X）',
    run: () => timeline.cut(),
    enabled: () => timeline.selectedCount > 0,
  },
  {
    id: 'paste',
    icon: ICONS.paste,
    title: '粘贴（Ctrl+V）',
    run: () => timeline.paste(),
    enabled: () => timeline.clipboardCount > 0,
  },
  {
    id: 'delete',
    icon: ICONS.del,
    title: '删除（Delete）',
    run: () => timeline.deleteSelection(),
    enabled: () => timeline.selectedCount > 0,
  },
];

const editButtons = new Map();

/** 按当前状态刷新这一列按钮的可用性（选中项 / 剪贴板 / 撤销栈一变就调） */
function updateEditButtons() {
  const labels = timeline.historyLabels ?? {};
  for (const [, entry] of editButtons) {
    const on = !!entry.action.enabled();
    entry.btn.disabled = !on;
    let title = entry.action.title;
    if (entry.action.id === 'undo' && labels.undo) title += `：${labels.undo}`;
    if (entry.action.id === 'redo' && labels.redo) title += `：${labels.redo}`;
    if (!on) title += '（当前不可用）';
    entry.btn.title = title;
  }
}

{
  const box = $('ed-actions');
  if (box) {
    for (const action of EDIT_ACTIONS) {
      if (action.sep) {
        const sep = document.createElement('div');
        sep.className = 'ed-tool-sep';
        box.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ed-tool'; // 与左列「模式」按钮同一套样式（.ed-action 已被详情面板占用）
      btn.type = 'button';
      btn.dataset.action = action.id;
      btn.appendChild(icon(action.icon, { size: 17 }));
      btn.addEventListener('click', () => {
        action.run();
        updateEditButtons();
      });
      box.appendChild(btn);
      editButtons.set(action.id, { btn, action });
    }
  }
}

// ───────────────────────────── 工具列 ─────────────────────────────
// 两个工具：鼠标（点选 / Ctrl 多选 / 框选 / 拖动）与移动（平移时间轴）
const TOOLS = [
  {
    id: 'mouse',
    icon: 'arrow', // assets/icons/arrow.svg：鼠标指针形状
    title: '点选 / 框选 / 拖动（Ctrl 多选）',
  },
  {
    id: 'pan',
    icon: 'hand', // assets/icons/hand.svg：抓手形状
    title: '拖动平移时间轴',
  },
  {
    id: 'add',
    icon: 'add', // assets/icons/add.svg：加号
    title: '放置音符与事件（Hold 与事件点两下）',
  },
  {
    id: 'scissors',
    icon: 'scissors', // assets/icons/scissors.svg
    title: '在指针处切开事件块 / Hold',
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
      setStatus(`自动回滚：${on ? '开' : '关'}`);
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
// 显示开关（判定线 / 音符 / 多押提示）已随预览顶栏一起去掉：默认全开，需要时用 preview.opts 控制。

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
        setStatus('拍号格式：a+b/c。');
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
      setStatus(`纵向吸附：${on ? '开' : '关'}`);
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
      setStatus(`横向吸附：${on ? '开' : '关'}`);
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
/** 按住 `T` 的试听状态：按下播放、松手暂停并回到起点 */
let previewHeld = false;
globalThis.addEventListener?.('keyup', (e) => {
  if (e.code !== 'KeyT' || !previewHeld) return;
  previewHeld = false;
  const at = preview.stopAndRollback();
  timeline.setTime(at);
  timeline.ensureBeatVisible(timeline.currentBeat);
  updateBeatInput(true);
  setStatus(`试听结束：回到 ${at.toFixed(2)}s`);
});

globalThis.addEventListener?.('keydown', (e) => {
  if (welcome.isOpen) return; // 欢迎弹窗期间编辑器是锁住的：快捷键一律不响应
  if (e.target instanceof HTMLInputElement) return;
  // ── 剪贴板与撤销（与桌面编辑器一致）──
  if (e.ctrlKey || e.metaKey) {
    switch (e.code) {
      case 'KeyZ':
        e.preventDefault();
        if (e.shiftKey) timeline.redo();
        else timeline.undo();
        break;
      case 'KeyY':
        e.preventDefault();
        timeline.redo();
        break;
      case 'KeyC':
        e.preventDefault();
        timeline.copy();
        break;
      case 'KeyX':
        e.preventDefault();
        timeline.cut();
        break;
      case 'KeyV':
        e.preventDefault();
        timeline.paste();
        break;
      default:
        break;
    }
    updateEditButtons();
    return;
  }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    timeline.deleteSelection();
    updateEditButtons();
    return;
  }
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      preview.toggle();
      break;
    case 'KeyT':
      // 按住 T 试听：按下开始播放，松开暂停并回到本次播放的起点（见上面的 keyup）
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) break;
      e.preventDefault();
      previewHeld = true;
      preview.play();
      setStatus('试听：按住 T 播放，松开回到起点');
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
  over.textContent = '松开以载入（文件夹 / zip / JSON）';
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
    const jsonFile = files.find((f) => /\.json$/i.test(f.name));
    const others = files.filter((f) => f !== jsonFile);
    try {
      if (zip && files.length === 1) {
        setStatus(`载入 zip 谱面包：${zip.name}…`);
        await preview.loadZip(zip);
        afterLoad(zip.name);
      } else if (jsonFile) {
        const parsed = JSON.parse(await jsonFile.text());
        if (isProject(parsed) || !others.length) {
          // 项目文件（或单个谱面 JSON）：一起拖进来的音频/曲绘会被自动挂上
          setStatus(`载入：${jsonFile.name}…`);
          await preview.loadJson(parsed, jsonFile.name, others);
          afterLoad(jsonFile.name);
        } else {
          // 谱面包目录/多文件：交给包加载器（info.txt / info.csv 的元数据也要读）
          setStatus(`载入谱面包：${files.length} 个文件…`);
          await preview.loadFiles(files);
          afterLoad(files[0].webkitRelativePath?.split('/')[0] || '谱面包');
        }
      } else if (files.length > 1) {
        setStatus(`载入谱面包：${files.length} 个文件…`);
        await preview.loadFiles(files);
        afterLoad(files[0].webkitRelativePath?.split('/')[0] || '谱面包');
      } else {
        setStatus(`不支持的文件：${files[0].name}`);
      }
    } catch (err) {
      setStatus(`拖放载入失败：${err.message}`);
    }
  });
}

// ───────────────────────────── 载入完成后的联动 ─────────────────────────────
function afterLoad(label) {
  const chart = preview.chart;
  welcome.hide(); // 载入完成：解锁编辑器（弹窗也可能由 loadJson/loadZip 之外的路径触发）
  // 默认只放「1 号线第 1 个事件层」的 5 条事件轨（整组绑定），其余由用户从结构树加
  const { axis, tracks } = defaultTracks(chart);
  currentAxis = axis;
  timeline.setChart(chart, axis);
  timeline.setTracks(tracks);
  timeline.resetView(); // 初始缩放：约 4 拍可见
  zoomInput.value = String(Math.round(timeline.pxPerBeat));
  lint.runNow(); // 换谱面后立刻重扫一遍（分片进行，不会卡住交互）
  notifyParseWarnings(chart, label); // 解析告警：载入时提醒一次（不常驻）
    setStatus(`已载入：${label}（${chart.lines.length} 线 / ${chart.notes.length} 音符）`);
  refreshAll();
}

function refreshAll() {
  topTabs.refresh();
  bottomTabs.refresh();
}

let playing = preview.playing;
let lastBeatSyncAt = 0;
preview.onTime((t) => {
  // 欢迎弹窗：一旦有谱面（无论从哪条路径载入，含控制台/测试直接调 API）就自动关掉
  if (welcome.isOpen && preview.chart) welcome.hide();
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

// ───────────────────────────── 内容交接：自动打开目标内容 ─────────────────────────────
// 开始页现在只剩两个入口、不再传数据；这里保留「外部页面 / 控制台把 JSON 或文件塞进交接区」的兼容路径。
async function openHandoff() {
  const payload = await takeHandoff();
  if (!payload) return false;
  try {
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
    setStatus(`不支持的交接类型：${payload.kind}`);
  } catch (err) {
    setStatus(`打开失败：${err.message}`);
  }
  return false;
}

await openHandoff();

// 暴露到控制台，方便后续阶段调试（编辑器骨架期）
globalThis.PhiChartEditor = {
  preview,
  timeline,
  layout,
  welcome, // 欢迎弹窗（未载入谱面前的入口：文件夹包 / zip 包 / 新建项目 / 草稿恢复 / JSON）
  autosave, // 未保存状态与草稿（脏标记、自动保存、关闭拦截、恢复）
  afterLoad, // 载入后的联动（重建拍轴/轨道/纠错）：外部用 preview.loadXxx 载入后调它即可
  topTabs,
  bottomTabs,
  lint,
  quickLine, // 快速切线（按住 Tab 的圆环选线菜单）
  setStatus,
  refreshAll,
  refreshTabs: refreshAll,
  updateEditButtons,
  notifyParseWarnings, // 载入时的一次性提醒（控制台/测试也能手动触发）
};
