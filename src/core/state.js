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
  };
}

/** 递归求世界变换（父子判定线；docs/02 §3：子线坐标叠加父线，旋转由 rotateWithFather 决定） */
function worldTransform(chart, index, time, out, depth = 0) {
  const line = chart.lines[index];
  const rt = line.rt;
  const state = out[index];
  if (state.__done) return state;
  if (depth > 32) return state; // 防御：父子成环

  state.x = evalLayers(rt.x, time, 0);
  state.y = evalLayers(rt.y, time, 0);
  state.rotate = evalLayers(rt.rotate, time, 0);
  state.alpha = evalLayers(rt.alpha, time, 0);
  state.height = rt.heightAt(time);

  const father = line.father;
  if (father >= 0 && father < chart.lines.length && father !== index) {
    const p = worldTransform(chart, father, time, out, depth + 1);
    state.worldX = p.worldX + state.x;
    state.worldY = p.worldY + state.y;
    state.worldRotate = state.rotate + (line.rotateWithFather ? p.worldRotate : 0);
  } else {
    state.worldX = state.x;
    state.worldY = state.y;
    state.worldRotate = state.rotate;
  }
  state.__done = true;
  return state;
}

/** 求值一帧（纯计算，无副作用）：线的变换/透明度、每个音符的可见性与纵向位置 */
export function evaluate(state, time) {
  const { chart } = state;
  state.time = time;
  for (const ls of state.lines) ls.__done = false;
  for (let i = 0; i < chart.lines.length; i++) worldTransform(chart, i, time, state.lines);

  for (const note of chart.notes) {
    const line = chart.lines[note.lineId];
    const ls = state.lines[note.lineId];
    const lineHeight = ls.height;
    const cur = note.height - lineHeight; // 单位 Y
    const speed = note.speed;

    let headY;
    let tailY = null;
    if (note.type === 'hold') {
      if (time < note.timeSec) {
        headY = cur;
        tailY = cur + speed * note.durationSec;
      } else {
        headY = 0;
        tailY = speed * (note.endSec - time);
      }
    } else {
      headY = speed * cur;
    }

    // 可见性（docs/03 §3）
    // 注意：判定线的 alpha **不**作用于其上的音符（三个参考实现一致；隐藏判定线时音符照常显示），
    // 只有 RPE 的「负 alpha」编码会把线与音符一起隐藏。
    let visible = true;
    let alpha = note.alpha;
    if (ls.alpha < 0) visible = false; // RPE 负 alpha：隐藏判定线及其上所有音符
    else if (line.isCover && !note.above) visible = false; // 遮罩：背面音符不渲染（v1 近似）
    else if (note.visibleTime !== Infinity && time < note.timeSec - note.visibleTime) visible = false;

    if (visible) {
      if (note.type === 'hold') {
        if (speed === 0 || note.durationSec <= 0) visible = false;
        else if (time > note.endSec) visible = false;
        else if (cur > NOTE.MAX_VISIBLE_Y) visible = false;
      } else {
        if (speed * cur > NOTE.MAX_VISIBLE_Y) visible = false;
        else if (time > note.timeSec) {
          alpha *= clamp(1 - (time - note.timeSec) / NOTE.FADE_OUT, 0, 1);
          if (alpha <= 0.001) visible = false;
        }
      }
      if (cur < -0.001 && !note.judged) visible = false; // 未判定且已越过线：不渲染
    }

    note.renderAlpha = clamp(alpha, 0, 1);
    note.visible = visible;
    note.distY = headY;
    note.headY = headY;
    note.tailY = tailY;
  }

  // 判定线颜色：全 Perfect 金色 / 全连蓝色 / 否则白
  const { stats } = state;
  const color = stats.allPerfect ? LINE.COLOR_ALL_PERFECT : stats.fullCombo ? LINE.COLOR_FULL_COMBO : LINE.COLOR;
  for (const ls of state.lines) ls.color = color;
}

/** 自动游玩：note 落到线上即视为 Perfect（项目要求） */
export function advanceJudging(state, time) {
  const { chart, stats } = state;
  const notes = chart.notes;
  state.hits.length = 0;
  while (state.judgeCursor < notes.length && notes[state.judgeCursor].timeSec <= time) {
    const note = notes[state.judgeCursor++];
    if (note.isFake || note.judged) continue;
    note.judged = true;
    note.judgement = state.options.autoplay ? 'perfect' : 'perfect'; // v1 只有自动游玩
    note.hitFxTime = time;
    stats.judged++;
    stats.perfect++;
    stats.combo++;
    if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;
    const ls = state.lines[note.lineId];
    state.hits.push({
      lineId: note.lineId,
      // 记录生成时刻的判定线世界变换，特效固定在命中位置（不随之后的线运动）
      lineX: ls.worldX,
      lineY: ls.worldY,
      lineRotate: ls.worldRotate,
      offsetX: note.positionX * 0.05625, // 以画面宽为单位的横向偏移
      offsetY: (note.type === 'hold' ? 0 : note.distY) * 0.6, // 以画面高为单位的纵向偏移
      above: note.above,
      perfect: true,
      time,
    });
  }
  updateScore(state);
  return state.hits;
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
  }
}
