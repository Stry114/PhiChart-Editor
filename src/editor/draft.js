/**
 * 草稿存储：把「编辑中的项目」按项目格式写进浏览器本地，供下次进入时恢复。
 *
 * 定位：**只是安全网**。网页不会把文件写进用户的磁盘，真正落盘要靠「导出」页的
 * 「保存项目（内部格式）」。草稿存的是项目格式（无损），不含渲染产物。
 *
 * 结构（独立数据库，刻意不复用 `src/ui/handoff.js` 的库，避免版本升级互相牵连）：
 *   库 `phichart-editor-drafts` v1，store `drafts`：
 *     `index`              小记录：时间 / 名称 / 来源格式 / 字节数 / 资源清单（启动时只读它）
 *     `chart`              `{ gzip, bytes }`：项目 JSON（gzip 后通常 1–2 MB）
 *     `asset:<name>|…`     资源 Blob（仅在预算内；音频通常超预算，不存）
 *
 * 无 IndexedDB（隐私模式、测试桩件）时自动退回内存后端：本次会话内仍可写入/恢复，
 * 关闭页面即失效 —— 由调用方（autosave.js）提示用户。
 */

/** 数据库与 store 名 */
export const DRAFT_DB = 'phichart-editor-drafts';
export const DRAFT_STORE = 'drafts';
/** 单草稿槽：不保留历史版本，也不做多项目管理 */
export const DRAFT_SLOT = 'current';

/** 改动后多久写一次草稿（毫秒） */
export const AUTOSAVE_DEBOUNCE_MS = 4000;
/** 两次写入之间的最小间隔（毫秒）：大谱面序列化 + 压缩约 0.3–0.6 s，别写太勤 */
export const AUTOSAVE_MIN_INTERVAL_MS = 15000;
/** 单个资源超过这个大小就不随草稿存 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** 全部资源合计上限 */
export const ASSET_BUDGET = 24 * 1024 * 1024;

const INDEX_KEY = 'index';
const CHART_KEY = 'chart';
const ASSET_PREFIX = 'asset:';

/** 视图的精确字节（Uint8Array 可能是更大 buffer 上的视图） */
const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/**
 * 内存后端：无 IndexedDB 的环境与测试用。
 * 接口与 IndexedDB 后端一致：put / get / keys / del。
 */
export function createMemoryBackend() {
  const map = new Map();
  return {
    kind: 'memory',
    async put(key, value) {
      map.set(key, value);
      return true;
    },
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async keys() {
      return [...map.keys()];
    },
    async del(key) {
      map.delete(key);
      return true;
    },
  };
}

/** IndexedDB 后端：连接常驻（草稿写入频繁，不每次开关） */
export function createIndexedDbBackend() {
  let dbPromise = null;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const idb = globalThis.indexedDB;
      if (!idb) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      const req = idb.open(DRAFT_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    });
    return dbPromise;
  };
  const withStore = async (mode, fn, fallback = true) => {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, mode);
      const store = tx.objectStore(DRAFT_STORE);
      const req = fn(store);
      // 注意：键不存在时 req.result 是 undefined —— 不能用 `?? true` 兜底（那会让「没有草稿」
      // 被读成 `true`，欢迎弹窗于是显示一张空的恢复卡片）。
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
    });
  };
  return {
    kind: 'indexeddb',
    put: (key, value) => withStore('readwrite', (s) => s.put(value, key)),
    get: (key) => withStore('readonly', (s) => s.get(key), null),
    keys: () => withStore('readonly', (s) => s.getAllKeys(), []),
    del: (key) => withStore('readwrite', (s) => s.delete(key)),
  };
}

/** JSON -> 字节（gzip 可选；环境不支持压缩时返回原始字节） */
export async function packJson(json, { compress = true } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const raw = { gzip: false, bytes: toArrayBuffer(bytes), rawBytes: bytes.length };
  if (!compress || typeof CompressionStream === 'undefined' || typeof Response === 'undefined') return raw;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (!packed.length) return raw;
    return { gzip: true, bytes: toArrayBuffer(packed), rawBytes: bytes.length };
  } catch {
    return raw;
  }
}

