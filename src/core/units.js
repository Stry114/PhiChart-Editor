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
 * 依据见 docs/Phigros文档.md（§7.1 内部统一模型与 §7.2 逐项实现状态）。
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
/** RPE note 类型编号 -> 规范类型（与官方**不同**，见 docs/Phigros文档.md） */
export const RPE_NOTE_TYPE = { 1: 'tap', 2: 'hold', 3: 'flick', 4: 'drag' };

export const NOTE_TYPES = ['tap', 'drag', 'hold', 'flick'];

/**
 * RPE 扩展（故事板）事件。
 *
 * 与 x/y/rotate/alpha/speed 的**根本区别**：扩展事件**不分事件层**，每条判定线各一份
 * （模型里收在 `line.extended`，RPE 文件里是 `line.extended.<key>Events`）。
 * 本版本实现 `scaleX / scaleY / color / z / theta`；其余键解析后原样保留、导出时写回，但暂不渲染。
 *
 * `z` / `theta` 是**本项目的（伪）3D 扩展**（RPE 本身没有这两个事件，写进 `extended` 后别的工具会忽略）：
 *  - `z`（Z 轴位移，`moveZEvents`）：正值往屏幕内、负值往屏幕外；单位与谱面里其它长度一致
 *    （RPE 长度单位：900 = 一个画面高），内部存成「画面高比例」。
 *  - `theta`（下落面倾斜，`thetaEvents`）：绕**判定线长轴**旋转下落面，正值向屏幕内倾、负值向屏幕外；
 *    角度制（与 rotate 同口径），内部存弧度。
 */
export const EXTENDED_KEYS = ['scaleX', 'scaleY', 'color', 'z', 'theta'];
/** 已识别、暂未实现渲染的扩展键（保留原始数据，导出写回） */
export const EXTENDED_KEYS_UNSUPPORTED = ['incline', 'text', 'paint', 'gif'];
/** 扩展键 → RPE 字段名 */
export const EXTENDED_RPE_FIELD = {
  scaleX: 'scaleXEvents',
  scaleY: 'scaleYEvents',
  color: 'colorEvents',
  z: 'moveZEvents',
  theta: 'thetaEvents',
  incline: 'inclineEvents',
  text: 'textEvents',
  paint: 'paintEvents',
  gif: 'gifEvents',
};
/**
 * 未覆盖时间的缺省值（取「不改变外观」的一侧）：
 * 缩放 1 = 原尺寸（RPE 内置 line.png 的 scale 因子为 1）、颜色 [255,255,255] = 乘 1、
 * z 与 theta 都为 0 = 不位移 / 不倾斜。
 */
export const EXTENDED_DEFAULTS = {
  scaleX: 1,
  scaleY: 1,
  color: [255, 255, 255],
  z: 0,
  theta: 0,
};

/** 扩展键 → RPE 里的数值换算（内部值 ↔ RPE 文件里的值）放在解析 / 序列化层：
 *  `z` 内部是「画面高比例」、RPE 是长度单位（900 = 一个画面高）；`theta` 内部弧度、RPE 角度制
 *  （与普通事件同一套口径，见 parse-rpe.js 的 EXTENDED_VALUE_IN / serialize-rpe.js 的 EXTENDED_VALUE_OUT）。 */

/**
 * （伪）3D 投影常数：**小孔相机**模型，像平面就是判定线所在的平面（z = 0 时画面不变）。
 *
 * 相机默认在画面中轴前方 F（焦距，1 屏高）、光轴朝屏幕里，屏幕中心就是灭点：
 *
 *   屏幕坐标 = 画面中心 + (相对世界偏移 − 相机位置) × k      k = F / (深度 + F − 相机推拉)
 *
 * 于是 depth(即 z) > 0（往屏幕内）→ 缩小；z < 0（往屏幕外）→ 放大；
 * z = 0 且相机在默认位置时 k = 1，画面与「没有 3D」逐像素一致。
 *
 * 相机本身是**可按拍动画**的谱面级状态（见 `CAMERA_KEYS`），其中「透视强弱」用**视角**表示
 * （比焦距直观：角度越大 = 广角 = 透视越强），焦距退化成内部换算量，不再暴露成通道。
 */

