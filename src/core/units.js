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

/**
 * RPE 扩展（故事板）事件。
 *
 * 与 x/y/rotate/alpha/speed 的**根本区别**：扩展事件**不分事件层**，每条判定线各一份
 * （模型里收在 `line.extended`，RPE 文件里是 `line.extended.<key>Events`）。
 * 本版本实现 `scaleX / scaleY / color`；其余键解析后原样保留、导出时写回，但暂不渲染。
 */
export const EXTENDED_KEYS = ['scaleX', 'scaleY', 'color'];
/** 已识别、暂未实现渲染的扩展键（保留原始数据，导出写回） */
export const EXTENDED_KEYS_UNSUPPORTED = ['incline', 'text', 'paint', 'gif'];
/** 扩展键 → RPE 字段名 */
export const EXTENDED_RPE_FIELD = {
  scaleX: 'scaleXEvents',
  scaleY: 'scaleYEvents',
  color: 'colorEvents',
  incline: 'inclineEvents',
  text: 'textEvents',
  paint: 'paintEvents',
  gif: 'gifEvents',
};
/**
 * 未覆盖时间的缺省值（取「不改变外观」的一侧）：
 * 缩放 1 = 原尺寸（RPE 内置 line.png 的 scale 因子为 1）、颜色 [255,255,255] = 乘 1。
 */
export const EXTENDED_DEFAULTS = {
  scaleX: 1,
  scaleY: 1,
  color: [255, 255, 255],
};

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
  /** Bad 判定后的音符：用 Tap 贴图整体着色（docs/03 §8）并在这么久内淡出 */
  BAD_FADE: 0.5,
  /** Bad 音符的着色（sim-phi 口径） */
  BAD_COLOR: '#6C4343',
  /**
   * 漏接（Miss）的长条：不淡出，而是变成这个透明度**继续下落**（用户要求）。
   * 头部的 perfect/good 命中不受影响（那种情况下头部贴线、尾巴收回来）。
   */
  HOLD_MISS_ALPHA: 0.35,
};

/**
 * 真实游玩（触屏）的判定规则。窗口单位**秒**，取 `docs/03 §4.1`：
 *
 *   判定   Tap / Hold        Drag      Flick      判定分比例
 *   Perfect ±80 ms           ±100 ms   ±140 ms    100%
 *   Good    ±80–180 ms       —         —          65%
 *   Bad     ±180–220 ms（Hold 无 Bad）  —  —       0%
 *   Miss    未命中           未命中     未命中      0%
 *
 * 语义（本项目决定，见 docs/03 §4.2）：
 *  - **垂直判定**：只看音符与判定线的垂直接近程度（= 上面的时间窗），手指在舞台任意位置都算；
 *  - **多指判定**：每个 touchstart 只能判一个 Tap/Hold（双押/多押必须多指），多余的输入不扣分；
 *  - Drag **过线即 Perfect**、不吃输入、不会 Miss（docs/03 §4 注）；
 *  - Flick 窗口内有任意滑动事件即 Perfect（简化口径）；
 *  - Hold 头部判定后不要求继续按住（docs/03 §4.1「可提前松手/换手，不影响判定」）。
 */
export const JUDGE = {
  TAP: { perfect: 0.08, good: 0.18, bad: 0.22 },
  HOLD: { perfect: 0.08, good: 0.18 }, // Hold 无 Bad
  DRAG: { perfect: 0.1 },
  FLICK: { perfect: 0.14 },
  /** 每帧向前看的最大时间（秒）：等于最大的 bad 窗口 */
  LOOKAHEAD: 0.22,
  /** 滑动识别：位移阈值（CSS 像素）与最长耗时（毫秒） */
  SWIPE_MIN_PX: 16,
  SWIPE_MAX_MS: 250,
  /**
   * 判定带（默认判定范围）：以**音符所在的列**为中心的一条带子 ——
   * 沿判定线方向的半宽 = 音符宽/2 × `BAND_SCALE` + `BAND_PAD`（CSS 像素，比音符略宽），
   * 沿**下落方向**不限位置（音符从远到近的整条路径都算）。
   * 只有落在这条带里的点击 / 经过它的滑动才对那个 note 有效；
   * 想要「点屏幕任意位置都能判」（全屏判定）时由 app 把判定范围切成 `screen`（见 `docs/03 §4.4`）。
   */
  BAND_SCALE: 1.25,
  BAND_PAD: 8,
  /**
   * Hold 允许**提前松手**的比例（相对音符时长）：按到 `时长 × (1 − 这个值)` 就算「按完了」，
   * 之后松手仍按头部等级计分；更早松手 = Miss。默认 0.2（提前 20% 以内不算失误）。
   */
  HOLD_RELEASE_SLACK: 0.2,
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
