/**
 * AI 会话状态机（见 docs/LLM辅助写谱方案.md §4.2、§6.3）。
 *
 * 无 DOM、无第三方依赖：`fetch` 与编辑器侧的三个回调都由调用方注入。
 * 一条主线：发消息 → 单次流式请求 + 工具循环（≤ maxRounds）→ 只读工具立刻执行、写工具只登记计划
 * → 回合结束后由用户点「应用」→ 追加一条系统消息（**不自动继续回合**）。
 */
import { streamChat, errorHint, redact } from './protocol.js';
import { loadSystemPrompt, buildContextBlock } from './prompt.js';
import { TOOLS, runTool, toolResultText, CAPS, ToolError, WRITE_TOOLS } from './tools.js';

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

/**
 * @param {{
 *   fetchImpl:Function,
 *   getConfig:() => {baseUrl:string, model:string, maxRounds?:number, writeLimit?:number},
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
  let controller = null;
  /** 当前阶段（界面据此显示「正在做什么 + 已等待多久」） */
  let phase = { kind: 'idle', name: '', startedAt: 0 };

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

  const push = (role, text, extra = {}) => {
    transcript.push({ role, text: String(text ?? ''), at: Date.now(), ...extra });
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

  const apiMessages = (systemPrompt) => [
    { role: 'system', content: `${systemPrompt}\n\n当前编辑器状态：\n${contextBlock()}` },
    ...messages,
  ];

  function fail(kind, message, detail = '') {
    error = { kind, message, hint: errorHint(kind), detail: redact(detail) };
    emit({ type: 'change' });
    return error;
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
    if (ctx.ensureConsent && !(await ctx.ensureConsent(cfg.baseUrl))) {
      fail('consent', '尚未确认把谱面数据发送给该服务');
      return { ok: false, reason: 'consent' };
    }

    error = null;
    running = true;
    controller = new AbortController();
    push('user', content);
    messages.push({ role: 'user', content });
    setPhase('preparing');
    emit({ type: 'change' });

    // 系统提示词内嵌在 src/ai/prompt.js 的 SYSTEM_PROMPT（内置缓存）
    const systemPrompt = await loadSystemPrompt(fetchImpl);
    const maxRounds = Math.max(1, Math.min(24, Math.round(cfg.maxRounds ?? 8)));
    const pendingPlans = [];
    let rounds = 0;
    try {
      for (; rounds < maxRounds; rounds++) {
        const apiKey = (await ctx.getKey?.()) ?? '';
        setPhase('requesting');
        const stream = await streamChat({
          fetchImpl,
          url: requireUrl(cfg.baseUrl),
          apiKey,
          model: cfg.model,
          messages: apiMessages(systemPrompt),
          tools: TOOLS,
          signal: controller.signal,
          onText: (t) => {
            const last = transcript[transcript.length - 1];
            if (last?.role === 'assistant' && last.streaming) last.text = t;
            else transcript.push({ role: 'assistant', text: t, streaming: true, at: Date.now() });
            if (phase.kind !== 'streaming') setPhase('streaming');
            emit({ type: 'delta' });
          },
        });

        if (stream.usage) {
          usage = {
            prompt: usage.prompt + (stream.usage.prompt_tokens ?? 0),
            completion: usage.completion + (stream.usage.completion_tokens ?? 0),
            total: usage.total + (stream.usage.total_tokens ?? 0),
          };
        }
        const last = transcript[transcript.length - 1];
        if (last?.streaming) {
          last.streaming = false;
          last.text = stream.text;
          if (!last.text) transcript.pop();
        } else if (stream.text) {
          push('assistant', stream.text);
        }

        if (!stream.toolCalls.length) {
          messages.push({ role: 'assistant', content: stream.text || '' });
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
          push('tool', brief, { ok, name: call.name, raw: rawText.length > 2000 ? `${rawText.slice(0, 2000)}…` : rawText });
          emit({ type: 'tool', name: call.name, ok, brief });
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(out.result) });
        }
      }

      if (rounds >= maxRounds) {
        push('system', `达到单回合工具调用上限（${maxRounds} 轮），已停止本轮。`);
      }
      if (pendingPlans.length) {
        plan = { ...mergePlans(pendingPlans), planChart: ctx.getToolContext?.().chart ?? null, createdAt: Date.now(), applied: false };
        emit({ type: 'plan', plan });
      }
      return { ok: true, rounds, plan };
    } catch (err) {
      fail(err?.kind ?? 'http', err?.message ?? '请求失败', err?.detail ?? '');
      return { ok: false, reason: err?.kind ?? 'http' };
    } finally {
      running = false;
      controller = null;
      setPhase('idle');
      emit({ type: 'change' });
    }
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
    push('system', text);
    messages.push({ role: 'system', content: text });
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
      usage = { prompt: 0, completion: 0, total: 0 };
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
    /** UI 渲染用快照 */
    snapshot() {
      return {
        running,
        error,
        plan: plan ? { ...plan } : null,
        phase: { ...phase },
        usage: { ...usage },
        transcript: transcript.map((t) => ({ ...t })),
      };
    },
  };
}
