/**
 * 左下角「结构树」标签页：最上面是**谱面相机**，然后是「判定线 → 音符 / 事件层 / 扩展事件 → 各事件」。
 *
 * 交互：
 *  - 点每行行首的折叠图标 → 折叠 / 展开该行
 *  - **单击**任意行 / 叶子 = 导入（部分浏览器里双击不灵，所以统一改成单击）：
 *    判定线行 = 清空时间轴后导入整条线；音符行 = 只导入音符轨；事件层行 = 整组导入该层的 5 条事件轨；
 *    扩展事件组 / 相机组 = 整组导入；单个叶子 = 只导入那一条轨
 *  - 事件层 / 扩展事件 / 相机组内**所有轨道都会列出来**（没有事件的那几条显示「空」），
 *    于是缺的轨道也能单击建出空轨，再用「添加」工具画事件
 *  - 叶子行尾的 ✕ = 删掉这条轨（清空该键的事件，可撤销）；事件层行尾的 ✕ = 删掉整个事件层
 *  - 顶部两个按钮：展开全部（展开到事件层与相机通道）、折叠全部（只留判定线与相机组行）
 *
 * 扩展事件**不分事件层**（RPE 里每条线只有一份 `extended`）：本版本渲染/编辑
 * scaleX / scaleY / color / z / theta；incline / text / paint / gif 解析后原样保留、导出写回，界面里标为未实现。
 * 谱面相机（x / y / z / 视角 angle）是本项目的自有扩展：RPE 写在根节点的 `camera` 里，
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
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // 兜底：双击也不该触发行的导入（现在导入是单击）
  return btn;
}

/** 行尾的小图标按钮（新增 / 删除层、删掉一条轨）：点它不该触发行本身的导入 */
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
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // 别把双击透给行本身（导入是单击）
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

  /**
   * 一条事件轨的叶子行（事件层 / 扩展事件 / 谱面相机共用）：
   *  - **单击** = 把这条轨放进时间轴（没有事件时就是一条空轨，用「添加」工具直接画第一条事件）；
   *  - 行尾 ✕ = 删掉整条轨（清空该键的事件，可撤销）；没有事件时禁用。
   * `makeTrack(key)` 用对应构造器建轨（同一个对象既能进时间轴，也能定位到数据数组）。
   */
  function appendTrackLeaf(parent, { indent, key, label, iconName, color, count, makeTrack }) {
    const node = el('div', `ed-node leaf ed-indent-${indent}`);
    node.appendChild(el('span', 'caret-spacer'));
    const ico = icon(iconName, { size: 14 });
    ico.style.color = color;
    node.appendChild(ico);
    node.appendChild(el('span', 'label', label));
    node.appendChild(el('span', 'tag', count ? String(count) : '空'));
    node.title = count
      ? `单击：导入这条轨（${count} 个事件）`
      : '单击：新建这条空轨，再用「添加」工具在本行上画事件';
    node.addEventListener('click', () => {
      const added = timeline.addTrack(makeTrack(key));
      // addTrack 会把视角滚到新轨道并让它闪一下（见 timeline.js 的 flashNewTracks）
      onStatus?.(added ? `已添加轨道：${label}（已滚动并高亮）` : '该轨道已在时间轴里');
    });
    node.appendChild(
      nodeButton(
        'delete',
        count ? `删掉这条轨（清空该键的 ${count} 个事件，可撤销）` : '这条轨还没有事件',
        () => {
          const track = makeTrack(key);
          const res = timeline.clearTrackData?.(track);
          if (!res?.ok) {
            onStatus?.(res?.reason ?? '删不掉这条轨');
            return;
          }
          timeline.removeTrack?.(track.id); // 时间轴上那条也一起移除
          onStatus?.(`已删除轨道 ${label}（清空 ${res.removed} 个事件，可撤销）`);
          rerender();
        },
        { disabled: !count },
      ),
    );
    parent.appendChild(node);
    return node;
  }

  // ── 谱面相机：**谱面级**的关键帧（不属于任何判定线），用法与可变 BPM 一样 ──
  // 四个通道**始终列出**（没有事件的通道也能单击建空轨，否则没法从零开始做相机动画）；
  // 单击组 = 整组导入（组里一条都没有时，把四个通道都建出来）。
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
    camIco.style.color = CAMERA_COLORS.angle;
    camNode.appendChild(camIco);
    camNode.appendChild(el('span', 'label', CAMERA_GROUP_LABEL));
    camNode.appendChild(el('span', 'tag', total ? `${total} 事件` : '无'));
    camNode.title = existing.length
      ? `单击：整组导入（${existing.length} 条轨）`
      : '谱面相机：还没有关键帧。单击这里或展开后单击任一通道，即可开始做相机动画';
    camNode.addEventListener('click', () => {
      const tracks = makeCameraTracks(chart, axis);
      const list = tracks.length ? tracks : CAMERA_KEYS.map((k) => makeCameraTrack(chart, k, axis));
      const added = timeline.addTracks(list);
      onStatus?.(added ? `已导入谱面相机（${added} 条轨，已滚动并高亮）。` : '谱面相机已在时间轴中。');
    });
    wrap.appendChild(camNode);

    if (cameraOpen) {
      for (const key of CAMERA_KEYS) {
        appendTrackLeaf(wrap, {
          indent: 1,
          key,
          label: `${CAMERA_LABELS[key] ?? key}（${key}）`,
          iconName: CAMERA_ICONS[key] ?? 'configure',
          color: CAMERA_COLORS[key],
          count: camera[key]?.length ?? 0,
          makeTrack: (k) => makeCameraTrack(chart, k, axis),
        });
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
    lineNode.title = '单击：清空时间轴后导入整条线';
    lineNode.addEventListener('click', () => {
      const list = makeLineTracks(chart, line.id, axis);
      // 时间轴里已经是这一条线的内容时不再重复载入（单击很容易误触，重复载入会丢掉选中与滚动位置）
      const same = list.length === (timeline.tracks?.length ?? 0) && list.every((t, i) => timeline.tracks[i]?.id === t.id);
      if (same) {
        onStatus?.(`${line.id + 1} 号线已在时间轴中。`);
        return;
      }
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
      node.title = '单击：导入音符轨';
      node.addEventListener('click', () => {
        const added = timeline.addTrack(makeNotesTrack(chart, line.id, axis));
        onStatus?.(added ? `已添加轨道：${line.id + 1}号线 音符（已滚动并高亮）` : '该轨道已在时间轴里');
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
      layerNode.title = present.length ? `单击：整组导入（${present.length} 条轨）` : '空事件层：单击把 5 条事件轨都建出来（都是空轨）';
      layerNode.addEventListener('click', () => {
        const tracks = makeLayerTracks(chart, line.id, li, axis);
        // 空事件层：整组导入 = 把 5 类事件轨都建出来，再用「添加」工具在各自的行上画事件
        const list = tracks.length ? tracks : EVENT_KEYS.map((k) => makeEventTrack(chart, line.id, li, k, axis));
        const added = timeline.addTracks(list);
        onStatus?.(added ? `已导入事件层 ${li + 1}（${added} 条轨，已滚动并高亮）。` : `事件层 ${li + 1} 已在时间轴中。`);
      });
      wrap.appendChild(layerNode);

      if (layerOpen) {
        // 5 类事件轨**全部列出**（没有事件的那几条显示「空」）：缺的轨道也能直接建出来
        for (const key of EVENT_KEYS) {
          appendTrackLeaf(wrap, {
            indent: 2,
            key,
            label: `${EVENT_LABELS[key] ?? key}（${key}）`,
            iconName: EVENT_ICONS[key] ?? 'note',
            color: EVENT_COLORS[key],
            count: layer?.[key]?.length ?? 0,
            makeTrack: (k) => makeEventTrack(chart, line.id, li, k, axis),
          });
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
    // 单击组 = 整组导入并绑定（与该层的 5 条事件轨同样待遇）；单击子项 = 只导入该键。
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
      extNode.title = present.length ? `单击：整组导入（${present.length} 条轨）` : '这一组还没有事件：单击把已实现的扩展键都建出来（都是空轨）';
      extNode.addEventListener('click', () => {
        const tracks = makeExtendedTracks(chart, line.id, axis);
        // 一条都没有时：把已实现的扩展键都建出来，再用「添加」工具在各自的行上画事件
        const list = tracks.length ? tracks : EXTENDED_KEYS.map((k) => makeExtendedTrack(chart, line.id, k, axis));
        const added = timeline.addTracks(list);
        onStatus?.(added ? `已导入 ${line.id + 1} 号线扩展事件（${added} 条轨，已滚动并高亮）。` : `${line.id + 1} 号线扩展事件已在时间轴中。`);
      });
      wrap.appendChild(extNode);

      if (extOpen) {
        // 已实现的扩展键**全部列出**（没有事件的那几个显示「空」）：缺的轨道也能直接建出来
        for (const key of EXTENDED_KEYS) {
          appendTrackLeaf(wrap, {
            indent: 2,
            key,
            label: `${EVENT_LABELS[key] ?? key}（${key}）`,
            iconName: EVENT_TRACK_ICONS[key] ?? 'note',
            color: EVENT_COLORS[key],
            count: ext[key]?.length ?? 0,
            makeTrack: (k) => makeExtendedTrack(chart, line.id, k, axis),
          });
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
