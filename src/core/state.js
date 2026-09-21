/**
 * 每帧状态求值 + 判定 + 计分。
 *
 * 位置公式（docs/Phigros文档.md 的核心公式）：
 *   判定线高度  PJ(t) = heightAt(t)                          （Y）
 *   非 Hold     Y(t)  = note.speed × (note.height − PJ(t))
 *   Hold 头部   Y(t)  = note.height − PJ(t)                  （t ≤ 命中时刻）
 *   Hold 尾部   YT(t) = Y(t) + note.speed × durationSec      （命中前）
 *                        = note.speed × (endSec − t)         （命中后，头部贴线）
 *
 * 两种判定模式：
 *  - **自动游玩**（默认，编辑器预览与桌面播放器用）：`advanceJudging`，note 落到线上即 Perfect；
 *  - **真实游玩**（仅触屏设备，见 `docs/Phigros文档.md` 的判定带）：`advancePlayJudging`，输入来自 `src/core/input.js`
 *    的输入缓冲，判定窗口见 `units.js` 的 `JUDGE`（垂直判定 / 多指 / Drag 需判定时刻有手指在带里 /
 *    Flick 滑动即 Perfect / Hold 需按住到尾部）。
 * 两条路径共用 `commitJudgement()` 记分，避免两套逻辑漂移。
 *
 * 计分：见 `docs/Phigros文档.md` 的计分（900000 判定分 + 100000 连击分）。
 */
import { NOTE, LINE, JUDGE, clamp, EXTENDED_KEYS, EXTENDED_DEFAULTS } from './units.js';
import { evalLayers, evalExtended } from './events.js';

export const JUDGEMENT_VALUE = { perfect: 1, good: 0.65, bad: 0, miss: 0 };

/** 音符类型 -> 判定窗口（`units.js` 的 `JUDGE`） */
const JUDGE_SPEC = { tap: JUDGE.TAP, hold: JUDGE.HOLD, drag: JUDGE.DRAG, flick: JUDGE.FLICK };

/** 该类型判定窗口的绝对值上限（秒）：超过就是 Miss */
export function windowMaxFor(type) {
  const w = JUDGE_SPEC[type];
  if (!w) return 0;
  return Math.max(w.perfect, w.good ?? 0, w.bad ?? 0);
}

/**
 * 按时间差取判定等级（纯函数）。
 * @param {string} type tap / hold / drag / flick
 * @param {number} delta |判定时刻 − 音符时刻|（秒）
 * @returns {'perfect'|'good'|'bad'|null} null = 超出窗口
 */
export function judgeWindowFor(type, delta) {
  const w = JUDGE_SPEC[type];
  if (!w || !Number.isFinite(delta)) return null;
  if (delta <= w.perfect) return 'perfect';
  if (w.good !== undefined && delta <= w.good) return 'good';
  if (w.bad !== undefined && delta <= w.bad) return 'bad';
  return null;
}

export function createState(chart, options = {}) {
  return {
    chart,
    options: {
      autoplay: options.autoplay !== false,
      ...options,
    },
    /** 画面宽高比（W/H）：父子线偏移旋转需要；渲染区域固定 16:9（docs/项目文档.md 的架构） */
    aspect: options.aspect ?? 16 / 9,
    time: 0,
    lines: chart.lines.map(() => ({ x: 0, y: 0, rotate: 0, alpha: 0, height: 0, worldX: 0, worldY: 0, worldRotate: 0, color: LINE.COLOR })),
    stats: {
      judged: 0,
      perfect: 0,
      good: 0,
      bad: 0,
      miss: 0,
      combo: 0,
      maxCombo: 0,
      judgeScore: 0,
      comboScore: 0,
      score: 0,
      accuracy: 0,
      allPerfect: false,
      fullCombo: false,
    },
    hits: [], // 本帧新增的打击特效
    judgeCursor: 0,
    /** 真实游玩用的扫描游标（自动游玩用 judgeCursor） */
    playCursor: 0,
    /** 正在持续、需要周期性重放打击动画的 Hold（头部已判定但还没结束） */
    activeHolds: [],
    /**
     * 真实游玩里**头部已点中、还没收尾**的 Hold：等尾巴到了、或手指抬起才最终判定
     * （规则见 docs/Phigros文档.md 的判定带：按到尾部才得分，中途放开 = Miss）
     */
    pendingHolds: [],
  };
}

