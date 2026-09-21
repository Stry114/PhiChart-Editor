/**
 * 解析/求值的健壮性工具：把「脏数据」收敛成安全值，并把问题收集成可展示的诊断信息。
 *
 * 原则（见 docs/项目文档.md 的健壮性策略）：
 *  1. **解析阶段绝不抛异常**：字段缺失/类型错误/越界/NaN 一律取缺省值并记一条诊断，
 *     只有「整个 JSON 不是对象」这类无法继续的情况才抛错。
 *  2. **诊断分级**：error（该条数据被丢弃/谱面不可用）、warn（已用缺省值替代）、info（仅提示）。
 *     同一条消息去重，且有数量上限，避免脏谱面刷屏。
 *  3. **求值阶段再加一道保险**：非有限值不进入渲染（见 state.js），保证 UI 永不因数据崩掉。
 */

export const DIAG_LIMIT_DEFAULT = 200;

export class Diagnostics {
  constructor(limit = DIAG_LIMIT_DEFAULT) {
    this.limit = limit;
    this.items = [];
    this.counts = { error: 0, warn: 0, info: 0 };
    this.deduped = 0; // 因重复而合并的条数
    this.truncated = 0; // 因超上限而未记录的消息数
    this._seen = new Set();
  }

  add(level, msg) {
    this.counts[level] = (this.counts[level] ?? 0) + 1;
    const key = `${level}:${msg}`;
    if (this._seen.has(key)) {
      this.deduped++;
      return;
    }
    this._seen.add(key);
    if (this.items.length >= this.limit) {
      this.truncated++;
      return;
    }
    this.items.push({ level, msg });
  }

  error(msg) {
    this.add('error', msg);
  }

  warn(msg) {
    this.add('warn', msg);
  }

  info(msg) {
    this.add('info', msg);
  }

  /** 供 UI 直接展示的行（带级别前缀） */
  get messages() {
    const label = { error: '错误', warn: '警告', info: '提示' };
    const out = this.items.map((i) => `${label[i.level]}：${i.msg}`);
    const extra = this.deduped + this.truncated;
    if (extra > 0) out.push(`…（另有 ${extra} 条重复/超限消息已省略）`);
    return out;
  }

  get summary() {
    const { error, warn, info } = this.counts;
    return `${error} 错误 / ${warn} 警告${info ? ` / ${info} 提示` : ''}`;
  }
}

/** 是否为普通对象（非 null、非数组） */
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 数组取值：不是数组就返回空数组（并让调用方决定是否告警） */
export const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 数值收敛：接受数字与「看起来像数字」的字符串；其余（undefined/null/NaN/±Infinity/对象）取缺省值。
 * @param {unknown} v
 * @param {number} def 缺省值
 * @param {{min?:number, max?:number}} [range] 超出范围时按边界钳制（钳制本身不算错误，避免噪声）
 */
export function num(v, def, range = {}) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else if (typeof v === 'boolean') n = v ? 1 : 0;
  else return def;
  if (!Number.isFinite(n)) return def;
  const { min = -Infinity, max = Infinity } = range;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * 数值收敛（带「是否被替换」的返回，便于诊断）。
 * @returns {{value:number, ok:boolean}}
 */
export function numChecked(v, def, range) {
  const value = num(v, def, range);
  const raw = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return { value, ok: Number.isFinite(raw) };
}

/** 只接受有限数值（不接受字符串）；用于「必须是真数字」的场合 */
export function strictNum(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export function int(v, def, range) {
  return Math.round(num(v, def, range));
}

export function str(v, def = '') {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return def;
}

export function bool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return def;
}

/** 正数（> 0）收敛；非正/非数字取缺省值 */
export function positive(v, def, { max = 1e9 } = {}) {
  const n = num(v, def, { min: -max, max });
  return n > 0 ? n : def;
}

/** 数组元素过滤：只保留普通对象，并返回被丢弃的个数 */
export function objList(v, { warnNonArray = true } = {}) {
  const raw = asArray(v);
  const kept = raw.filter(isObj);
  return { kept, dropped: raw.length - kept.length, nonArray: !Array.isArray(v) && v !== undefined && v !== null, warnNonArray };
}

/** 把 JSON 路径片段拼成可读路径，如 `judgeLineList[3].notes[12].positionX` */
export const pathOf = (base, ...parts) =>
  parts.reduce((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : `${acc}.${p}`), base);
