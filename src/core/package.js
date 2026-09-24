/**
 * 谱面包加载：
 *  - 目录（<input webkitdirectory> 或多选文件 / 拖拽文件夹）
 *  - zip 压缩包（用浏览器/Node 自带的 DecompressionStream('deflate-raw') 解压，无需第三方库）
 *
 * 产出的包对象：
 *   { name, files: Map<相对路径, {blob, size}>, chartFile, chartJson, chartText, warnings }
 * 路径统一使用 '/'，比较时不区分大小写。
 * 元数据按 `src/core/meta.js` 的权威顺序仲裁：info.txt > info.csv > 谱面 JSON 元数据 > 包名。
 */

/**
 * 从拖放的 DataTransfer 里取出所有文件（支持整个文件夹）。
 * 浏览器不支持 webkitGetAsEntry 时退回 dt.files。
 * @returns {Promise<File[]>}
 */
export async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])];
  const entries = items
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...(dataTransfer?.files ?? [])];

  const collect = async (entry) => {
    if (entry.isFile) {
      return await new Promise((resolve) => entry.file((f) => resolve([f]), () => resolve([])));
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const out = [];
      for (;;) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) out.push(...(await collect(child)));
      }
      return out;
    }
    return [];
  };

  const files = [];
  for (const entry of entries) files.push(...(await collect(entry)));
  return files;
}

/** 读取 zip（仅支持 store/deflate，即最常见的两种压缩方式） */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // 从尾部查找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到 EOCD）');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // 读取本地文件头以定位数据
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    files.set(name.replace(/\\/g, '/'), { method, raw });
  }
  return files;
}

