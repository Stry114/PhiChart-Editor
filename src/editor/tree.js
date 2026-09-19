/**
 * 左下角「结构树」标签页：判定线 → 事件层 → 各事件 / 音符。
 *
 * 交互：
 *  - 点每行行首的折叠图标 → 折叠 / 展开该行
 *  - 双击「事件层」= 把该层的 5 条事件轨**整组导入并绑定**到时间轴
 *  - 双击单个事件/音符叶子 = 只导入那一条轨
 *  - 顶部两个按钮：展开全部（展开到事件层，不展开下属 5 个具体事件）、折叠全部
 */
import {
  EVENT_KEYS,
  EVENT_LABELS,
  EVENT_COLORS,
  makeEventTrack,
  makeNotesTrack,
  makeLayerTracks,
  makeLineTracks,
  createBeatAxis,
} from './tracks.js';
import { icon, EVENT_ICONS, ICONS } from '../ui/icons.js';

const NOTE_KEYS = ['tap', 'drag', 'hold', 'flick'];
const NOTE_LABELS = { tap: 'Tap', drag: 'Drag', hold: 'Hold', flick: 'Flick' };
const MAX_LAYERS = 8; // 事件层太多的线只展开前若干个，避免一次塞几百行

// 折叠状态（跨标签页切换保留）：线的折叠集合、事件层的展开集合
const collapsedLines = new Set();
const expandedLayers = new Set();

const keyOfLine = (lineId) => `L:${lineId}`;
const keyOfLayer = (lineId, li) => `E:${lineId}:${li}`;

/** 展开全部：展开到事件层，但不展开下属 5 个具体事件 */
export function expandAll() {
  collapsedLines.clear();
  expandedLayers.clear();
}

/** 折叠全部：只留判定线一行 */
export function collapseAll() {
  collapsedLines.clear();
  expandedLayers.clear();
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

export function renderTree(root, ctx) {
  const { chart, timeline, onStatus } = ctx;
  root.innerHTML = '';
  const wrap = el('div', 'ed-scroll');

  if (!chart) {
    wrap.appendChild(el('div', 'ed-hint', '还没有载入谱面。用上方「预览」面板的载入按钮或内置示例包。'));
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
    const dot = el('span', 'dot');
    dot.style.background = '#e6e6e6';
    lineNode.appendChild(dot);
    lineNode.appendChild(el('span', 'label', `${line.id + 1} 号线  ${line.name || `Line ${line.id}`}`));
    lineNode.appendChild(el('span', 'tag', `${line.rt?.notes?.length ?? 0} 音符`));
    lineNode.title = '双击：清空时间轴，把这条线的音符与所有事件层一起放进去';
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

    // 音符排在事件层前面（与时间轴默认轨道顺序一致）
    const notes = line.rt?.notes ?? [];
    if (notes.length) {
      const counts = {};
      for (const n of notes) counts[n.type] = (counts[n.type] ?? 0) + 1;
      const node = el('div', 'ed-node leaf ed-indent-1');
      node.appendChild(el('span', 'caret-spacer'));
      const ico = icon(EVENT_ICONS.notes, { size: 14 });
      ico.style.color = EVENT_COLORS.notes;
      node.appendChild(ico);
      node.appendChild(el('span', 'label', '音符'));
      node.appendChild(
        el('span', 'tag', NOTE_KEYS.filter((k) => counts[k]).map((k) => `${NOTE_LABELS[k]} ${counts[k]}`).join(' / ')),
      );
      node.title = '双击把该线音符加到时间轴';
      node.addEventListener('dblclick', () => {
        const added = timeline.addTrack(makeNotesTrack(chart, line.id, axis));
        onStatus?.(added ? `已添加轨道：${line.id + 1}号线 音符` : '该轨道已在时间轴里');
      });
      wrap.appendChild(node);
    }

    // 事件层
    const layers = line.layers ?? [];
    let shown = 0;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const present = EVENT_KEYS.filter((k) => (layer[k]?.length ?? 0) > 0);
      if (!present.length) continue;
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
      layerNode.appendChild(el('span', 'label', `事件层 ${li + 1}`));
      layerNode.appendChild(el('span', 'tag', `${present.reduce((a, k) => a + layer[k].length, 0)} 事件`));
      layerNode.title = `双击整组导入 ${present.length} 条事件轨（导入后绑定）`;
      layerNode.addEventListener('dblclick', () => {
        const added = timeline.addTracks(makeLayerTracks(chart, line.id, li, axis));
        onStatus?.(
          added
            ? `已整组导入事件层 ${li + 1}：${added} 条事件轨（已绑定）`
            : `该事件层已在时间轴里（${present.length} 条事件轨）`,
        );
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
          node.title = '双击只导入这一条轨';
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

  }
}
