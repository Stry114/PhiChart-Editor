/**
 * 新建 / 测试项目生成器。
 *
 * 目前内部项目格式（自有格式）还没实现（见 README「分发与路线图」阶段 1），
 * 因此这里生成的是**官方格式（formatVersion 3）的谱面 JSON**：
 * 它既能被现有解析器 100% 读入，也能作为「新建项目」的第一版产物继续编辑。
 * 等自有项目格式落地后，把输出换成项目格式即可（其余调用方不变）。
 */

const T = 32; // 官方：1 拍 = 32 个时间单位

/** 目标导出格式的默认谱面骨架：judgeLineList 里每线自带 bpm 与四类事件 */
function emptyLine(index, { bpm, beatCount, x, y }) {
  const v = 0.5 + x; // 官方 v3：0..1，左下角原点；0.5 = 画面中心
  const vy = 0.5 + y;
  return {
    name: `Line ${index}`,
    bpm,
    notesAbove: [],
    notesBelow: [],
    speedEvents: [{ startTime: 0, endTime: beatCount * T, value: 1 }],
    judgeLineMoveEvents: [{ startTime: -999999, endTime: beatCount * T, start: v, end: v, start2: vy, end2: vy }],
    judgeLineRotateEvents: [{ startTime: -999999, endTime: beatCount * T, start: 0, end: 0 }],
    judgeLineDisappearEvents: [{ startTime: -999999, endTime: beatCount * T, start: 1, end: 1 }],
  };
}

/**
 * 生成一个项目骨架。
 * @param {{name?:string, bpm?:number, seconds?:number, lines?:number, withDemoNotes?:boolean}} opts
 * @returns {{formatVersion:number, offset:number, judgeLineList:object[]}} 官方格式谱面 JSON
 */
export function makeProject(opts = {}) {
  const name = opts.name ?? '未命名项目';
  const bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 174;
  const seconds = Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : 60;
  const lineCount = Math.max(1, Math.min(24, Math.round(opts.lines ?? 4)));
  const beatCount = Math.max(1, Math.round((seconds * bpm) / 60));

  const chart = {
    formatVersion: 3,
    offset: 0,
    judgeLineList: [],
    // 生成器信息（官方引擎会忽略未知字段；保留便于以后转成自有项目格式）
    _generatedBy: 'PhiChart Editor 新建项目',
    _name: name,
  };

  for (let i = 0; i < lineCount; i++) {
    const spread = lineCount === 1 ? 0 : (i / (lineCount - 1) - 0.5) * 0.6; // 横向铺开
    chart.judgeLineList.push(emptyLine(i, { bpm, beatCount, x: spread, y: 0 }));
  }

  if (opts.withDemoNotes) addDemoContent(chart, { bpm, beatCount });
  return chart;
}

/** 往骨架里塞一点内容，方便测试时间轴/结构树/预览（不追求像真实谱面） */
function addDemoContent(chart, { bpm, beatCount }) {
  const lines = chart.judgeLineList;
  const perLine = Math.min(24, Math.max(4, Math.round(beatCount / 8)));
  const types = [1, 2, 3, 4]; // Tap / Drag / Hold / Flick

  lines.forEach((line, li) => {
    for (let k = 0; k < perLine; k++) {
      const beat = 4 + k * Math.max(1, Math.floor(beatCount / perLine));
      const type = types[(k + li) % types.length];
      const pos = ((k % 6) - 2.5) * 1.4;
      line.notesAbove.push({
        type,
        time: beat * T,
        positionX: pos,
        holdTime: type === 3 ? 32 : 0, // Hold：1 拍
        speed: 1,
        floorPosition: 0, // 由渲染器按速度积分重算（官方文件里是缓存值）
      });
      // 每隔几个音符加一个测试事件
      if (k % 4 === 0) {
        const t0 = beat * T;
        const t1 = (beat + 4) * T;
        line.judgeLineMoveEvents.push({
          startTime: t0,
          endTime: t1,
          start: 0.5 + ((k % 4) - 1.5) * 0.1,
          end: 0.5 - ((k % 4) - 1.5) * 0.1,
          start2: 0.5,
          end2: 0.5,
          easingType: 1,
        });
        line.judgeLineRotateEvents.push({ startTime: t0, endTime: t1, start: li % 2 ? 20 : -20, end: 0 });
      }
      if (k % 8 === 0) {
        line.judgeLineDisappearEvents.push({ startTime: beat * T, endTime: (beat + 2) * T, start: 0.35, end: 1 });
      }
    }
    line.speedEvents = [
      { startTime: 0, endTime: 4 * T, value: 1 },
      { startTime: 4 * T, endTime: beatCount * T, value: 2.2 },
    ];
  });
  void bpm;
}

/** 便于开始页展示：项目里大致有多少内容 */
export function projectStats(chart) {
  const notes = chart.judgeLineList.reduce((a, l) => a + l.notesAbove.length + l.notesBelow.length, 0);
  const events = chart.judgeLineList.reduce(
    (a, l) => a + l.speedEvents.length + l.judgeLineMoveEvents.length + l.judgeLineRotateEvents.length + l.judgeLineDisappearEvents.length,
    0,
  );
  return { lines: chart.judgeLineList.length, notes, events };
}