/** 焦距（画面高）→ 垂直视角（弧度）：`2·atan(1/(2F))`；F = 1 屏高时约 53.13° */
export const focalToAngle = (focalH) => 2 * Math.atan(1 / (2 * Math.max(1e-6, Number.isFinite(focalH) ? focalH : 1)));
/** 垂直视角（弧度）→ 焦距（画面高）：`1/(2·tan(θ/2))`；超出 (0°, 180°) 时夹到有效范围 */
export const angleToFocal = (angleRad) => {
  const a = Math.min(Math.max(Number.isFinite(angleRad) ? angleRad : Math.PI / 3, 0.01), Math.PI * 0.98);
  return 1 / (2 * Math.tan(a / 2));
};

export const PSEUDO3D = {
  /** 焦距 F（单位：画面高）：z = 1 屏高时缩到一半。内部换算用，界面上不再让用户填焦距 */
  FOCAL_H: 1,
  /** 相机视角的缺省值（弧度）：等价于焦距 1 屏高 ≈ 53.13°（缺省视角下画面与没有相机时逐像素一致） */
  ANGLE_DEFAULT: 2 * Math.atan(1 / 2),
  /**
   * 视角的可用范围（弧度）：0 会让焦距发散、180° 会让投影翻转，两端各留一点余量。
   * 求值时越界只会**夹到最近的合法视角**，不会跳回缺省视角 —— 相机通道在事件之间的缺口处
   * 沿用上一个事件的末值，那个末值即使越界也应该保持（缺省值只在通道完全没覆盖时用）。
   */
  ANGLE_MIN: 0.01,
  ANGLE_MAX: Math.PI * 0.99,
  /** 深度下限（相对焦距）：相机逼近像平面之前就夹住，避免除零 / 画面翻转 */
  MIN_DEPTH_RATIO: 0.05,
};

/**
 * **谱面相机**（本项目的自有扩展，可按拍给关键帧，用法与「可变 BPM」一样）：
 * 每个通道都是一条**扩展事件式**的关键帧列表（`chart.camera.<键>`，与 `line.extended` 同构，
 * 支持 29 种缓动 / 贝塞尔 / 缓动裁剪），每帧求值出相机状态，供（伪）3D 投影使用。
 *
 * 单位（内部规范单位；RPE 写出时的长度单位见下）：
 *  - `x`：相机横向平移（画面宽比例，右为正）—— 相当于相机往右移，画面整体往左走；
 *  - `y`：相机纵向平移（画面高比例，上为正）；
 *  - `z`：相机沿光轴推拉（画面高比例，正 = 往屏幕内）—— 靠近画面 → 整体放大、透视更强；
 *  - `angle`：**视角**（内部弧度，与 `rotate` 同口径；界面与 RPE 里用**角度制**）——
 *    越大 = 广角 = 透视越强，越小越接近正交投影；画面平面上的东西大小不受它影响。
 *    缺省 `PSEUDO3D.ANGLE_DEFAULT ≈ 53.13°`（= 焦距 1 屏高）。
 *
 * RPE 里写在**根节点**的自有扩展键 `camera`（`{ xEvents / yEvents / zEvents / angleEvents }`；
 * `x` 用长度单位 1350 = 一个画面宽，`y` / `z` 用 900 = 一个画面高，`angle` 用角度制）：
 * RPE 自己与其它工具会忽略它，本项目读写往返保留；导出官方格式时无法表达（按告警丢弃）。
 */
