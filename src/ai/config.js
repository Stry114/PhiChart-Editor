/**
 * AI 助手的本地配置与密钥（见 docs/LLM辅助写谱方案.md §7）。
 *
 *  - **设置**（Base URL / 模型 / 上限 / 是否记住密钥 / 各端点的发送确认）：localStorage，小且非敏感；
 *  - **密钥**：默认 sessionStorage（刷新不丢、关标签页失效）；勾选「记住这台设备」后写**独立** IndexedDB 库
 *    `phichart-editor-ai`（与草稿库 phichart-editor-drafts 分开，互不牵连）；允许留空（本地端点免密钥）。
 *  - 密钥绝不写进项目文件 / 草稿 / 导出 / 交接 / 日志；留空时调用方不发送 `Authorization` 头。
 *
 * 存储 API 缺失（无 sessionStorage / 无 IndexedDB / 测试桩件）时退回**内存**，本次会话内仍然可用。
 */

export const SETTINGS_KEY = 'phichart.ai.settings';
export const KEY_SESSION_KEY = 'phichart.ai.key';
export const AI_DB = 'phichart-editor-ai';
export const AI_STORE = 'secrets';
export const AI_SECRET_KEY = 'apiKey';
/** AI 对话历史（多对话 + 项目绑定）也放在这个库里，见 conversations.js */
export const AI_CONV_STORE = 'conversations';

/** 本地调试（llama.cpp 内置 server）：一键预填，无密钥 */
export const LOCAL_DEBUG = { baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.6-35b-a3b', apiKey: '' };

/** 默认设置：Base URL 预填 DeepSeek（OpenAI 兼容），模型名可改 */
export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  /** 单回合工具调用轮数上限 */
  maxRounds: 8,
  /** 单次写的对象数上限 */
  writeLimit: 200,
  /** 是否把密钥记到这台设备（IndexedDB） */
  rememberKey: false,
  /** 每个 host 的一次性发送确认：{ [host]: true } */
  consent: {},
  /**
   * 模型上下文窗口大小（token）。上下文管理按它裁剪历史（留 15% 余量给本轮输出）；
   * 显示「上下文占用比例」也用它。估算不准只影响裁剪时机，不影响正确性。
   */
  contextTokens: 65536,
  /** 单次请求超时（秒）。网络慢的本地模型可调大 */
  requestTimeoutSec: 120,
  /** 输入单价（元 / 百万 token）；0 或留空 = 不计费显示 */
  priceIn: 0,
  /** 输出单价（元 / 百万 token） */
  priceOut: 0,
  /** 累计花费限额（元）；0 = 不限额。达到后停止发送，防止跑飞 */
  spendLimit: 0,
};