async function inflateFile(entry) {
  if (entry.method === 0) return entry.raw.slice();
  if (entry.method !== 8) throw new Error(`不支持的 zip 压缩方式：${entry.method}`);
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持 DecompressionStream');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([entry.raw]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 解压 zip 的所有条目成 `Map<相对路径, {blob, size}>`（包加载与项目 zip 共用） */
export async function unzipToFiles(buffer) {
  const entries = await readZip(buffer);
  const files = new Map();
  for (const [path, entry] of entries) {
    const data = await inflateFile(entry);
    files.set(path, { blob: new Blob([data]), size: data.length });
  }
  return files;
}

/** 从 zip 包创建包对象 */
export async function loadZipPackage(buffer, name = 'chart.zip') {
  return buildPackage(name, await unzipToFiles(buffer));
}

/**
 * 在解压后的文件表里找**本编辑器的项目文件**（`<曲名>.pce.zip` 里的 `project.json`）。
 * 找不到返回 null（说明这是普通谱面包）。
 */
export async function findProjectFile(files) {
  for (const [path, entry] of files) {
    if (!/\.json$/i.test(path)) continue;
    try {
      const json = JSON.parse(await entry.blob.text());
      if (json && typeof json === 'object' && json.format === PROJECT_FORMAT) return { path, json };
    } catch {
      /* 不是合法 JSON：跳过 */
    }
  }
  return null;
}

/** 从 FileList（目录或文件）创建包对象 */
export async function loadFilePackage(fileList, name) {
  const list = [...fileList];
  const files = new Map();
  // webkitRelativePath 形如 "包名/子目录/文件"；去掉第一层目录名
  for (const file of list) {
    const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const parts = rel.split('/');
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel;
    files.set(path, { blob: file, size: file.size });
  }
  return buildPackage(name ?? (list[0]?.webkitRelativePath?.split('/')[0] || list[0]?.name || 'package'), files);
}

const AUDIO_EXT = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const ext = (p) => (p.split('.').pop() || '').toLowerCase();

import { resolveMeta } from './meta.js';
import { PROJECT_FORMAT } from './model.js';

/** 识别谱面文件、音频、曲绘 */
export async function buildPackage(name, files) {
  const warnings = [];
  const paths = [...files.keys()];
  const jsonPaths = paths.filter((p) => ext(p) === 'json');

  let chartPath = null;
  let chartJson = null;
  let chartText = '';
  // 优先找能解析且含 judgeLineList 的 json；多个时取最大的（官谱通常非常大）
  const candidates = jsonPaths
    .map((p) => ({ p, size: files.get(p).size }))
    .filter((c) => !/info\.json|meta\.json/i.test(c.p))
    .sort((a, b) => b.size - a.size);
  for (const c of candidates) {
    try {
      const text = await files.get(c.p).blob.text();
      const json = JSON.parse(text);
      if (Array.isArray(json?.judgeLineList)) {
        chartPath = c.p;
        chartJson = json;
        chartText = text;
        break;
      }
    } catch (err) {
      warnings.push(`解析 ${c.p} 失败：${err.message}`);
    }
  }
  if (!chartJson) warnings.push('包内没有找到可用的谱面 json（需要含 judgeLineList）');

  // 先解析元数据来源：info.txt / info.csv（权威顺序见 src/core/meta.js）
  const infoPath = paths.find((p) => /^info\.txt$/i.test(p) || /\.txt$/i.test(p));
  let infoMeta = null;
  if (infoPath) infoMeta = parseInfoTxt(await files.get(infoPath).blob.text());

  // info.csv（官方包常见的元数据表；多行时按 Chart 列匹配谱面文件名）
  const csvPath = paths.find((p) => /^info\.csv$/i.test(p));
  let csvMeta = null;
  if (csvPath) {
    try {
      const records = parseInfoCsv(await files.get(csvPath).blob.text());
      const base = (chartPath ?? '').split('/').pop()?.toLowerCase() ?? '';
      const matched = records.find((r) => (r.Chart ?? '').toLowerCase() === base) ?? records[0];
      csvMeta = infoCsvToMeta(matched);
    } catch (err) {
      warnings.push(`解析 info.csv 失败：${err.message}`);
    }
  }
  if (paths.some((p) => /^line\.csv$/i.test(p))) {
    warnings.push('包内含 line.csv（官方格式的逐判定线贴图配置），v1 未使用');
  }

  const audioPaths = paths.filter((p) => AUDIO_EXT.includes(ext(p))).sort((a, b) => files.get(b).size - files.get(a).size);
  const imagePaths = paths.filter((p) => IMAGE_EXT.includes(ext(p)) && !/HL\.png$/i.test(p));

  const findByName = (wanted) => {
    if (!wanted) return null;
    const target = wanted.replace(/\\/g, '/').toLowerCase();
    return paths.find((p) => p.toLowerCase() === target) ?? paths.find((p) => p.toLowerCase().endsWith('/' + target)) ?? null;
  };

  // 元数据仲裁：info.txt（文本文档） > info.csv > 谱面 JSON 内元数据 > 包名兜底曲名
  const resolved = resolveMeta({ infoTxt: infoMeta, infoCsv: csvMeta, chartMeta: chartJson?.META, packageName: name });
  const meta = chartJson ? resolved.meta : {};

  const songPath = findByName(meta.song) ?? audioPaths[0] ?? null;
  const backgroundPath = findByName(meta.background) ?? imagePaths[0] ?? null;

  return {
    name,
    files,
    chartPath,
    chartJson,
    chartText,
    info: infoMeta,
    infoCsv: csvMeta,
    meta,
    metaSources: resolved.sources,
    songPath,
    backgroundPath,
    warnings,
    urlFor(path) {
      const entry = files.get(path);
      return entry ? URL.createObjectURL(entry.blob) : null;
    },
  };
}

/** 解析包内的 info.txt（键值形如 "Name: ..."，编码可能是 GBK，这里只做尽力解析） */
export function parseInfoTxt(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*[:：]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * 解析官方包常见的 info.csv（首行为列名，其后每行一个谱面；列名见 docs/Phigros文档.md 的包内元数据（info.csv / line.csv / info.txt））。
 * 支持双引号包裹的字段（含逗号）。
 */
export function parseInfoCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const filtered = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (filtered.length < 2) return [];
  const header = filtered[0].map((h) => h.trim());
  return filtered.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** info.csv 记录 -> 统一 meta（兼容多种列名别名） */
export function infoCsvToMeta(record) {
  if (!record) return null;
  const pick = (...keys) => {
    for (const k of keys) if (record[k]) return record[k];
    return '';
  };
  return {
    name: pick('Name'),
    song: pick('Music', 'Song'),
    background: pick('Image', 'Picture', 'Illustration'),
    composer: pick('Musician', 'Composer', 'Artist'),
    charter: pick('Designer', 'Charter'),
    illustrator: pick('Illustrator'),
    level: pick('Level'),
    id: '',
    chart: pick('Chart'),
    // 谱面延迟（秒）：official 的 info.csv 用 Offset 列，交给 resolveMeta 按权威顺序仲裁
    offset: pick('Offset'),
    noteScale: record.NoteScale ?? '',
    backgroundDim: record.BackgroundDim ?? '',
    aspectRatio: record.AspectRatio ?? '',
  };
}
