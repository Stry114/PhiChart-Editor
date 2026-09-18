/**
 * 每帧状态求值 + 自动游玩判定 + 计分。
 *
 * 位置公式（docs/03 §2）：
 *   判定线高度  PJ(t) = heightAt(t)                          （Y）
 *   非 Hold     Y(t)  = note.speed × (note.height − PJ(t))
 *   Hold 头部   Y(t)  = note.height − PJ(t)                  （t ≤ 命中时刻）
 *   Hold 尾部   YT(t) = Y(t) + note.speed × durationSec      （命中前）
 *                        = note.speed × (endSec − t)         （命中后，头部贴线）
 * 判定/计分：docs/03 §4（900000 判定分 + 100000 连击分；本渲染器为自动游玩，恒为 Perfect）。
 */
import { NOTE, LINE, clamp } from './units.js';
import { evalLayers } from './events.js';

export const JUDGEMENT_VALUE = { perfect: 1, good: 0.65, bad: 0, miss: 0 };

export function createState(chart, options = {}) {
  return {
    chart,
    options: {
      autoplay: options.autoplay !== false,
      ...options,
    },
    /** 画面宽高比（W/H）：父子线偏移旋转需要；渲染区域固定 16:9（docs/05 §3） */
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
    /** 正在持续、需要周期性重放打击动画的 Hold（头部已判定但还没结束） */
    activeHolds: [],
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
    if (note.type === 'hold') {
      if (state.time < note.timeSec) {
        headY = cur;
        tailY = cur + speed * note.durationSec;
      } else {
        headY = 0;
        tailY = speed * (note.endSec - state.time);
      }
    } else {
      // 普通音符越过线后位置钳制在线上（不继续往下走）：
      // 高速判定线（例如 official 的 999 速度段）一帧就能移动十几 Y，
      // 若按实际距离渲染，这些音符会在两帧之间直接飞出屏幕、**永远看不到**。
      headY = Math.max(0, speed * cur);
    }
    if (!Number.isFinite(headY)) headY = 0;
    if (tailY !== null && !Number.isFinite(tailY)) tailY = headY;

    // 可见性（docs/03 §3）
    // 注意：判定线的 alpha **不**作用于其上的音符（三个参考实现一致；隐藏判定线时音符照常显示），
    // 只有 RPE 的「负 alpha」编码会把线与音符一起隐藏。
    let visible = true;
    let alpha = note.alpha;
    if (ls.alpha < 0) visible = false; // RPE 负 alpha：隐藏判定线及其上所有音符
    else if (line.isCover && !note.above) visible = false; // 遮罩：背面音符不渲染（v1 近似）
    else if (note.visibleTime !== Infinity && state.time < note.timeSec - note.visibleTime) visible = false;

    if (visible) {
      if (note.type === 'hold') {
        // Hold 是例外：头部命中后本体要一直显示到尾部过线
        if (speed === 0 || note.durationSec <= 0) visible = false;
        else if (state.time > note.endSec) visible = false;
        else if (cur > NOTE.MAX_VISIBLE_Y) visible = false;
      } else {
        if (speed * cur > NOTE.MAX_VISIBLE_Y) visible = false;
        // 已判定的音符立即消失，只留打击特效。
        // 判定发生在 evaluate 之后（advanceJudging），因此「落到线上」那一帧仍会画出来
        // （音符就停在线上），下一帧起消失 —— 这样高速线上的音符也不会一辈子看不到。
        else if (note.judged) visible = false;
        // 未判定且已过线（真实游玩漏接）才淡出 —— 这种情况不显示打击特效
        else if (state.time > note.timeSec) {
          alpha *= clamp(1 - (state.time - note.timeSec) / NOTE.FADE_OUT, 0, 1);
          if (alpha <= 0.001) visible = false;
        }
      }
    }

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

/** 自动游玩：note 落到线上即视为 Perfect（项目要求） */
export function advanceJudging(state, time) {
  const { chart, stats } = state;
  const notes = chart.notes;
  state.hits.length = 0;
  if (!Number.isFinite(time)) return state.hits;
  const scratch = [];
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
    note.judged = true;
    note.judgement = state.options.autoplay ? 'perfect' : 'perfect'; // v1 只有自动游玩
    note.hitFxTime = time;
    stats.judged++;
    stats.perfect++;
    stats.combo++;
    if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;
    // 打击特效锚在「音符落到线上」那个时刻的位置（不是判定发生时的当前帧位置）：
    // 落点 = 判定线在 note.timeSec 的变换 + note 自身的 positionX / yOffset，
    // 因此线在快速移动、或一次补判很多音符（跳转/快进）时，特效位置依然准确。
    // 补判太久以前的音符只计分、不再补特效（否则会同时炸出几十个特效）。
    if (time - note.timeSec <= NOTE.FX_SPAWN_WINDOW) pushHit(state, note, note.timeSec, scratch);
    // Hold 未结束时：每 10 帧再产生一次打击动画
    if (note.type === 'hold' && note.endSec > note.timeSec) {
      note.nextFxTime = Math.min(note.timeSec + NOTE.HOLD_FX_INTERVAL, note.endSec);
      state.activeHolds.push(note);
    }
  }
  // Hold 的重复打击动画（只要还没结束就每 42 帧来一次；结束时刻本身不再补）
  if (state.activeHolds.length) {
    for (let i = state.activeHolds.length - 1; i >= 0; i--) {
      const note = state.activeHolds[i];
      const last = Math.min(time, note.endSec);
      if (note.nextFxTime < note.endSec && note.nextFxTime <= last) {
        let guard = 0;
        while (note.nextFxTime < note.endSec && note.nextFxTime <= last && guard++ < 8) {
          // 同样只在生成窗口内补特效（快进经过的旧时刻只跳过，不补播）
          if (last - note.nextFxTime <= NOTE.FX_SPAWN_WINDOW) pushHit(state, note, note.nextFxTime, scratch, true);
          note.nextFxTime += NOTE.HOLD_FX_INTERVAL;
        }
      }
      if (note.nextFxTime >= note.endSec) state.activeHolds.splice(i, 1);
    }
  }
  updateScore(state);
  return state.hits;
}

/**
 * 生成一条打击特效记录。
 * @param {object} state
 * @param {object} note
 * @param {number} at 命中时刻（音符落到线上的那个时间点）
 * @param {object[]} scratch 复用的临时判定线状态数组（避免每帧分配）
 */
function pushHit(state, note, at, scratch, repeat = false) {
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
    perfect: true,
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

/** 官方/游戏一致的分数显示格式（docs/03 §4） */
export function formatScore(score) {
  let s = score + 0.5;
  s = Number.isFinite(s) ? s | 0 : 1 << 31;
  if (s >= 1e6) return '1000000';
  return `0${(s / 1e5).toFixed(5).replace('.', '')}`;
}

export function resetState(state) {
  state.time = 0;
  state.judgeCursor = 0;
  state.hits.length = 0;
  state.activeHolds.length = 0;
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
  }
}
