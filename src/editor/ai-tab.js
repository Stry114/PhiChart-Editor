/**
 * 「AI 助手」标签页（左上工作区，见 docs/LLM辅助写谱方案.md §8）。
 *
 * 面板只是**状态的外显**：对话、待应用计划、设置都存在模块级状态（`createSession` + `config.js`）里，
 * 因为 `tabs.js` 每次切回来都会清空并重渲染标签体。所有来自对话 / 谱面的文字都用 `textContent` 渲染。
 */
import { el, createForm } from './detail-common.js';
import { createSession } from '../ai/session.js';
import { applyPlan } from './ai-apply.js';
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

export function createAiPanel(deps) {
  const { preview, timeline, lint, setStatus, refreshAll, getLoadedLine } = deps;
  let settings = loadSettings();
  let apiKey = '';
  let keyLoaded = false;
  let draft = ''; // 输入框草稿（标签页重渲染后恢复）
  let consentAsk = null; // { host, resolve }
  let mounted = null; // 当前挂载的容器引用集合
  let rafId = 0;

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

  const session = createSession({
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
    onEvent: () => refreshSoon(),
  });

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
    const snap = session.snapshot();
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
    const want = session.running && mounted;
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
    if (session.running) return { state: 'running', text: liveText() || '请求中…（可停止）' };
    if (session.error) return { state: 'error', text: `错误：${session.error.message}${session.error.hint ? `（${session.error.hint}）` : ''}` };
    if (session.plan) return { state: 'ready', text: `有 ${session.plan.count} 处待应用改动` };
    const u = session.snapshot().usage;
    return { state: 'ready', text: u.total ? `就绪 · 本轮已用 ${u.total} tokens` : '就绪' };
  }

  function renderTranscript(host) {
    const stick = host.scrollHeight - host.scrollTop - host.clientHeight < 40 || !host.children.length;
    mounted.liveRow = null;
    host.innerHTML = '';
    const items = session.snapshot().transcript;
    for (const item of items) {
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
        continue;
      }
      const row = el('div', `ed-ai-msg ${item.role}`);
      if (item.role === 'system') row.classList.add('note');
      row.textContent = item.streaming ? `${item.text || ''}▍` : item.text; // 流式光标
      host.appendChild(row);
    }
    renderLive(host);
    if (stick) host.scrollTop = host.scrollHeight; // 只在自己已经在底部时跟随，避免打断向上翻阅
  }

  function renderPlan(host) {
    host.innerHTML = '';
    const plan = session.plan;
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
    applyBtn.disabled = session.running;
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      const res = await session.applyPending();
      if (!res?.ok) setStatus(`应用改动未完成：${res?.reason ?? '未知原因'}`);
      // 成功时 session 会清掉计划，卡片随之消失（结果作为系统消息留在对话里）
    });
    const discard = el('button', 'ed-btn', '放弃');
    discard.type = 'button';
    discard.dataset.ai = 'discard';
    discard.addEventListener('click', () => {
      session.discardPending();
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
      setStatus(apiKey ? '密钥已保存（仅本机浏览器）。' : '密钥已清空。');
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
    if (!mounted) return;
    const st = statusOf();
    mounted.dot.dataset.state = st.state;
    mounted.dot.title = STATE_LABEL[st.state] ?? '';
    mounted.sub.textContent = `${settings.model || '—'} · ${hostOf(settings.baseUrl) ?? '未设置端点'}`;
    mounted.status.textContent = st.text;
    mounted.sendBtn.disabled = session.running || st.state === 'nokey';
    mounted.stopBtn.classList.toggle('hidden', !session.running);
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

    const head = el('div', 'ed-ai-head');
    const dot = el('span', 'ed-ai-dot');
    const title = el('span', 'ed-ai-title', 'AI 助手');
    const sub = el('span', 'ed-ai-sub');
    const settingsBtn = el('button', 'ed-btn small', '设置');
    settingsBtn.type = 'button';
    settingsBtn.dataset.ai = 'settings';
    const settingsBox = el('div', 'ed-ai-settings hidden');
    settingsBtn.addEventListener('click', () => {
      mounted.settingsOpen = !mounted.settingsOpen;
      settingsBox.classList.toggle('hidden', !mounted.settingsOpen);
      settingsBtn.textContent = mounted.settingsOpen ? '收起设置' : '设置';
      if (mounted.settingsOpen) renderSettings(settingsBox);
    });
    head.append(dot, title, el('span', 'grow'), sub, settingsBtn);
    wrap.append(head, settingsBox);

    const list = el('div', 'ed-ai-list');
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
    const status = el('span', 'ed-ai-status');
    row.append(sendBtn, stopBtn, status);
    compose.append(input, row);
    wrap.append(list, plan, consent, compose);

    async function doSend() {
      const text = input.value.trim();
      if (!text || session.running) return;
      draft = '';
      input.value = '';
      await session.send(text);
    }
    sendBtn.addEventListener('click', () => void doSend());
    stopBtn.addEventListener('click', () => session.stop());

    mounted = { dot, sub, status, list, plan, consent, settings: settingsBox, settingsOpen: false, sendBtn, stopBtn, input };
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
    session,
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
