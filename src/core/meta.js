/**
 * 包内元数据的**权威顺序**（项目决定，第三方包存储方式不统一时按此仲裁）：
 *
 *   1. 包内文本文档：`info.txt`（键值对）优先，其次是 `info.csv`（表格）
 *   2. 谱面 JSON 自带的元数据：RPE 的 `META`（official 格式没有元数据字段）
 *   3. 包目录名 —— 作为**曲名**的兜底
 *
 * 按字段逐个仲裁（info.txt 里缺某字段时，才向下一级要），并记录每个字段的来源，
 * 便于界面上直接显示「曲名：xxx（来源：info.txt）」。
 *
 * **导出时统一**：`metaToInfoTxt()` 把解析后的元数据写回成一份标准 `info.txt`，
 * 因此无论来源多混乱，导出结果只有一种形态（见 README 路线图：导出与自有项目格式）。
 */

export const META_FIELDS = ['name', 'song', 'background', 'composer', 'charter', 'illustrator', 'level', 'id'];

/**
 * **谱面延迟（offset）也来自包内元数据**：official 的 `info.csv` / `info.txt` 里有 `Offset` 列
 * （游戏读的就是包内文本，所以它比谱面 JSON 里的 `offset` 更权威 —— 与其它字段同一套顺序）。
 * 单位与 official 一致：**秒**（RPE 的毫秒在解析时已换算成秒）。
 */
const OFFSET_ALIASES = ['Offset', 'offset'];

/** 从一份元数据对象里读 offset（秒）；读不到返回 null */
export function readMetaOffset(source) {
  if (!source || typeof source !== 'object') return null;
  const lower = new Map();
  for (const [k, v] of Object.entries(source)) lower.set(k.toLowerCase(), v);
  for (const alias of OFFSET_ALIASES) {
    const v = lower.get(alias.toLowerCase());
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export const META_FIELD_LABELS = {
  name: '曲名',
  song: '音频文件',
  background: '曲绘文件',
  composer: '曲师',
  charter: '谱师',
  illustrator: '曲绘师',
  level: '难度',
  id: 'ID / Path',
};

/** info.txt / info.csv 的键名 → 规范字段名（含常见别名） */
const KEY_ALIASES = {
  name: ['Name', 'name', 'SongName', 'Title'],
  song: ['Song', 'song', 'Audio', 'Music'],
  background: ['Picture', 'Background', 'background', 'Image', 'Illustration'],
  composer: ['Composer', 'Musician', 'composer'],
  charter: ['Charter', 'Designer', 'charter', 'Mapper'],
  illustrator: ['Illustrator', 'Artist', 'illustrator'],
  level: ['Level', 'Difficulty', 'level'],
  id: ['Path', 'Id', 'ID', 'id'],
};

/** 归一化任意来源的元数据对象：把别名键折叠到规范字段名上 */
export function normalizeMeta(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  const lower = new Map();
  for (const [k, v] of Object.entries(source)) lower.set(k.toLowerCase(), v);
  for (const field of META_FIELDS) {
    for (const alias of KEY_ALIASES[field] ?? [field]) {
      const v = lower.get(alias.toLowerCase());
      if (typeof v === 'string' && v.trim()) {
        out[field] = v.trim();
        break;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[field] = String(v);
        break;
      }
    }
  }
  return out;
}

/**
 * 按权威顺序仲裁元数据。
 * @param {{infoTxt?:object, infoCsv?:object, chartMeta?:object, packageName?:string}} input
 * @returns {{meta:object, sources:Record<string,string>}}
 */
export function resolveMeta({ infoTxt, infoCsv, chartMeta, packageName } = {}) {
  const layers = [
    { key: 'info.txt', data: normalizeMeta(infoTxt) },
    { key: 'info.csv', data: normalizeMeta(infoCsv) },
    { key: '谱面 JSON', data: normalizeMeta(chartMeta) },
  ];
  const meta = {};
  const sources = {};
  for (const field of META_FIELDS) {
    for (const layer of layers) {
      if (layer.data[field]) {
        meta[field] = layer.data[field];
        sources[field] = layer.key;
        break;
      }
    }
  }
  // 谱面延迟（offset，秒）：**包内文本优先**（official 的 Offset 列就是给游戏读的），
  // 文本里没有时保留解析器从谱面 JSON 里读到的值（RPE 的 META.offset 已经换算成秒）。
  const offsetFromTxt = readMetaOffset(infoTxt);
  const offsetFromCsv = offsetFromTxt === null ? readMetaOffset(infoCsv) : null;
  if (offsetFromTxt !== null || offsetFromCsv !== null) {
    meta.offset = offsetFromTxt !== null ? offsetFromTxt : offsetFromCsv;
    sources.offset = offsetFromTxt !== null ? 'info.txt' : 'info.csv';
  }
  // 包目录名兜底曲名（来源标成「包名」，便于界面区分）
  if (!meta.name && packageName) {
    meta.name = String(packageName);
    sources.name = '包名';
  }
  for (const field of META_FIELDS) if (!meta[field]) meta[field] = '';
  return { meta, sources };
}

/** 权威顺序的简短说明（界面/文档共用） */
export const META_PRIORITY_HINT = 'info.txt > info.csv > 谱面 JSON 元数据 > 包名（曲名兜底）';

/**
 * 导出时统一：把元数据写成标准 info.txt（键名与官方包一致，UTF-8）。
 * @param {object} meta 已仲裁的元数据
 * @returns {string}
 */
export function metaToInfoTxt(meta) {
  const m = normalizeMeta(meta);
  const offset = Number.isFinite(Number(meta?.offset)) ? Number(meta.offset) : 0;
  const lines = [
    '#',
    `Name: ${m.name ?? ''}`,
    `Path: ${m.id ?? ''}`,
    `Song: ${m.song ?? ''}`,
    `Picture: ${m.background ?? ''}`,
    `Level: ${m.level ?? ''}`,
    `Composer: ${m.composer ?? ''}`,
    `Charter: ${m.charter ?? ''}`,
    `Illustrator: ${m.illustrator ?? ''}`,
    `Offset: ${Math.round(offset * 1000) / 1000}`, // 秒（与 official 一致；写出来才能在包里往返保留）
    '',
  ];
  return lines.join('\n');
}

/** 把仲裁结果塞进谱面模型（解析器与播放器/编辑器共用同一条路径） */
export function applyMetaToChart(chart, resolved) {
  if (!chart || !resolved?.meta) return chart;
  chart.meta = { ...chart.meta, ...resolved.meta };
  chart.metaSources = resolved.sources;
  return chart;
}
