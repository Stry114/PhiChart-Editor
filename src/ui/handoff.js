/**
 * 跨页面交接（开始页 → 编辑器）：用 IndexedDB 传文件/JSON，避免 localStorage 的大小限制
 * （RPE 谱面 JSON 就有 40 MB，localStorage 存不下）。
 *
 * 约定：开始页 `saveHandoff(payload)`，编辑器启动时 `takeHandoff()` 取走并删除。
 * payload 形态：
 *   { kind: 'sample', id }                    内置示例包（编辑器用 fetch 载入）
 *   { kind: 'file',   blob, name }            用户选的文件（谱面 JSON / 项目文件）
 *   { kind: 'json',   json, label }           页面内生成的项目（新建/测试项目）
 *   { kind: 'package', files: [{name, blob}] } 谱面包（文件夹/zip，暂未使用，留给后续阶段）
 */

const DB_NAME = 'phichart-editor';
const STORE = 'handoff';
const KEY = 'pending';
const FALLBACK_KEY = 'phichart-handoff';

function openDb() {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

/** 写入交接数据；IndexedDB 不可用时退回 sessionStorage（只适合小数据） */
export async function saveHandoff(payload) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(payload, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close?.();
    return 'indexeddb';
  } catch (err) {
    try {
      globalThis.sessionStorage?.setItem(FALLBACK_KEY, JSON.stringify(payload));
      return 'sessionstorage';
    } catch (err2) {
      console.warn('交接数据保存失败（IndexedDB 与 sessionStorage 都不可用）：', err, err2);
      return null;
    }
  }
}

/** 读取并清空交接数据；没有则返回 null */
export async function takeHandoff() {
  try {
    const db = await openDb();
    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => {
        store.delete(KEY);
        resolve(req.result ?? null);
      };
      req.onerror = () => reject(req.error);
    });
    db.close?.();
    if (payload) return payload;
  } catch {
    /* 落到 sessionStorage */
  }
  try {
    const raw = globalThis.sessionStorage?.getItem(FALLBACK_KEY) ?? null;
    if (!raw) return null;
    globalThis.sessionStorage.removeItem(FALLBACK_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