/** 递归求世界变换（父子判定线）——严格对齐 Phira/prpr 的实现：
 *   rot  = 自身旋转 + (rotateWithFather ? 父线 rot : 0)          （fetch_rot，递归叠加）
 *   pos  = 父线 pos + R(父线 rot) × 自身偏移                      （fetch_pos，偏移会被父线旋转）
 *  注意偏移的旋转必须在「等尺度」空间里做：规范坐标的 x 是画面宽比例、y 是画面高比例，
 *  因此先按 aspect(=W/H) 把 x 折算成与 y 同尺度，旋转后再折回。
 *  参考：prpr/src/core/line.rs 的 fetch_rot / fetch_pos；rotateWithFather 缺省视为 false。
 */
function worldTransform(chart, index, time, out, aspect, depth = 0) {
  const line = chart.lines[index];
  const rt = line.rt;
  const state = out[index];
  if (state.__done) return state;
  if (depth > 64) return state; // 防御：父线关系成环

  state.x = evalLayers(rt.x, time, 0);
  state.y = evalLayers(rt.y, time, 0);
  state.rotate = evalLayers(rt.rotate, time, 0);
  state.alpha = evalLayers(rt.alpha, time, 0);
  state.height = rt.heightAt(time);
  // 扩展事件（不分层，单键单列表）：scaleX / scaleY 缩放判定线，color 直接决定线色。
  // 颜色写到 `extColor`；线**有** color 事件时 `state.useExtColor = true`，
  // 此时渲染器直接用事件颜色画（不再与 AP 金 / FC 蓝 / 白相乘）——
  // 「设了颜色事件就完全按事件颜色显示」，只有完全没有该事件的线才回退到判定色。
  // 另外取一条线段首尾两个颜色（`extColor` / `extColorEnd`）供渐变绘制用。
  for (const key of EXTENDED_KEYS) {
    const target = key === 'color' ? 'extColor' : key;
    state[target] = evalExtended(rt.extended?.[key], key, time, EXTENDED_DEFAULTS[key]);
  }
  // 颜色是唯一「编译结果不是 {list,starts} 而是 {channels:[...]}」的键：判断与取端点都要用通道 0
  const colorList = rt.extended?.color?.channels?.[0]?.list;
  state.useExtColor = Array.isArray(colorList) && colorList.length > 0;
  state.extColorEnd = state.extColor;
  if (state.useExtColor) {
    let segment = colorList[0];
    for (const e of colorList) {
      if (e.t0 <= time) segment = e;
      else break;
    }
    // 线段末端：`t` 还没到末端时，末端色就是这一段结束时的颜色（渐变用）
    if (segment.t1 > time) state.extColorEnd = evalExtended(rt.extended.color, 'color', segment.t1, EXTENDED_DEFAULTS.color);
  }

  const father = line.father;
  if (father >= 0 && father < chart.lines.length && father !== index) {
    const p = worldTransform(chart, father, time, out, aspect, depth + 1);
    const pr = p.worldRotate;
    const ax = state.x * aspect;
    const ay = state.y;
    const cos = Math.cos(pr);
    const sin = Math.sin(pr);
    state.worldX = p.worldX + (ax * cos - ay * sin) / aspect;
    state.worldY = p.worldY + (ax * sin + ay * cos);
    state.worldRotate = state.rotate + (line.rotateWithFather ? pr : 0);
  } else {
    state.worldX = state.x;
    state.worldY = state.y;
    state.worldRotate = state.rotate;
  }
  // 保险：任何非有限值都不允许进入渲染/求值（脏数据在解析层已告警，这里只做兜底）
  if (!Number.isFinite(state.x)) state.x = 0;
  if (!Number.isFinite(state.y)) state.y = 0;
  if (!Number.isFinite(state.rotate)) state.rotate = 0;
  if (!Number.isFinite(state.alpha)) state.alpha = 0;
  if (!Number.isFinite(state.height)) state.height = 0;
  if (!Number.isFinite(state.worldX)) state.worldX = 0;
  if (!Number.isFinite(state.worldY)) state.worldY = 0;
  if (!Number.isFinite(state.worldRotate)) state.worldRotate = 0;
  // 扩展事件兜底：缩放取正数、颜色取合法三元组
  if (!Number.isFinite(state.scaleX) || state.scaleX <= 0) state.scaleX = 1;
  if (!Number.isFinite(state.scaleY) || state.scaleY <= 0) state.scaleY = 1;
  if (!Array.isArray(state.extColor) || state.extColor.length < 3) state.extColor = [255, 255, 255];
  if (!Array.isArray(state.extColorEnd) || state.extColorEnd.length < 3) state.extColorEnd = state.extColor;
  state.__done = true;
  return state;
}

