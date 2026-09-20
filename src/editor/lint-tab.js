/**
 * 左下角「纠错」标签页 + 检查调度。
 *
 * 调度策略（性能优先，docs/06 §纠错 有完整说明）：
 *  - **分片**：扫描本身是生成器（src/editor/lint.js），这里每片最多占 8ms，优先用
 *    `requestIdleCallback`（带 500ms 超时兜底），没有就退回 `setTimeout(0)`。
 *    大谱面 15.4 万事件的扫描因此不会顶掉时间轴的拖动与绘制。
 *  - **防抖**：编辑后不立刻重扫，静默 900ms 再开始；连续拖动只会重扫最后一次。
 *  - **不在前台也扫**：编辑后无论当前在哪个标签页都会防抖重扫（角标要一直准），只是不在前台时不重绘列表。
 *  - **缓存**：未变动的判定线按签名复用上次结果（lint.js 负责），改一个音符只重扫那一条线。
 *  - **上限**：明细最多 4000 条（lint.js 限制），列表一次渲染 300 行、可「显示更多」；
 *    计数始终是准确的，超出上限的条目也计入统计。
 */
import { icon, ICONS } from '../ui/icons.js';
import { makeEventTrack, makeNotesTrack, createBeatAxis, EVENT_LABELS } from './tracks.js';
import { createLintScan, summarize, RULES, fmtBeat } from './lint.js';

/** 每片最多占用主线程多少毫秒 */
const SLICE_MS = 8;
/** 编辑后多久开始重扫（防抖） */
const DEBOUNCE_MS = 900;
/** requestIdleCallback 的超时兜底（保证最终一定会跑） */
const IDLE_TIMEOUT = 500;
/** 列表一次最多渲染多少行（其余等「显示更多」） */
const RENDER_STEP = 300;
/** 扫描中的进度通知间隔（毫秒）：太密会一直重绘列表 */
const PROGRESS_MS = 300;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtCount = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
const okNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * 检查控制器：整页建一个（main.js），标签页渲染与编辑事件都通过它驱动。
 *
 * @param {{
 *   getChart:()=>object|null, getAxis:()=>object|null, timeline?:object, preview?:object,
 *   onStatus?:(msg:string)=>void, onUpdate?:(info:object)=>void, isVisible?:()=>boolean
 * }} ctx
 */
