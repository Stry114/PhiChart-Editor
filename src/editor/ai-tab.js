/**
 * 「AI 助手」标签页（左上工作区，见 docs/LLM辅助写谱方案.md §8）。
 *
 * 面板只是**状态的外显**：对话存在 `conversations.js` 的会话存储（多对话 + IndexedDB 持久化 +
 * 项目绑定），设置存在 `config.js` 里 —— 因为 `tabs.js` 每次切回来都会清空并重渲染标签体。
 * 所有来自对话 / 谱面的文字都用 `textContent` 渲染。
 *
 * 面板结构（自上而下）：头部（状态 + 设置）→ 会话栏（多对话切换）→ 消息列表（每条可复制 / 分支）
 * → 待应用计划 → 发送确认 → 统计行（token / 费用 / 上下文占用）→ 输入区。
 */
import { el, createForm } from './detail-common.js';
import { icon } from '../ui/icons.js';
import { createSession } from '../ai/session.js';
import { createConversationStore } from '../ai/conversations.js';
import { applyPlan } from './ai-apply.js';
import { costOf, fmtCost, fmtTokens } from '../ai/tokens.js';
import {
  BASE_URL_HINTS,
  LOCAL_DEBUG,
  clearKey,
  endpointUrl,
  giveConsent,
  hasConsent,
  hasRememberedKey,
  hostOf,
  isAllowedBaseUrl,
  loadKey,
  loadSettings,
  saveKey,
  saveSettings,
} from '../ai/config.js';
import { streamChat } from '../ai/protocol.js';
import { PHASE_TEXT, TOOL_LABELS } from '../ai/session.js';

const STATE_LABEL = {
  nokey: '未配置',
  ready: '就绪',
  running: '请求中',
  error: '出错',
};

