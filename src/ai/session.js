/**
 * AI 会话状态机（见 docs/LLM辅助写谱方案.md §4.2、§6.3）。
 *
 * 无 DOM、无第三方依赖：`fetch` 与编辑器侧的三个回调都由调用方注入。
 * 一条主线：发消息 → 单次流式请求 + 工具循环（≤ maxRounds）→ 只读工具立刻执行、写工具只登记计划
 * → 回合结束后由用户点「应用」→ 追加一条系统消息（**不自动继续回合**）。
 *
 * 稳健性：
 *  - 单条请求内建**自动重连**：网络抖动 / 超时 / 限流 / 5xx 时按退避重试（最多 3 次），
 *    半截流式文本会在重试前清掉（服务端无断点续传，只能整条重发）；
 *  - 重试仍失败时回滚到**回合开始前**的状态并标记「可重试」，用户点「重试」重新发起，
 *    不会像以前那样把 user 消息重复留在 messages 里；
 *  - transcript 每项带 `miEnd`（对应 messages 的写入位置），供「从这条消息分支」按
 *    API 消息边界精确截断。
 */
import { streamChat, errorHint, redact } from './protocol.js';
import { loadSystemPrompt, buildContextBlock } from './prompt.js';
import { TOOLS, runTool, toolResultText, CAPS, ToolError, WRITE_TOOLS } from './tools.js';
import { estimateTokens, trimMessages } from './tokens.js';

const WRITE_LABELS = {
  add_notes: '新增音符',
  edit_notes: '修改音符',
  edit_events: '编辑事件',
  set_meta: '改元数据',
};

/** 工具名 → 中文（界面上的「正在做什么」与工具活动行共用） */
export const TOOL_LABELS = {
  read_chart: '读取谱面',
  check_chart: '纠错扫描',
  add_notes: '登记新增音符',
  edit_notes: '登记修改音符',
  edit_events: '登记事件改动',
  set_meta: '登记元数据改动',
};

/** 阶段文案（界面状态行用） */
export const PHASE_TEXT = {
  idle: '',
  preparing: '准备提示词与上下文',
  requesting: '等待模型响应',
  streaming: '模型正在输出',
  tool: '执行工具',
};

/** 自动重连：最多重试次数与退避上限（600ms × 次数，封顶 3s） */
const MAX_AUTO_RETRIES = 3;
const RETRY_BACKOFF_MS = 600;
const RETRY_BACKOFF_MAX_MS = 3000;
/** 这几类错误值得自动重连（用户主动停止 / 密钥错误 / 参数错误重试也不会好） */
const RETRIABLE_KINDS = new Set(['cors', 'network', 'timeout', 'server', 'rate', 'http']);

/** 合并多条写工具的计划（一轮里可能调用多次） */
function mergePlans(plans) {
  const ops = [];
  const merged = { ops, summary: [], label: '', count: 0, lineIds: [], keys: [], notes: false, meta: false, reasons: [] };
  for (const p of plans) {
    if (!p) continue;
    ops.push(...(p.ops ?? []));
    for (const id of p.lineIds ?? []) if (!merged.lineIds.includes(id)) merged.lineIds.push(id);
    for (const k of p.keys ?? []) if (!merged.keys.includes(k)) merged.keys.push(k);
    merged.notes = merged.notes || !!p.notes;
    merged.meta = merged.meta || !!p.meta;
    if (p.reason) merged.reasons.push(String(p.reason).slice(0, 60));
  }
  const groups = new Map();
  for (const op of ops) {
    const g = groups.get(op.label) ?? { label: op.label, count: 0, danger: false };
    g.count += op.count ?? 1;
    g.danger = g.danger || !!op.danger;
    groups.set(op.label, g);
  }
  merged.summary = [...groups.values()];
  merged.count = ops.reduce((n, op) => n + (op.count ?? 1), 0);
  merged.label = merged.summary.length ? `AI：${merged.summary.map((g) => `${g.label} ${g.count} 个`).join('，')}` : 'AI 改动';
  return merged;
}

