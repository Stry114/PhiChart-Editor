/**
 * 音符序列化往返测试（`node tools/note-serialize-tests.mjs`）：
 * 复现并守护「编辑器内新建/修改的音符，保存（含草稿自动备份）后 type / startBeat 丢失」的 bug。
 */
import { parseProject, serializeProject, createBlankProject } from '../src/core/project.js';
import { prepareChart } from '../src/core/model.js';
import { makeNote, insertNote, sourceTemplate } from '../src/editor/insert.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 基础项目：一条线，既有解析器形状的源音符（字符串 type），也有后续编辑器新建的
const base = () => {
  const chart = parseProject(createBlankProject({ lines: 1 }), {});
  return chart;
};

{
  console.log('编辑器新建音符的保存往返');
  const chart = base();
  prepareChart(chart, {});
  const line = chart.lines[0];
  const template = sourceTemplate(line);
  // 模拟「添加」工具 / AI 的 add_notes：拖 (8 拍, x=-0.5) 的 Drag
  const note = makeNote({
    type: 'drag',
    startBeat: 8,
    endBeat: 8,
    positionX: -0.5,
    above: true,
    line,
    lineId: 0,
    timeline: line.rt.timeline,
    template,
  });
  insertNote(chart, line, note);
  prepareChart(chart, {}); // 与编辑器一致：插入后全量重编译一次

  const src = line.notes.find((n) => n !== note.src);
  const srcNew = line.notes.find((n) => n === note.src);
  check('源音符 type 是内部字符串', srcNew.type === 'drag', JSON.stringify(srcNew.type));
  check('源音符带 startBeat/endBeat', srcNew.startBeat === 8 && srcNew.endBeat === 8);

  const { json } = serializeProject(chart, {});
  const saved = json.chart.lines[0].notes;
  const savedNew = saved[saved.length - 1];
  check('保存后 type 还是 drag', savedNew?.type === 'drag', JSON.stringify(savedNew));
  check('保存后 startBeat 还是 8', savedNew?.startBeat === 8, JSON.stringify(savedNew?.startBeat));

  // 重载（草稿恢复 / 打开项目）后音符还在、类型正确
  const reloaded = parseProject(JSON.parse(JSON.stringify(json)), {});
  prepareChart(reloaded, {});
  const rtNote = reloaded.lines[0].rt.notes.find((n) => n.positionX === -0.5);
  check('重载后音符存在且是 drag', rtNote?.type === 'drag', JSON.stringify(rtNote?.type));
}

{
  console.log('AI 改类型后的保存往返');
  const chart = base();
  prepareChart(chart, {});
  const line = chart.lines[0];
  const template = sourceTemplate(line);
  const note = makeNote({
    type: 'tap',
    startBeat: 4,
    endBeat: 4,
    positionX: 0.3,
    above: true,
    line,
    lineId: 0,
    timeline: line.rt.timeline,
    template,
  });
  insertNote(chart, line, note);
  // 模拟 ai-apply 的 note.update（改 type 为 flick）：改派生对象，同时写回源
  const hit = line.rt.notes.find((n) => n.positionX === 0.3);
  hit.type = 'flick';
  hit.src.type = 'flick';
  hit.src.startBeat = hit.startBeat;
  hit.src.endBeat = hit.endBeat;

  const { json } = serializeProject(chart, {});
  const saved = json.chart.lines[0].notes.find((n) => n.positionX === 0.3);
  check('改类型后保存还是 flick', saved?.type === 'flick', JSON.stringify(saved));
}

{
  console.log('历史脏数据（数字 type 码）的防御');
  const chart = base();
  prepareChart(chart, {});
  const line = chart.lines[0];
  // 旧版 makeNote 产出的形状：数字 type、无 startBeat（已在旧草稿里损坏的，startBeat 无从恢复）
  line.notes.push({
    type: 2,
    time: 8 * 32,
    positionX: -0.5,
    holdTime: 0,
    speed: 1,
    floorPosition: 0,
    startBeat: 8,
    endBeat: 8,
  });
  prepareChart(chart, {});
  const { json } = serializeProject(chart, {});
  const saved = json.chart.lines[0].notes.find((n) => n.startBeat === 8);
  check('数字 type 码映射回 drag', saved?.type === 'drag', JSON.stringify(saved));
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
