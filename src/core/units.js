/**
 * 单位与常量：两种格式 <-> 内部规范单位。
 *
 * 内部规范单位（canonical）：
 *  - 时间：秒（运行期）/ 拍（模型层，解析后由 timeline 转换）
 *  - note 横向位置 positionX：官方 X 单位（1 X = 0.05625 × 画面宽）
 *  - note 纵向距离 / 判定线速度：官方 Y 单位（1 Y = 0.6 × 画面高），速度单位 Y/s
 *  - 判定线位置：以画面中心为原点的比例偏移（x: ±0.5 覆盖整宽，y: ±0.5 覆盖整高，y 向上为正）
 *  - 旋转：弧度，逆时针为正；不透明度：0..1
 *  - note 类型：'tap' | 'drag' | 'hold' | 'flick'
 *
 * 依据见 docs/01、docs/02、docs/03。
 */

/** 官方格式常量 */
export const OFFICIAL = {
  /** 1 X = 0.05625 × 画面宽 */
  X_RATIO: 0.05625,
  /** 1 Y = 0.6 × 画面高 */
  Y_RATIO: 0.6,
  /** 1 拍 = 32 个时间单位（time 的 1/32 拍） */
  TIME_PER_BEAT: 32,
  /** 事件哨兵 */
  SENTINEL_MIN: -999999,
  SENTINEL_MAX: 1000000000,
};

/** RPE 格式常量 */
export const RPE = {
  /** 画布宽 1350 单位 = 画面宽（x ∈ [-675, 675]） */
  WIDTH: 1350,
  /** 画布高 900 单位 = 画面高（y ∈ [-450, 450]） */
  HEIGHT: 900,
  /** 1 RPE 速度 = 每秒下落 120 长度单位（= 2/15 屏幕高度/秒） */
  SPEED_UNITS_PER_SEC: 120,
  /** 时间哨兵（拍） */
  SENTINEL_BEAT: 31250000,
};

/** RPE x 单位 -> 官方 X */
export const RPE_X_TO_X = 1 / RPE.WIDTH / OFFICIAL.X_RATIO; // = 1 / 75.9375
/** RPE y 单位 -> 官方 Y */
export const RPE_Y_TO_Y = 1 / RPE.HEIGHT / OFFICIAL.Y_RATIO; // = 1 / 540
/** RPE 速度值 -> 官方 Y/s */
export const RPE_SPEED_TO_YPS = RPE.SPEED_UNITS_PER_SEC / RPE.HEIGHT / OFFICIAL.Y_RATIO; // = 2/9

/** 官方 note 类型编号 -> 规范类型 */
export const OFFICIAL_NOTE_TYPE = { 1: 'tap', 2: 'drag', 3: 'hold', 4: 'flick' };
/** RPE note 类型编号 -> 规范类型（与官方**不同**，见 docs/02） */
export const RPE_NOTE_TYPE = { 1: 'tap', 2: 'hold', 3: 'flick', 4: 'drag' };

export const NOTE_TYPES = ['tap', 'drag', 'hold', 'flick'];

/** 内部类型 -> 官方 type 编号（写回官谱时用；与 RPE 完全不同，见 docs/02 §8） */
export const OFFICIAL_TYPE_CODE = { tap: 1, drag: 2, hold: 3, flick: 4 };
/** 内部类型 -> RPE type 编号（写回 RPE 谱时用） */
export const RPE_TYPE_CODE = { tap: 1, hold: 2, flick: 3, drag: 4 };

/** 判定线渲染常量（docs/03 §8） */
export const LINE = {
  /** 贴图长宽比：6220.8 × 7.68 px @1080p */
  TEXTURE_W: 6220.8,
  TEXTURE_H: 7.68,
  /** 长度 = LENGTH_H × 画面高 */
  LENGTH_H: 6220.8 / 1080, // 5.76
  /** 厚度 = THICKNESS_H × 画面高 */
  THICKNESS_H: 7.68 / 1080, // 0.00711
  COLOR: [255, 255, 255],
  COLOR_FULL_COMBO: [0xa2, 0xee, 0xff],
  COLOR_ALL_PERFECT: [0xfe, 0xff, 0xa9],
};

/** 音符与特效渲染常量 */
export const NOTE = {
  /**
   * 音符贴图宽度（画面宽的比例）。默认 **W/8**（项目决定，可用 N/M 键调整）。
   * 参考：prpr 的 NOTE_WIDTH_RATIO_BASE ≈ 0.1318 W、phi-chart-render ≈ 0.1178 W（均为资源包口径），
   * 仓库参考效果图实测约 0.17 W——三者并不一致，故做成可修改值。
   */
  DEFAULT_WIDTH_RATIO: 1 / 8,
  /** 过线后淡出时间（秒） */
  FADE_OUT: 0.16,
  /** 打击特效帧数（hit.png 为 7×6） */
  HIT_FRAMES_X: 7,
  HIT_FRAMES_Y: 6,
  /** 打击特效持续时间（秒）：42 帧 @60fps = 0.7s（hit.png 是 7×6 = 42 帧） */
  HIT_DURATION: 42 / 60,
  /** Hold 未结束时重复生成打击特效的间隔（秒）：每 10 帧一次 */
  HOLD_FX_INTERVAL: 10 / 60,
  /**
   * 打击特效的生成窗口（秒）：只有在「音符落线时刻」之后这么久以内才会真的生成特效。
   * 用于跳转/快进后一次性补判大量音符的场合 —— 否则几十个特效会同时炸出来。
   */
  FX_SPAWN_WINDOW: 0.25,
  /** 打击特效缩放（相对音符宽度） */
  HIT_SCALE: 0.6,
  /** 可见性：距判定线超过该 Y 值则不渲染（官方 3.3333336 ≈ 2 屏幕高） */
  MAX_VISIBLE_Y: 3.3333336,
  /** 判定区宽度（画面宽比例），= 2.1 X */
  JUDGE_WIDTH_RATIO: 0.118125,
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 官方 v3 归一化坐标（左下角原点 0..1）-> 以画面中心为原点的偏移 */
export const officialCenterOffset = (v) => v - 0.5;
/** RPE 坐标 -> 以画面中心为原点的偏移（x 除以 1350，y 除以 900） */
export const rpeCenterOffsetX = (v) => v / RPE.WIDTH;
export const rpeCenterOffsetY = (v) => v / RPE.HEIGHT;

/** 官方 formatVersion 1：事件值 = 1000x + y，左上角 (880, 520)（见 docs/01 §2.1） */
export function unpackOfficialV1(value) {
  const x = (value - (((value % 1000) + 1000) % 1000)) / 1000;
  const y = ((value % 1000) + 1000) % 1000;
  return { x: x / 880, y: y / 520 };
}

export const degToRad = (deg) => (deg * Math.PI) / 180;