/** 求值一帧（纯计算，无副作用）：线的变换/透明度、每个音符的可见性与纵向位置 */
export function evaluate(state, time) {
  const { chart } = state;
  state.time = Number.isFinite(time) ? time : 0;
  const aspect = state.aspect || 16 / 9;
  for (const ls of state.lines) ls.__done = false;
  for (let i = 0; i < chart.lines.length; i++) {
    if (!chart.lines[i]?.rt) continue; // 被丢弃的脏判定线
    worldTransform(chart, i, state.time, state.lines, aspect);
  }

  for (const note of chart.notes) {
    const line = chart.lines[note.lineId];
    const ls = state.lines[note.lineId];
    if (!line?.rt || !ls) {
      note.visible = false;
      continue;
    }
    const lineHeight = ls.height;
    const cur = note.height - lineHeight; // 单位 Y
    const speed = Number.isFinite(note.speed) ? note.speed : 1;

    let headY;
    let tailY = null;
    // Hold 的头部是否算「已经中了」（待定或已按头部等级记分）：
    // 只有头部中了才贴着线「收尾巴」；头部漏了 / 中途放开 → 整条继续下落
    const holdHeadHit = note.type === 'hold' && (note.holdPending ? true : note.judged && note.judgement !== 'miss');
    if (note.type === 'hold') {
      if (state.time < note.timeSec || !holdHeadHit) {
        headY = cur;
        tailY = cur + speed * note.durationSec;
      } else {
        headY = 0;
        tailY = speed * (note.endSec - state.time);
      }
    } else {
      // 普通音符**不钳制**：过线后继续沿下落方向走 ——
      // 漏接（Miss）与还没判定的音符要在越过判定线之后继续下落并淡出（用户要求 + docs/Phigros文档.md 的参考实现关键渲染常数）。
      // 自动游玩时音符在落线那一帧就被判定并立即消失，所以看不到「飞出去」。
      headY = speed * cur;
    }
    if (!Number.isFinite(headY)) headY = 0;
    if (tailY !== null && !Number.isFinite(tailY)) tailY = headY;

    // 可见性（docs/Phigros文档.md 的可见性剔除）
    // 注意：判定线的 alpha **不**作用于其上的音符（三个参考实现一致；隐藏判定线时音符照常显示），
    // 只有 RPE 的「负 alpha」编码会把线与音符一起隐藏。
    let visible = true;
    let alpha = note.alpha;
    if (ls.alpha < 0) visible = false; // RPE 负 alpha：隐藏判定线及其上所有音符
    else if (line.isCover && !note.above) visible = false; // 遮罩：背面音符不渲染（v1 近似）
    else if (note.visibleTime !== Infinity && state.time < note.timeSec - note.visibleTime) visible = false;

    if (visible) {
      if (note.type === 'hold') {
        if (speed === 0 || note.durationSec <= 0) visible = false;
        else if (cur > NOTE.MAX_VISIBLE_Y) visible = false;
        else if (state.time > note.endSec) visible = false; // 尾部也过了线 → 消失
        else if (!holdHeadHit && state.time > note.timeSec) {
          // 漏接 / 中途放开的长条：**半透明**继续下落（不做淡出，看得见自己漏了哪条）
          alpha = Math.min(alpha, NOTE.HOLD_MISS_ALPHA);
        }
      } else {
        if (speed * cur > NOTE.MAX_VISIBLE_Y) visible = false;
        // 命中（Perfect / Good）→ 立即消失，只留打击特效（判定发生在 evaluate 之后，
        // 所以「落到线上」那一帧仍会画出来）。
        else if (note.judged && note.judgement !== 'bad' && note.judgement !== 'miss') visible = false;
        // Bad（真实游玩）：按 sim-phi 口径用暗红贴图（`NOTE.BAD_COLOR`）在 0.5 s 内淡出
        else if (note.judged && note.judgement === 'bad') {
          note.badStyle = true;
          alpha *= clamp(1 - (state.time - (Number.isFinite(note.hitFxTime) ? note.hitFxTime : note.timeSec)) / NOTE.BAD_FADE, 0, 1);
          if (alpha <= 0.001) visible = false;
        }
        // Miss / 还没判定的漏接：过线后**继续下落**并在 0.16 s 内淡出（见 `docs/Phigros文档.md` 的漏接与命中表现）
        else if (state.time > note.timeSec) {
          const from = note.judged ? (Number.isFinite(note.hitFxTime) ? note.hitFxTime : note.timeSec) : note.timeSec;
          alpha *= clamp(1 - (state.time - from) / NOTE.FADE_OUT, 0, 1);
          if (alpha <= 0.001) visible = false;
        }
      }
    }

    note.badStyle = visible && note.judgement === 'bad';

    note.renderAlpha = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    note.visible = visible;
    note.distY = headY;
    note.headY = headY;
    note.tailY = tailY;
  }

  // 判定线颜色：目前没有任何非 Perfect → 金色；全连（无 Bad/Miss）→ 蓝色；否则白
  // 注意：自动游玩必然满分，因此线在自动游玩下应始终为金色（而不是等全部判定完才变金）。
  const { stats } = state;
  const allPerfectSoFar = stats.good === 0 && stats.bad === 0 && stats.miss === 0;
  const fullComboSoFar = stats.bad === 0 && stats.miss === 0;
  const color = allPerfectSoFar ? LINE.COLOR_ALL_PERFECT : fullComboSoFar ? LINE.COLOR_FULL_COMBO : LINE.COLOR;
  for (const ls of state.lines) ls.color = color;
}

