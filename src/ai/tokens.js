/**
 * Token 估算与费用计算（纯函数、零依赖）。
 *
 * 编辑器拿不到模型的分词器，这里用启发式估算：中日韩字符按 ~0.6 token/字、
 * 其它（拉丁/数字/符号）按 ~4 字符/token，另给每条消息 ~4 token 的结构开销。
 * 只用于**显示与上下文预算**（裁剪留了余量），不追求精确。
 */

/** 单段文本的 token 估算（≥0） */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // CJK 统一表意文字、扩展 A、假名、谚文、全角标点
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0x20000 && c <= 0x2fa1f)
    ) {
      cjk++;
    }
  }
  const other = s.length - cjk;
  return Math.ceil(cjk * 0.6 + other / 4);
}

/** 单条 OpenAI 消息的 token 估算（含 ~4 的消息头开销；tool_calls 的参数也计入） */
export function estimateMessageTokens(msg) {
  if (!msg || typeof msg !== 'object') return 0;
  let n = 4;
  if (typeof msg.content === 'string') n += estimateTokens(msg.content);
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) n += estimateTokens(part?.text ?? '');
  }
  for (const call of msg.tool_calls ?? []) {
    n += estimateTokens(call?.function?.name) + estimateTokens(call?.function?.arguments) + 4;
  }
  return n;
}

/** 一组消息的总估算 */
export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages ?? []) n += estimateMessageTokens(m);
  return n;
}

/**
 * 上下文裁剪：在预算内保留**尽量新**的消息。
 *
 * 安全边界：assistant 的 tool_calls 与其后的 tool 消息必须同生共死（OpenAI 协议要求配对），
 * 所以切口只落在 user 消息或不带 tool_calls 的 assistant 消息上；切口若是 tool 消息则继续
 * 向前扩到它所属的 assistant。怎么都装不下时至少保留最后一条。
 * @returns {{messages:object[], dropped:number, tokens:number}} dropped = 被裁掉的消息数
 */
export function trimMessages(messages, budgetTokens) {
  const list = [...(messages ?? [])];
  if (!list.length) return { messages: list, dropped: 0, tokens: 0 };
  let total = 0;
  for (const m of list) total += estimateMessageTokens(m);
  if (total <= budgetTokens) return { messages: list, dropped: 0, tokens: total };

  // 从末尾向前累积；越界时记下边界（第一条保留消息的下标），再修成安全切口
  let acc = 0;
  let start = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(list[i]);
    if (acc > budgetTokens) break;
    start = i;
  }
  if (start >= list.length) start = list.length - 1; // 一条都装不下：保最后一条
  // 切口安全化：tool 消息不能打头；assistant 带 tool_calls 也不行（它的 tool 回复在后面）
  while (start < list.length) {
    const m = list[start];
    if (m?.role === 'tool') {
      start--;
      continue;
    }
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      start--;
      continue;
    }
    break;
  }
  if (start < 0) start = Math.max(0, list.length - 1); // 全是配对的工具链：保最后一条（哪怕超预算）
  const kept = list.slice(start);
  let tokens = 0;
  for (const m of kept) tokens += estimateMessageTokens(m);
  return { messages: kept, dropped: list.length - kept.length, tokens };
}

/** 费用（按设置里的「元 / 百万 token」单价）；未填单价返回 0 */
export function costOf(usage, { priceIn = 0, priceOut = 0 } = {}) {
  const p = Math.max(0, Number(usage?.prompt ?? 0));
  const c = Math.max(0, Number(usage?.completion ?? 0));
  return (p / 1e6) * priceIn + (c / 1e6) * priceOut;
}

/** token 数格式化：1234 → 1.2k */
export function fmtTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}k`;
  return `${(v / 1e6).toFixed(2)}M`;
}

/** 金额格式化：保留两位小数；不足 1 分时仍显示有效位 */
export function fmtCost(yuan) {
  const v = Math.max(0, Number(yuan) || 0);
  if (v > 0 && v < 0.01) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
}
