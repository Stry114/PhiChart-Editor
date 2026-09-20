/**
 * 自动保存与「未保存」状态。
 *
 * 三条职责：
 *  1. **脏标记**：模型被改动（时间轴写回 / 详情面板 / 元数据 / 媒体替换）→ `dirty = true`，
 *     导出标签页出现「未保存」角标。只有**保存项目（内部格式）**成功才算保存，官谱 / RPE
 *     导出是有损互操作，不改变未保存状态。
 *  2. **草稿自动保存**：改动去抖 4 秒后把项目格式写进浏览器本地（见 `draft.js`），
 *     两次写入间隔不小于 15 秒；页面隐藏 / 卸载前尽力补一次。
 *  3. **关闭拦截**：有未保存改动时 `beforeunload` 阻止关闭并提醒保存（原生文案由浏览器决定）。
 *
 * 文案与提醒：第一次改动时弹一次 toast —— **只讲不保存的后果与保存方式**，
 * 不宣称「有自动备份」（否则用户会依赖草稿，而草稿只是意外关闭时的补救）。
 */
import { createDraftStore, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MIN_INTERVAL_MS } from './draft.js';
import { serializeProject } from '../core/project.js';

const SAVE_HINT = '关闭或刷新页面会丢失本次修改；请在「导出」页用「保存项目」写入文件。';

/** HH:MM:SS（状态栏与导出页显示用） */
const fmtTime = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString() : '—';
};

/**
 * @param {{
 *   preview:object, store?:object, onStatus?:(msg:string)=>void,
 *   onDirtyChange?:(dirty:boolean)=>void, onNotice?:(msg:string)=>void,
 *   debounceMs?:number, minIntervalMs?:number
 * }} ctx
 */
export function createAutosave(ctx = {}) {
  const { preview, onStatus, onDirtyChange, onNotice } = ctx;
  const store = ctx.store ?? createDraftStore();
  const debounceMs = Number.isFinite(ctx.debounceMs) ? ctx.debounceMs : AUTOSAVE_DEBOUNCE_MS;
  const minIntervalMs = Number.isFinite(ctx.minIntervalMs) ? ctx.minIntervalMs : AUTOSAVE_MIN_INTERVAL_MS;

  let dirty = false;
  let savedAt = null;
  let draftIndex = null; // 启动时读到的旧草稿概要（恢复卡片用）
  let timer = 0;
  let inFlight = null; // 正在进行的草稿写入（Promise）：并发调用合并到同一次
  let lastWriteAt = 0;
  let writes = 0;
  let flushes = 0;
  let error = null;
  let sawEdit = false; // 「不写入磁盘」提醒只发一次
  let stopped = false; // 写入失败后停用自动保存（脏标记与拦截继续工作）

  const notify = () => onDirtyChange?.(dirty);

  function markEdited() {
    if (!preview?.chart) return;
    if (!dirty) {
      dirty = true;
      notify();
    }
    if (!sawEdit) {
      sawEdit = true;
      onNotice?.(SAVE_HINT);
    }
    schedule();
  }

  /** 载入新内容：与「刚打开的文件」一致 → 清脏、清角标，但**不动草稿**（它可能属于另一张谱面） */
  function markClean() {
    if (!dirty) return;
    dirty = false;
    notify();
  }

  /** 保存项目成功：清脏、清角标、删掉草稿（它的使命已经完成） */
  function markSaved() {
    dirty = false;
    notify();
    void store
      .clear()
      .then(() => {
        draftIndex = null;
        savedAt = null;
      })
      .catch(() => {});
  }

  function schedule() {
    if (stopped || !preview?.chart) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      void save(false);
    }, debounceMs);
  }

  async function save(force) {
    if (stopped || !preview?.chart) return false;
    if (inFlight) return await inFlight; // 已有一次写入在飞：合并，等它
    const now = Date.now();
    if (!force && now - lastWriteAt < minIntervalMs) {
      schedule(); // 距上次写入太近：往后挪
      return false;
    }
    inFlight = (async () => {
      try {
        const { json } = serializeProject(preview.chart);
        const resources = (await preview.resources?.()) ?? [];
        const index = await store.write({
          json,
          label: preview.chart.meta?.name ?? '',
          sourceFormat: preview.chart.format ?? '',
          meta: preview.chart.meta ?? {},
          resources,
        });
        savedAt = index?.savedAt ?? new Date().toISOString();
        draftIndex = index ?? null;
        lastWriteAt = Date.now();
        writes++;
        error = null;
        onStatus?.(`本地草稿已更新（${fmtTime(savedAt)}）`);
        return true;
      } catch (err) {
        error = err?.message ?? String(err);
        stopped = true;
        onStatus?.(`本地草稿写入失败：${error}（请手动保存项目）`);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return await inFlight;
  }

  /** 立刻写一次（页面隐藏 / 卸载 / 测试用；忽略最小间隔，并等待正在进行的写入） */
  async function flush() {
    flushes++;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    return await save(true);
  }

  async function discardDraft() {
    draftIndex = null;
    savedAt = null;
    await store.clear().catch(() => {});
    onStatus?.('草稿已丢弃。');
  }

  /** 启动时读一次草稿概要（只读小记录） */
  async function loadDraftIndex() {
    draftIndex = await store.peek();
    savedAt = draftIndex?.savedAt ?? null;
    return draftIndex;
  }

  // ── 关闭 / 隐藏时的处理 ──
  const onBeforeUnload = (e) => {
    if (!dirty) return undefined;
    e?.preventDefault?.();
    if (e) e.returnValue = '有未保存的修改，请先保存项目。';
    return '有未保存的修改，请先保存项目。';
  };
  const onPageHide = () => {
    if (dirty) void flush();
  };
  const onVisibilityChange = () => {
    // document.hidden === false 才是「确定可见」；桩件环境没有该字段时按隐藏处理（可直接测）
    if (globalThis.document?.hidden === false) return;
    if (dirty) void flush();
  };
  globalThis.addEventListener?.('beforeunload', onBeforeUnload);
  globalThis.addEventListener?.('pagehide', onPageHide);
  globalThis.addEventListener?.('visibilitychange', onVisibilityChange);
  globalThis.document?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    markEdited,
    markClean,
    markSaved,
    flush,
    discardDraft,
    loadDraftIndex,
    /** 完整草稿（恢复用）：{ index, json, files } */
    readDraft: () => store.read(),
    /** 草稿概要（不读谱面体，也不改内部状态） */
    peekDraft: () => store.peek(),
    get isDirty() {
      return dirty;
    },
    get savedAt() {
      return savedAt;
    },
    get draftIndex() {
      return draftIndex;
    },
    get storeKind() {
      return store.kind;
    },
    get state() {
      return { dirty, savedAt, draft: draftIndex, store: store.kind, writes, flushes, error, stopped, lastWriteAt };
    },
    /** 草稿时间文案（导出页用） */
    savedAtLabel: () => (savedAt ? fmtTime(savedAt) : ''),
    dispose() {
      if (timer) clearTimeout(timer);
      timer = 0;
      globalThis.removeEventListener?.('beforeunload', onBeforeUnload);
      globalThis.removeEventListener?.('pagehide', onPageHide);
      globalThis.removeEventListener?.('visibilitychange', onVisibilityChange);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}