/** 工具活动行文案（界面显示用） */
function briefOf(name, args, result) {
  if (name === 'read_chart') {
    if (args?.query === 'idle') {
      return `查空闲判定线（${result?.window?.fromBeat ?? '?'}~${result?.window?.toBeat ?? '?'} 拍，空闲 ${result?.idleCount ?? 0} 条）`;
    }
    if (args?.lineId === undefined || args?.lineId === null) {
      const t = result?.totals;
      return t ? `读取谱面总览（${t.lines} 条线 / ${t.notes} 个音符）` : '读取谱面总览';
    }
    const w = result?.window;
    const notes = result?.notesTotal ?? result?.notes?.length ?? 0;
    const events = result?.events ? Object.values(result.events).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0) : 0;
    return `读取 ${Number(args.lineId) + 1} 号线 ${w ? `${w.fromBeat}~${w.toBeat} 拍` : ''}（音符 ${notes}，事件 ${events}）`;
  }
  if (name === 'check_chart') {
    const s = result?.summary;
    return s ? `纠错扫描（错误 ${s.error} / 警告 ${s.warn}）` : '纠错扫描';
  }
  return `登记 ${WRITE_LABELS[name] ?? name}（${result?.count ?? 0} 个）`;
}

/** 深拷贝（messages / transcript 都是纯 JSON 数据） */
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   fetchImpl:Function,
 *   getConfig:() => {baseUrl:string, model:string, maxRounds?:number, writeLimit?:number,
 *     contextTokens?:number, requestTimeoutSec?:number, priceIn?:number, priceOut?:number, spendLimit?:number},
 *   getKey:() => Promise<string>,
 *   getToolContext:() => {chart:object, viewport?:object, lintSummary?:Function},
 *   ensureConsent?:(baseUrl:string) => Promise<boolean>,
 *   applyPlan?:(plan:object) => Promise<{applied:number, failed:object[], label:string}>,
 *   now?:() => number,
 * }} ctx
 */
