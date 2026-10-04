/**
 * AI 多对话管理与历史持久化。
 *
 * 对话**与项目绑定**：项目身份是 `chart.projectId`（UUID，保存在内部项目格式里，
 * 随 `.pce.zip` / `.pce.json` 往返，见 project.js）。同一个 projectId 的对话：
 *  - 写进 IndexedDB（库 `phichart-editor-ai` / store `conversations`，键 = projectId）——刷新不丢；
 *  - 随「保存项目」嵌进项目文件的 `aiConversations` 字段——跨设备带走。
 * 两处按对话 id + updatedAt 合并（新的赢），所以旧存档 + 本地缓存能互补。
 *
 * 活动对话的 session 实例按 id 缓存在内存里（页面存活期间切换零成本）；
 * 持久化时序列化成纯 JSON。待应用的改动计划**不**跨持久化保留（必须现场对着当前谱面生成），
 * 序列化时会在对话里留一条说明。
 */
import { AI_CONV_STORE, openAiDb } from './config.js';

export const ARCHIVE_FORMAT = 'phichart-ai-conversations';
export const ARCHIVE_VERSION = 1;
/** 单个项目最多保留的对话数（超出丢最旧的） */
const MAX_CONVERSATIONS = 50;

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const now = () => Date.now();

/** 从 transcript 取对话标题：手动改过用改的，否则用第一条用户消息 */
function titleOf(record) {
  if (record.customTitle) return record.title;
  const first = (record.transcript ?? []).find((t) => t.role === 'user');
  const text = String(first?.text ?? '').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 24 ? `${text.slice(0, 24)}…` : text) : '新对话';
}

function emptyRecord() {
  return {
    id: uuid(),
    customTitle: false,
    title: '',
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    transcript: [],
    usage: { prompt: 0, completion: 0, total: 0 },
  };
}

/** 修一个来自存档 / 缓存的记录：字段收敛，防止旧版本或损坏数据把 UI 搞挂 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    customTitle: !!raw.customTitle,
    title: typeof raw.title === 'string' ? raw.title : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now(),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
    usage:
      raw.usage && typeof raw.usage === 'object'
        ? {
            prompt: Number(raw.usage.prompt) || 0,
            completion: Number(raw.usage.completion) || 0,
            total: Number(raw.usage.total) || 0,
          }
        : { prompt: 0, completion: 0, total: 0 },
  };
}

/** 合并两份对话集：按 id 取 updatedAt 新的；activeId 用 updatedAt 更新的那份存档的 */
function mergeArchive(a, b) {
  const byId = new Map();
  for (const rec of [...(a?.conversations ?? []), ...(b?.conversations ?? [])]) {
    const rec2 = normalizeRecord(rec);
    if (!rec2) continue;
    const prev = byId.get(rec2.id);
    if (!prev || rec2.updatedAt >= prev.updatedAt) byId.set(rec2.id, rec2);
  }
  const conversations = [...byId.values()].sort((x, y) => x.createdAt - y.createdAt);
  const pickActive = (arch) => {
    const id = arch?.activeId;
    return id && byId.has(id) ? id : null;
  };
  const newer = Number(a?.savedAt ?? 0) >= Number(b?.savedAt ?? 0) ? a : b;
  const activeId = pickActive(newer) ?? (conversations.length ? conversations[conversations.length - 1].id : null);
  return { conversations, activeId };
}

// ───────────────────────────── IndexedDB ─────────────────────────────

async function idbLoad(projectId) {
  try {
    const db = await openAiDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(AI_CONV_STORE, 'readonly');
      const req = tx.objectStore(AI_CONV_STORE).get(projectId);
      req.onsuccess = () => resolve(req.result && typeof req.result === 'object' ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
    });
  } catch {
    return null; // 无 IndexedDB（隐私模式 / 桩件）：只靠本次会话与项目存档
  }
}

async function idbSave(projectId, archive) {
  try {
    const db = await openAiDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AI_CONV_STORE, 'readwrite');
      tx.objectStore(AI_CONV_STORE).put(archive, projectId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
    });
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── 会话存储 ─────────────────────────────

/**
 * @param {{createSession:() => object}} deps createSession：造一个挂好回调的 session 实例
 */
