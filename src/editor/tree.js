/**
 * 左下角「结构树」标签页：判定线 → 音符 / 事件层 / 扩展事件 → 各事件；最上面还有**谱面相机**。
 *
 * 交互：
 *  - 点每行行首的折叠图标 → 折叠 / 展开该行
 *  - 双击「事件层」= 把该层的 5 条事件轨**整组导入并绑定**到时间轴
 *  - 双击「扩展事件」组 = 把该线已实现的扩展事件轨（scaleX / scaleY / color / z / theta）整组导入并绑定
 *  - 双击「谱面相机」组 / 它的通道 = 导入相机关键帧轨（谱面级，不属于任何判定线）
 *  - 双击单个事件 / 音符 / 扩展键叶子 = 只导入那一条轨
 *  - 顶部两个按钮：展开全部（展开到事件层）、折叠全部
 *
 * 扩展事件**不分事件层**（RPE 里每条线只有一份 `extended`）：本版本渲染/编辑
 * scaleX / scaleY / color / z / theta；incline / text / paint / gif 解析后原样保留、导出写回，界面里标为未实现。
 * 谱面相机（x / y / z / focal）是本项目的自有扩展：RPE 写在根节点的 `camera` 里，
 * 与扩展事件同构但**属于整张谱面**（见 core/units.js 的 CAMERA_KEYS）。
 */
import {
  EVENT_KEYS,
  EVENT_LABELS,
  EVENT_COLORS,
  EVENT_SHORT,
  EVENT_TRACK_ICONS,
  CAMERA_COLORS,
  CAMERA_ICONS,
  CAMERA_LABELS,
  CAMERA_SHORT,
  CAMERA_GROUP_ICON,
  CAMERA_GROUP_LABEL,
  makeEventTrack,
  makeNotesTrack,
  makeLayerTracks,
  makeLineTracks,
  makeExtendedTrack,
  makeExtendedTracks,
  makeCameraTrack,
  makeCameraTracks,
  createBeatAxis,
} from './tracks.js';
import { icon, EVENT_ICONS, ICONS } from '../ui/icons.js';
import { makeEasing } from '../core/easing.js';
import { refreshLine } from '../core/model.js';
import { RPE, CAMERA_KEYS, EXTENDED_KEYS, EXTENDED_RPE_FIELD } from '../core/units.js';

const NOTE_KEYS = ['tap', 'drag', 'hold', 'flick'];
const NOTE_LABELS = { tap: 'Tap', drag: 'Drag', hold: 'Hold', flick: 'Flick' };
const MAX_LAYERS = 8; // 事件层太多的线只展开前若干个，避免一次塞几百行

/** 新事件层里那条默认事件的起点：「第 1 拍」= 拍轴 0（也就是「从开头就生效」） */
const NEW_LAYER_EVENT_BEAT = 0;
/** 「保持到结束」的哨兵拍值：RPE 与官方格式都用这个约定（RPE.SENTINEL_BEAT） */
const HOLD_TO_END_BEAT = RPE.SENTINEL_BEAT;
/**
 * 新事件层里那条默认事件的取值：**全 0 = 中性**（层之间是相加的，见 addEventLayer 说明）。
 * 只有「没有任何 speed 事件」时求值才回退到 1（那是 `LINE_EVENT_DEFAULTS` 的用途）。
 */
const NEW_LAYER_VALUES = { x: 0, y: 0, rotate: 0, alpha: 0, speed: 0 };

// 折叠状态（跨标签页切换保留）：线的折叠集合、事件层的展开集合
const collapsedLines = new Set();
const expandedLayers = new Set();
/** 扩展事件组的展开集合（扩展事件不分层，每线只有一组） */
const expandedExtended = new Set();
/** 谱面相机组的展开状态（相机是谱面级的，树里只有一组） */
let cameraOpen = true;

