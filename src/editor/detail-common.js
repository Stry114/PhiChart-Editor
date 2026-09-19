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