export function createSession(ctx = {}) {
  const fetchImpl = ctx.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  let messages = [];
  let transcript = [];
  let plan = null;
  let running = false;
  let error = null;
  let usage = { prompt: 0, completion: 0, total: 0 };
  /** 本回合消耗（usage 的回合增量；重试不回滚——token 已经真实消耗） */
  let turnUsage = { prompt: 0, completion: 0, total: 0 };
  let controller = null;
  /** 当前阶段（界面据此显示「正在做什么 + 已等待多久」） */
  let phase = { kind: 'idle', name: '', startedAt: 0 };
  /** 自动重连中：{ attempt, max, kind }；null = 没有 */
  let retrying = null;
  /** 上一回合失败后可重试：记录回滚点与用户消息 */
  let canRetry = null; // { content, msgLen, trLen }
  /** 最近一次请求的上下文裁剪情况（UI 显示「已裁剪早期 N 条」） */
  let trimmedCount = 0;

  const setPhase = (kind, name = '') => {
    phase = { kind, name, startedAt: Date.now() };
    emit({ type: 'phase', phase: { ...phase } });
  };

  const emit = (evt) => {
    try {
      ctx.onEvent?.(evt);
    } catch (err) {
      console.warn('[ai] onEvent 回调出错：', err?.message ?? err);
    }
  };

  /** transcript 每项都记下 miEnd（对应 messages 的写入位置），分支时按它截断 */
  const push = (role, text, extra = {}) => {
    transcript.push({ role, text: String(text ?? ''), at: Date.now(), miEnd: messages.length, ...extra });
  };

  /** 当前上下文块（每轮重新拼，保证模型看到的是最新状态） */
  const contextBlock = () => {
    const { chart, viewport } = ctx.getToolContext?.() ?? {};
    return buildContextBlock({
      chart,
      view: {
        currentBeat: viewport?.currentBeat,
        fromBeat: viewport?.fromBeat,
        toBeat: viewport?.toBeat,
        lineId: viewport?.lineId,
        selectionCount: viewport?.selectionCount,
      },
    });
  };

  /**
   * 组装 API 消息：系统提示 + 动态上下文 + 历史。
   * 历史按设置的上下文窗口裁剪（留 ~15% 给本轮输出），切口只落在消息边界的安全位置
   * （tool 与其 assistant.tool_calls 不会被拆开）。
   */
  const apiMessages = (systemPrompt) => {
    const sys = { role: 'system', content: `${systemPrompt}\n\n当前编辑器状态：\n${contextBlock()}` };
    const cfg = ctx.getConfig?.() ?? {};
    const contextTokens = Math.max(2048, Math.round(cfg.contextTokens ?? 65536));
    const budget = Math.max(1024, Math.round(contextTokens * 0.85) - estimateTokens(sys.content));
    const { messages: kept, dropped } = trimMessages(messages, budget);
    trimmedCount = dropped;
    return [sys, ...kept];
  };

  function fail(kind, message, detail = '') {
    error = { kind, message, hint: errorHint(kind), detail: redact(detail) };
    emit({ type: 'change' });
    return error;
  }

  /** 达到花费限额（设置里 >0 时启用）：阻止发送，已花的钱不退 */
  const overSpendLimit = () => {
    const cfg = ctx.getConfig?.() ?? {};
    const limit = Math.max(0, Number(cfg.spendLimit) || 0);
    if (!limit) return null;
    const cost = (usage.prompt / 1e6) * (cfg.priceIn ?? 0) + (usage.completion / 1e6) * (cfg.priceOut ?? 0);
    return cost >= limit ? cost : null;
  };

  /** 带自动重连的单条请求：半截输出在重试前清空（服务端不能续传，只能整条重发） */
  async function streamWithRetry(params, onDelta) {
    let attempt = 0;
    let lastErr = null;
    while (attempt <= MAX_AUTO_RETRIES) {
      if (controller.signal.aborted) {
        // 退避等待期间用户按了停止：按「已停止」结束，不要把上一次的网络错误当结果
        const e = new Error('已停止');
        e.kind = 'abort';
        throw e;
      }
      try {
        retrying = null;
        return await streamChat(params);
      } catch (err) {
        lastErr = err;
        if (controller.signal.aborted) throw err; // 用户停止：原样抛出
        attempt++;
        if (!RETRIABLE_KINDS.has(err?.kind) || attempt > MAX_AUTO_RETRIES) throw err;
        retrying = { attempt, max: MAX_AUTO_RETRIES, kind: err.kind };
        emit({ type: 'change' });
        await delay(Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_MS * attempt));
        onDelta(''); // 清掉上一次尝试的半截文本，从头接收
      }
    }
    throw lastErr;
  }

  /** 发送一条用户消息并跑完这一轮（含工具循环） */
  async function send(text) {
    const content = String(text ?? '').trim();
    if (!content) return { ok: false, reason: 'empty' };
    if (running) return { ok: false, reason: 'running' };
    const { chart } = ctx.getToolContext?.() ?? {};
    if (!chart?.lines?.length) {
      fail('no_chart', '还没有载入谱面');
      return { ok: false, reason: 'no_chart' };
    }
    const cfg = ctx.getConfig?.() ?? {};
    if (!String(cfg.baseUrl ?? '').trim() || !String(cfg.model ?? '').trim()) {
      fail('no_config', '还没配置 Base URL 或模型');
      return { ok: false, reason: 'no_config' };
    }
    const spent = overSpendLimit();
    if (spent !== null) {
      fail('limit', `已达到花费限额（设置里可调整或关闭）`);
      return { ok: false, reason: 'limit' };
    }
    if (ctx.ensureConsent && !(await ctx.ensureConsent(cfg.baseUrl))) {
      fail('consent', '尚未确认把谱面数据发送给该服务');
      return { ok: false, reason: 'consent' };
    }

    error = null;
    canRetry = null;
    running = true;
    controller = new AbortController();
    // 回合起点（失败回滚用）：重试时截回到这里，user 消息不会重复
    const msgLen = messages.length;
    const trLen = transcript.length;
    turnUsage = { prompt: 0, completion: 0, total: 0 };
    messages.push({ role: 'user', content });
    push('user', content);
    setPhase('preparing');
    emit({ type: 'change' });

    try {
      await runTurn(content, cfg);
    } catch (err) {
      // 保留半截输出（用户能看到模型说到哪），但标记可重试：回滚点就是回合起点
      canRetry = { content, msgLen, trLen };
      fail(err?.kind ?? 'http', err?.message ?? '请求失败', err?.detail ?? '');
      return { ok: false, reason: err?.kind ?? 'http' };
    } finally {
      running = false;
      controller = null;
      retrying = null;
      setPhase('idle');
      emit({ type: 'change' });
    }
    return { ok: true, plan };
  }

  /** 工具循环本体：send / retry 共用。调用前 user 消息必须已在 messages 里 */
  async function runTurn(content, cfg) {
    // 系统提示词内嵌在 src/ai/prompt.js 的 SYSTEM_PROMPT（内置缓存）
    const systemPrompt = await loadSystemPrompt(fetchImpl);
    const maxRounds = Math.max(1, Math.min(24, Math.round(cfg.maxRounds ?? 8)));
    const timeoutMs = Math.max(5, Math.round(cfg.requestTimeoutSec ?? 120)) * 1000;
    const pendingPlans = [];
    let rounds = 0;
    for (; rounds < maxRounds; rounds++) {
      const apiKey = (await ctx.getKey?.()) ?? '';
      setPhase('requesting');
      /** 流式上屏：重试时用 onDelta('') 清掉半截文本 */
      const onDelta = (t) => {
        const last = transcript[transcript.length - 1];
        if (last?.role === 'assistant' && last.streaming) last.text = t;
        else transcript.push({ role: 'assistant', text: t, streaming: true, at: Date.now(), miEnd: messages.length });
        if (phase.kind !== 'streaming') setPhase('streaming');
        emit({ type: 'delta' });
      };
      const stream = await streamWithRetry(
        {
          fetchImpl,
          url: requireUrl(cfg.baseUrl),
          apiKey,
          model: cfg.model,
          messages: apiMessages(systemPrompt),
          tools: TOOLS,
          signal: controller.signal,
          timeoutMs,
          onText: onDelta,
        },
        onDelta,
      );

      if (stream.usage) {
        usage = {
          prompt: usage.prompt + (stream.usage.prompt_tokens ?? 0),
          completion: usage.completion + (stream.usage.completion_tokens ?? 0),
          total: usage.total + (stream.usage.total_tokens ?? 0),
        };
        turnUsage = {
          prompt: turnUsage.prompt + (stream.usage.prompt_tokens ?? 0),
          completion: turnUsage.completion + (stream.usage.completion_tokens ?? 0),
          total: turnUsage.total + (stream.usage.total_tokens ?? 0),
        };
      }
      const last = transcript[transcript.length - 1];
      if (last?.streaming) {
        last.streaming = false;
        last.text = stream.text;
        if (!stream.toolCalls?.length) {
          messages.push({ role: 'assistant', content: stream.text || '' });
          last.miEnd = messages.length;
        }
        if (!last.text && !stream.toolCalls?.length) transcript.pop();
      } else if (stream.text || stream.toolCalls?.length) {
        if (stream.text) push('assistant', stream.text);
      }
      if (!stream.toolCalls?.length) {
        if (!(last?.role === 'assistant' && !last.streaming)) {
          // 没有流式行也没有文本：补一条空的 assistant 消息占位（协议要求 assistant 回合有回应）
          if (!stream.text) messages.push({ role: 'assistant', content: '' });
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: stream.text || null,
        tool_calls: stream.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });

      for (const call of stream.toolCalls) {
        const args = call.args ?? {};
        let out = null;
        let ok = true;
        setPhase('tool', call.name);
        try {
          if (call.argsError) throw new ToolError(call.argsError);
          out = runTool(call.name, args, ctx.getToolContext?.() ?? {});
        } catch (err) {
          ok = false;
          const message = err instanceof ToolError ? err.message : `工具执行失败：${redact(err?.message ?? err)}`;
          out = { ok: false, result: { ok: false, error: message } };
        }
        if (ok && out.pending && out.plan) {
          const merged = mergePlans([...pendingPlans, out.plan]);
          if (merged.count > CAPS.plan) {
            out = { ok: false, result: { ok: false, error: `这一轮改动累计超过 ${CAPS.plan} 个对象，已拒绝；请拆分后再改。` } };
            ok = false;
          } else {
            pendingPlans.push(out.plan);
          }
        }
        const brief = ok ? briefOf(call.name, args, out.result) : `${call.name}：${out.result.error}`;
        const rawText = toolResultText(out.result);
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(out.result) });
        push('tool', brief, { ok, name: call.name, raw: rawText.length > 2000 ? `${rawText.slice(0, 2000)}…` : rawText });
        emit({ type: 'tool', name: call.name, ok, brief });
      }
    }

    if (rounds >= maxRounds) {
      push('system', `达到单回合工具调用上限（${maxRounds} 轮），已停止本轮。`);
    }
    if (pendingPlans.length) {
      plan = { ...mergePlans(pendingPlans), planChart: ctx.getToolContext?.().chart ?? null, createdAt: Date.now(), applied: false };
      emit({ type: 'plan', plan });
    }
  }

  /** 重试上一回合：回滚到回合开始前再重发（不产生重复的 user 消息） */
  async function retry() {
    if (running || !canRetry) return { ok: false, reason: 'not_retryable' };
    const cfg = ctx.getConfig?.() ?? {};
    if (!String(cfg.baseUrl ?? '').trim() || !String(cfg.model ?? '').trim()) {
      fail('no_config', '还没配置 Base URL 或模型');
      return { ok: false, reason: 'no_config' };
    }
    const spent = overSpendLimit();
    if (spent !== null) {
      fail('limit', '已达到花费限额（设置里可调整或关闭）');
      return { ok: false, reason: 'limit' };
    }
    const { content, msgLen, trLen } = canRetry;
    canRetry = null;
    error = null;
    // 回滚：上半回合的半截输出（含错误后的状态）全部丢弃，usage 不回滚（token 已真实消耗）
    messages.length = msgLen;
    transcript.length = trLen;
    running = true;
    controller = new AbortController();
    turnUsage = { prompt: 0, completion: 0, total: 0 };
    messages.push({ role: 'user', content });
    push('user', content);
    setPhase('preparing');
    emit({ type: 'change' });
    try {
      await runTurn(content, cfg);
    } catch (err) {
      canRetry = { content, msgLen, trLen };
      fail(err?.kind ?? 'http', err?.message ?? '请求失败', err?.detail ?? '');
      return { ok: false, reason: err?.kind ?? 'http' };
    } finally {
      running = false;
      controller = null;
      retrying = null;
      setPhase('idle');
      emit({ type: 'change' });
    }
    return { ok: true, plan };
  }

  function requireUrl(baseUrl) {
    const url = String(baseUrl).trim().replace(/\/+$/, '');
    return /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`;
  }

  /** 应用待应用计划（由编辑器注入的 applyPlan 落地）；成功后**清掉卡片**，结果作为系统消息留在对话里 */
  async function applyPending() {
    if (!plan) return { ok: false, reason: 'no_plan' };
    if (plan.applied) return { ok: false, reason: 'applied' };
    if (typeof ctx.applyPlan !== 'function') return { ok: false, reason: 'no_applier' };
    const target = plan;
    let res = null;
    try {
      res = await ctx.applyPlan(target);
    } catch (err) {
      // 落地失败：保留卡片让用户重试，并把原因写进状态行
      fail('apply', `应用改动失败：${err?.message ?? err}`);
      emit({ type: 'change' });
      return { ok: false, reason: 'apply_failed' };
    }
    const text =
      res.failed?.length
        ? `已应用 ${res.applied} 处改动（${res.failed.length} 条失败：${res.failed.slice(0, 3).map((f) => f.reason).join('；')}）；可撤销。`
        : `已应用 ${res.applied} 处改动；可撤销。`;
    messages.push({ role: 'system', content: text });
    push('system', text);
    // 卡片一次性：应用过就收起来（失败明细已在上面的系统消息里），避免重复应用
    plan = null;
    emit({ type: 'applied', result: res });
    emit({ type: 'change' });
    return { ok: true, result: res };
  }

  function discardPending() {
    if (!plan) return false;
    plan = null;
    push('system', '已放弃这次改动。');
    emit({ type: 'change' });
    return true;
  }

  return {
    send,
    retry,
    stop() {
      controller?.abort();
      return true;
    },
    applyPending,
    discardPending,
    reset() {
      messages = [];
      transcript = [];
      plan = null;
      error = null;
      canRetry = null;
      usage = { prompt: 0, completion: 0, total: 0 };
      turnUsage = { prompt: 0, completion: 0, total: 0 };
      trimmedCount = 0;
      phase = { kind: 'idle', name: '', startedAt: 0 };
      emit({ type: 'change' });
    },
    get running() {
      return running;
    },
    get plan() {
      return plan;
    },
    get error() {
      return error;
    },
    get phase() {
      return { ...phase };
    },
    /**
     * 从某条 transcript 消息分支：返回截至该条的对话数据（含该条）。
     * messages 按 `miEnd` 截断，保证 API 消息边界完整（tool 与其 assistant 配对不拆散）。
     */
    sliceTo(trIndex) {
      const item = transcript[trIndex];
      const miEnd = Number.isFinite(item?.miEnd) ? item.miEnd : messages.length;
      return {
        messages: clone(messages.slice(0, miEnd)),
        transcript: clone(transcript.slice(0, trIndex + 1).map((t) => ({ ...t, streaming: false }))),
        usage: { ...usage },
      };
    },
    /** 序列化（持久化用）：半截流式行按已完成处理 */
    serialize() {
      return {
        messages: clone(messages),
        transcript: clone(transcript.map((t) => ({ ...t, streaming: false }))),
        usage: { ...usage },
      };
    },
    /** 恢复（多对话切换 / 刷新后还原）；运行中拒绝。plan 不随存档恢复（待应用计划必须现场生成） */
    restore(data) {
      if (running) return false;
      const d = data && typeof data === 'object' ? data : {};
      messages = Array.isArray(d.messages) ? clone(d.messages) : [];
      transcript = Array.isArray(d.transcript)
        ? clone(d.transcript).map((t) => ({ ...t, streaming: false, miEnd: Number.isFinite(t?.miEnd) ? t.miEnd : messages.length }))
        : [];
      usage = d.usage && typeof d.usage === 'object' ? { ...d.usage } : { prompt: 0, completion: 0, total: 0 };
      turnUsage = { prompt: 0, completion: 0, total: 0 };
      plan = null;
      error = null;
      canRetry = null;
      trimmedCount = 0;
      phase = { kind: 'idle', name: '', startedAt: 0 };
      emit({ type: 'change' });
      return true;
    },
    /**
     * 当前沿用上下文（发给模型会看到什么）：系统提示 + 动态状态 + 裁剪后的历史。
     * 「复制上下文」按钮用它导出 JSON；异步因为系统提示词首次要从内置缓存加载。
     */
    async peekContext() {
      const cfg = ctx.getConfig?.() ?? {};
      const systemPrompt = await loadSystemPrompt(fetchImpl);
      return apiMessages(systemPrompt);
    },
    /** 上下文占用（估算）：给 UI 显示「上下文 a/b（c%）」与裁剪提示 */    contextStats() {
      const cfg = ctx.getConfig?.() ?? {};
      const contextTokens = Math.max(2048, Math.round(cfg.contextTokens ?? 65536));
      // SYSTEM_PROMPT 约 1.2k token（prompt.js 的守卫上限 3600 字符），加动态上下文块的估算
      let n = 1200 + estimateTokens(contextBlock());
      for (const m of messages) {
        if (typeof m.content === 'string') n += estimateTokens(m.content);
        for (const c of m.tool_calls ?? []) n += estimateTokens(c?.function?.arguments ?? '');
        if (m.role === 'tool') n += estimateTokens(m.content);
      }
      return {
        used: n,
        budget: contextTokens,
        ratio: Math.min(1, n / contextTokens),
        trimmed: trimmedCount,
      };
    },
    /** UI 渲染用快照 */
    snapshot() {
      return {
        running,
        error,
        plan: plan ? { ...plan } : null,
        phase: { ...phase },
        usage: { ...usage },
        turnUsage: { ...turnUsage },
        retryable: !!canRetry && !running,
        retrying: retrying ? { ...retrying } : null,
        trimmed: trimmedCount,
        transcript: transcript.map((t) => ({ ...t })),
      };
    },
  };
}
