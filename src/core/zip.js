/**
 * zip **写出**（读取见 `src/core/package.js` 的 readZip）。
 *
 * 为什么自己写：导出官谱 / RPE 谱都需要把「谱面 JSON + info.txt + 音频 + 曲绘」打成一个 zip，
 * 而项目本身零第三方依赖（见 `docs/项目文档.md` 的项目概览）。
 *
 * 压缩方式：
 *  - 优先 `deflate-raw`（浏览器与 Node 都自带 `CompressionStream`），压不动时退回 store；
 *  - 两个后端都没有（老浏览器）时也能用：全部按 store 写出，任何解压工具都能读。
 *
 * 兼容性：文件名按 UTF-8 编码并设置通用位标记 bit 11（EFS），中文/空格/`#` 文件名都不会乱码
 * （本项目样本里就有 `music #1988.wav` 这种名字）。
 */

const encoder = new TextEncoder();

/** CRC32 查表（zip 用标准多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** 计算字节串的 CRC32（无符号 32 位） */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把各种输入统一成 Uint8Array */
async function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  return encoder.encode(String(data));
}

/** deflate-raw 压缩；环境不支持或失败时返回 null（调用方退回 store） */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** MS-DOS 时间戳（zip 头用；本地时间，精度 2 秒） */
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

/** 把文件名规整成包内安全的相对路径（去掉目录分隔符与 Windows 非法字符） */
export function safeEntryName(name) {
  const base = String(name ?? '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_');
  return base.trim() || 'unnamed';
}

/**
 * 保留目录结构的包内路径安全化：`sub/a.png` 原样保留（谱面包里资源可能放在子目录，
 * 引用是相对谱面的路径），但逐段清掉非法字符，并丢掉 `.` / `..` 段以防路径穿越。
 */
export function safeEntryPath(name) {
  const parts = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg));
  return parts.join('/') || 'unnamed';
}

/**
 * 写出一个 zip。
 * @param {{name:string, data:string|Uint8Array|ArrayBuffer|Blob}[]} entries 依次写入的文件
 * @param {{compress?:boolean, date?:Date, safeNames?:boolean}} [opts] safeNames=false 时按原样写名字
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, opts = {}) {
  const compress = opts.compress !== false;
  const { time: dosTime, day: dosDay } = dosDateTime(opts.date);
  const chunks = [];
  const records = [];
  let offset = 0;

  for (const entry of entries ?? []) {
    if (!entry) continue;
    const name = opts.safeNames === false ? String(entry.name) : safeEntryPath(entry.name);
    const raw = await toBytes(entry.data);
    let method = 0;
    let packed = raw;
    if (compress && raw.length) {
      const deflated = await deflateRaw(raw).catch(() => null);
      if (deflated && deflated.length < raw.length) {
        method = 8;
        packed = deflated;
      }
    }
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length + packed.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    dv.setUint16(4, 20, true); // 需要 2.0 版本
    dv.setUint16(6, 0x0800, true); // bit 11：文件名为 UTF-8
    dv.setUint16(8, method, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDay, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, packed.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra 长度
    local.set(nameBytes, 30);
    local.set(packed, 30 + nameBytes.length);
    chunks.push(local);
    records.push({ nameBytes, method, crc, compSize: packed.length, size: raw.length, offset });
    offset += local.length;
  }

  // 中央目录
  const centralSize = records.reduce((n, r) => n + 46 + r.nameBytes.length, 0);
  const central = new Uint8Array(centralSize);
  const cdv = new DataView(central.buffer);
  let cpos = 0;
  for (const r of records) {
    cdv.setUint32(cpos, 0x02014b50, true);
    cdv.setUint16(cpos + 4, 20, true); // 生成程序版本
    cdv.setUint16(cpos + 6, 20, true); // 需要版本
    cdv.setUint16(cpos + 8, 0x0800, true);
    cdv.setUint16(cpos + 10, r.method, true);
    cdv.setUint16(cpos + 12, dosTime, true);
    cdv.setUint16(cpos + 14, dosDay, true);
    cdv.setUint32(cpos + 16, r.crc, true);
    cdv.setUint32(cpos + 20, r.compSize, true);
    cdv.setUint32(cpos + 24, r.size, true);
    cdv.setUint16(cpos + 28, r.nameBytes.length, true);
    cdv.setUint16(cpos + 30, 0, true); // extra
    cdv.setUint16(cpos + 32, 0, true); // comment
    cdv.setUint16(cpos + 34, 0, true); // 起始磁盘
    cdv.setUint16(cpos + 36, 0, true); // 内部属性
    cdv.setUint32(cpos + 38, 0, true); // 外部属性
    cdv.setUint32(cpos + 42, r.offset, true);
    central.set(r.nameBytes, cpos + 46);
    cpos += 46 + r.nameBytes.length;
  }
  chunks.push(central);

  // 中央目录结束记录
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, Math.min(records.length, 0xffff), true);
  edv.setUint16(10, Math.min(records.length, 0xffff), true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}
