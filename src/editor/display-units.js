/**
 * 事件取值的**显示单位**与**参考范围**（「事件曲线」纵轴 / Event 详情共用）。
 *
 * 模型里存的是内部规范单位（x/y 是画面比例、rotate/theta 是弧度、z 是画面高比例……），
 * 界面上按谱师习惯的单位显示（与 RPE 文件里的数一致）：
 *   - `z`（线的 Z 轴位移）：长度单位，900 = 一个画面高
 *   - `theta`（下落面倾斜）/ `rotate`（线旋转）：角度制
 *   - 相机 x / y / z：长度单位（x 用 1350 = 一个画面宽，其余 900 = 一个画面高）；相机 angle：角度制
 * 键名带 `ev:` / `cam:` 前缀：相机的 x / y / z 与普通事件 / 扩展事件同名，不能共用一张表。
 */
import { RPE, RPE_X_TO_X, RPE_SPEED_TO_YPS } from '../core/units.js';
import { LIMITS } from './lint.js';

/** 显示单位换算表：`to` = 内部 → 显示，`from` = 显示 → 内部 */
export const DISPLAY_UNITS = {
  'ev:z': {
    to: (v) => v * 900,
    from: (v) => v / 900,
    step: '10',
    hint: '长度单位（900 = 一个画面高）；正 = 往屏幕内，负 = 往屏幕外',
  },
  'ev:theta': {
    to: (v) => (v * 180) / Math.PI,
    from: (v) => (v * Math.PI) / 180,
    step: '1',
    hint: '角度（度）；正 = 下落面向屏幕内倾，负 = 向屏幕外倾',
  },
  'ev:rotate': {
    to: (v) => (v * 180) / Math.PI,
    from: (v) => (v * Math.PI) / 180,
    step: '1',
    hint: '角度（度）；正 = 顺时针（RPE / 官谱里都是度数，内部存弧度）',
  },
  'cam:x': {
    to: (v) => v * 1350,
    from: (v) => v / 1350,
    step: '50',
    hint: '长度单位（1350 = 一个画面宽）；正 = 相机往右移，画面整体往左走',
  },
  'cam:y': {
    to: (v) => v * 900,
    from: (v) => v / 900,
    step: '10',
    hint: '长度单位（900 = 一个画面高）；正 = 相机往上移，画面整体往下走',
  },
  'cam:z': {
    to: (v) => v * 900,
    from: (v) => v / 900,
    step: '10',
    hint: '长度单位（900 = 一个画面高）；正 = 相机往屏幕里推 → 整体放大、透视更强',
  },
  'cam:angle': {
    to: (v) => (v * 180) / Math.PI,
    from: (v) => (v * Math.PI) / 180,
    step: '1',
    hint: '视角（度）；越大透视越强（广角），越小越接近正交；缺省 ≈ 53.1°',
  },
};

// ───────────────────────── 双单位制（官谱 ↔ RPE） ─────────────────────────
// 详情页的数值行同时给出两种谱面格式里的数：官谱列 = 官方格式文件里的写法（v3 口径），
// RPE 列 = RPE 格式文件里的写法。内部值（模型单位）作为换算媒介，两个方向都能编辑。
// 换算依据见 docs/Phigros文档.md §1.1（X / Y 定义）、§1.3（v3 左下角原点 0–1）、§2.11（与 official 的换算）。
//
// 只登记「两种格式都有对应物」的键：官谱没有的通道（扩展事件 / 谱面相机）不在表里，
// 详情页对它们自动走「合并前两列」的单单位显示（沿用上面的 DISPLAY_UNITS）。

const deg = (v) => (v * 180) / Math.PI;
const rad = (v) => (v * Math.PI) / 180;

export const DUAL_UNITS = {
  /** 音符 positionX：官谱 X 单位（1X = 0.05625W，内部即官谱）；RPE = X × 75.9375 */
  'note:x': {
    official: { to: (v) => v, from: (v) => v },
    rpe: { to: (v) => v / RPE_X_TO_X, from: (v) => v * RPE_X_TO_X },
    range: `±${Math.round(LIMITS.positionX * 100) / 100}`,
  },
  /** 线移动事件 x：官谱 v3 = 左下角原点 0–1（内部是中心原点比例，+0.5 平移）；RPE = 比例 × 1350 */
  'ev:x': {
    official: { to: (v) => v + 0.5, from: (v) => v - 0.5 },
    rpe: { to: (v) => v * RPE.WIDTH, from: (v) => v / RPE.WIDTH },
    range: '0..1',
  },
  /** 线移动事件 y：同上（900 = 一个画面高） */
  'ev:y': {
    official: { to: (v) => v + 0.5, from: (v) => v - 0.5 },
    rpe: { to: (v) => v * RPE.HEIGHT, from: (v) => v / RPE.HEIGHT },
    range: '0..1',
  },
  /** 线旋转：内部为弧度（逆时针为正）；官谱角度 = 弧度转度；RPE 角度方向相反（顺时针为正） */
  'ev:rotate': {
    official: { to: deg, from: rad },
    rpe: { to: (v) => -deg(v), from: (v) => -rad(v) },
    range: '−180..180',
  },
  /** 线不透明度：官谱 0–1 浮点（内部即官谱）；RPE 0–255 整数 */
  'ev:alpha': {
    official: { to: (v) => v, from: (v) => v },
    rpe: { to: (v) => v * 255, from: (v) => v / 255 },
    range: '0..1',
  },
  /** 下落速度：官谱 Y/s（内部即官谱）；RPE 值 = Y/s × 4.5（1 RPE 速度 = 2/9 Y/s） */
  'ev:speed': {
    official: { to: (v) => v, from: (v) => v },
    rpe: { to: (v) => v / RPE_SPEED_TO_YPS, from: (v) => v * RPE_SPEED_TO_YPS },
    range: '0..5',
  },
};

