/**
 * 详情面板（Note / Event）共用的零部件：
 *  - 多选时的「共同值」判定（不加载默认值，而是一致才显示、不一致显示「多个值」）
 *  - 表单行 / 数字输入 / 复选 / 下拉的构造（都走 .ed-note-row 风格）
 *  - 拍号解析与格式化（a+b/c）
 */

export const round4 = (v) => Math.round(v * 1e4) / 1e4;

export const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * 上一次编辑结果的提示行。
 * 背景：状态文字只写到窗口标题，改完之后面板里看不出任何变化时，用户会以为「改了没反应」；
 * 这里把结果留在面板里，并且只在选中项没变时显示（换了选中就清空，避免误导）。
 */
let lastAction = null;

export function setLastAction(text, { bad = false, sig = '' } = {}) {
  lastAction = text ? { text, bad, sig } : null;
}

/**
 * 取出提示行。
 * 成功的修改**不再显示任何文字**（界面保持干净）；只有真出问题时才有这一行：
 * 写入失败、选中项已变化、模型复读不到刚写的值（多见于浏览器缓存了旧谱面/旧脚本）。
 */
export function actionLine(selectionSig = '') {
  if (!lastAction || lastAction.sig !== selectionSig) return null;
  if (!lastAction.bad) return null; // 成功＝不打扰
  return el('div', `ed-action${lastAction.bad ? ' bad' : ''}`, lastAction.text);
}

/** 多项取共同值：全部相同才返回，否则 undefined（表示「多个值」，不加载默认值） */
export function commonValue(items, read) {
  if (!items.length) return undefined;
  const first = read(items[0]);
  for (const it of items) {
    const v = read(it);
    if (Number.isNaN(first) && Number.isNaN(v)) continue;
    if (v !== first) return undefined;
  }
  return first;
}

/** 解析 a+b/c（也接受小数） */
export function parseBeat(text) {
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

/** 拍 → a+b/c 文本 */
export function fmtBeat(beat, den = 8) {
  const whole = Math.floor(beat + 1e-9);
  const frac = beat - whole;
  if (frac < 1e-6) return `${whole}+0/1`;
  const num = Math.round(frac * den);
  if (Math.abs(num / den - frac) > 1e-6) return String(round4(beat));
  return `${whole}+${num}/${den}`;
}

/**
 * 生成一个「表单面板」构造器。
 * @returns {{form: HTMLElement, row: Function, number: Function, check: Function, select: Function, hint: Function}}
 */
export function createForm() {
  const form = el('div', 'ed-note-form');
  const row = (label, control, hintText) => {
    const r = el('div', 'ed-note-row');
    r.appendChild(el('label', 'k', label));
    const box = el('div', 'v');
    box.appendChild(control);
    if (hintText) box.appendChild(el('span', 'dim', hintText));
    r.appendChild(box);
    form.appendChild(r);
    return r;
  };
  const number = ({ value, placeholder, step = '0.1', min = null, onChange }) => {
    const input = document.createElement('input');
    input.className = 'ed-num';
    input.type = 'number';
    input.step = step;
    if (min !== null) input.min = String(min);
    input.placeholder = placeholder;
    if (value !== undefined) input.value = String(round4(value));
    input.addEventListener('change', () => onChange(Number(input.value)));
    return input;
  };
  const check = ({ checked, mixed, hintText, onChange }) => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    if (mixed) {
      input.indeterminate = true;
      input.checked = false;
    } else {
      input.checked = !!checked;
    }
    input.addEventListener('change', () => onChange(input.checked));
    const box = el('div', 'v');
    box.appendChild(input);
    if (hintText) box.appendChild(el('span', 'dim', hintText));
    return box;
  };
  const select = ({ options, value, emptyLabel, onChange }) => {
    const sel = document.createElement('select');
    sel.className = 'ed-select';
    if (emptyLabel) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = emptyLabel;
      sel.appendChild(opt);
      sel.value = '';
    }
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    if (value !== undefined) sel.value = String(value);
    sel.addEventListener('change', () => {
      if (sel.value !== '') onChange(sel.value);
    });
    return sel;
  };
  const hint = (text) => form.appendChild(el('div', 'ed-hint', text));
  return { form, row, number, check, select, hint };
}