/** 常见端点提示（设置区的 datalist） */
export const BASE_URL_HINTS = [
  { url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { url: LOCAL_DEBUG.baseUrl, model: LOCAL_DEBUG.model },
];

// ───────────────────────────── 存储兜底 ─────────────────────────────

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** 无 sessionStorage 的环境（测试桩件 / 隐私模式）共用同一份内存 */
const memorySession = memoryStore();
const memoryLocal = memoryStore();

const safeGet = (factory, fallback) => {
  try {
    return factory() ?? fallback;
  } catch {
    return fallback;
  }
};

const localStore = () => safeGet(() => globalThis.localStorage, memoryLocal);
const sessionStore = () => safeGet(() => globalThis.sessionStorage, memorySession);

const readJson = (store, key) => {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

// ───────────────────────────── 设置 ─────────────────────────────

/** @returns {typeof DEFAULT_SETTINGS} 已并入存档、并做过类型收敛的设置 */
export function loadSettings() {
  const saved = readJson(localStore(), SETTINGS_KEY);
  const out = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    if (typeof saved.baseUrl === 'string') out.baseUrl = saved.baseUrl;
    if (typeof saved.model === 'string') out.model = saved.model;
    if (Number.isFinite(saved.maxRounds)) out.maxRounds = Math.max(1, Math.min(24, Math.round(saved.maxRounds)));
    if (Number.isFinite(saved.writeLimit)) out.writeLimit = Math.max(1, Math.min(1000, Math.round(saved.writeLimit)));
    out.rememberKey = !!saved.rememberKey;
    out.consent = saved.consent && typeof saved.consent === 'object' ? { ...saved.consent } : {};
    if (Number.isFinite(saved.contextTokens)) out.contextTokens = Math.max(2048, Math.min(2e6, Math.round(saved.contextTokens)));
    if (Number.isFinite(saved.requestTimeoutSec)) out.requestTimeoutSec = Math.max(5, Math.min(1800, Math.round(saved.requestTimeoutSec)));
    if (Number.isFinite(saved.priceIn)) out.priceIn = Math.max(0, saved.priceIn);
    if (Number.isFinite(saved.priceOut)) out.priceOut = Math.max(0, saved.priceOut);
    if (Number.isFinite(saved.spendLimit)) out.spendLimit = Math.max(0, saved.spendLimit);
  }
  return out;
}

/** 合并写入并返回新设置 */
export function saveSettings(patch = {}) {
  const next = { ...loadSettings(), ...patch };
  try {
    localStore().setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下忽略 */
  }
  return next;
}

/** 该 host 是否已确认过「谱面数据会发送给该服务」 */
export function hasConsent(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return false;
  return !!loadSettings().consent[host];
}

export function giveConsent(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  const consent = { ...loadSettings().consent, [host]: true };
  saveSettings({ consent });
  return host;
}

export function hostOf(url) {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
}

/**
 * 补全请求地址：以 `/chat/completions` 结尾时原样使用，否则拼 `${base}/chat/completions`。
 * 例：`https://api.deepseek.com` → `https://api.deepseek.com/chat/completions`；
 *     `http://127.0.0.1:8081/v1` → `http://127.0.0.1:8081/v1/chat/completions`。
 */
export function endpointUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** 只允许 https，以及本机明文 http（本地调试端点） */
export function isAllowedBaseUrl(baseUrl) {
  let u = null;
  try {
    u = new URL(String(baseUrl ?? '').trim());
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
}

// ───────────────────────────── 密钥 ─────────────────────────────

/**
 * 打开 AI 库（密钥与对话历史共用；v2 起多一个 conversations store）。
 * 所有打开方必须走这里（同一版本号），否则先开 v2 再开 v1 会抛 VersionError。
 */
export function openAiDb() {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = idb.open(AI_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AI_STORE)) db.createObjectStore(AI_STORE);
      if (!db.objectStoreNames.contains(AI_CONV_STORE)) db.createObjectStore(AI_CONV_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

function openDb() {
  return openAiDb();
}

async function idbGet() {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(AI_STORE, 'readonly');
    const req = tx.objectStore(AI_STORE).get(AI_SECRET_KEY);
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : '');
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
  });
}

async function idbSet(value) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(AI_STORE, 'readwrite');
    tx.objectStore(AI_STORE).put(value, AI_SECRET_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
  });
}

async function idbDel() {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(AI_STORE, 'readwrite');
    tx.objectStore(AI_STORE).delete(AI_SECRET_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 删除失败'));
  });
}

/**
 * 取密钥：优先本次会话（sessionStorage），其次「记住的设备」（IndexedDB）。
 * 返回空串表示未配置（本地端点免密钥）。
 */
export async function loadKey() {
  const fromSession = sessionStore().getItem(KEY_SESSION_KEY);
  if (fromSession) return fromSession;
  try {
    return (await idbGet()) || '';
  } catch {
    return '';
  }
}

/** 保存密钥；`remember` 为真时同时写入 IndexedDB（并保留会话副本） */
export async function saveKey(key, { remember = false } = {}) {
  const value = String(key ?? '').trim();
  const store = sessionStore();
  if (value) store.setItem(KEY_SESSION_KEY, value);
  else store.removeItem?.(KEY_SESSION_KEY) ?? store.setItem(KEY_SESSION_KEY, '');
  try {
    if (remember && value) await idbSet(value);
    else await idbDel();
  } catch {
    /* 无 IndexedDB 时只保留会话副本 */
  }
  return value;
}

/** 清除密钥（两处一起清） */
export async function clearKey() {
  const store = sessionStore();
  store.removeItem?.(KEY_SESSION_KEY) ?? store.setItem(KEY_SESSION_KEY, '');
  try {
    await idbDel();
  } catch {
    /* 忽略 */
  }
  return true;
}

/** 该密钥是否只存在于「记住的设备」里（设置区提示用） */
export async function hasRememberedKey() {
  try {
    return !!(await idbGet());
  } catch {
    return false;
  }
}
