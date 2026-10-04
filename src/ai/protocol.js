/**
 * OpenAI 兼容接口的最小适配：请求体构造、SSE 流式解析、错误归类（见 docs/LLM辅助写谱方案.md §4、§10）。
 *
 * 零依赖、无 DOM：`fetch` 由调用方注入（编辑器传 `globalThis.fetch`，测试传桩件）。
 * 只支持流式（`stream: true`）——不流式的响应同样能解析（整段文本按同一套 SSE 规则切）。
 */

/** 单次请求超时（毫秒） */
export const TIMEOUT_MS = 120000;

/** 一条工具调用的最大参数体积（防止模型刷出超长参数打爆内存） */
export const MAX_TOOL_ARGS_CHARS = 200000;

/** @param {{model:string, messages:object[], tools?:object[], stream?:boolean, temperature?:number, maxTokens?:number}} p */
export function buildRequestBody({ model, messages, tools, stream = true, temperature, maxTokens }) {
  const body = { model, messages, stream: !!stream };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens)) body.max_tokens = Math.max(1, Math.round(maxTokens));
  return body;
}

/** 去掉密钥与常见 token 形态，供错误信息与控制台输出使用 */
export function redact(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9._\-]{6,}/g, 'sk-***')
    .replace(/("?api[_-]?key"?\s*[:=]\s*")[^"]+(")/gi, '$1***$2');
}

/**
 * SSE 增量解析器：把任意分片的响应文本喂进来，产出正文与工具调用。
 * 工具调用按 `index` 累积（参数会跨多个分片），与 OpenAI 流式协议一致。
 */
export function createStreamParser() {
  const toolCalls = new Map();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = null;
  let malformed = 0;
  let done = false;

  const applyDelta = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.usage) usage = obj.usage;
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message ?? null;
    if (!delta) return;
    if (typeof delta.content === 'string') text += delta.content;
    for (const call of delta.tool_calls ?? []) {
      const index = Number.isFinite(call?.index) ? call.index : toolCalls.size;
      const slot = toolCalls.get(index) ?? { id: '', name: '', args: '' };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      if (typeof call.function?.arguments === 'string') {
        // 未收到 id 的兼容写法：`{"name":..., "arguments":...}`
        slot.args = (slot.args + call.function.arguments).slice(0, MAX_TOOL_ARGS_CHARS);
      }
      toolCalls.set(index, slot);
    }
    // 非流式响应（message.tool_calls 是完整数组）：补 id
    if (!delta.tool_calls && Array.isArray(choice.message?.tool_calls)) {
      choice.message.tool_calls.forEach((call, i) => {
        const slot = toolCalls.get(i) ?? { id: '', name: '', args: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (typeof call.function?.arguments === 'string') slot.args = call.function.arguments.slice(0, MAX_TOOL_ARGS_CHARS);
        toolCalls.set(i, slot);
      });
    }
  };

  const handleLine = (line) => {
    const t = line.trim();
    if (!t || t.startsWith(':')) return false;
    if (!t.startsWith('data:')) return false;
    const payload = t.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    if (done) return false; // [DONE] 之后的任何分片都不再累积
    try {
      applyDelta(JSON.parse(payload));
    } catch {
      malformed++;
    }
    return false;
  };

  return {
    /** 喂入一段响应文本；返回 true 表示收到 `[DONE]` */
    push(chunk) {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (handleLine(line)) done = true;
        idx = buffer.indexOf('\n');
      }
      return done;
    },
    finish() {
      if (buffer) handleLine(buffer);
      buffer = '';
    },
    get text() {
      return text;
    },
    get usage() {
      return usage;
    },
    get finishReason() {
      return finishReason;
    },
    get malformed() {
      return malformed;
    },
    /** 工具调用：`[{id, name, args}]`，`args` 已解析为对象（解析失败时退化为 `{}` 并带 `argsError`） */
    toolCalls() {
      return [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, slot]) => {
          const out = { index, id: slot.id || `call_${index}`, name: slot.name || '', args: {}, raw: slot.args };
          if (slot.args) {
            try {
              const parsed = JSON.parse(slot.args);
              if (parsed && typeof parsed === 'object') out.args = parsed;
              else out.argsError = '参数不是 JSON 对象';
            } catch (err) {
              out.argsError = `参数不是合法 JSON：${err?.message ?? err}`;
            }
          }
          return out;
        })
        .filter((c) => c.name);
    },
  };
}

