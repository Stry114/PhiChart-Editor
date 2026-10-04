/**
 * AI 工具的**稳定 ID**（会话级寻址）。
 *
 * 为什么需要：模型改音符 / 事件靠「引用」（拍 + 位置 + 类型）模糊匹配，而谱面里的拍数
 * 常是无限小数（官方谱由 floorPosition 反推），读取时四舍五入、回写时就对不上 —— 这是
 * 「AI 经常修改不成功」的根因。改为**读取时发一个会话内唯一的整数 id**，模型原样带回，
 * 写入时按 id 精确寻址：不再有模糊匹配，也不怕对象在两次读取之间被移动（撤销 / 重做 /
 * 拖动都不换对象，见 src/editor/history.js 的「记对象不记快照」设计）。
 *
 * 存储方式：id 挂在对象自己的 **Symbol 属性**上 ——
 *  - `JSON.stringify` / `Object.keys` 都看不见它：不会漏进草稿、项目文件与导出结果；
 *  - 历史记录按对象身份记账，撤销重做后 id 依旧有效；
 *  - 复制粘贴产生的新对象没有 id，下次读取时懒分配即可。
 *
 * 计数器是模块级的：id 只要求「同一时刻在同一张谱面里唯一」，跨谱面不回收也不冲突。
 */

import { EVENT_KEYS, EXTENDED_KEYS } from '../core/model.js';
import { CAMERA_KEYS } from '../core/units.js';

const AI_ID = Symbol('aiId');
let nextId = 1;

/** 取对象的 id；没有就分配一个（懒分配，读取路径调用） */
export function ensureId(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  let id = obj[AI_ID];
  if (id === undefined) {
    id = nextId++;
    obj[AI_ID] = id;
  }
  return id;
}

/** 读对象的 id（不分配）；没分配过返回 undefined */
export function peekId(obj) {
  return obj ? obj[AI_ID] : undefined;
}

/**
 * 在一组候选里按 id 精确查找。
 * @param {Iterable<object>} objs 候选对象
 * @returns {object|null} 命中的对象；找不到返回 null
 */
export function findById(objs, id) {
  const want = Number(id);
  if (!Number.isFinite(want)) return null;
  for (const obj of objs) {
    if (obj && obj[AI_ID] === want) return obj;
  }
  return null;
}

/**
 * 按 id 在**整条判定线**（所有事件层 × 全部事件键 + 扩展事件）里找事件。
 * 扩展事件的 `layer` 为 null（数据在 `line.extended[key]`，不分层）。
 * @returns {{ev:object, list:object[], key:string, layer:number|null, extended?:boolean}|null}
 */
export function findEventInLine(line, id) {
  const want = Number(id);
  if (!Number.isFinite(want)) return null;
  const layers = Array.isArray(line?.layers) ? line.layers : [];
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (!layer || typeof layer !== 'object') continue;
    for (const key of EVENT_KEYS) {
      const list = layer[key];
      if (!Array.isArray(list)) continue;
      for (const ev of list) {
        if (ev && ev[AI_ID] === want) return { ev, list, key, layer: li };
      }
    }
  }
  // 扩展事件（theta / z / color / scaleX / scaleY）：不分层，id 全局唯一所以不会与上面撞
  for (const key of EXTENDED_KEYS) {
    const list = line?.extended?.[key];
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      if (ev && ev[AI_ID] === want) return { ev, list, key, layer: null, extended: true };
    }
  }
  return null;
}

/**
 * 按 id 在**谱面相机**（全部相机通道）里找事件。
 * @returns {{ev:object, list:object[], key:string}|null}
 */
export function findEventInCamera(chart, id) {
  const want = Number(id);
  if (!Number.isFinite(want)) return null;
  const camera = chart?.camera;
  if (!camera || typeof camera !== 'object') return null;
  for (const key of CAMERA_KEYS) {
    const list = camera[key];
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      if (ev && ev[AI_ID] === want) return { ev, list, key };
    }
  }
  return null;
}