export const CAMERA_KEYS = ['x', 'y', 'z', 'angle'];
/** 相机通道 → RPE 根节点 `camera` 里的字段名 */
export const CAMERA_RPE_FIELD = { x: 'xEvents', y: 'yEvents', z: 'zEvents', angle: 'angleEvents' };
/** 相机各通道「没有事件覆盖」时的缺省值（= 默认视图，画面与无相机时一致） */
export const CAMERA_DEFAULTS = { x: 0, y: 0, z: 0, angle: PSEUDO3D.ANGLE_DEFAULT };
/**
 * 早期版本的相机通道 `focal`（焦距，内部「画面高比例」）→ 现在的 `angle`（视角，弧度）。
 * 只用于读旧文件（RPE 的 `focalEvents` 长度单位、项目文件的 `camera.focal`），新文件一律写 `angle`。
 */
export const CAMERA_LEGACY_FOCAL_FIELD = 'focalEvents';
/** RPE 根节点上存相机关键帧的自有扩展键 */
export const CAMERA_RPE_ROOT = 'camera';
/**
 * 相机是**谱面级**的（不属于任何判定线）。编辑器为了复用「按线重编译 / 撤销 / 轨道重建」
 * 那套既有路径，给相机轨道用一个哨兵 lineId；`model.js` 的 `refreshLine` 见到它会转去刷新相机。
 */
export const CAMERA_LINE_ID = -1;
/**
 * 相机通道 → RPE 值换算：`x` 用长度单位（1350 = 一个画面宽），`y` / `z` 用长度单位（900 = 一个画面高），
 * `angle` 用角度制（与 `rotate` / `theta` 一样：内部弧度、文件里写度数）。
 */
export const CAMERA_VALUE_IN = {
  x: (v) => v / RPE.WIDTH,
  y: (v) => v / RPE.HEIGHT,
  z: (v) => v / RPE.HEIGHT,
  angle: (v) => degToRad(v),
};
export const CAMERA_VALUE_OUT = {
  x: (v) => v * RPE.WIDTH,
  y: (v) => v * RPE.HEIGHT,
  z: (v) => v * RPE.HEIGHT,
  angle: (v) => (v * 180) / Math.PI,
};


/** 内部类型 -> 官方 type 编号（写回官谱时用；与 RPE 完全不同，见 docs/Phigros文档.md 的 RPE 音符编号对照） */
export const OFFICIAL_TYPE_CODE = { tap: 1, drag: 2, hold: 3, flick: 4 };
/** 内部类型 -> RPE type 编号（写回 RPE 谱时用） */
export const RPE_TYPE_CODE = { tap: 1, hold: 2, flick: 3, drag: 4 };

/** 判定线渲染常量（docs/Phigros文档.md 的参考实现关键渲染常数） */
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
  /** Bad 判定后的音符：用 Tap 贴图整体着色（docs/Phigros文档.md 的参考实现关键渲染常数）并在这么久内淡出 */
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
 * 真实游玩（触屏）的判定规则。窗口单位**秒**，来源见 `docs/Phigros文档.md` 的判定窗口：
 *
 *   判定   Tap / Hold        Drag      Flick      判定分比例
 *   Perfect ±80 ms           ±100 ms   ±140 ms    100%
 *   Good    ±80–180 ms       —         —          65%
 *   Bad     ±180–220 ms（Hold 无 Bad）  —  —       0%
 *   Miss    未命中           未命中     未命中      0%
 *
 * 本项目落地口径（完整说明见 `docs/Phigros文档.md` 的判定带）：
 *  - **垂直判定**：判定范围默认是「音符判定带」，即只看点击 / 滑动沿判定线方向的偏移，
 *    沿下落方向不限位置；
 *  - **多指判定**：每个触摸只判一个 Tap/Hold（双押 / 多押必须多指），空点不扣分、不消耗音符；
 *  - Drag / Flick 的判定窗口统一为 **±80 ms**（项目口径；参考实现给的 ±100 / ±140 ms 见上文表格），
 *    它们的**音效**另行处理：提前判定的等音符真的落线时再响（见 `pushHit` 的 `soundTime`）；
 *  - Drag 需**判定时刻有手指按在判定带里**（不是过线即满分）；
 *  - Flick 需**真实的滑动**（位移 ≥ `SWIPE_MIN_PX`、距上次上报 ≤ `SWIPE_MAX_MS`）：滑动线段与判定带
 *    相交即 Perfect —— 不要求滑动**起点**落在带内，一次滑动可以同时点亮多个 Flick；纯点击 / 按住不动不算；
 *  - Hold 允许**换手**：持续时间内判定范围里只要有**任一根**手指按着就算没断，
 *    断连不超过 `HOLD_GRACE_SEC` 迅速接上仍算没断；提前松手在 `HOLD_RELEASE_RATIO`（上限
 *    `HOLD_RELEASE_MAX_BEATS` 拍）之内按头部等级记分；**短于 `HOLD_LENIENT_BEATS` 拍的 Hold
 *    不设断连概念**（随时松手都算按完）；更早断连才判 Miss（无 Bad）。
 */