const keyOfLine = (lineId) => `L:${lineId}`;
const keyOfLayer = (lineId, li) => `E:${lineId}:${li}`;
const keyOfExtended = (lineId) => `X:${lineId}`;

/** 展开全部：展开到事件层，但不展开下属 5 个具体事件 */
export function expandAll() {
  collapsedLines.clear();
  expandedLayers.clear();
  expandedExtended.clear();
  cameraOpen = true;
}

/** 折叠全部：只留判定线一行 */
export function collapseAll() {
  collapsedLines.clear();
  expandedLayers.clear();
  expandedExtended.clear();
  cameraOpen = false;
  for (const key of lastRenderedLines) collapsedLines.add(key);
}

let lastRenderedLines = [];

/** 供测试/调试查看当前折叠状态 */
export function treeState() {
  return {
    collapsedLines: [...collapsedLines],
    expandedLayers: [...expandedLayers],
  };
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 可点击的折叠图标（fold.svg，展开时朝下、折叠时朝右） */
function caretButton(expanded, onToggle, { hidden = false } = {}) {
  if (hidden) {
    const spacer = el('span', 'caret-spacer');
    return spacer;
  }
  const btn = document.createElement('button');
  btn.className = `caret-btn${expanded ? ' open' : ''}`;
  btn.type = 'button';
  btn.title = expanded ? '折叠' : '展开';
  btn.appendChild(icon('fold', { size: 12 }));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // 别把双击透给行的导入操作
  return btn;
}

/** 行尾的小图标按钮（新增层 / 删除层用）：点它不该触发行本身的双击导入 */
function nodeButton(iconName, title, onClick, { disabled = false } = {}) {
  const btn = document.createElement('button');
  btn.className = 'ed-node-btn';
  btn.type = 'button';
  btn.disabled = !!disabled;
  btn.title = title;
  btn.appendChild(icon(iconName, { size: 12 }));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    onClick();
  });
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // 别把双击透给行本身
  return btn;
}

/**
 * 新增一个事件层：5 条事件轨各建一条**默认事件**（从开头起、保持到结束）。
 *
 * 取值一律用 **0**（`NEW_LAYER_VALUES`），因为多层的同名事件是**相加**的：
 * 实测给已有层加一层 `speed = 1` 会让判定线速度直接翻倍（某时刻高度积分 6.897 → 13.793），
 * 而 `speed = 0` 与全 0 都完全不改变当前画面。所以「默认值」这里取「中性值」——
 * 加一层只多出 5 条可以抓的空事件，不动现有动画，作者再按需要改。
 * （注意别直接把 `LINE_EVENT_DEFAULTS` 拿来用：那是**求值兜底**用的，speed 是 1。）
 * @returns {{ok:boolean, layerIndex?:number, reason?:string}}
 */
export function addEventLayer(chart, timeline, lineId) {
  const line = chart?.lines?.[lineId];
  if (!line) return { ok: false, reason: '找不到这条判定线' };
  const layer = {};
  for (const key of EVENT_KEYS) {
    const fn = makeEasing(1, null, 0, 1);
    const value = Number.isFinite(NEW_LAYER_VALUES[key]) ? NEW_LAYER_VALUES[key] : 0;
    layer[key] = [
      {
        startBeat: NEW_LAYER_EVENT_BEAT,
        endBeat: HOLD_TO_END_BEAT, // 「保持到结束」的哨兵：两套格式都用这个约定
        start: value,
        end: value,
        easingType: fn.easingType,
        easingPreset: fn.easingPreset,
        bezierPoints: null,
        easingLeft: 0,
        easingRight: 1,
        easingFn: fn,
      },
    ];
  }
  line.layers = Array.isArray(line.layers) ? line.layers : [];
  line.layers.push(layer);
  refreshLine(chart, lineId, { keys: EVENT_KEYS }); // 重编译这条线（新层要参与求值）
  return { ok: true, layerIndex: line.layers.length - 1 };
}