/** 复制文本到剪贴板（无 clipboard API 的环境退回 execCommand） */
async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body?.appendChild?.(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

export function createAiPanel(deps) {
  const { preview, timeline, lint, setStatus, refreshAll, getLoadedLine } = deps;
  let settings = loadSettings();
  let apiKey = '';
  let keyLoaded = false;
  let draft = ''; // 输入框草稿（标签页重渲染后恢复）
  let consentAsk = null; // { host, resolve }
  let mounted = null; // 当前挂载的容器引用集合
  let rafId = 0;
  let persistTimer = 0;
  let deleteArm = ''; // 两步删除确认：已点过删除的对话 id（超时复位）

  const toolContext = () => {
    const chart = preview.chart;
    const from = timeline.scrollBeat ?? 0;
    const span = timeline.visibleBeats || 8;
    return {
      chart,
      lintSummary: () => {
        const s = lint?.summary;
        return s ? { error: s.error ?? 0, warn: s.warn ?? 0 } : { error: 0, warn: 0 };
      },
      // 纠错扫描的结果直接复用编辑器缓存（大谱面上重新扫一遍要几百毫秒）
      lintScan: () => ({ summary: lint?.summary ?? null, items: lint?.items ?? [], dirty: !!lint?.dirty }),
      viewport: {
        currentBeat: timeline.currentBeat ?? 0,
        fromBeat: from,
        toBeat: from + span,
        lineId: getLoadedLine ? getLoadedLine() : undefined,
        selectionCount: timeline.selectedCount ?? 0,
        /** 把视图移到指定线与拍区间（不切换时间轴上载入的轨道，避免打断用户当前的工作） */
        focus: ({ lineId, fromBeat, toBeat }) => {
          if (Number.isFinite(fromBeat) && Number.isFinite(toBeat) && toBeat > fromBeat) {
            timeline.setVisibleBeats?.(Math.max(2, toBeat - fromBeat), fromBeat);
            timeline.seekToBeat?.(fromBeat);
          }
          void lineId;
        },
      },
    };
  };

  /** 历史持久化（防抖）：对话变化 1.5s 后写 IndexedDB */
  const persistSoon = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      store.persist();
    }, 1500);
  };

  const store = createConversationStore({
    createSession: () =>
      createSession({
        fetchImpl: (...a) => globalThis.fetch(...a),
        getConfig: () => settings,
        getKey: async () => {
          if (!keyLoaded) {
            apiKey = await loadKey();
            keyLoaded = true;
          }
          return apiKey;
        },
        getToolContext: toolContext,
        ensureConsent: async (baseUrl) => {
          if (!isAllowedBaseUrl(baseUrl)) {
            setStatus('Base URL 只允许 https，或本机 http://127.0.0.1 / http://localhost。');
            return false;
          }
          if (hasConsent(baseUrl)) return true;
          const host = hostOf(baseUrl) ?? baseUrl;
          const ok = await new Promise((resolve) => {
            consentAsk = { host, resolve };
            refreshSoon();
          });
          consentAsk = null;
          if (ok) giveConsent(baseUrl);
          refreshSoon();
          return ok;
        },
        applyPlan: async (plan) => {
          const res = applyPlan({
            plan,
            chart: preview.chart,
            timeline,
            preview,
            refreshAll,
          });
          setStatus(`${res.label}：已应用 ${res.applied} 处改动${res.failed.length ? `，${res.failed.length} 处失败` : ''}（可撤销）`);
          return res;
        },
        onEvent: () => {
          refreshSoon();
          persistSoon();
        },
      }),
  });

  /** 当前活动对话的 session（面板各处都从它取状态） */
  const session = () => store.activeSession();

  /** 载入项目后由 main.js 调用：绑定项目（读缓存 + 项目内嵌存档），恢复对话 */
  async function bindProject(p) {
    const chart = p?.chart;
    if (!chart) return;
    try {
      await store.bind(chart);
    } catch (err) {
      console.warn('[ai] 对话历史载入失败：', err?.message ?? err);
    }
    refreshSoon();
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  const refreshSoon = () => {
    if (rafId) return;
    const schedule = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(() => fn(0), 16));
    rafId = schedule(() => {
      rafId = 0;
      refresh();
    });
  };

  /** 运行中的「正在做什么 + 已等待多久」（本地模型首次请求要加载，秒数很重要） */
  function liveText() {
    const snap = session().snapshot();
    if (snap.retrying) return `连接中断，正在重连（${snap.retrying.attempt}/${snap.retrying.max}）…`;
    if (!snap.running) return '';
    const p = snap.phase ?? { kind: 'idle', name: '', startedAt: Date.now() };
    const secs = Math.max(0, (Date.now() - (p.startedAt || Date.now())) / 1000);
    const base =
      p.kind === 'tool'
        ? `${TOOL_LABELS[p.name] ?? PHASE_TEXT.tool}`
        : PHASE_TEXT[p.kind] || '处理中';
    const slow = secs > 8 && (p.kind === 'requesting' || p.kind === 'preparing');
    return `${base}…${slow ? '（首次请求可能正在加载模型）' : ''} ${secs.toFixed(1)}s`;
  }

  /** 只更新底部那一行状态，不重建整个消息列表（避免打断向上翻阅） */
  function renderLive(host) {
    if (!host) return;
    const text = liveText();
    if (!text) {
      mounted.liveRow?.remove?.();
      mounted.liveRow = null;
      mounted.liveText = null;
      return;
    }
    if (!mounted.liveRow) {
      const row = el('div', 'ed-ai-live');
      const txt = el('span', 'text');
      row.append(el('span', 'dot'), txt);
      mounted.liveRow = row;
      mounted.liveText = txt;
    }
    mounted.liveText.textContent = text;
    if (host.lastElementChild !== mounted.liveRow) host.appendChild(mounted.liveRow);
  }

  let liveTimer = 0;
  function syncLiveTimer() {
    const want = session().running && mounted;
    if (want && !liveTimer) {
      liveTimer = setInterval(() => renderLive(mounted?.list), 400);
      return;
    }
    if (!want && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = 0;
    }
  }

  function statusOf() {
    if (!String(settings.baseUrl ?? '').trim() || !String(settings.model ?? '').trim()) return { state: 'nokey', text: '未配置：填 Base URL 与模型名' };
    const s = session();
    if (s.running) return { state: 'running', text: liveText() || '请求中…（可停止）' };
    if (s.error) return { state: 'error', text: `错误：${s.error.message}${s.error.hint ? `（${s.error.hint}）` : ''}` };
    if (s.plan) return { state: 'ready', text: `有 ${s.plan.count} 处待应用改动` };
    const u = s.snapshot().usage;
    return { state: 'ready', text: u.total ? `就绪 · 累计已用 ${fmtTokens(u.total)} tokens` : '就绪' };
  }

  /** 左侧对话侧边栏：新建 + 对话列表（点条目切换，悬停出 改名 / 删除） */
  function renderConversations(host) {
    host.innerHTML = '';
    const head = el('div', 'ed-ai-conv-head');
    head.appendChild(el('span', 'label', '对话'));
    const addBtn = document.createElement('button');
    addBtn.className = 'ed-iconbtn';
    addBtn.type = 'button';
    addBtn.title = '新建对话';
    addBtn.dataset.ai = 'conv-new';
    addBtn.appendChild(icon('add', { size: 14 }));
    addBtn.addEventListener('click', async () => {
      if (session().running) return;
      store.create();
      await store.persist();
      refresh();
    });
    head.appendChild(addBtn);
    host.appendChild(head);

    const list = el('div', 'ed-ai-conv-list');
    const running = session().running;
    for (const c of store.list()) {
      const item = el('div', `ed-ai-conv-item${c.active ? ' active' : ''}`);
      item.title = `${c.title}\n${c.count} 条消息 · 累计 ${fmtTokens(c.total)} tokens`;
      const info = el('div', 'info');
      info.appendChild(el('span', 't', c.title));
      info.appendChild(el('span', 'm', `${c.count} 条`));
      item.appendChild(info);
      item.addEventListener('click', async () => {
        if (store.switchTo(c.id)) {
          await store.persist();
          refresh();
        }
      });
      if (!running) {
        const acts = el('span', 'acts');
        const renameBtn = document.createElement('button');
        renameBtn.className = 'ed-iconbtn';
        renameBtn.type = 'button';
        renameBtn.title = '重命名';
        renameBtn.appendChild(icon('configure', { size: 12 }));
        renameBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = globalThis.prompt?.('对话名称（留空恢复自动标题）：', c.title);
          if (name === null) return;
          store.rename(c.id, name);
          await store.persist();
          refresh();
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'ed-iconbtn';
        delBtn.type = 'button';
        delBtn.title = '删除对话（不可恢复）';
        delBtn.appendChild(icon('delete', { size: 12 }));
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // 两步确认：第一下点亮红色，3 秒内再点才真删
          if (deleteArm !== c.id) {
            deleteArm = c.id;
            delBtn.classList.add('arm');
            setTimeout(() => {
              if (deleteArm === c.id) {
                deleteArm = '';
                delBtn.classList.remove('arm');
              }
            }, 3000);
            return;
          }
          deleteArm = '';
          store.remove(c.id);
          await store.persist();
          setStatus('对话已删除。');
          refresh();
        });
        acts.append(renameBtn, delBtn);
        item.appendChild(acts);
      }
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  function renderTranscript(host) {
    const stick = host.scrollHeight - host.scrollTop - host.clientHeight < 40 || !host.children.length;
    mounted.liveRow = null;
    host.innerHTML = '';
    const items = session().snapshot().transcript;
    items.forEach((item, index) => {
      if (item.role === 'tool') {
        const row = el('div', `ed-ai-tool${item.ok ? '' : ' bad'}`);
        row.appendChild(el('span', 'dot', item.ok ? '·' : '×'));
        row.appendChild(el('span', 'text', item.text));
        if (item.raw) {
          const det = document.createElement('details');
          det.appendChild(el('summary', '', '原始结果'));
          const pre = document.createElement('pre');
          pre.textContent = item.raw;
          det.appendChild(pre);
          row.appendChild(det);
        }
        host.appendChild(row);
        return;
      }
      const row = el('div', `ed-ai-msg ${item.role}`);
      if (item.role === 'system') row.classList.add('note');
      const body = el('span', 'ed-ai-msg-body');
      body.textContent = item.streaming ? `${item.text || ''}▍` : item.text; // 流式光标
      row.appendChild(body);
      // 每条消息的行内操作：复制全文 / 从这里分支（悬停显示）
      if (!item.streaming && item.text && (item.role === 'user' || item.role === 'assistant')) {
        const actions = el('span', 'ed-ai-msg-actions');
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ed-iconbtn';
        copyBtn.type = 'button';
        copyBtn.title = '复制这条消息';
        copyBtn.appendChild(icon('copy', { size: 11 }));
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await copyText(item.text);
          setStatus(ok ? '已复制消息。' : '复制失败：浏览器不允许访问剪贴板。');
        });
        const branchBtn = document.createElement('button');
        branchBtn.className = 'ed-iconbtn';
        branchBtn.type = 'button';
        branchBtn.title = '以这条消息为终点开一个新对话（保留之前的上下文）';
        branchBtn.appendChild(icon('layer', { size: 11 }));
        branchBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (session().running) return;
          const data = session().sliceTo(index);
          store.create(data);
          await store.persist();
          setStatus('已从这条消息分支出新对话。');
          refresh();
        });
        actions.append(copyBtn, branchBtn);
        row.appendChild(actions);
      }
      host.appendChild(row);
    });
    renderLive(host);
    if (stick) host.scrollTop = host.scrollHeight; // 只在自己已经在底部时跟随，避免打断向上翻阅
  }

  /** 统计行：本轮 / 累计 token、费用与限额、上下文占用比例（操作按钮在底部输入区那一排） */
  function renderStats(host) {
    host.innerHTML = '';
    const s = session();
    const snap = s.snapshot();
    const cs = s.contextStats();
    const parts = [`本轮 ${fmtTokens(snap.turnUsage.total)}`, `累计 ${fmtTokens(snap.usage.total)}`];
    const cost = costOf(snap.usage, settings);
    if (settings.priceIn > 0 || settings.priceOut > 0) {
      parts.push(settings.spendLimit > 0 ? `${fmtCost(cost)}/${fmtCost(settings.spendLimit)}` : fmtCost(cost));
    }
    const pct = Math.round(cs.ratio * 100);
    parts.push(`上下文 ${fmtTokens(cs.used)}/${fmtTokens(cs.budget)}（${pct}%）`);
    if (cs.trimmed > 0) parts.push(`已裁剪早期 ${cs.trimmed} 条`);
    host.appendChild(el('span', `ed-ai-stats-text${cs.ratio >= 0.85 ? ' warn' : ''}`, parts.join(' · ')));
  }

  function renderPlan(host) {
    host.innerHTML = '';
    const plan = session().plan;
    host.classList.toggle('hidden', !plan);
    if (!plan) return;
    const head = el('div', 'ed-ai-plan-head', `将应用 ${plan.count} 处改动`);
    host.appendChild(head);
    const list = el('div', 'ed-ai-plan-list');
    for (const g of plan.summary ?? []) {
      const row = el('div', `ed-ai-plan-item${g.danger ? ' bad' : ''}`);
      row.appendChild(el('span', 'label', g.label));
      row.appendChild(el('span', 'count', `${g.count} 个`));
      list.appendChild(row);
    }
    if (plan.span) list.appendChild(el('div', 'ed-ai-plan-span', `拍区间 ${plan.span.from} ~ ${plan.span.to}`));
    if (plan.reasons?.length) list.appendChild(el('div', 'ed-ai-plan-span', plan.reasons[0]));
    host.appendChild(list);
    const actions = el('div', 'ed-ai-plan-actions');
    const applyBtn = el('button', 'ed-btn primary', '应用');
    applyBtn.type = 'button';
    applyBtn.dataset.ai = 'apply';
    applyBtn.disabled = session().running;
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      const res = await session().applyPending();
      if (!res?.ok) setStatus(`应用改动未完成：${res?.reason ?? '未知原因'}`);
      // 成功时 session 会清掉计划，卡片随之消失（结果作为系统消息留在对话里）
    });
    const discard = el('button', 'ed-btn', '放弃');
    discard.type = 'button';
    discard.dataset.ai = 'discard';
    discard.addEventListener('click', () => {
      session().discardPending();
      setStatus('已放弃这次改动。');
    });
    actions.append(applyBtn, discard);
    host.appendChild(actions);
    host.appendChild(el('div', 'ed-hint', '应用后整批只占一步撤销（结果会留在对话里）。'));
  }

  function renderConsent(host) {
    host.innerHTML = '';
    host.classList.toggle('hidden', !consentAsk);
    if (!consentAsk) return;
    host.appendChild(el('div', 'ed-ai-consent-text', `把谱面数据发送给 ${consentAsk.host}？只发送当前谱面的文字信息与工具结果，不发送音频与曲绘。`));
    const ok = el('button', 'ed-btn primary', '同意并发送');
    ok.type = 'button';
    ok.dataset.ai = 'consent-ok';
    ok.addEventListener('click', () => consentAsk?.resolve(true));
    const no = el('button', 'ed-btn', '取消');
    no.type = 'button';
    no.dataset.ai = 'consent-no';
    no.addEventListener('click', () => consentAsk?.resolve(false));
    host.append(ok, no);
  }

  function renderSettings(host) {
    host.innerHTML = '';
    const form = createForm();
    const url = document.createElement('input');
    url.className = 'ed-text';
    url.type = 'text';
    url.value = settings.baseUrl ?? '';
    url.placeholder = 'https://api.deepseek.com';
    url.setAttribute('list', 'ed-ai-baseurls');
    url.addEventListener('change', () => {
      settings = saveSettings({ baseUrl: url.value.trim() });
      refresh();
    });
    form.row('Base URL', url, '只允许 https；本机调试可用 http://127.0.0.1');

    const datalist = document.createElement('datalist');
    datalist.id = 'ed-ai-baseurls';
    for (const h of BASE_URL_HINTS) {
      const opt = document.createElement('option');
      opt.value = h.url;
      opt.label = h.model;
      datalist.appendChild(opt);
    }
    form.form.appendChild(datalist);

    const model = document.createElement('input');
    model.className = 'ed-text';
    model.type = 'text';
    model.value = settings.model ?? '';
    model.placeholder = 'deepseek-chat';
    model.addEventListener('change', () => {
      settings = saveSettings({ model: model.value.trim() });
      refresh();
    });
    form.row('模型', model, '需支持工具调用');

    const key = document.createElement('input');
    key.className = 'ed-text';
    key.type = 'password';
    key.value = apiKey;
    key.placeholder = '留空 = 不发送 Authorization（本地端点）';
    key.addEventListener('change', async () => {
      apiKey = key.value.trim();
      keyLoaded = true;
      await saveKey(apiKey, { remember: settings.rememberKey });
      setStatus('密钥已保存（仅本机浏览器）。');
      refresh();
    });
    form.row('API key', key, '只保存在本机浏览器，不会写入项目文件或导出内容');

    const remember = form.check({
      checked: !!settings.rememberKey,
      hintText: '存 IndexedDB（否则只保留到关闭标签页）',
      onChange: async (on) => {
        settings = saveSettings({ rememberKey: on });
        await saveKey(apiKey, { remember: on });
        refresh();
      },
    });
    form.row('记住这台设备', remember);

    const rounds = form.number({
      value: settings.maxRounds,
      step: '1',
      min: 1,
      onChange: (v) => {
        settings = saveSettings({ maxRounds: v });
        refresh();
      },
    });
    form.row('单回合工具轮数上限', rounds);

    const limit = form.number({
      value: settings.writeLimit,
      step: '10',
      min: 1,
      onChange: (v) => {
        settings = saveSettings({ writeLimit: v });
        refresh();
      },
    });
    form.row('单次改动上限', limit);

    // ── 上下文与费用（按用户填写的模型参数做裁剪 / 计费 / 限额） ──
    const ctxTok = form.number({
      value: settings.contextTokens,
      step: '4096',
      min: 2048,
      onChange: (v) => {
        settings = saveSettings({ contextTokens: v });
        refresh();
      },
    });
    form.row('上下文大小（token）', ctxTok, '按模型窗口填；历史超限时自动裁掉最早的消息');

    const timeout = form.number({
      value: settings.requestTimeoutSec,
      step: '10',
      min: 5,
      onChange: (v) => {
        settings = saveSettings({ requestTimeoutSec: v });
        refresh();
      },
    });
    form.row('请求超时（秒）', timeout);

    const priceIn = form.number({
      value: settings.priceIn,
      step: '0.1',
      min: 0,
      onChange: (v) => {
        settings = saveSettings({ priceIn: v });
        refresh();
      },
    });
    form.row('单价 · 输入（元/百万 token）', priceIn, '两个单价都填了才显示费用');

    const priceOut = form.number({
      value: settings.priceOut,
      step: '0.1',
      min: 0,
      onChange: (v) => {
        settings = saveSettings({ priceOut: v });
        refresh();
      },
    });
    form.row('单价 · 输出（元/百万 token）', priceOut);

    const spend = form.number({
      value: settings.spendLimit,
      step: '1',
      min: 0,
      onChange: (v) => {
        settings = saveSettings({ spendLimit: v });
        refresh();
      },
    });
    form.row('花费限额（元）', spend, '累计费用达到后停止发送；0 = 不限额');

    const actions = el('div', 'ed-ai-settings-actions');
    const local = el('button', 'ed-btn small', '本地调试预填');
    local.type = 'button';
    local.dataset.ai = 'local-debug';
    local.title = '填入本机 llama.cpp 端点（无密钥）';
    local.addEventListener('click', async () => {
      settings = saveSettings({ baseUrl: LOCAL_DEBUG.baseUrl, model: LOCAL_DEBUG.model });
      apiKey = LOCAL_DEBUG.apiKey;
      keyLoaded = true;
      await clearKey();
      setStatus('已填入本地调试端点。');
      renderSettings(host);
      refresh();
    });
    const test = el('button', 'ed-btn small', '测试连接');
    test.type = 'button';
    test.dataset.ai = 'test';
    test.addEventListener('click', async () => {
      test.disabled = true;
      setStatus('测试连接中…');
      try {
        const out = await streamChat({
          fetchImpl: (...a) => globalThis.fetch(...a),
          url: endpointUrl(settings.baseUrl),
          apiKey: apiKey || (await loadKey()),
          model: settings.model,
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 4,
        });
        setStatus(`连接成功（返回 ${out.text ? out.text.length : 0} 字符）。`);
      } catch (err) {
        setStatus(`连接失败：${err?.message ?? err}`);
      } finally {
        test.disabled = false;
      }
    });
    const clear = el('button', 'ed-btn small', '清除密钥');
    clear.type = 'button';
    clear.dataset.ai = 'clear-key';
    clear.addEventListener('click', async () => {
      apiKey = '';
      keyLoaded = true;
      await clearKey();
      setStatus('密钥已清除。');
      renderSettings(host);
      refresh();
    });
    actions.append(local, test, clear);
    form.form.appendChild(actions);
    host.appendChild(form.form);

    const note = el('div', 'ed-hint', '');
    hasRememberedKey().then((has) => {
      note.textContent = has ? '这台设备上存有密钥（IndexedDB），可随时清除。' : '密钥只保存在本会话（sessionStorage），关闭标签页即失效。';
    });
    host.appendChild(note);
  }

  function refresh() {
    if (!mounted || !store.loaded) return;
    const s = session();
    const st = statusOf();
    mounted.dot.dataset.state = st.state;
    mounted.dot.title = STATE_LABEL[st.state] ?? '';
    mounted.sub.textContent = `${settings.model || '—'} · ${hostOf(settings.baseUrl) ?? '未设置端点'}`;
    mounted.status.textContent = st.text;
    mounted.sendBtn.disabled = s.running || st.state === 'nokey';
    mounted.stopBtn.classList.toggle('hidden', !s.running);
    mounted.retryBtn.classList.toggle('hidden', !s.snapshot().retryable);
    mounted.retryBtn.disabled = s.running;
    mounted.ctxBtn.disabled = s.running;
    mounted.clearBtn.disabled = s.running;
    renderConversations(mounted.convList);
    renderStats(mounted.stats);
    renderTranscript(mounted.list);
    renderPlan(mounted.plan);
    renderConsent(mounted.consent);
    syncLiveTimer();
    // 设置区只在展开 / 配置变化时重建：每次事件都重建会把输入焦点与光标位置弄丢
  }

  function render(root) {
    root.innerHTML = '';
    if (liveTimer) {
      clearInterval(liveTimer); // 切换标签页会重建 DOM：先停掉指向旧节点的计时器
      liveTimer = 0;
    }
    mounted = null;
    const wrap = el('div', 'ed-scroll ed-ai');
    root.appendChild(wrap);

    // 左侧：对话侧边栏（多对话切换 / 新建 / 改名 / 删除）
    const convList = el('div', 'ed-ai-conv');
    wrap.appendChild(convList);

    // 右侧：主区
    const main = el('div', 'ed-ai-main');
    wrap.appendChild(main);

    const head = el('div', 'ed-ai-head');
    const dot = el('span', 'ed-ai-dot');
    const title = el('span', 'ed-ai-title', 'AI 助手');
    const sub = el('span', 'ed-ai-sub');
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'ed-iconbtn';
    settingsBtn.type = 'button';
    settingsBtn.title = '设置（端点 / 模型 / 上下文与费用）';
    settingsBtn.dataset.ai = 'settings';
    settingsBtn.appendChild(icon('configure', { size: 15 }));
    const settingsBox = el('div', 'ed-ai-settings hidden');
    settingsBtn.addEventListener('click', () => {
      mounted.settingsOpen = !mounted.settingsOpen;
      settingsBox.classList.toggle('hidden', !mounted.settingsOpen);
      settingsBtn.classList.toggle('open', mounted.settingsOpen);
      if (mounted.settingsOpen) renderSettings(settingsBox);
    });
    head.append(dot, title, el('span', 'grow'), sub, settingsBtn);
    main.append(head, settingsBox);

    const list = el('div', 'ed-ai-list');
    const stats = el('div', 'ed-ai-stats');
    const plan = el('div', 'ed-ai-plan hidden');
    const consent = el('div', 'ed-ai-consent hidden');
    const compose = el('div', 'ed-ai-compose');
    const input = document.createElement('textarea');
    input.className = 'ed-ai-input';
    input.rows = 3;
    input.placeholder = '描述要写或要改什么；Enter 发送，Shift+Enter 换行';
    input.value = draft;
    input.addEventListener('input', () => {
      draft = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void doSend();
      }
    });
    const row = el('div', 'ed-ai-row');
    const sendBtn = el('button', 'ed-btn primary', '发送');
    sendBtn.type = 'button';
    sendBtn.dataset.ai = 'send';
    const stopBtn = el('button', 'ed-btn hidden', '停止');
    stopBtn.type = 'button';
    stopBtn.dataset.ai = 'stop';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'ed-iconbtn';
    retryBtn.type = 'button';
    retryBtn.dataset.ai = 'retry';
    retryBtn.title = '重发上一条消息（会先回滚失败的那一轮，不会重复）';
    retryBtn.appendChild(icon('return', { size: 14 }));
    const status = el('span', 'ed-ai-status');
    const ctxBtn = document.createElement('button');
    ctxBtn.className = 'ed-iconbtn';
    ctxBtn.type = 'button';
    ctxBtn.dataset.ai = 'copy-context';
    ctxBtn.title = '复制上下文：把当前发给模型的完整内容（系统提示 + 历史）复制为 JSON';
    ctxBtn.appendChild(icon('copy', { size: 14 }));
    ctxBtn.addEventListener('click', async () => {
      try {
        const data = await session().peekContext();
        const ok = await copyText(JSON.stringify(data, null, 2));
        setStatus(ok ? `已复制上下文（${data.length} 条消息）。` : '复制失败：浏览器不允许访问剪贴板。');
      } catch (err) {
        setStatus(`复制上下文失败：${err?.message ?? err}`);
      }
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'ed-iconbtn';
    clearBtn.type = 'button';
    clearBtn.dataset.ai = 'clear-conv';
    clearBtn.title = '清空当前对话的消息与统计（不影响其它对话）';
    clearBtn.appendChild(icon('delete', { size: 14 }));
    clearBtn.addEventListener('click', () => {
      session().reset();
      setStatus('当前对话已清空。');
      refresh();
    });
    row.append(sendBtn, stopBtn, retryBtn, status, ctxBtn, clearBtn);
    compose.append(input, row);
    main.append(list, stats, plan, consent, compose);

    async function doSend() {
      const text = input.value.trim();
      if (!text || session().running) return;
      draft = '';
      input.value = '';
      await session().send(text);
    }
    sendBtn.addEventListener('click', () => void doSend());
    stopBtn.addEventListener('click', () => session().stop());
    retryBtn.addEventListener('click', () => void session().retry());

    mounted = {
      dot, sub, status, list, stats, plan, consent, settings: settingsBox, settingsOpen: false,
      sendBtn, stopBtn, retryBtn, ctxBtn, clearBtn, input, convList,
    };
    // 首次挂载时读一次密钥（异步，读到后刷新设置区）
    if (!keyLoaded) {
      void loadKey().then((k) => {
        apiKey = k;
        keyLoaded = true;
        refresh();
      });
    }
    refresh();
    return { refresh };
  }

  return {
    render,
    /** 兼容旧用法（测试钩子等）：当前活动对话的 session */
    get session() {
      return session();
    },
    store,
    /** 载入项目后调用（main.js afterLoad）：恢复该项目绑定的对话历史 */
    bindProject,
    /** 保存项目前调用（export-tab）：把对话存档挂到 chart 上随项目写入 */
    exportForSave() {
      return store.exportArchive();
    },
    /** 供测试与外部（纠错页「让 AI 修」）使用：把文字放进输入框 */
    fillInput(text) {
      draft = String(text ?? '');
      if (mounted?.input) mounted.input.value = draft;
      refresh();
      return draft;
    },
    get settings() {
      return settings;
    },
  };
}