/** 某个「kind:key」的双单位换算（没有对应物返回 null = 合并前两列） */
export function dualUnitsFor(kind, key) {
  return DUAL_UNITS[`${kind}:${key}`] ?? null;
}

/**
 * 时间（拍）的双单位：官谱文件里的 `time` / `holdTime` 是**单个数字、单位 1/32 拍**
 * （`time = 拍 × 32`，见 docs/Phigros文档.md §1.1 的 T）；RPE 与内部一样用拍。
 * 时间行的 RPE 列走拍号文本（a+b/c），官谱列是数字输入。
 */
export const TIME_DUAL_UNITS = {
  official: { to: (v) => v * 32, from: (v) => v / 32 },
  rpe: { to: (v) => v, from: (v) => v },
};

/** 事件 / 相机通道的键：`{ kind: 'ev' | 'cam', key }` */
export function unitKeyOf(clip) {
  if (!clip?.key) return null;
  return `${clip.camera ? 'cam' : 'ev'}:${clip.key}`;
}

/** 该通道的显示单位（没有换算时为 null = 直接按内部值显示） */
export function displayUnitFor(clip) {
  const k = unitKeyOf(clip);
  return k ? DISPLAY_UNITS[k] ?? null : null;
}

/**
 * 「事件曲线」纵轴的**参考范围**（**显示单位**）：谱面里常见的取值区间。
 * 轨道上出现更小 / 更大的值（含相邻事件的取值）时就按实际值扩出去，见 `curveRangeFor`。
 */
export const REFERENCE_RANGES = {
  'ev:x': [0, 1], // 官谱 x 位移：0~1 个画面宽
  'ev:y': [0, 1], // 官谱 y 位移：0~1 个画面高
  'ev:rotate': [-180, 180], // 旋转：角度制
  'ev:alpha': [0, 1],
  'ev:speed': [0, 5],
  'ev:scaleX': [0, 5],
  'ev:scaleY': [0, 5],
  'ev:theta': [-180, 180], // 下落面倾斜：角度制
  'ev:z': [0, 900], // Z 轴位移：长度单位（900 = 一个画面高）
  'cam:x': [-675, 675], // 相机横向平移：±半个画面宽
  'cam:y': [-450, 450], // 相机纵向平移：±半个画面高
  'cam:z': [-450, 450], // 相机推拉：±半个画面高
  'cam:angle': [0, 180], // 视角：合法范围就是 0°~180°
};

/** 参考范围（显示单位）；没有登记该通道时返回 null */
export function referenceRangeFor(clip) {
  const k = unitKeyOf(clip);
  const r = k ? REFERENCE_RANGES[k] : null;
  return r ? { min: r[0], max: r[1] } : null;
}

/**
 * 纵轴范围（**内部单位**）= 参考范围 ∪ 轨道实际范围 ∪ 相邻事件取值，两端留 5% 余量。
 * 都没有时返回 null（由曲线自己按这条事件的两个值兜底）。
 * @param {object} p
 * @param {object|null} p.reference 参考范围（显示单位，`{min,max}`）
 * @param {object|null} p.unit 该通道的显示单位换算（`{to,from}`），没有就按内部值算
 * @param {object|null} p.trackRange 轨道实际范围（内部单位，`{min,max}`）
 * @param {number[]} p.extra 其它要包含进去的值（内部单位：事件两端、相邻事件取值）
 */
export function curveRangeFor({ reference = null, unit = null, trackRange = null, extra = [] } = {}) {
  let min = Infinity;
  let max = -Infinity;
  const add = (v) => {
    if (!Number.isFinite(v)) return;
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (reference && Number.isFinite(reference.min) && Number.isFinite(reference.max)) {
    add(unit ? unit.from(reference.min) : reference.min);
    add(unit ? unit.from(reference.max) : reference.max);
  }
  if (trackRange && Number.isFinite(trackRange.min) && Number.isFinite(trackRange.max)) {
    add(Math.min(trackRange.min, trackRange.max));
    add(Math.max(trackRange.min, trackRange.max));
  }
  for (const v of extra) add(v);
  if (!(min < max)) return null;
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}
