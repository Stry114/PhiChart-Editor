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