/**
 * 重新定位自动判定的游标。
 *
 * 拖动写回会改音符时间 → `chart.notes` 要重排（refreshNotes），而 advanceJudging 是按
 * 数组顺序用游标单调前进的，重排后旧游标可能指到别的音符上（重复判定 / 漏判）。
 * 这里统一把游标放回「第一个还没判定的音符」：已判定的靠 `judged` 标记跳过，不会重复计分。
 */
export function resyncJudgeCursor(state) {
  const notes = state?.chart?.notes;
  if (!Array.isArray(notes)) return 0;
  let i = 0;
  while (i < notes.length && (notes[i].judged || !Number.isFinite(notes[i].timeSec))) i++;
  state.judgeCursor = i;
  return i;
}

/** 真实游玩的扫描游标（含义同 `resyncJudgeCursor`；`advancePlayJudging` 用） */
export function resyncPlayCursor(state) {
  const notes = state?.chart?.notes;
  if (!Array.isArray(notes)) return 0;
  let i = 0;
  while (i < notes.length && (notes[i].judged || !Number.isFinite(notes[i].timeSec))) i++;
  state.playCursor = i;
  return i;
}

/**
 * 提交一次判定（自动游玩与真实游玩共用）：统计 / 连击 / 打击特效 / Hold 跟踪。
 *
 * @param {object} state
 * @param {object} note
 * @param {'perfect'|'good'|'bad'|'miss'} judgement
 * @param {number} at 判定发生的谱面时刻（秒）：写入 `hitFxTime`（Bad 淡出也用它）
 * @param {object[]} scratch `pushHit` 复用的临时判定线状态数组
 * @param {{fxAt?:number|null, holdFx?:boolean}} [opts] 打击特效的时刻（缺省 = 音符落线时刻；
 *        Miss 传 null 表示不生成）；`holdFx: false` 表示不要再开 Hold 的重复动画
 *        （收尾记分时用，动画在头部命中时就开过了）
 */