/** 面板头部：已选中 N 项 + 汇总 */
export function buildHead(count, label, summaryText) {
  const head = el('div', 'ed-note-head');
  head.appendChild(el('span', 'count', `已选中 ${count} 个${label}`));
  if (summaryText) head.appendChild(el('span', 'dim', summaryText));
  return head;
}

/** ───────────────────────── 步进按钮（Event / Note 详情共用） ─────────────────────────
 * 按钮一律无底无边框、只放图标（add / minus），动作说明走悬浮提示 —— 与界面整体风格一致。 */

import { setIcon } from '../ui/icons.js';

/** 拍步进：细步 1/32 拍、粗步 1 拍 */
export const BEAT_STEPS = [
  { icon: 'minus', delta: -1, title: '减 1 拍' },
  { icon: 'minus', delta: -1 / 32, title: '减 1/32 拍' },
  { icon: 'add', delta: 1 / 32, title: '加 1/32 拍' },
  { icon: 'add', delta: 1, title: '加 1 拍' },
];

/**
 * 拍号输入 + 步进按钮（−1拍 / −1/32 / +1/32 / +1拍）+ 可选的尾部图标按钮。
 * `onDelta(delta)` 收到带符号的拍数；`extra` 是要追加进同一行的按钮（已建好）。
 */
export function beatStepperRow(input, onDelta, extra = []) {
  const box = el('div', 'ed-inline');
  box.appendChild(input);
  for (const st of BEAT_STEPS) {
    const b = document.createElement('button');
    b.className = 'ed-mini';
    b.type = 'button';
    b.title = st.title;
    setIcon(b, st.icon, { size: 12 });
    b.addEventListener('click', () => onDelta(st.delta));
    box.appendChild(b);
  }
  for (const b of extra) box.appendChild(b);
  return box;
}

/**
 * 数值步长 = **数值最高位的 1/10**：521 → 10、30 → 1、1.5 → 0.1、0.5 → 0.01、0 → 0.1。
 * 步长在「当前显示单位」里算（官谱列 / RPE 列各自按自己的数取步长）。
 */
export function unitStepOf(v) {
  const a = Math.abs(Number(v));
  if (!Number.isFinite(a) || a === 0) return 0.1;
  return Math.pow(10, Math.floor(Math.log10(a))) / 10;
}

/** 把步进结果清到 6 位小数（消掉 0.1 + 0.2 之类的浮点尾巴） */
const snap = (v) => Math.round(v * 1e6) / 1e6;