export function createLintController(ctx) {
  const { getChart, getAxis, onUpdate, isVisible } = ctx;

  let scan = null; // 正在进行的扫描
  let results = null; // 上一次扫完的结果
  let cache = new Map(); // 按判定线的增量缓存
  let chartRef = null; // 缓存对应的谱面对象（换谱面就清空）
  let axisRef = null;
  let state = 'idle'; // idle | scanning | ready
  let dirty = !!getChart?.();
  let timer = null;
  let idleHandle = null;
  let lastRunAt = 0;
  let runMs = 0;
  let lastProgressAt = 0;
  /** 扫描中的轻量进度输出（只改状态行文字，不重绘整个列表）；由 renderLint 挂上来 */
  let statusSink = null;

  const visible = () => (isVisible ? !!isVisible() : true);

  function cancelPending() {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    if (idleHandle !== null) {
      if (idleHandle.kind === 'idle') globalThis.cancelIdleCallback?.(idleHandle.id);
      else globalThis.clearTimeout(idleHandle.id);
      idleHandle = null;
    }
  }

  function info() {
    return {
      state,
      dirty,
      summary: results?.summary ?? null,
      items: results?.items ?? [],
      progress: scan?.progress ?? null,
      lastRunAt,
      runMs,
    };
  }

  const notify = (full = true) => onUpdate?.(info(), { full });

  /** 排下一片（idle 优先，超时兜底） */
  function scheduleSlice() {
    const fn = () => {
      idleHandle = null;
      if (!scan) return;
      const t0 = okNow();
      const done = scan.step(SLICE_MS);
      runMs += okNow() - t0;
      if (done) {
        finish();
        return;
      }
      const now = okNow();
      if (now - lastProgressAt > PROGRESS_MS) {
        lastProgressAt = now;
        // 只更新状态行（重绘整个列表太贵，而且扫描期间结果本来就没变）
        statusSink?.(info());
        notify(false);
      }
      scheduleSlice();
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      idleHandle = { kind: 'idle', id: globalThis.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT }) };
    } else {
      idleHandle = { kind: 'timeout', id: globalThis.setTimeout(fn, 0) };
    }
  }

  /** 解析期告警（解析器丢弃 / 忽略的东西）：不在模型里，所以纠错规则扫不到，单列一块显示 */
  const parseWarnings = () => {
    const w = getChart?.()?.warnings;
    return Array.isArray(w) ? w.length : 0;
  };

  function finish() {
    results = { items: scan.items, summary: { ...summarize(scan), parseWarnings: parseWarnings() } };
    cache = scan.cache;
    scan = null;
    state = 'ready';
    const wasDirty = dirty;
    dirty = false;
    lastRunAt = Date.now();
    notify();
    // 扫描期间数据又变了 → 再排一次（防抖，不会递归立刻跑）
    if (wasDirty) schedule();
  }

  /** 立刻开始一次扫描（会取消正在进行的） */
  function runNow() {
    cancelPending();
    const chart = getChart?.() ?? null;
    if (!chart) {
      scan = null;
      results = null;
      cache = new Map();
      chartRef = null;
      state = 'idle';
      dirty = false;
      notify();
      return null;
    }
    if (chart !== chartRef) {
      cache = new Map(); // 换谱面：线号可能完全不同，缓存作废
      results = null;
      chartRef = chart;
    }
    axisRef = getAxis?.() ?? null;
    scan = createLintScan(chart, { axis: axisRef, cache });
    state = 'scanning';
    runMs = 0;
    lastProgressAt = 0;
    dirty = false;
    notify();
    scheduleSlice();
    return scan;
  }

  /** 防抖后重扫 */
  function schedule(delay = DEBOUNCE_MS) {
    cancelPending();
    timer = globalThis.setTimeout(() => {
      timer = null;
      runNow();
    }, delay);
  }

  /**
   * 数据变了：防抖后重扫。
   * 不在前台**也会扫**（角标要一直准，不然「✓」会一直骗人）——扫描是分片的，代价只有几毫秒；
   * 只是不在前台时不重绘列表（onUpdate 里已经判断了）。
   */
  function markDirty() {
    dirty = true;
    if (state === 'scanning') return; // 扫完会自己再排一次
    schedule();
  }

  /** 打开本页时调用：脏了（还没排上）就立刻开扫，不等防抖 */
  function ensureFresh() {
    if (!dirty || state === 'scanning') return false;
    runNow();
    return true;
  }

  return {
    get state() {
      return state;
    },
    get dirty() {
      return dirty;
    },
    get chart() {
      return chartRef;
    },
    get axis() {
      return axisRef;
    },
    get items() {
      return results?.items ?? [];
    },
    get summary() {
      return results?.summary ?? null;
    },
    get progress() {
      return scan?.progress ?? null;
    },
    info,
    runNow,
    schedule,
    markDirty,
    ensureFresh,
    cancel: cancelPending,
    /** 挂一个「只改状态行」的轻量输出（renderLint 用；传 null 摘掉） */
    setStatusSink(fn) {
      statusSink = fn ?? null;
    },
  };
}

/** 跳转到某条错误：需要时先自动把轨道加进时间轴，再纵向/横向把视角移过去并选中对象 */
export function jumpToLintItem(item, { timeline, chart, axis, preview, onStatus }) {
  if (!item || !timeline) return false;
  // 拍轴可能还没就位（例如没有走 afterLoad 的调用方）→ 就地建一个，别把 null 传下去
  const ax = axis ?? (chart ? createBeatAxis(chart) : null);
  const trackId = item.kind === 'note' ? `notes:${item.lineId}` : `ev:${item.lineId}:${item.layerIndex}:${item.key}`;
  let track = timeline.tracks.find((t) => t.id === trackId);
  let added = false;
  if (!track && chart) {
    track =
      item.kind === 'note'
        ? makeNotesTrack(chart, item.lineId, ax)
        : makeEventTrack(chart, item.lineId, item.layerIndex, item.key, ax);
    added = timeline.addTrack(track) !== false;
  }
  timeline.revealTrack?.(trackId); // 纵向滚到该轨道
  let selected = false;
  if (track) {
    const index = track.clips.findIndex((c) => (item.kind === 'note' ? c.note === item.obj : c.ev === item.obj));
    if (index >= 0) {
      const key = `${trackId}#${index}`;
      if (item.kind === 'note') timeline.selectNotes([key]);
      else timeline.selectEvents([key]);
      selected = true;
    }
  }
  // 横向跳转用**秒**：纠错条目里的秒是线内时间轴算出来的，与时间轴的拍轴无关
  const sec = Number.isFinite(item.sec) ? item.sec : (ax?.toSec?.(item.beat ?? 0) ?? 0);
  timeline.setTime(sec); // 指针跳过去（main.js 的 onSeek 会把预览一起带过去）
  // 视野用时间轴自己的拍号，避免「线内拍 ≠ 全局拍」时滚错位置
  timeline.ensureBeatVisible(timeline.currentBeat ?? item.beat ?? 0);
  const what = item.kind === 'note' ? '音符' : `${EVENT_LABELS[item.key] ?? item.key}（层 ${Number(item.layerIndex) + 1}）`;
  onStatus?.(
    `纠错跳转：${item.where} · ${what} · ${fmtBeat(item.beat ?? 0)} 拍` +
      (added ? '　（该轨道不在时间轴里，已自动加入）' : '') +
      (selected ? '' : '　（时间轴里没找到对应片段，只跳了视角）'),
  );
  return true;
}