function commitJudgement(state, note, judgement, at, scratch, opts = {}) {
  const { stats } = state;
  const hit = judgement === 'perfect' || judgement === 'good';
  note.judged = true;
  note.judgement = judgement;
  note.hitFxTime = at;
  stats.judged++;
  stats[judgement] = (stats[judgement] ?? 0) + 1;
  if (hit) {
    stats.combo++;
    if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;
    // 打击特效只有命中才有（Bad/Miss 不生成）：锚点缺省是「音符落到线上」那一刻，
    // 真实游玩传判定时刻（提前命中时特效跟着手指出现，而不是等到落线）。
    // 生成窗口按**判定时刻**判断：跳转/快进后一次性补判的旧音符只计分、不补特效
    // （否则几十个特效会同时炸出来）。
    const fxAt = opts.fxAt === null ? null : Number.isFinite(opts.fxAt) ? opts.fxAt : note.timeSec;
    if (fxAt !== null && at - note.timeSec <= NOTE.FX_SPAWN_WINDOW) pushHit(state, note, fxAt, scratch, false, judgement);
    // Hold 未结束时：每 10 帧再产生一次打击动画（收尾记分时不再重开）
    if (opts.holdFx !== false && note.type === 'hold' && note.endSec > note.timeSec) {
      note.nextFxTime = Math.min(note.timeSec + NOTE.HOLD_FX_INTERVAL, note.endSec);
      state.activeHolds.push(note);
    }
  } else {
    stats.combo = 0; // Bad / Miss：断连
  }
}

/** 停掉一个 Hold 的重复打击动画（中途放开 → Miss 时用） */
function stopHoldFx(state, note) {
  const idx = state.activeHolds.indexOf(note);
  if (idx >= 0) state.activeHolds.splice(idx, 1);
  note.nextFxTime = 0;
}

/**
 * **Hold 头部命中**：先只登记（记住头部等级与按下的那根手指），不立刻记分。
 *
 * 规则（项目决定，`docs/Phigros文档.md 的判定带`）：头部时机决定 Good / Perfect；**必须按住直到尾部**
 * 才真正得分；中途放开 = Miss；**Hold 无 Bad**。
 * 头部命中的打击动画照旧立刻开始（每 10 帧重放，见 `updateActiveHolds`）。
 */
function registerHoldHead(state, note, judgement, at, scratch, finger) {
  note.holdPending = { judgement, at, finger: finger ?? null };
  note.hitFxTime = at;
  const fxAt = Number.isFinite(at) ? at : note.timeSec;
  if (at - note.timeSec <= NOTE.FX_SPAWN_WINDOW) pushHit(state, note, fxAt, scratch, false, judgement);
  note.nextFxTime = Math.min(note.timeSec + NOTE.HOLD_FX_INTERVAL, note.endSec);
  if (!state.activeHolds.includes(note)) state.activeHolds.push(note);
  if (!state.pendingHolds.includes(note)) state.pendingHolds.push(note);
}

/** 待定 Hold 的收尾：按到尾部（或提前 ≤20%）→ 按头部等级记分；更早松手 / 中断 → Miss */
function updatePendingHolds(state, time, input, scratch) {
  const pending = state.pendingHolds;
  for (let i = pending.length - 1; i >= 0; i--) {
    const note = pending[i];
    const hold = note.holdPending;
    if (!hold) {
      pending.splice(i, 1);
      continue;
    }
    // 只认「点中头部的那根手指」：它一直按着才算保持（多指时不会因为别的手指乱动而误判）
    const stillDown = hold.finger === null || !!input?.fingers?.has(hold.finger);
    const released = !stillDown;
    // 允许提前一点点松手：按到 `时长 × (1 − HOLD_RELEASE_SLACK)` 就算按完了
    const releaseOkAt = note.timeSec + Math.max(0, note.durationSec) * (1 - JUDGE.HOLD_RELEASE_SLACK);
    const finished = time >= note.endSec || (released && time >= releaseOkAt);
    if (finished) {
      pending.splice(i, 1);
      note.holdPending = null;
      stopHoldFx(state, note);
      commitJudgement(state, note, hold.judgement, time, scratch, { fxAt: null, holdFx: false });
    } else if (released) {
      // 松得太早 → Miss（Hold 无 Bad）
      pending.splice(i, 1);
      note.holdPending = null;
      stopHoldFx(state, note);
      commitJudgement(state, note, 'miss', time, scratch, { fxAt: null, holdFx: false });
    }
  }
}