/**
 * 双单位制数值行（Note / Event 详情共用；网格布局，各行的列相互对齐）。
 *
 * 每行六列：标签 | 官谱值 | RPE 值 | − | ＋ | 参考范围。
 *  - `units.official / units.rpe` 都给 → 两列分别按官谱 / RPE 单位显示，改任一列写回内部值，
 *    另一列由重渲染自动适配；
 *  - `units.single` → 该项不区分单位制，前两列合并成一个输入（按 single 的换算显示）；
 *  - `units` 为 null → 合并列直接按内部值显示；
 *  - `rpeText` → RPE 列渲染成**文本输入**（拍号的 a+b/c 写法用：`to` 内部值 → 文本、
 *    `parse` 文本 → 内部值），此时 RPE 列不参与数字换算，但 ± 按钮仍可对它步进；
 *  - `−` / `＋` 按钮作用于**最近聚焦的那一列**（默认官谱列）。步长：给了 `fixedStep`
 *    （内部单位，时间行 = 1 拍）就按它；否则 = 该列数值最高位的 1/10（unitStepOf：
 *    521 → 10、1.5 → 0.1、0.5 → 0.01、0 → 0.1）。悬停输入框滚轮同理；
 *  - `range` 参考范围（官谱列口径；无范围或不明确就给空串，整格留空）。
 *
 * @param {object} p
 * @param {string} p.label 行标签
 * @param {{official?:{to:Function,from:Function}, rpe?:{to:Function,from:Function}, single?:{to:Function,from:Function}}|null} [p.units]
 * @param {number|undefined} p.value 当前内部值（多选不一致 = undefined → 占位「多个值」）
 * @param {(v:number, source:string)=>void} p.onSet 写回内部值（调用方负责撤销记录与重渲染）
 * @param {string} [p.range]
 * @param {string} [p.mixedLabel] 多选不一致 / 哨兵态的占位文字
 * @param {(v:number)=>number|null} [p.validate] 写回前校验（返回 null 拒绝，配合 onInvalid 提示）
 * @param {(msg:string)=>void} [p.onInvalid]
 * @param {HTMLElement} [p.control] 自定义控件（下拉 / 复选 / 色块等），占据合并后的值列
 * @param {boolean} [p.stepper] 合并行也带 −/＋ 按钮
 * @param {{to:Function, parse:Function}} [p.rpeText] RPE 列用文本输入（拍号 a+b/c）
 * @param {number} [p.fixedStep] 固定步长（内部单位；时间行 = 1 拍），不给就按「最高位 1/10」规则
 * @param {HTMLElement[]} [p.rpeExtra] 追加到 RPE 列输入框后面的图标按钮（如「延到下一事件」）
 * @param {boolean} [p.integer] 整数输入（颜色通道等；步长至少 1）
 */