/** 渲染「纠错」标签页（左下工作区）。ctx: { lint, chart, axis, timeline, preview, onStatus } */
export function renderLint(root, ctx) {
  const { lint, chart, axis, timeline, preview, onStatus } = ctx;
  const wrap = el('div', 'ed-scroll ed-lint');
  // 视图状态放在 render 外面：重绘（进度刷新、切标签页）不能丢用户的筛选与分页
  const view = { filter: 'all', limit: RENDER_STEP };

  /** 状态行文字（进度只更新这一行，不重绘列表） */
  const statusText = (info) => {
    const summary = info.summary;
    if (!chart) return '还没有载入谱面。';
    if (info.state === 'scanning') {
      const p = info.progress;
      return `检查中…（${p ? `${p.lines}/${p.total} 条判定线 · 已发现 ${fmtCount(p.items)} 条` : '准备中'}）`;
    }
    if (info.dirty) return '数据已变动：正在排队重扫（切回本页会立刻开始）。';
    if (!summary) return '尚未检查。点上面「重新检查」，或等自动开始。';
    const t = info.lastRunAt ? new Date(info.lastRunAt).toLocaleTimeString() : '';
    return (
      `检查完毕${t ? `（${t} · 耗时 ${Math.round(info.runMs)}ms）` : ''}：` +
      `${summary.lines} 条线 · ${fmtCount(summary.scanned.notes)} 音符 · ${fmtCount(summary.scanned.events)} 事件` +
      (summary.truncated ? `　⚠ 另有 ${fmtCount(summary.truncated)} 条超出明细上限，只计入统计` : '')
    );
  };

  function render() {
    wrap.innerHTML = '';
    const info = lint.info();
    const summary = info.summary;

    // ── 工具条：重新检查 + 统计 ──
    const bar = el('div', 'ed-tree-bar ed-lint-bar');
    const btn = document.createElement('button');
    btn.className = 'ed-iconbtn';
    btn.type = 'button';
    btn.title = '立刻重新检查一遍（分片进行，不会卡住时间轴）';
    btn.appendChild(icon(ICONS.redo, { size: 14 }));
    btn.appendChild(el('span', 'lbl', '重新检查'));
    btn.addEventListener('click', () => {
      lint.runNow();
      onStatus?.('纠错：重新检查中…');
      render();
    });
    bar.appendChild(btn);
    if (summary) {
      bar.appendChild(el('span', 'ed-lint-tally errors', `错误 ${summary.error}`));
      bar.appendChild(el('span', 'ed-lint-tally warns', `警告 ${summary.warn}`));
      if (summary.parseWarnings) bar.appendChild(el('span', 'ed-lint-tally parses', `解析 ${summary.parseWarnings}`));
    }
    wrap.appendChild(bar);

    // ── 状态行（扫描中的进度只更新这一行） ──
    const st = el('div', 'ed-lint-state', statusText(info));
    wrap.appendChild(st);
    lint.setStatusSink?.((next) => {
      st.textContent = statusText(next);
    });

    // ── 解析告警（原来单独的「诊断」页）：解析器丢弃 / 忽略掉的东西 ──
    // 与纠错规则是两回事：那些数据**没能进模型**，所以纠错扫不到；但作者必须知道
    // （「用了未实现的扩展事件」「*Control 字段被忽略」正是「编辑器看起来没反应」的常见原因）。
    const warnings = Array.isArray(chart?.warnings) ? chart.warnings : [];
    if (warnings.length) {
      const head = el('div', 'ed-lint-group warn');
      head.appendChild(el('span', 'name', '解析告警（解析时被忽略或丢弃的内容）'));
      head.appendChild(el('span', 'n', String(warnings.length)));
      head.title = '解析器在读文件时给出的告警：不支持的扩展字段、被丢弃的脏数据等。这些内容不会进入模型，所以上面的纠错规则扫不到。';
      wrap.appendChild(head);
      const box = el('div', 'ed-lint-list');
      for (const w of warnings.slice(0, 60)) {
        const row = el('div', 'ed-lint-item warn plain');
        const main = el('div', 'main');
        main.appendChild(el('div', 'd', String(w)));
        row.appendChild(main);
        box.appendChild(row);
      }
      if (warnings.length > 60) box.appendChild(el('div', 'ed-hint', `…其余 ${warnings.length - 60} 条省略（控制台里有全部）`));
      wrap.appendChild(box);
    }

    if (chart && !summary) {
      wrap.appendChild(el('div', 'ed-hint', '尚未检查。点上面「重新检查」，或等自动开始。'));
      return;
    }

    // ── 全部通过：把检查项列出来，说明「检查了什么」 ──
    if (summary && !summary.total) {
      const ruleNames = Object.values(RULES);
      wrap.appendChild(
        el(
          'div',
          'ed-hint',
          `模型检查通过：以下 ${ruleNames.length} 项都没有发现问题。` +
            (warnings.length ? `（另有 ${warnings.length} 条解析告警，见上）` : ''),
        ),
      );
      const chips = el('div', 'ed-list ed-lint-rules');
      for (const rule of ruleNames) {
        const chip = el('span', `ed-chip ed-lint-rule ${rule.severity}`, rule.name);
        chip.title = rule.hint;
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return;
    }
    if (!summary) return;

    // ── 筛选 ──
    const filterBar = el('div', 'ed-list ed-lint-filter');
    const mkChip = (id, label, count) => {
      const chip = document.createElement('button');
      chip.className = `ed-chip${view.filter === id ? ' active' : ''}`;
      chip.type = 'button';
      chip.textContent = `${label} ${count}`;
      chip.addEventListener('click', () => {
        view.filter = id;
        view.limit = RENDER_STEP;
        render();
      });
      filterBar.appendChild(chip);
    };
    mkChip('all', '全部', summary.total);
    mkChip('error', '错误', summary.error);
    mkChip('warn', '警告', summary.warn);
    wrap.appendChild(filterBar);

    // ── 列表：按规则分组（顺序 = 明细里首次出现的顺序，即 错误优先 → 线号 → 拍） ──
    const items = lint.items.filter((it) => view.filter === 'all' || it.severity === view.filter);
    const groups = new Map();
    for (const it of items) {
      let g = groups.get(it.rule);
      if (!g) groups.set(it.rule, (g = { rule: it.rule, items: [] }));
      g.items.push(it);
    }

    const list = el('div', 'ed-lint-list');
    let shown = 0;
    let capped = false;
    for (const g of groups.values()) {
      if (capped) break;
      const rule = RULES[g.rule] ?? { name: g.rule, severity: 'warn', hint: '' };
      const head = el('div', `ed-lint-group ${rule.severity}`);
      head.appendChild(el('span', 'name', rule.name));
      head.appendChild(el('span', 'n', String(g.items.length)));
      head.title = rule.hint;
      list.appendChild(head);
      for (const it of g.items) {
        if (shown >= view.limit) {
          capped = true;
          break;
        }
        const row = document.createElement('div');
        row.className = `ed-lint-item ${it.severity}`;
        row.title = '点击跳到这个位置（轨道不在时间轴里时会自动加入）';
        const main = el('div', 'main');
        const t = el('div', 't');
        t.appendChild(el('span', 'loc', `${it.where} · ${fmtBeat(it.beat ?? 0)} 拍`));
        t.appendChild(el('span', 'tag', it.kind === 'note' ? '音符' : EVENT_LABELS[it.key] ?? it.key));
        main.appendChild(t);
        main.appendChild(el('div', 'd', it.text));
        row.appendChild(main);
        row.addEventListener('click', () => {
          jumpToLintItem(it, { timeline, chart, axis, preview, onStatus });
          for (const other of list.querySelectorAll('.ed-lint-item.active')) other.classList.remove('active');
          row.classList.add('active');
        });
        list.appendChild(row);
        shown++;
      }
    }
    if (capped) {
      const more = document.createElement('button');
      more.className = 'ed-btn small';
      more.type = 'button';
      more.textContent = `显示更多（还有 ${items.length - shown} 条）`;
      more.addEventListener('click', () => {
        view.limit += RENDER_STEP;
        render();
      });
      list.appendChild(more);
    }
    wrap.appendChild(list);
  }

  root.appendChild(wrap);
  render();
  const started = lint.ensureFresh(); // 打开本页时，数据脏了就立刻开扫
  if (started) onStatus?.('纠错：检查中…');
}