/** Hold 的重复打击动画（只要还没结束就每 10 帧来一次；结束时刻本身不再补） */
function updateActiveHolds(state, time, scratch) {
  if (!state.activeHolds.length) return;
  for (let i = state.activeHolds.length - 1; i >= 0; i--) {
    const note = state.activeHolds[i];
    const last = Math.min(time, note.endSec);
    if (note.nextFxTime < note.endSec && note.nextFxTime <= last) {
      let guard = 0;
      while (note.nextFxTime < note.endSec && note.nextFxTime <= last && guard++ < 8) {
        // 同样只在生成窗口内补特效（快进经过的旧时刻只跳过，不补播）
        if (last - note.nextFxTime <= NOTE.FX_SPAWN_WINDOW) pushHit(state, note, note.nextFxTime, scratch, true, note.judgement);
        note.nextFxTime += NOTE.HOLD_FX_INTERVAL;
      }
    }
    if (note.nextFxTime >= note.endSec) state.activeHolds.splice(i, 1);
  }
}

/**
 * **自动游玩**：note 落到线上即视为 Perfect（项目要求）。
 * 关掉 `state.options.autoplay` 后这里不做任何判定（真实游玩走 `advancePlayJudging`）。
 */
export function advanceJudging(state, time) {
  const notes = state.chart.notes;
  state.hits.length = 0;
  if (!Number.isFinite(time)) return state.hits;
  const scratch = [];
  if (state.options.autoplay) {
    while (state.judgeCursor < notes.length) {
      const next = notes[state.judgeCursor];
      // 脏数据兜底：时间非有限的音符直接跳过（否则游标会被卡住，后面的音符永远不判定）
      if (!Number.isFinite(next.timeSec)) {
        state.judgeCursor++;
        continue;
      }
      if (next.timeSec > time) break;
      const note = notes[state.judgeCursor++];
      if (note.isFake || note.judged) continue;
      commitJudgement(state, note, 'perfect', time, scratch);
    }
  }
  updateActiveHolds(state, time, scratch);
  updateScore(state);
  return state.hits;
}

/**
 * 在未判定的 Tap/Hold 里挑这次点击要判的音符：**优先最早出现的可判定音符**
 * （`docs/Phigros文档.md 的判定窗口`）；从头像游标开始扫，越过前瞻窗口就停。
 *
 * `hitTest(note, input)` 是**判定范围**：返回 false 表示这次点击不落在该音符的判定带里
 * （app 用渲染器的投影算「音符所在的列」，见 `projection.judgeBand`）。
 * 不传（或判定范围设成「全屏」）时任意位置都算。
 */
function findTapTarget(state, notes, tap, hitTest) {
  let best = null;
  for (let i = state.playCursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.timeSec - tap.at > JUDGE.LOOKAHEAD) break; // 后面的更晚，不用再看
    if (note.judged || note.isFake || note.holdPending) continue; // 已经点中头部的 Hold 不能再点
    if (note.type !== 'tap' && note.type !== 'hold') continue;
    if (Math.abs(note.timeSec - tap.at) > windowMaxFor(note.type)) continue;
    if (hitTest && !hitTest(note, tap)) continue; // 不在判定带里：这次点击与它无关
    if (!best || note.timeSec < best.timeSec) best = note;
  }
  return best;
}

/**
 * Drag 的判定：**判定时刻有没有手指落在它的判定带里**（docs/Phigros文档.md 的判定窗口「Drag 只需判定时刻有手指
 * 在判定区域」）。注意 Drag 不能被「点击」判定成别的等级，也不吃单独的 tap 事件 ——
 * 只要那一刻有任何一根手指按在带里就算过。
 * 全屏判定（没有 hitTest）时任意手指都算；没有位置信息的合成输入退化为「有手指就算」。
 */
function fingerInBand(note, input, hitTest) {
  const positions = input?.positions;
  if (positions && positions.size) {
    for (const p of positions.values()) {
      if (!hitTest) return true;
      if (hitTest(note, { x: p.x, y: p.y })) return true;
    }
    return false;
  }
  return (input?.fingerCount ?? 0) > 0;
}

