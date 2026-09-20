/**
 * 导出包组装：把「序列化结果 + 元数据 + 音频/曲绘」打包成可下载的文件。
 *
 * 三种导出（对应编辑器左上「导出」页的三个按钮）：
 *  1. `official` —— 官谱 zip：`<曲名>.json` + `info.txt` + 音频 + 曲绘（游戏/模拟器可直接读的包结构）
 *  2. `rpe`      —— RPE 谱 zip：同上，但谱面 JSON 是 RPE 格式（META 里带音频/曲绘文件名）
 *  3. `project`  —— 内部项目 zip（`.pce.zip`）：`project.json` + `info.txt` + **全部资源文件**
 *                  （项目是「下次接着改」的那份，只存 json 会丢音频/曲绘/自定义贴图）
 *
 * 这里只做「纯数据 + zip 字节」，不碰 DOM：下载动作在 `src/editor/export-tab.js`。
 * 媒体文件的文件名会写回导出用的元数据（RPE 的 META.song / info.txt 的 Song），
 * 因此包内引用与工程文件里的引用始终一致（见 `格式说明.md` §3 的引用解析规则）。
 */
import { metaToInfoTxt } from './meta.js';
import { serializeOfficial } from './serialize-official.js';
import { serializeRpe } from './serialize-rpe.js';
import { serializeProject } from './project.js';
import { createZip, safeEntryName, safeEntryPath } from './zip.js';
import { safeFileName } from './serialize-common.js';

export const EXPORT_KINDS = {
  official: { id: 'official', label: '官谱（zip 包）', ext: 'json', zip: true, suffix: ' [official]' },
  rpe: { id: 'rpe', label: 'RPE 谱（zip 包）', ext: 'json', zip: true, suffix: ' [RPE]' },
  project: { id: 'project', label: '项目（内部格式）', ext: 'pce.json', zip: false, suffix: '' },
};

/** 曲名兜底成文件名（去掉路径分隔符与 Windows 非法字符；顺带去掉误当成曲名的 `.json`） */
export function baseNameOf(chart) {
  return safeFileName(stripChartExt(chart?.meta?.name || 'chart'), 'chart');
}

/** 曲名里可能带着原谱面文件名（.json / .pce.json），导出文件名不要叠两层后缀 */
export function stripChartExt(name) {
  return String(name ?? '')
    .replace(/\.(json|pce)$/i, '')
    .trim();
}

/**
 * 组装导出用的元数据：把音频/曲绘的文件名换成**将要写进包里的名字**。
 * @param {object} chart
 * @param {{song?:{name?:string}, background?:{name?:string}}} media
 * @param {string[]} warnings 追加告警
 */
export function exportMetaFor(chart, media = {}, warnings = []) {
  const meta = { ...(chart?.meta ?? {}) };
  if (media.song?.blob) {
    meta.song = safeEntryName(media.song.name || meta.song || 'song');
  } else if (meta.song) {
    warnings.push(`没有读到音频内容（${meta.song}）：导出的包里不会有音频文件，谱面里的引用保持原样，请把音频放进包里`);
    meta.song = safeEntryName(meta.song);
  } else {
    warnings.push('谱面没有音频文件名，也没有提供音频文件；导出的包里不含音频');
  }
  if (media.background?.blob) {
    meta.background = safeEntryName(media.background.name || meta.background || 'background.png');
  } else if (meta.background) {
    warnings.push(`没有读到曲绘内容（${meta.background}）：导出的包里不会有曲绘文件，谱面里的引用保持原样，请把曲绘放进包里`);
    meta.background = safeEntryName(meta.background);
  } else {
    warnings.push('谱面没有曲绘文件名，也没有提供曲绘文件；导出的包里不含曲绘');
  }
  return meta;
}

/**
 * 导出官谱 / RPE 谱的 zip 包。
 * @param {object} chart 谱面模型
 * @param {'official'|'rpe'} kind
 * @param {{media?:{song?:{name:string,blob:Blob},background?:{name:string,blob:Blob}}, compress?:boolean, curveSegments?:number}} [opts]
 * @returns {Promise<{kind:string,fileName:string,blob:Blob,entries:string[],warnings:string[],stats:object,json:object}>}
 */
export async function buildChartZip(chart, kind, opts = {}) {
  if (kind !== 'official' && kind !== 'rpe') throw new Error(`不支持的导出格式：${String(kind)}`);
  if (!chart) throw new Error('还没有载入谱面，无法导出');
  const warnings = [];
  const meta = opts.meta ?? exportMetaFor(chart, opts.media, warnings);
  const serialized =
    kind === 'official'
      ? serializeOfficial(chart, { meta, curveSegments: opts.curveSegments })
      : serializeRpe(chart, { meta, rpeVersion: opts.rpeVersion, xybind: opts.xybind });
  warnings.push(...serialized.warnings);

  // 文件名里的“曲名”用导出元数据（可能已被媒体文件名改写）
  const base = safeFileName(stripChartExt(meta.name) || baseNameOf(chart), 'chart');
  const chartFile = `${base}.json`;
  const media = opts.media ?? {};
  const entries = [
    { name: chartFile, data: JSON.stringify(serialized.json) },
    { name: 'info.txt', data: metaToInfoTxt(meta) },
  ];
  if (media.song?.blob) entries.push({ name: safeEntryName(media.song.name || meta.song || 'song'), data: media.song.blob });
  if (media.background?.blob) entries.push({ name: safeEntryName(media.background.name || meta.background || 'background'), data: media.background.blob });

  const blob = await createZip(entries, { compress: opts.compress });
  return {
    kind,
    fileName: `${base}${EXPORT_KINDS[kind].suffix}.zip`,
    blob,
    entries: entries.map((e) => e.name),
    warnings,
    stats: { ...serialized.stats, mediaFiles: entries.length - 2 },
    json: serialized.json,
  };
}