/**
 * 删除一个事件层：**至少保留 1 层**。删完重编译这条线，并让时间轴把这一层的轨道移除、
 * 后面几层的轨道整体前移（层号变了）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function removeEventLayer(chart, timeline, lineId, layerIndex) {
  const line = chart?.lines?.[lineId];
  const layers = line?.layers;
  if (!Array.isArray(layers)) return { ok: false, reason: '找不到这条判定线的事件层' };
  if (layers.length <= 1) return { ok: false, reason: '至少保留 1 个事件层，删不掉' };
  if (layerIndex < 0 || layerIndex >= layers.length) return { ok: false, reason: '层号超出范围' };
  layers.splice(layerIndex, 1);
  refreshLine(chart, lineId, { keys: EVENT_KEYS });
  timeline?.dropEventLayer?.(lineId, layerIndex); // 时间轴上同步：移除该层轨道 + 后面层号前移
  return { ok: true };
}

export function renderTree(root, ctx) {
  const { chart, timeline, onStatus } = ctx;
  root.innerHTML = '';
  const wrap = el('div', 'ed-scroll');

  if (!chart) {
    wrap.appendChild(el('div', 'ed-hint', '尚未载入谱面。'));
    root.appendChild(wrap);
    return;
  }

  const axis = ctx.axis ?? createBeatAxis(chart);
  lastRenderedLines = chart.lines.map((l) => keyOfLine(l?.id ?? 0));

  const render = () => {
    wrap.innerHTML = '';
    renderTreeBody(wrap, { chart, timeline, axis, onStatus, rerender: render });
  };
  render();
  root.appendChild(wrap);
}

function renderTreeBody(wrap, ctx) {
  const { chart, timeline, axis, onStatus, rerender } = ctx;

  // 顶部工具条：展开全部 / 折叠全部（原来的提示文字已按需求删除）
  const bar = el('div', 'ed-tree-bar');
  const mkBtn = (label, iconName, title, handler) => {
    const btn = document.createElement('button');
    btn.className = 'ed-iconbtn';
    btn.type = 'button';
    btn.title = title;
    btn.appendChild(icon(iconName, { size: 14 }));
    if (label) btn.appendChild(el('span', 'lbl', label));
    btn.addEventListener('click', handler);
    bar.appendChild(btn);
    return btn;
  };
  mkBtn('展开全部', ICONS.expandAll, '展开到每条线下的事件层（不展开下属 5 个具体事件）', () => {
    expandAll();
    rerender();
    onStatus?.('结构树：已展开到事件层');
  });
  mkBtn('折叠全部', ICONS.foldAll, '折叠全部，只保留判定线', () => {
    collapseAll();
    rerender();
    onStatus?.('结构树：已全部折叠');
  });
  wrap.appendChild(bar);

  // ── 谱面相机：**谱面级**的关键帧（不属于任何判定线），用法与可变 BPM 一样 ──
  // 四个通道**始终列出**（没有事件的通道也要能双击导入，否则没法从零开始做相机动画）；
  // 双击组 = 整组导入已有通道，双击通道 = 只导入该通道（与事件层 / 扩展事件同一套交互）。
  {
    const camera = chart.camera ?? {};
    const existing = CAMERA_KEYS.filter((k) => (camera[k]?.length ?? 0) > 0);
    const total = existing.reduce((a, k) => a + camera[k].length, 0);
    const camNode = el('div', 'ed-node');
    camNode.appendChild(
      caretButton(cameraOpen, () => {
        cameraOpen = !cameraOpen;
        rerender();
      }),
    );
    const camIco = icon(CAMERA_GROUP_ICON, { size: 14 });
    camIco.style.color = CAMERA_COLORS.focal;
    camNode.appendChild(camIco);
    camNode.appendChild(el('span', 'label', CAMERA_GROUP_LABEL));
    camNode.appendChild(el('span', 'tag', total ? `${total} 事件` : '无'));
    camNode.title = existing.length
      ? `双击：整组导入（${existing.length} 条轨）`
      : '谱面相机：还没有关键帧。展开后双击任一通道即可开始做相机动画';
    camNode.addEventListener('dblclick', () => {
      const added = timeline.addTracks(makeCameraTracks(chart, axis));
      onStatus?.(added ? `已导入谱面相机（${added} 条轨）。` : '谱面相机已在时间轴中（或还没有关键帧）');
    });
    wrap.appendChild(camNode);

    if (cameraOpen) {
      for (const key of CAMERA_KEYS) {
        const count = camera[key]?.length ?? 0;
        const node = el('div', 'ed-node leaf ed-indent-1');
        node.appendChild(el('span', 'caret-spacer'));
        const ico = icon(CAMERA_ICONS[key] ?? 'configure', { size: 14 });
        ico.style.color = CAMERA_COLORS[key];
        node.appendChild(ico);
        node.appendChild(el('span', 'label', `${CAMERA_LABELS[key] ?? key}（${key}）`));
        node.appendChild(el('span', 'tag', count ? String(count) : '空'));
        node.title = '双击：导入该通道（没有事件时会新建空轨，再用「添加」工具画关键帧）';
        node.addEventListener('dblclick', () => {
          const added = timeline.addTrack(makeCameraTrack(chart, key, axis));
          onStatus?.(
            added
              ? `已添加轨道：${CAMERA_GROUP_LABEL} · ${CAMERA_SHORT[key] ?? key}`
              : '该轨道已在时间轴里',
          );
        });
        wrap.appendChild(node);
      }
    }
  }

  for (const line of chart.lines) {
    if (!line) continue;
    const lineKey = keyOfLine(line.id);
    const lineOpen = !collapsedLines.has(lineKey);

    const lineNode = el('div', 'ed-node');
    lineNode.appendChild(
      caretButton(lineOpen, () => {
        if (lineOpen) collapsedLines.add(lineKey);
        else collapsedLines.delete(lineKey);
        rerender();
      }),
    );
    lineNode.appendChild(el('span', 'label', `${line.id + 1} 号线  ${line.name || `Line ${line.id}`}`));
    lineNode.appendChild(el('span', 'tag', `${line.rt?.notes?.length ?? 0} 音符`));
    // 新增事件层：5 条事件轨各自动建一条默认事件（从开头起、保持到结束），加完直接能抓
    const addLayerBtn = nodeButton('add', '新增事件层（5 条事件轨各建一条默认事件：从开头保持到结束）', () => {
      const res = addEventLayer(chart, timeline, line.id);
      if (!res.ok) {
        onStatus?.(res.reason);
        return;
      }
      onStatus?.(`已新增事件层 ${res.layerIndex + 1}。`);
      rerender();
    });
    lineNode.appendChild(addLayerBtn);
    lineNode.title = '双击：清空时间轴后导入整条线';
    lineNode.addEventListener('dblclick', () => {
      const list = makeLineTracks(chart, line.id, axis);
      timeline.setTracks(list); // 先清空再放入
      onStatus?.(
        list.length
          ? `已载入 ${line.id + 1} 号线：${list.filter((t) => t.kind === 'notes').length} 条音符轨 + ${list.filter((t) => t.kind === 'events').length} 条事件轨（已清空原有轨道）`
          : `${line.id + 1} 号线没有可放入的内容`,
      );
    });
    wrap.appendChild(lineNode);
    if (!lineOpen) continue;

    // 音符排在事件层前面（与时间轴默认轨道顺序一致）。**没有音符也照样列出来**：
    // 结构树是「这张谱面有什么」的全景，缺行的树会让人以为编辑器读漏了。
    const notes = line.rt?.notes ?? [];
    {
      const counts = {};
      for (const n of notes) counts[n.type] = (counts[n.type] ?? 0) + 1;
      const node = el('div', 'ed-node leaf ed-indent-1');
      node.appendChild(el('span', 'caret-spacer'));
      const ico = icon(EVENT_ICONS.notes, { size: 14 });
      ico.style.color = EVENT_COLORS.notes;
      node.appendChild(ico);
      node.appendChild(el('span', 'label', '音符'));
      const tags = NOTE_KEYS.filter((k) => counts[k])
        .map((k) => `${NOTE_LABELS[k]} ${counts[k]}`)
        .join(' / ');
      node.appendChild(el('span', 'tag', tags || '无音符'));
      node.title = '双击：导入音符轨';
      node.addEventListener('dblclick', () => {
        const added = timeline.addTrack(makeNotesTrack(chart, line.id, axis));
        onStatus?.(added ? `已添加轨道：${line.id + 1}号线 音符` : '该轨道已在时间轴里');
      });
      wrap.appendChild(node);
    }

    // 事件层：**每一层都列出来**（空层也能删），行尾有 ✕ 删层（至少保留 1 层）
    const layers = line.layers ?? [];
    let shown = 0;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const present = EVENT_KEYS.filter((k) => (layer?.[k]?.length ?? 0) > 0);
      const total = present.reduce((a, k) => a + layer[k].length, 0);
      const layerKey = keyOfLayer(line.id, li);
      const layerOpen = expandedLayers.has(layerKey);
      const layerNode = el('div', 'ed-node ed-indent-1');
      layerNode.appendChild(
        caretButton(layerOpen, () => {
          if (layerOpen) expandedLayers.delete(layerKey);
          else expandedLayers.add(layerKey);
          rerender();
        }),
      );
      // 事件层图标：assets/icons/layer.svg（层里含 5 类事件，所以用中性色，不跟某一类的主题色）
      layerNode.appendChild(icon('layer', { size: 14 }));
      layerNode.appendChild(el('span', 'label', `事件层 ${li + 1}`));
      layerNode.appendChild(el('span', 'tag', `${total} 事件`));
      // 删除这一层：至少要留 1 个（只剩 1 个时按钮禁用）
      const canRemove = layers.length > 1;
      const delBtn = nodeButton(
        'delete',
        canRemove ? '删掉这一层（时间轴上这一层的轨道也会一起移除）' : '至少保留 1 个事件层',
        () => {
          const res = removeEventLayer(chart, timeline, line.id, li);
          onStatus?.(res.ok ? `已删除 ${line.id + 1} 号线事件层 ${li + 1}` : res.reason);
          if (res.ok) rerender();
        },
        { disabled: !canRemove },
      );
      layerNode.appendChild(delBtn);
      layerNode.title = present.length ? `双击：整组导入（${present.length} 条轨）` : '空事件层';
      layerNode.addEventListener('dblclick', () => {
        const added = timeline.addTracks(makeLayerTracks(chart, line.id, li, axis));
        onStatus?.(added ? `已导入事件层 ${li + 1}（${added} 条轨）。` : `事件层 ${li + 1} 已在时间轴中。`);
      });
      wrap.appendChild(layerNode);

      if (layerOpen) {
        for (const key of EVENT_KEYS) {
          const count = layer[key]?.length ?? 0;
          if (!count) continue;
          const node = el('div', 'ed-node leaf ed-indent-2');
          node.appendChild(el('span', 'caret-spacer'));
          const ico = icon(EVENT_ICONS[key] ?? 'note', { size: 14 });
          ico.style.color = EVENT_COLORS[key];
          node.appendChild(ico);
          node.appendChild(el('span', 'label', `${EVENT_LABELS[key] ?? key}（${key}）`));
          node.appendChild(el('span', 'tag', String(count)));
          node.title = '双击：只导入本条';
          node.addEventListener('dblclick', () => {
            const added = timeline.addTrack(makeEventTrack(chart, line.id, li, key, axis));
            onStatus?.(added ? `已添加轨道：${line.id + 1}号线 事件层${li + 1} · ${EVENT_LABELS[key]}` : '该轨道已在时间轴里');
          });
          wrap.appendChild(node);
        }
      }

      shown++;
      if (shown >= MAX_LAYERS && layers.length > MAX_LAYERS + 1) {
        const more = el('div', 'ed-node leaf ed-indent-1');
        more.appendChild(el('span', 'caret-spacer'));
        more.appendChild(el('span', 'label', `其余 ${layers.length - li - 1} 个事件层不再展开`));
        wrap.appendChild(more);
        break;
      }
    }

    // ── 扩展（故事板）事件：**不分事件层**，一条线只有一组 ──
    // 双击组 = 整组导入并绑定（与该层的 5 条事件轨同样待遇）；双击子项 = 只导入该键。
    {
      const ext = line.extended ?? {};
      const present = EXTENDED_KEYS.filter((k) => (ext[k]?.length ?? 0) > 0);
      const total = present.reduce((a, k) => a + ext[k].length, 0);
      const rawKeys = Object.keys(line.extendedRaw ?? {});
      const unsupported = rawKeys.filter((f) => !EXTENDED_KEYS.some((k) => EXTENDED_RPE_FIELD[k] === f));
      const extKey = keyOfExtended(line.id);
      const extOpen = expandedExtended.has(extKey);

      const extNode = el('div', 'ed-node ed-indent-1');
      extNode.appendChild(
        caretButton(extOpen, () => {
          if (extOpen) expandedExtended.delete(extKey);
          else expandedExtended.add(extKey);
          rerender();
        }),
      );
      const groupIco = icon('scale', { size: 14 });
      groupIco.style.color = EVENT_COLORS.scaleX;
      extNode.appendChild(groupIco);
      extNode.appendChild(el('span', 'label', '扩展事件'));
      extNode.appendChild(el('span', 'tag', total ? `${total} 事件` : '无'));
      if (unsupported.length) extNode.appendChild(el('span', 'tag', `${unsupported.length} 个未支持`));
      extNode.title = present.length ? `双击：整组导入（${present.length} 条轨）` : '这一组还没有事件';
      extNode.addEventListener('dblclick', () => {
        const added = timeline.addTracks(makeExtendedTracks(chart, line.id, axis));
        onStatus?.(added ? `已导入 ${line.id + 1} 号线扩展事件（${added} 条轨）。` : `${line.id + 1} 号线扩展事件已在时间轴中。`);
      });
      wrap.appendChild(extNode);

      if (extOpen) {
        for (const key of present) {
          const node = el('div', 'ed-node leaf ed-indent-2');
          node.appendChild(el('span', 'caret-spacer'));
          const ico = icon(EVENT_TRACK_ICONS[key] ?? 'note', { size: 14 });
          ico.style.color = EVENT_COLORS[key];
          node.appendChild(ico);
          node.appendChild(el('span', 'label', `${EVENT_LABELS[key] ?? key}（${key}）`));
          node.appendChild(el('span', 'tag', String(ext[key].length)));
          node.title = '双击：只导入本条';
          node.addEventListener('dblclick', () => {
            const added = timeline.addTrack(makeExtendedTrack(chart, line.id, key, axis));
            onStatus?.(added ? `已添加轨道：${line.id + 1}号线 扩展事件 · ${EVENT_SHORT[key] ?? key}` : '该轨道已在时间轴里');
          });
          wrap.appendChild(node);
        }
        for (const field of unsupported) {
          const node = el('div', 'ed-node leaf ed-indent-2');
          node.appendChild(el('span', 'caret-spacer'));
          const ico = icon('warn', { size: 14 });
          ico.style.color = '#8a8a8a';
          node.appendChild(ico);
          node.appendChild(el('span', 'label', `${field}（本版本未实现）`));
          node.appendChild(el('span', 'tag', String(line.extendedRaw[field]?.length ?? 0)));
          node.title = '解析时原样保留、导出时写回，但暂不渲染';
          wrap.appendChild(node);
        }
      }
    }

  }
}