/** 字节 -> JSON（与 packJson 对称） */
export async function unpackJson(record) {
  const bytes = new Uint8Array(record?.bytes ?? []);
  if (!bytes.length) return null;
  if (!record.gzip) return JSON.parse(new TextDecoder().decode(bytes));
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压草稿');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(raw));
}

/** 资源在库里的键：名称 + 大小 + 修改时间（同一文件重复写入时命中同一键） */
const assetKey = (name, blob) => `${name}|${blob?.size ?? 0}|${blob?.lastModified ?? 0}`;

/**
 * 草稿仓库。
 * @param {{backend?:object}} [opts] 不传时优先 IndexedDB，不可用则内存后端
 */
export function createDraftStore({ backend = null } = {}) {
  const be = backend ?? (globalThis.indexedDB ? createIndexedDbBackend() : createMemoryBackend());
  const slotIndex = `${DRAFT_SLOT}:${INDEX_KEY}`;
  const slotChart = `${DRAFT_SLOT}:${CHART_KEY}`;

  /** 草稿概要：记录不完整（没有保存时间）时视为「没有草稿」 */
  async function peekIndex() {
    try {
      const index = await be.get(slotIndex);
      return index && typeof index === 'object' && index.savedAt ? index : null;
    } catch {
      return null;
    }
  }

  return {
    get kind() {
      return be.kind;
    },
    peek: peekIndex,
    /**
     * 读完整草稿。
     * @returns {Promise<{index:object, json:object, files:{name:string, blob:Blob}[]}|null>}
     */
    async read() {
      const index = await peekIndex();
      if (!index) return null;
      const chartRecord = await be.get(slotChart);
      if (!chartRecord?.bytes) return null;
      const json = await unpackJson(chartRecord);
      if (!json) return null;
      const files = [];
      for (const res of index.resources ?? []) {
        if (!res.key) continue;
        const blob = await be.get(ASSET_PREFIX + res.key);
        if (blob) files.push({ name: res.name, blob });
      }
      return { index, json, files };
    },
    /**
     * 写草稿（覆盖单槽）。写入失败（配额等）会抛出，由调用方决定是否停用自动保存。
     * @param {{json:object, label?:string, sourceFormat?:string, meta?:object, resources?:{name:string, blob:Blob}[]}} input
     */
    async write({ json, label = '', sourceFormat = '', meta = {}, resources = [] }) {
      const packed = await packJson(json);
      const stored = [];
      let budget = ASSET_BUDGET;
      for (const res of resources ?? []) {
        const size = res?.blob?.size ?? 0;
        const name = res?.name ?? '';
        if (!name || !res?.blob || size > MAX_ASSET_BYTES || size > budget) continue;
        const key = assetKey(name, res.blob);
        await be.put(ASSET_PREFIX + key, res.blob);
        budget -= size;
        stored.push({ name, size, key });
      }
      const index = {
        savedAt: new Date().toISOString(),
        label,
        sourceFormat,
        gzip: packed.gzip,
        chartBytes: packed.rawBytes,
        packedBytes: packed.bytes.byteLength,
        meta: { name: meta.name ?? '', song: meta.song ?? '', background: meta.background ?? '' },
        resources: [
          ...stored,
          ...(resources ?? [])
            .filter((r) => r?.name && !stored.some((s) => s.name === r.name))
            .map((r) => ({ name: r.name, size: r.blob?.size ?? 0, key: null })),
        ],
        assets: stored.length,
      };
      await be.put(slotChart, { gzip: packed.gzip, bytes: packed.bytes });
      await be.put(slotIndex, index);
      // 清掉不再引用的资源，避免库里越积越多
      const keep = new Set(stored.map((s) => ASSET_PREFIX + s.key));
      try {
        for (const key of await be.keys()) {
          if (String(key).startsWith(ASSET_PREFIX) && !keep.has(key)) await be.del(key);
        }
      } catch {
        /* 清理失败不影响草稿本身 */
      }
      return index;
    },
    /** 丢弃草稿（含已存的资源） */
    async clear() {
      try {
        for (const key of await be.keys()) {
          if (String(key).startsWith(ASSET_PREFIX)) await be.del(key);
        }
      } catch {
        /* 忽略 */
      }
      await be.del(slotIndex);
      await be.del(slotChart);
      return true;
    },
  };
}