export const JUDGE = {
  TAP: { perfect: 0.08, good: 0.18, bad: 0.22 },
  HOLD: { perfect: 0.08, good: 0.18 }, // Hold 无 Bad
  DRAG: { perfect: 0.08 },
  FLICK: { perfect: 0.08 },
  /** 每帧向前看的最大时间（秒）：等于最大的 bad 窗口 */
  LOOKAHEAD: 0.22,
  /** 滑动识别：位移阈值（CSS 像素）与最长耗时（毫秒） */
  SWIPE_MIN_PX: 16,
  SWIPE_MAX_MS: 250,
  /**
   * 判定带（默认判定范围）：以**音符所在的列**为中心的一条带子 ——
   * 沿判定线方向的半宽 = **音符宽度 × `BAND_HALF_RATIO`**（默认 0.8，即两边各 80% 音符宽、
   * 总宽 = 音符宽的 160%），沿**下落方向**不限位置（音符从远到近的整条路径都算）。
   * 只有落在这条带里的点击 / 经过它的滑动才对那个 note 有效；
   * 想要「点屏幕任意位置都能判」（全屏判定）时由 app 把判定范围切成 `screen`（见 `docs/Phigros文档.md` 的判定带）。
   */
  BAND_HALF_RATIO: 0.8,
  /** 判定带额外留白（CSS 像素，默认 0；音符本身已经很宽了） */
  BAND_PAD: 0,
  /**
   * Hold 允许的**断连宽限**（秒）：持握期间判定范围里没有手指就开始计时，
   * 在这个时间内重新有手指（哪一根都行、也可以换手）接上 → 不算断连；超过它才判 Miss。
   */
  HOLD_GRACE_SEC: 0.08,
  /**
   * Hold 允许**提前松开**的量：相对时长的比例（30%），并且**最长不超过 1 拍**
   * （实际允许量 = min(时长 × 这个比例, 1 拍)）。松在这个窗口内 → 按已按完记分（贴线收尾，不判 Miss）。
   */
  HOLD_RELEASE_RATIO: 0.3,
  HOLD_RELEASE_MAX_BEATS: 1,
  /**
   * **小于这个拍数的 Hold 不设「断连」概念**：头部点中之后随便什么时候松手都不算断连
   * （短到几乎没有按住时间的 Long note，要求「一直按着」没有意义）。默认 0.5 拍。
   */
  HOLD_LENIENT_BEATS: 0.5,
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 官方 v3 归一化坐标（左下角原点 0..1）-> 以画面中心为原点的偏移 */
export const officialCenterOffset = (v) => v - 0.5;
/** RPE 坐标 -> 以画面中心为原点的偏移（x 除以 1350，y 除以 900） */
export const rpeCenterOffsetX = (v) => v / RPE.WIDTH;
export const rpeCenterOffsetY = (v) => v / RPE.HEIGHT;

/** 官方 formatVersion 1：事件值 = 1000x + y，左上角 (880, 520)（见 docs/Phigros文档.md 的 formatVersion 与移动事件坐标） */
export function unpackOfficialV1(value) {
  const x = (value - (((value % 1000) + 1000) % 1000)) / 1000;
  const y = ((value % 1000) + 1000) % 1000;
  return { x: x / 880, y: y / 520 };
}

export const degToRad = (deg) => (deg * Math.PI) / 180;