export function createConversationStore({ createSession }) {
  let projectId = null;
  // 初始就有一个空对话：编辑器刚启动、谱面还没载入时面板也要能用（bind() 会按项目重建）
  let records = [emptyRecord()];
  let activeId = records[0].id;
  /** 活动过的 session 缓存：切换时先序列化回 record，避免丢刚说的内容 */
  const sessions = new Map();
  let loaded = true;

  const recordOf = (id) => records.find((r) => r.id === id) ?? null;

  const ensureSession = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = createSession();
      const rec = recordOf(id);
      if (rec) s.restore(rec);
      sessions.set(id, s);
    }
    return s;
  };

  /** 活动对话的 session 状态落回 record（切换 / 持久化前都要调） */
  const flushActive = () => {
    const rec = recordOf(activeId);
    const s = sessions.get(activeId);
    if (!rec || !s) return;
    const data = s.serialize();
    // 序列化时待应用计划带不走：留一句说明，用户刷新后需让 AI 重新生成
    if (s.plan && !s.plan.applied) {
      const last = data.transcript[data.transcript.length - 1];
      const note = '注意：有一份未应用的改动计划不会跨会话保留，请重新让 AI 生成。';
      if (last?.role !== 'system' || last.text !== note) data.transcript.push({ role: 'system', text: note, at: now(), miEnd: data.messages.length });
    }
    rec.messages = data.messages;
    rec.transcript = data.transcript;
    rec.usage = data.usage;
    rec.updatedAt = now();
  };

  const capRecords = () => {
    if (records.length <= MAX_CONVERSATIONS) return;
    const sorted = [...records].sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = new Set(sorted.slice(0, records.length - MAX_CONVERSATIONS).map((r) => r.id));
    for (const id of drop) sessions.delete(id);
    records = records.filter((r) => !drop.has(r.id));
  };

  return {
    /** 项目身份；未绑定（没谱面）时为 null */
    get projectId() {
      return projectId;
    },
    get activeId() {
      return activeId;
    },
    get loaded() {
      return loaded;
    },
    /** 对话列表（视图用：附带算好的标题与摘要） */
    list() {
      return records.map((r) => ({
        id: r.id,
        title: titleOf(r),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        count: r.transcript.length,
        total: r.usage.total,
        active: r.id === activeId,
      }));
    },
    activeSession() {
      return activeId ? ensureSession(activeId) : null;
    },
    /** 活动对话的 session 状态落回 record（外部在持久化 / 切换前调用） */
    flush() {
      flushActive();
    },
    /** 标题（活动对话的实时版：优先取 session 里第一条用户消息） */
    activeTitle() {
      const rec = recordOf(activeId);
      if (!rec) return '';
      return titleOf(rec);
    },
    /** 绑定项目：确保 projectId，载入本地缓存并与项目内嵌存档合并 */
    async bind(chart) {
      if (!chart) return;
      if (!chart.projectId) {
        chart.projectId = uuid();
      }
      projectId = chart.projectId;
      const [cached, embedded] = await Promise.all([
        idbLoad(projectId),
        Promise.resolve(chart.aiConversations && typeof chart.aiConversations === 'object' ? chart.aiConversations : null),
      ]);
      // 内嵌存档消费掉：留在 chart 上会随下一次保存原样写出（把旧对话又带回来）
      delete chart.aiConversations;
      const hasLocal = cached && Array.isArray(cached.conversations) && cached.conversations.length;
      const hasEmbedded = embedded && Array.isArray(embedded.conversations) && embedded.conversations.length;
      if (hasLocal || hasEmbedded) {
        const merged = mergeArchive(hasLocal ? cached : null, hasEmbedded ? embedded : null);
        records = merged.conversations;
        activeId = merged.activeId;
      } else {
        records = [];
        activeId = null;
      }
      capRecords();
      if (!records.length) {
        const rec = emptyRecord();
        records = [rec];
        activeId = rec.id;
      }
      if (!recordOf(activeId)) activeId = records[records.length - 1].id;
      loaded = true;
      ensureSession(activeId);
    },
    /** 切换对话：当前 session 先落盘内存 record，再恢复目标 */
    switchTo(id) {
      if (!recordOf(id) || id === activeId) return false;
      flushActive();
      activeId = id;
      ensureSession(activeId);
      return true;
    },
    /** 新建对话；`data`（sliceTo/serialize 的产物）给分支用 */
    create(data = null) {
      flushActive();
      const rec = emptyRecord();
      if (data) {
        rec.messages = Array.isArray(data.messages) ? data.messages : [];
        rec.transcript = Array.isArray(data.transcript) ? data.transcript : [];
        rec.usage = data.usage && typeof data.usage === 'object' ? { ...data.usage } : rec.usage;
        rec.updatedAt = now();
      }
      records.push(rec);
      capRecords();
      activeId = rec.id;
      ensureSession(activeId);
      return rec.id;
    },
    rename(id, title) {
      const rec = recordOf(id);
      if (!rec) return false;
      const t = String(title ?? '').trim();
      rec.customTitle = !!t;
      rec.title = t;
      rec.updatedAt = now();
      return true;
    },
    remove(id) {
      const at = records.findIndex((r) => r.id === id);
      if (at < 0) return false;
      const wasActive = id === activeId;
      sessions.delete(id);
      records.splice(at, 1);
      if (!records.length) {
        const rec = emptyRecord();
        records = [rec];
        activeId = rec.id;
        ensureSession(activeId);
      } else if (wasActive) {
        activeId = records[records.length - 1].id;
        ensureSession(activeId);
      }
      return true;
    },
    /** 从某条消息分支（session.sliceTo 的结果开一个新对话） */
    branchFrom(data) {
      return this.create(data);
    },
    /** 持久化用的存档（先落当前 session 状态） */
    exportArchive() {
      flushActive();
      return {
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        projectId,
        savedAt: now(),
        activeId,
        conversations: records.map((r) => ({ ...r })),
      };
    },
    /** 写 IndexedDB（失败静默：隐私模式等，本次会话内仍可用） */
    async persist() {
      if (!projectId) return false;
      return await idbSave(projectId, this.exportArchive());
    },
    /** 直接导入一份存档（不经过 chart）；当前 store 里没内容的空对话会被丢弃，不掺进结果 */
    importArchive(archive) {
      if (!archive || archive.format !== ARCHIVE_FORMAT) return false;
      const keepCurrent = records.filter((r) => r.transcript.length || r.messages.length || r.customTitle);
      const merged = mergeArchive(archive, {
        conversations: keepCurrent,
        activeId: keepCurrent.some((r) => r.id === activeId) ? activeId : null,
        savedAt: 0,
      });
      records = merged.conversations;
      capRecords();
      activeId = merged.activeId ?? activeId;
      if (!recordOf(activeId)) activeId = records.length ? records[records.length - 1].id : null;
      if (!records.length) {
        const rec = emptyRecord();
        records = [rec];
        activeId = rec.id;
      }
      ensureSession(activeId);
      return true;
    },
  };
}

/** 存档 JSON 是否合法（导入 / 打开项目时防呆） */
export function isConversationArchive(json) {
  return !!json && typeof json === 'object' && json.format === ARCHIVE_FORMAT && Array.isArray(json.conversations);
}