/**
 * **真实游玩**（仅触屏；`docs/Phigros文档.md 的判定带`）：用输入缓冲判定。
 *
 * 每帧三步：
 *  1. 消费输入：每个 tap 判一个最早可判定的 Tap/Hold；一次滑动点亮窗口内所有 Flick（简化口径）；
 *  2. 扫描游标附近：Drag 过线即 Perfect；超过窗口仍未判定 → Miss；
 *  3. 推进游标（跳过已解决 / 已过期的音符，保证大谱面每帧只看窗口内几条）。
 *
 * @param {object} state
 * @param {number} time 当前谱面时间（秒）
 * @param {object} input `src/core/input.js` 的输入缓冲（可为 null → 无输入）
 * @param {{hitTest?:(note:object, input:object)=>boolean}} [options]
 *        hitTest = 判定范围：点击/滑动是否落在该音符的判定带里；
 *        不传 = **全屏判定**（点屏幕任意位置都算，作为可选模式保留）
 */
export function advancePlayJudging(state, time, input, options = {}) {
  const notes = state.chart.notes;
  state.hits.length = 0;
  if (!Number.isFinite(time)) return state.hits;
  // 保险：自动游玩开着时不要用真实判定（调用方应传对函数）
  if (state.options.autoplay) return advanceJudging(state, time);
  const hitTest = typeof options.hitTest === 'function' ? options.hitTest : null;
  const scratch = [];
  const taps = [...(input?.taps ?? [])].sort((a, b) => a.at - b.at);
  const swipes = [...(input?.swipes ?? [])].sort((a, b) => a.at - b.at);

  // 1) 输入
  for (const swipe of swipes) {
    for (let i = state.playCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.timeSec - swipe.at > JUDGE.FLICK.perfect) break;
      if (note.judged || note.isFake || note.type !== 'flick') continue;
      if (Math.abs(note.timeSec - swipe.at) > JUDGE.FLICK.perfect) continue;
      if (hitTest && !hitTest(note, swipe)) continue; // 滑动没有经过它的判定带
      commitJudgement(state, note, 'perfect', swipe.at, scratch, { fxAt: swipe.at });
    }
  }
  for (const tap of taps) {
    const target = findTapTarget(state, notes, tap, hitTest);
    if (!target) continue; // 空点 / 不在判定带里：不扣分、不消耗音符
    const judgement = judgeWindowFor(target.type, Math.abs(target.timeSec - tap.at));
    if (!judgement) continue;
    if (target.type === 'hold') {
      // Hold：先登记头部（等级 + 手指），尾巴到了 / 松手时才真正判定
      registerHoldHead(state, target, judgement, tap.at, scratch, tap.id);
    } else {
      commitJudgement(state, target, judgement, tap.at, scratch, { fxAt: tap.at });
    }
  }

  // 2) 过线即 Perfect 的 Drag + 过期未判定 → Miss
  for (let i = state.playCursor; i < notes.length; i++) {
    const note = notes[i];
    if (!Number.isFinite(note.timeSec)) {
      note.judged = true; // 脏数据：解决掉，别卡住游标
      continue;
    }
    if (note.timeSec - JUDGE.LOOKAHEAD > time) break;
    if (note.isFake) {
      note.judged = true;
      continue;
    }
    if (note.judged) continue;
    if (note.type === 'hold' && note.holdPending) continue; // 头部已点中：等尾巴 / 松手（见 updatePendingHolds）
    if (note.type === 'drag') {
      // Drag：判定时刻（±0.10s）有手指在判定带里 → Perfect；一直没手指 → Miss
      // （用户反馈：以前「过线即 Perfect、不吃输入」会让人什么都没按也满分，那不是想要的手感）
      if (Math.abs(time - note.timeSec) <= JUDGE.DRAG.perfect && fingerInBand(note, input, hitTest)) {
        commitJudgement(state, note, 'perfect', time, scratch, { fxAt: time });
      } else if (time - note.timeSec > JUDGE.DRAG.perfect) {
        commitJudgement(state, note, 'miss', time, scratch, { fxAt: null });
      }
      continue;
    }
    if (time - note.timeSec > windowMaxFor(note.type)) commitJudgement(state, note, 'miss', time, scratch, { fxAt: null });
  }

  // 2.5) 待定的 Hold：按到尾部 → 按头部等级记分；中途放开 → Miss
  updatePendingHolds(state, time, input, scratch);

  // 3) 游标推进：只跳过「已解决」或「已经超出前瞻窗口」的音符
  while (state.playCursor < notes.length) {
    const note = notes[state.playCursor];
    const done = note.judged || !Number.isFinite(note.timeSec) || note.isFake;
    if (!done && note.timeSec + JUDGE.LOOKAHEAD >= time) break;
    state.playCursor++;
  }

  updateActiveHolds(state, time, scratch);
  updateScore(state);
  return state.hits;
}