/**
 * 发起一次对话请求并解析流式响应。
 * @param {{fetchImpl:Function, url:string, apiKey?:string, model:string, messages:object[], tools?:object[],
 *          signal?:AbortSignal, timeoutMs?:number, onText?:(t:string)=>void}} p
 * @returns {Promise<{text:string, toolCalls:object[], usage:object|null, finishReason:string|null, malformed:number}>}
 */
export async function streamChat(p) {
  const {
    fetchImpl,
    url,
    apiKey = '',
    model,
    messages,
    tools,
    signal = null,
    timeoutMs = TIMEOUT_MS,
    onText = null,
    maxTokens,
  } = p;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  const headers = { 'content-type': 'application/json' };
  // 密钥留空（本地端点）时不发送 Authorization 头
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res = null;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody({ model, messages, tools, maxTokens })),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    throw streamError(err, null, controller.signal);
  }

  const parser = createStreamParser();
  try {
    if (!res?.ok) {
      const body = await safeText(res);
      throw streamError(null, res, controller.signal, body);
    }
    const reader = res.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const stopped = parser.push(chunk);
        if (onText && parser.text) onText(parser.text);
        if (stopped) break;
      }
    } else {
      parser.push(await safeText(res));
    }
    parser.finish();
  } catch (err) {
    // 用户主动停止：按「已停止」结束（中途 abort 会从 reader.read() 抛裸 AbortError）
    if (controller.signal.aborted) {
      const e = new Error('已停止');
      e.kind = 'abort';
      throw e;
    }
    // 已开始读取后的异常（网络抖动断流）：单独归类，别和「请求发不出去」混在一起
    if (!err?.kind) {
      const e = streamError(err, null, controller.signal);
      e.kind = 'network';
      e.message = '连接中断（读取响应时网络出错）';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  return {
    text: parser.text,
    toolCalls: parser.toolCalls(),
    usage: parser.usage,
    finishReason: parser.finishReason,
    malformed: parser.malformed,
  };
}

async function safeText(res) {
  try {
    if (typeof res?.text === 'function') return await res.text();
    if (typeof res?.json === 'function') return JSON.stringify(await res.json());
  } catch {
    /* 忽略：正文只是给错误分类用 */
  }
  return '';
}

/** 构造带分类信息的错误（`kind` 供 UI 出中文提示） */
export function streamError(err, res, signal = null, body = '') {
  const status = Number.isFinite(res?.status) ? res.status : null;
  const aborted = signal?.aborted === true || err?.name === 'AbortError';
  const detail = redact(body || err?.message || '').slice(0, 300);
  let kind = 'http';
  let message = detail || '请求失败';
  if (status === 401 || status === 403) {
    kind = 'auth';
    message = '密钥无效或无权访问该端点';
  } else if (status === 404) {
    kind = 'not_found';
    message = 'Base URL 路径不对（常见写法：…/v1 或完整 …/v1/chat/completions）';
  } else if (status === 429) {
    kind = 'rate';
    message = '请求过于频繁或被限流';
  } else if (status && status >= 500) {
    kind = 'server';
    message = `端点内部错误（HTTP ${status}）`;
  } else if (status === 400 || status === 422) {
    kind = /tool|function/i.test(detail) ? 'unsupported_tools' : 'bad_request';
    message =
      kind === 'unsupported_tools'
        ? '该端点不支持工具调用（本地 llama.cpp 需启用 --jinja 之类的对话模板）'
        : `请求被拒绝：${detail || '参数不合法'}`;
  } else if (aborted) {
    kind = err === 'timeout' ? 'timeout' : 'abort';
    message = kind === 'timeout' ? '请求超时' : '已停止';
  } else if (!res) {
    kind = 'cors';
    message = '浏览器无法访问该端点（跨域被拒或网络不通）';
  }
  const error = new Error(message);
  error.kind = kind;
  error.status = status;
  error.detail = detail;
  return error;
}

/** 中文提示（界面状态行用） */
export function errorHint(kind) {
  switch (kind) {
    case 'cors':
      return '可换一个端点，或在本机跑一个反向代理；本地 llama.cpp 需允许页面来源访问。';
    case 'network':
      return '通常是网络抖动或服务端提前断开；已自动重试过，可再点「重试」。';
    case 'auth':
      return '检查 API key 是否填写正确、以及该 key 是否有该模型的权限。';
    case 'not_found':
      return 'Base URL 只写到域名或 /v1 即可，路径会由编辑器补全。';
    case 'rate':
      return '稍后重试，或换一个模型。';
    case 'unsupported_tools':
      return '换一个支持工具调用的模型。';
    case 'timeout':
      return '可在设置里调大「请求超时」，或稍后重试。';
    case 'limit':
      return '在设置里提高「花费限额」或清零关闭限额。';
    default:
      return '';
  }
}