/**
 * 内部项目文件（**单文件**、不含资源）：`.pce.json`。
 * 轻量、便于比对/入库，但重新打开时音频与曲绘要自己再选一次；
 * 编辑器按钮默认走 `buildProjectZip()`（连资源一起打包）。
 * @returns {{kind:'project',fileName:string,text:string,json:object,warnings:string[],stats:object}}
 */
export function buildProjectJson(chart, opts = {}) {
  if (!chart) throw new Error('还没有载入谱面，无法保存项目');
  const { json, warnings, stats } = serializeProject(chart, { savedAt: opts.savedAt });
  return {
    kind: 'project',
    fileName: `${baseNameOf(chart)}.pce.json`,
    text: opts.pretty ? JSON.stringify(json, null, 2) : JSON.stringify(json),
    json,
    warnings,
    stats,
  };
}

/**
 * 保存项目（内部格式，**zip 包**）：`project.json` + `info.txt` + 全部资源文件。
 *
 * 为什么要带资源：项目文件是「下次还能接着改」的那一份 —— 只存 json 的话重新打开就没有
 * 音频/曲绘（以及自定义判定线贴图、打击音等）了，等于丢了一半工程。
 * 包内资源沿用它们在原谱面包里的相对路径；打开 `.pce.zip` 时按 `META.song` /
 * `META.background` / `info.txt` 的文件名自动认领。
 *
 * @param {object} chart
 * @param {{resources?:{name:string,blob:Blob}[], media?:{song?:object,background?:object},
 *          savedAt?:string, compress?:boolean}} [opts]
 *        resources：谱面包里除谱面 JSON / 元数据以外的全部文件（见 preview.resources()）
 * @returns {Promise<{kind:'project',fileName:string,blob:Blob,entries:string[],warnings:string[],stats:object,json:object}>}
 */
export async function buildProjectZip(chart, opts = {}) {
  if (!chart) throw new Error('还没有载入谱面，无法保存项目');
  const warnings = [];
  const { json, warnings: serialWarnings, stats } = serializeProject(chart, { savedAt: opts.savedAt });
  warnings.push(...serialWarnings);

  const meta = { ...(chart.meta ?? {}) };
  const resources = [];
  const seen = new Set();
  const addResource = (name, blob) => {
    const clean = safeEntryPath(name); // 保留子目录结构（资源引用是相对谱面的路径）
    if (!blob || seen.has(clean)) return;
    seen.add(clean);
    resources.push({ name: clean, blob });
  };
  for (const r of opts.resources ?? []) addResource(r.name, r.blob);

  // 音频/曲绘：包内已有的（同一个 blob）只把 meta 的文件名对齐；来自 URL 的（示例包）补进包
  const media = opts.media ?? {};
  for (const [field, fallbackName] of [
    ['song', 'song'],
    ['background', 'background.png'],
  ]) {
    const item = media[field];
    if (!item?.blob) continue;
    const existing = resources.find((r) => r.blob === item.blob);
    if (existing) {
      meta[field] = existing.name;
      continue;
    }
    const name = safeEntryPath(item.name || meta[field] || fallbackName);
    addResource(name, item.blob);
    meta[field] = name;
  }

  const base = safeFileName(stripChartExt(meta.name) || baseNameOf(chart), 'chart');
  const entries = [
    { name: 'project.json', data: JSON.stringify(json) },
    { name: 'info.txt', data: metaToInfoTxt(meta) },
    ...resources,
  ];
  const blob = await createZip(entries, { compress: opts.compress });
  if (!resources.length) {
    warnings.push('谱面没有可打包的资源文件（音频 / 曲绘 / 自定义贴图 / 打击音）：项目 zip 里只有 project.json，重新打开后需要自己再选一次媒体');
  }
  return {
    kind: 'project',
    fileName: `${base}.pce.zip`,
    blob,
    entries: entries.map((e) => e.name),
    warnings,
    stats: { ...stats, resources: resources.length },
    json,
  };
}

/** 统一入口（导出页与测试都用它）：返回可下载的对象 */
export async function buildExport(chart, kind, opts = {}) {
  if (kind === 'project') return buildProjectZip(chart, opts);
  return buildChartZip(chart, kind, opts);
}