export function dualUnitRow(p) {
  const {
    label,
    units = null,
    value,
    onSet,
    range = '',
    mixedLabel = '',
    validate = null,
    onInvalid = null,
    control = null,
    stepper = false,
    rpeText = null,
    fixedStep = null,
    rpeExtra = [],
    integer = false,
  } = p;
  const row = el('div', 'ed-dual-row');
  row.appendChild(el('label', 'k', label));
  const mixed = value === undefined;
  const mode = units ? (units.single ? 'single' : 'dual') : 'raw';
  const show = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return integer ? String(Math.round(n)) : String(round4(n));
  };
  const reject = (msg) => {
    onInvalid?.(msg);
  };
  const conv = (unitKey) =>
    unitKey === 'official' ? units?.official : unitKey === 'rpe' && !rpeText ? units?.rpe : units?.single ?? null;
  /** 显示值 → 内部值（校验通过返回内部值，否则 null） */
  const toInternal = (raw, unitKey) => {
    const c = conv(unitKey);
    const internal = c ? c.from(raw) : raw;
    const checked = validate ? validate(internal) : internal;
    return checked === null || checked === undefined || !Number.isFinite(checked) ? null : checked;
  };

  let active = 'official'; // ± 按钮作用的列（最近聚焦的一列）
  let offInput = null;
  let rpeInput = null;

  /** 步进的核心：内部值 ± step → 写回（input 的显示由调用方先刷新）；viaWheel 用于合并撤销 */
  const commitInternal = (internal, unitKey, viaWheel = false) => {
    const checked = validate ? validate(internal) : internal;
    if (checked === null || checked === undefined || !Number.isFinite(checked)) {
      reject(`${label} 超出允许范围`);
      return false;
    }
    onSet(checked, unitKey ?? 'single', viaWheel);
    return true;
  };

  const mkNum = (unitKey) => {
    const input = document.createElement('input');
    input.className = 'ed-num';
    input.type = 'number';
    if (integer) {
      input.step = '1';
      input.min = '0';
    }
    // 占位文字与旧版一致：多选 / 哨兵态时恒写占位串 —— 有值时不显示，但属性保留，
    // 便于调用方（测试 / 无障碍）按它找到这一行的数值输入框
    input.placeholder = mixed ? mixedLabel : mixedLabel || '';
    // Tab 循环的标记：official / rpe / single（合并列两轮都参与）
    input.dataset.unit = unitKey ?? 'single';
    if (!mixed) input.value = show(unitKey && units ? units[unitKey].to(value) : value);
    input.addEventListener('change', () => {
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      const internal = toInternal(raw, unitKey);
      if (internal === null) {
        reject(`${label} 超出允许范围`);
        return;
      }
      onSet(internal, unitKey ?? 'single');
    });
    const stepBy = (dir, viaWheel = false) => {
      const cur = Number(input.value);
      if (!Number.isFinite(cur)) {
        if (mixed) reject('多项取值不同，请先统一');
        return;
      }
      if (fixedStep !== null && fixedStep !== undefined) {
        // 固定步长（内部单位）：当前显示值换回内部 → ± step → 换回显示
        const internalCur = toInternal(cur, unitKey);
        if (internalCur === null) return;
        const next = snap(internalCur + dir * fixedStep);
        input.value = show(units && unitKey ? units[unitKey].to(next) : next);
        commitInternal(next, unitKey ?? 'single', viaWheel);
        return;
      }
      let step = unitStepOf(cur);
      if (integer) step = Math.max(1, Math.round(step));
      const next = snap(cur + dir * step);
      input.value = show(next);
      const internal = toInternal(next, unitKey);
      if (internal === null) {
        reject(`${label} 超出允许范围`);
        return;
      }
      onSet(internal, unitKey ?? 'single', viaWheel);
    };
    input.addEventListener(
      'wheel',
      (e) => {
        if (!e.deltaY) return;
        e.preventDefault();
        stepBy(e.deltaY < 0 ? 1 : -1, true);
      },
      { passive: false },
    );
    if (unitKey) {
      input.addEventListener('focus', () => {
        active = unitKey;
      });
    }
    return { input, stepBy };
  };

  if (control) {
    // 自定义控件（下拉 / 复选 / 色块…）：占据合并后的值列，± 列留空
    const cell = el('div', 'v span2');
    cell.appendChild(control);
    row.appendChild(cell);
    row.appendChild(el('div', 'cell'));
    row.appendChild(el('div', 'cell'));
  } else if (mode === 'dual') {
    // 双单位制：官谱列（数字）+ RPE 列（数字，或 rpeText 的文本输入）
    const off = mkNum('official');
    offInput = off.input;
    const cOff = el('div', 'v');
    cOff.appendChild(offInput);
    const cRpe = el('div', 'v');
    let rpeStepBy = null;
    if (rpeText) {
      rpeInput = document.createElement('input');
      rpeInput.className = 'ed-beat';
      rpeInput.type = 'text';
      rpeInput.dataset.unit = 'rpe';
      rpeInput.placeholder = mixed ? mixedLabel : '';
      if (!mixed) rpeInput.value = rpeText.to(value);
      const commitText = (viaWheel = false) => {
        const parsed = rpeText.parse(rpeInput.value);
        if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) return;
        const checked = validate ? validate(parsed) : parsed;
        if (checked === null || checked === undefined || !Number.isFinite(checked)) {
          reject(`${label} 超出允许范围`);
          return;
        }
        onSet(checked, 'rpe', viaWheel);
      };
      rpeStepBy = (dir, viaWheel = false) => {
        const parsed = rpeText.parse(rpeInput.value);
        if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) {
          if (mixed) reject('多项取值不同，请先统一');
          return;
        }
        const step = fixedStep !== null && fixedStep !== undefined ? fixedStep : unitStepOf(parsed);
        const next = snap(parsed + dir * step);
        rpeInput.value = rpeText.to(next);
        commitText(viaWheel);
      };
      rpeInput.addEventListener('change', commitText);
      rpeInput.addEventListener(
        'wheel',
        (e) => {
          if (!e.deltaY) return;
          e.preventDefault();
          rpeStepBy(e.deltaY < 0 ? 1 : -1, true);
        },
        { passive: false },
      );
      rpeInput.addEventListener('focus', () => {
        active = 'rpe';
      });
      cRpe.appendChild(rpeInput);
    } else {
      const rpe = mkNum('rpe');
      rpeInput = rpe.input;
      rpeStepBy = rpe.stepBy;
      cRpe.appendChild(rpeInput);
    }
    row.append(cOff, cRpe);
    const mk = (iconName, dir) => {
      const b = document.createElement('button');
      b.className = 'ed-mini';
      b.type = 'button';
      b.title = fixedStep !== null && fixedStep !== undefined ? `${dir > 0 ? '加' : '减'} ${fixedStep} 拍` : dir > 0 ? '加' : '减';
      setIcon(b, iconName, { size: 12 });
      b.addEventListener('click', () => {
        if (active === 'rpe' && rpeStepBy) rpeStepBy(dir);
        else off.stepBy(dir);
      });
      return b;
    };
    row.appendChild(mk('minus', -1));
    row.appendChild(mk('add', 1));
  } else {
    // 合并行：前两列一个输入（single 换算或原样），可选 −/＋
    const inp = mkNum(units?.single ? 'single' : null);
    offInput = inp.input;
    const cell = el('div', 'v span2');
    cell.appendChild(offInput);
    row.appendChild(cell);
    if (stepper) {
      const mk = (iconName, dir) => {
        const b = document.createElement('button');
        b.className = 'ed-mini';
        b.type = 'button';
        b.title = dir > 0 ? '加' : '减';
        setIcon(b, iconName, { size: 12 });
        b.addEventListener('click', () => inp.stepBy(dir));
        return b;
      };
      row.appendChild(mk('minus', -1));
      row.appendChild(mk('add', 1));
    } else {
      row.appendChild(el('div', 'cell'));
      row.appendChild(el('div', 'cell'));
    }
  }

  // 参考范围格：文字 + 行尾附加图标按钮（如「延到下一事件」）都放这里，不与 ± 重叠
  const rangeCell = el('span', 'range dim', range);
  for (const b of rpeExtra) rangeCell.appendChild(b);
  row.appendChild(rangeCell);
  return row;
}

