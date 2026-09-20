/**
 * 撤销 / 重做：记录「这次操作真的碰过什么」，而不是给整张谱面拍快照。
 *
 * **性能上的取舍（为什么不存快照）**
 *  - 白复生 AT 是 24 线 / 15.4 万事件，整谱深拷贝一次要几十毫秒、几十 MB；每次操作存一份会立刻吃满内存。
 *  - 这里只记两样：① 被改对象的**改动前字段值**（提交时再取一次改后的，只留真正变了的键）；
 *    ② 结构改动（往哪个数组加了 / 删了哪个对象）。一次「拖动 3 个事件」= 3 个小对象拷贝；
 *    一次「粘贴 200 个音符」= 200 条只带引用的记录。
 *  - **派生数据一律不存**（编译后的事件列表、音符的 timeSec/height）：撤销后由调用方按受影响的线跑一次
 *    `refreshLine()` / `refreshNotes()` 重算。这样内存小、也不会出现「快照与派生数据不一致」。
 *  - 栈有上限（默认 80 步），超出丢最旧的；换谱面时整体清空。
 *
 * 用法（调用方负责「先记录再改」）：
 * ```
 * const h = createHistory({ onChange });
 * const tx = h.begin('移动事件');
 * h.touch(ev);                      // 记录改动前字段（带 obj.src 的会一起记）
 * h.eventLine(0, 'x');              // 标记哪条线的哪类事件要重编译
 * ...就地改 ev...
 * h.commit();                       // 提交（没有任何变化则不占栈位）
 * ```
 */

/** 撤销栈深度上限（步） */
export const HISTORY_LIMIT = 80;

/** 浅拷贝对象的可枚举字段（事件/音符都是扁平对象；easingFn 这类引用直接带着走） */
function cloneFields(obj) {
  const out = {};
  for (const key of Object.keys(obj)) out[key] = obj[key];
  return out;
}

/** 把对象插回数组：给了位置就插回去，否则按时间有序插入（找不到时间就追加） */
function insertAt(list, obj, index) {
  if (!Array.isArray(list) || !obj) return false;
  if (list.includes(obj)) return false;
  if (Number.isInteger(index) && index >= 0 && index <= list.length) {
    list.splice(index, 0, obj);
    return true;
  }
  const t = Number.isFinite(obj.timeSec) ? obj.timeSec : Number.isFinite(obj.startBeat) ? obj.startBeat : null;
  if (t !== null) {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const v = it && (Number.isFinite(it.timeSec) ? it.timeSec : Number.isFinite(it.startBeat) ? it.startBeat : null);
      if (v !== null && v > t) {
        list.splice(i, 0, obj);
        return true;
      }
    }
  }
  list.push(obj);
  return true;
}

const removeFrom = (list, obj) => {
  if (!Array.isArray(list)) return false;
  const i = list.indexOf(obj);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
};

function assign(obj, values) {
  for (const [k, v] of Object.entries(values ?? {})) obj[k] = v;
}

export function createHistory({ limit = HISTORY_LIMIT, onChange = null } = {}) {
  const undoStack = [];
  const redoStack = [];
  let tx = null;

  function begin(label = '编辑') {
    tx = { label, before: new Map(), adds: [], removes: [], lines: new Map(), selBefore: null, selAfter: null };
    return tx;
  }
  const ensure = () => tx ?? begin();

  /** 记录对象的改动前字段（`obj.src` 会被一起记：详情面板会同时写源对象） */
  function touch(obj, seen = null) {
    if (!obj || typeof obj !== 'object') return;
    const seenSet = seen ?? new Set();
    if (seenSet.has(obj)) return;
    seenSet.add(obj);
    const t = ensure();
    if (!t.before.has(obj)) t.before.set(obj, cloneFields(obj));
    if (obj.src && typeof obj.src === 'object') touch(obj.src, seenSet);
  }

  const touchAll = (list) => {
    for (const o of list ?? []) touch(o);
  };
  const added = (list, obj) => ensure().adds.push({ list, obj });
  const removed = (list, obj) => ensure().removes.push({ list, obj, index: Array.isArray(list) ? list.indexOf(obj) : -1 });
  const eventLine = (lineId, key) => {
    if (!Number.isFinite(lineId)) return;
    const t = ensure();
    let d = t.lines.get(lineId);
    if (!d) t.lines.set(lineId, (d = { keys: new Set(), notes: false }));
    for (const k of Array.isArray(key) ? key : [key]) if (k) d.keys.add(k);
  };
  const noteLine = (lineId) => {
    if (!Number.isFinite(lineId)) return;
    const t = ensure();
    let d = t.lines.get(lineId);
    if (!d) t.lines.set(lineId, (d = { keys: new Set(), notes: false }));
    d.notes = true;
  };
  /** 撤销/重做之后要恢复的选中项（传对象而不是 key：重建轨道后 index 会变） */
  const selection = ({ before, after } = {}) => {
    const t = ensure();
    if (before !== undefined) t.selBefore = before;
    if (after !== undefined) t.selAfter = after;
  };

  /** 提交：把「变了的字段」固化下来；没有实际变化就不占栈位 */
  function commit() {
    const t = tx;
    tx = null;
    if (!t) return null;
    const fields = [];
    for (const [obj, before] of t.before) {
      const after = cloneFields(obj);
      const b = {};
      const a = {};
      let changed = false;
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[key] !== after[key]) {
          b[key] = before[key];
          a[key] = after[key];
          changed = true;
        }
      }
      if (changed) fields.push({ obj, before: b, after: a });
    }
    if (!fields.length && !t.adds.length && !t.removes.length) return null;
    const entry = {
      label: t.label,
      fields,
      adds: t.adds,
      removes: t.removes,
      lines: [...t.lines],
      notes: [...t.lines.values()].some((d) => d.notes),
      selBefore: t.selBefore,
      selAfter: t.selAfter,
    };
    undoStack.push(entry);
    while (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    onChange?.({ entry, direction: 'do' });
    return entry;
  }

  const abort = () => {
    tx = null;
  };

  function applyEntry(entry, direction) {
    if (direction === 'undo') {
      for (const a of entry.adds) removeFrom(a.list, a.obj);
      for (const r of entry.removes) insertAt(r.list, r.obj, r.index);
      for (const f of entry.fields) assign(f.obj, f.before);
    } else {
      for (const r of entry.removes) removeFrom(r.list, r.obj);
      for (const a of entry.adds) insertAt(a.list, a.obj, a.index ?? null);
      for (const f of entry.fields) assign(f.obj, f.after);
    }
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    applyEntry(entry, 'undo');
    redoStack.push(entry);
    onChange?.({ entry, direction: 'undo' });
    return entry;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return null;
    applyEntry(entry, 'redo');
    undoStack.push(entry);
    onChange?.({ entry, direction: 'redo' });
    return entry;
  }

  return {
    begin,
    touch,
    touchAll,
    added,
    removed,
    eventLine,
    noteLine,
    selection,
    commit,
    abort,
    undo,
    redo,
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      tx = null;
    },
    /** 放弃最后一步（不回滚数据，只丢弃这条记录） */
    dropLast() {
      undoStack.pop();
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get undoLabel() {
      return undoStack[undoStack.length - 1]?.label ?? null;
    },
    get redoLabel() {
      return redoStack[redoStack.length - 1]?.label ?? null;
    },
    get depth() {
      return { undo: undoStack.length, redo: redoStack.length };
    },
  };
}