/**
 * 生成一条打击特效记录。
 * @param {object} state
 * @param {object} note
 * @param {number} at 命中时刻（自动游玩 = 音符落线时刻；真实游玩 = 判定时刻）
 * @param {object[]} scratch 复用的临时判定线状态数组（避免每帧分配）
 * @param {boolean} [repeat] Hold 的重复打击动画
 * @param {'perfect'|'good'} [judgement] 命中等级（决定特效配色：金 / 蓝）
 */
function pushHit(state, note, at, scratch, repeat = false, judgement = 'perfect') {
  const chart = state.chart;
  if (!chart.lines[note.lineId]?.rt) return;
  const t = Number.isFinite(at) ? at : note.timeSec;
  // 判定线在「命中时刻」的世界变换（与 evaluate 用同一套公式：父子线、aspect 都一致）
  const n = chart.lines.length;
  for (let i = 0; i < n; i++) (scratch[i] ??= {}).__done = false;
  scratch.length = n;
  const ls = worldTransform(chart, note.lineId, t, scratch, state.aspect || 16 / 9);
  state.hits.push({
    lineId: note.lineId,
    // 特效固定在命中位置（不随之后的线运动）
    lineX: ls.worldX,
    lineY: ls.worldY,
    lineRotate: ls.worldRotate,
    offsetX: note.positionX * 0.05625, // 以画面宽为单位的横向偏移
    // 落到线上时纵向距离为 0，只剩音符自身的 yOffset（RPE）
    offsetY: (Number.isFinite(note.yOffset) ? note.yOffset : 0) * 0.6,
    above: note.above,
    type: note.type, // 供音效（tap/hold → click.wav，drag/flick 各自一个）
    repeat: !!repeat, // Hold 的重复打击动画：不再重复播放音效
    judgement: judgement === 'good' ? 'good' : 'perfect',
    perfect: judgement !== 'good', // 渲染器按它选金色 / 蓝色特效与粒子
    time: t,
  });
}

function updateScore(state) {
  const { stats, chart } = state;
  const total = chart.noteCount || 1;
  // 与官方/Phira/sim-phi 一致的公式：score = round((900000·Perfect + 585000·Good + 100000·maxCombo) / N)
  const value = 900000 * stats.perfect + 585000 * stats.good + 100000 * stats.maxCombo;
  stats.judgeScore = (900000 * (stats.perfect + 0.65 * stats.good)) / total;
  stats.comboScore = (100000 * stats.maxCombo) / total;
  stats.score = Math.min(1000000, Math.round(value / total));
  stats.accuracy = stats.judgeScore / 900000;
  stats.allPerfect = stats.judged >= total && stats.perfect >= total;
  stats.fullCombo = stats.bad + stats.miss === 0;
}

/** 官方/游戏一致的分数显示格式（docs/Phigros文档.md 的判定与计分） */
export function formatScore(score) {
  let s = score + 0.5;
  s = Number.isFinite(s) ? s | 0 : 1 << 31;
  if (s >= 1e6) return '1000000';
  return `0${(s / 1e5).toFixed(5).replace('.', '')}`;
}

export function resetState(state) {
  state.time = 0;
  state.judgeCursor = 0;
  state.playCursor = 0;
  state.hits.length = 0;
  state.activeHolds.length = 0;
  if (Array.isArray(state.pendingHolds)) state.pendingHolds.length = 0;
  Object.assign(state.stats, {
    judged: 0,
    perfect: 0,
    good: 0,
    bad: 0,
    miss: 0,
    combo: 0,
    maxCombo: 0,
    judgeScore: 0,
    comboScore: 0,
    score: 0,
    accuracy: 0,
    allPerfect: false,
    fullCombo: false,
  });
  for (const note of state.chart.notes) {
    note.judged = false;
    note.judgement = null;
    note.hitFxTime = -1;
    note.nextFxTime = 0;
    note.badStyle = false;
    note.holdPending = null;
  }
}