/**
 * 双单位行的**表头**（列名提示：官谱单位制 / RPE单位制 / 范围）。同一面板里至少有一行双单位时才值得加。
 */
export function dualHeadRow() {
  const row = el('div', 'ed-dual-row head');
  row.appendChild(el('label', 'k', ''));
  row.appendChild(el('span', 'h', '官谱单位制'));
  row.appendChild(el('span', 'h', 'RPE单位制'));
  row.appendChild(el('span', 'h', ''));
  row.appendChild(el('span', 'h', ''));
  row.appendChild(el('span', 'h', '范围'));
  return row;
}

/** 数值输入 + −/＋ 按钮 + 悬停滚轮微调（`onStep(dir)` 收到 ±1，步长由调用方决定） */
export function valueStepper(input, onStep, { stepTitle = '' } = {}) {
  const box = el('div', 'ed-inline');
  box.appendChild(input);
  const mk = (iconName, dir, title) => {
    const b = document.createElement('button');
    b.className = 'ed-mini';
    b.type = 'button';
    b.title = title;
    setIcon(b, iconName, { size: 12 });
    b.addEventListener('click', () => onStep(dir));
    return b;
  };
  box.append(mk('minus', -1, `减 ${stepTitle}`), mk('add', 1, `加 ${stepTitle}`));
  // 悬停在输入框上滚动滚轮 = 按同一步进加 / 减（不滚动页面）
  input.addEventListener(
    'wheel',
    (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      onStep(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  return box;
}

/** Tab 刚全选过的输入框：若跟着一次面板重建，恢复焦点时要连同全选恢复（一次性软标记） */
let tabSelectTag = null;

/** 控件的焦点恢复分类（跨重建匹配用；输入框 / 下拉 / 按钮 / 复选各算一类） */
function controlKind(node) {
  const tag = String(node.tagName ?? '').toUpperCase();
  if (tag === 'SELECT') return 'select';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'INPUT' && node.type === 'checkbox') return 'check';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'input';
  return null;
}

/** node 是否在 root 里（沿父链向上走；无头桩件没有 Element.contains） */
function insideNode(root, node) {
  let n = node;
  while (n) {
    if (n === root) return true;
    n = n.parentElement;
  }
  return false;
}

/** 控件的「跨重建描述子」：所在行标签 + 控件类别 + 行内同类序号（行标签重建后不变） */
function describeControl(node) {
  const kind = controlKind(node);
  if (!kind) return null;
  const row = node.closest?.('.ed-dual-row, .ed-note-row') ?? null;
  const label = row?.querySelector?.('.k')?.textContent ?? '';
  const peers = row ? [...row.querySelectorAll('input, select, button')].filter((n) => controlKind(n) === kind) : [];
  return { label, kind, nth: Math.max(0, peers.indexOf(node)) };
}

/** 在（可能已重建的）root 里把描述子解析回控件；找不到（行被删了等）返回 null */
function resolveControl(root, cap) {
  const rows = [...root.querySelectorAll('.ed-dual-row, .ed-note-row')];
  const row = rows.find((r) => r.querySelector?.('.k')?.textContent === cap.label);
  if (!row) return null;
  const peers = [...row.querySelectorAll('input, select, button')].filter((n) => controlKind(n) === cap.kind);
  return peers[cap.nth] ?? null;
}

/**
 * 重渲染前**抓一下焦点**。
 * 面板任何一次修改都会整页重建（root.innerHTML = ''），焦点会掉回 body —— 之后按 Tab
 * 命中的是全局快速切线（全局 Tab 在非输入框焦点时触发），这就是「Tab 时灵时不灵」的根源。
 * 返回描述子交给 `restorePanelFocus`；焦点不在面板控件上时返回 null。
 */
export function capturePanelFocus(root) {
  // 面板重建会把滚动容器（.ed-scroll）整个换掉，scrollTop 归零 —— 一并抓下来
  const scrollEl = root.querySelector?.('.ed-scroll') ?? null;
  const scroll = { el: scrollEl, top: scrollEl ? scrollEl.scrollTop : 0 };
  const active = globalThis.document?.activeElement ?? null;
  if (!active || active === root || !insideNode(root, active)) return { focus: null, scroll };
  const cap = describeControl(active);
  if (!cap) return { focus: null, scroll };
  return { focus: { ...cap, select: tabSelectTag === active }, scroll };
}

/**
 * 重渲染后把焦点放回 `capturePanelFocus` 抓到的控件；找不到对应控件就不动焦点。
 * Tab 路径（select 标记置位）会连同全选一起恢复，打字直接覆盖旧值。
 */
export function restorePanelFocus(root, cap) {
  tabSelectTag = null;
  if (!cap) return;
  // 先恢复滚动位置（旧滚动容器已随重建移除，scrollTop 记在 capture 里）
  if (cap.scroll?.el && !cap.scroll.el.isConnected) {
    const live = root.querySelector?.('.ed-scroll');
    if (live) live.scrollTop = cap.scroll.top;
  }
  if (!cap.focus) return;
  const target = resolveControl(root, cap.focus);
  if (!target) return;
  target.focus?.();
  if (cap.focus.select && controlKind(target) === 'input') target.select?.();
}

/**
 * 详情面板的 **Tab 焦点循环**：只在数值输入框之间切换，链路按单位制分段 ——
 * 先官谱列自上而下、再 RPE 列自上而下（合并列两段都参与），到尾部回卷。
 * 下拉 / 复选 / 步进按钮**不入链**：焦点落在它们上面时按 Tab 跳到「所在行之后」的第一个
 * 数值输入框（Shift+Tab = 之前的），不会在按钮间停留。
 * 面板之外的 Tab 不归这里管（编辑器全局 Tab = 快速切线，见 main.js）。
 * @param {HTMLElement} container 详情面板的滚动容器（每次重渲染都重建，监听器随它销毁）
 */
export function attachTabCycle(container) {
  container.dataset.tabCycle = '1'; // 提交触发的同步重建会换掉整个面板：活面板靠这个标记找回来
  // 用 dataset 过滤而不是属性选择器：编辑器的无头测试桩件里 dataset 不是 attribute
  const tagged = (scope = container) => [...scope.querySelectorAll('input')].filter((i) => i.dataset && i.dataset.unit);
  /** 活动元素是否在容器内（沿父链向上走；无头桩件没有 Element.contains） */
  const inside = (node) => {
    let n = node;
    while (n) {
      if (n === container) return true;
      n = n.parentElement;
    }
    return false;
  };
  const rowOf = (node) => node.closest?.('.ed-dual-row, .ed-note-row') ?? null;
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    let active = globalThis.document?.activeElement ?? null;
    if (!active || !inside(active)) return;
    if (!tagged().length) return;
    e.preventDefault();
    const back = e.shiftKey === true;
    let scope = container;
    if (active.dataset?.unit && String(active.tagName ?? '').toUpperCase() === 'INPUT') {
      // **先提交、后转移**：输入框值有改动时，失焦触发的 change 会**同步**重建面板
      // （改值 → apply → 数据联动 refresh → activate 整页重建）。若先 focus 下一框，
      // change 会在焦点转移途中触发，重建把还没聚焦成的下一框从 DOM 里拔掉 —— Tab
      // 就「时灵时不灵」。先让当前框真实失焦提交，再在**重建后的活面板**里继续找目标
      // （本监听器挂在旧容器上，重建后它已脱离文档，查询必须换到活容器）。
      const cap = describeControl(active);
      active.blur();
      scope = container.isConnected ? container : active.ownerDocument.querySelector('[data-tab-cycle="1"]') ?? container;
      active = (cap && resolveControl(scope, cap)) || null;
      if (!active) return; // 提交后这一行没了（理论不该发生）：焦点交给恢复逻辑
    }
    // 两段链：官谱段（official + 合并列）→ RPE 段（rpe + 合并列），段尾相接、尾部回卷。
    // 链必须在可能的重建**之后**从活面板收集：上面的提交可能已把面板换成一轮新的 DOM。
    const inputs = tagged(scope);
    const officialSeq = inputs.filter((i) => i.dataset.unit !== 'rpe');
    const rpeSeq = inputs.filter((i) => i.dataset.unit === 'rpe' || i.dataset.unit === 'single');
    const chain = [...officialSeq, ...rpeSeq];
    let next = null;
    if (active.dataset?.unit) {
      // 数值输入框：在本单位制的段内依次走；官谱段走完接 RPE 段（合并列两段都参与）
      const inRpe = active.dataset.unit === 'rpe';
      const seq = inRpe ? rpeSeq : officialSeq;
      const base = inRpe ? officialSeq.length : 0;
      const at = (base + seq.indexOf(active) + (back ? -1 : 1) + chain.length) % chain.length;
      next = chain[at];
    } else {
      // 下拉 / 复选 / 按钮：交给所在行之后（Shift = 之前）的第一个数值输入框
      const rows = [...scope.querySelectorAll('.ed-dual-row, .ed-note-row')];
      const ri = rowOf(active) ? rows.indexOf(rowOf(active)) : back ? rows.length : -1;
      const rowAt = (f) => {
        const r = rowOf(f);
        return r ? rows.indexOf(r) : -1;
      };
      if (back) {
        for (let i = chain.length - 1; i >= 0; i--) {
          if (rowAt(chain[i]) < ri) {
            next = chain[i];
            break;
          }
        }
        next = next ?? chain[chain.length - 1];
      } else {
        for (const f of chain) {
          if (rowAt(f) > ri) {
            next = f;
            break;
          }
        }
        next = next ?? chain[0];
      }
    }
    if (!next) return;
    // 标记「Tab 刚全选过的输入框」：若这次移动跟着一次面板重建（改值 → blur → change →
    // rerender），恢复焦点时要连同全选一起恢复（见 capturePanelFocus / restorePanelFocus）
    tabSelectTag = next;
    next.focus();
    next.select?.();
  });
}
