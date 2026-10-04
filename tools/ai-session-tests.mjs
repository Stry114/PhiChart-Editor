/**
 * AI 会话模块的功能测试（Node 直接跑：`node tools/ai-session-tests.mjs`）。
 * 覆盖：基础收发与 usage、自动重连、失败回滚 + 手动重试、上下文裁剪、分支、
 * 花费限额、多对话存储（含存档合并）。fetch / IndexedDB 用桩件。
 */
import { createSession } from '../src/ai/session.js';
import { createConversationStore, isConversationArchive, ARCHIVE_FORMAT } from '../src/ai/conversations.js';
import { estimateTokens, trimMessages, costOf } from '../src/ai/tokens.js';

const enc = new TextEncoder();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** 造一个 SSE 响应桩件 */
function sseResponse(parts) {
  const chunks = parts.map((p) => enc.encode(p));
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      }),
    },
  };
}
const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const usageChunk = (u) => `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
const doneChunk = 'data: [DONE]\n\n';
const okStream = (text = '回复', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) =>
  sseResponse([delta(text), usageChunk(usage), doneChunk]);

const baseCtx = (fetchImpl, cfg = {}) => ({
  fetchImpl,
  getConfig: () => ({ baseUrl: 'https://x.example', model: 'm', ...cfg }),
  getKey: async () => 'key',
  getToolContext: () => ({ chart: { lines: [{ id: 0 }] } }),
});

// ── 1. 基础收发 + usage ──
{
  console.log('基础收发');
  let calls = 0;
  const s = createSession(baseCtx(async () => (calls++, okStream())));
  const r = await s.send('你好');
  check('发送成功', r.ok === true);
  const snap = s.snapshot();
  check('transcript 有 user+assistant', snap.transcript.length === 2 && snap.transcript[0].role === 'user');
  check('usage 累计', snap.usage.total === 15, JSON.stringify(snap.usage));
  check('turnUsage 记录', snap.turnUsage.total === 15);
  check('miEnd 记录', snap.transcript[1].miEnd === 2);
  const data = s.serialize();
  check('serialize 可回放', data.messages.length === 2 && data.messages[1].content === '回复');
}

// ── 2. 自动重连：第一次网络错误，第二次成功 ──
{
  console.log('自动重连');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed: network drop');
    return okStream('重连后回复');
  };
  const s = createSession(baseCtx(fetchImpl));
  const r = await s.send('测试');
  check('网络错误后自动重连成功', r.ok === true && calls === 2, `calls=${calls}`);
  const snap = s.snapshot();
  check('没有重复的 user 消息', snap.transcript.filter((t) => t.role === 'user').length === 1);
  check('正文正确', snap.transcript.some((t) => t.text === '重连后回复'));
}

// ── 3. 中途断流（已收到半截文本后 read 抛错）→ 重连重发 ──
{
  console.log('中途断流');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      // 先给半截正文，然后读取时断掉
      const chunks = [enc.encode(delta('半截'))];
      let i = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              throw new TypeError('network error while reading');
            },
          }),
        },
      };
    }
    return okStream('完整回复');
  };
  const s = createSession(baseCtx(fetchImpl));
  const r = await s.send('断流测试');
  check('断流后重连成功', r.ok === true && calls === 2, `calls=${calls}`);
  const texts = s.snapshot().transcript.map((t) => t.text);
  check('半截文本被清掉', !texts.includes('半截'), JSON.stringify(texts));
  check('完整回复在', texts.includes('完整回复'));
}

// ── 4. 重试耗尽 → 可手动重试，回滚不重复 ──
{
  console.log('失败回滚与手动重试');
  let calls = 0;
  let failMode = true;
  const fetchImpl = async () => {
    calls++;
    if (failMode) return { ok: false, status: 500, statusText: 'server error', text: async () => 'boom' };
    return okStream('重试成功');
  };
  const s = createSession(baseCtx(fetchImpl));
  const r = await s.send('会失败的消息');
  check('发送失败', r.ok === false);
  const snap = s.snapshot();
  check('标记可重试', snap.retryable === true);
  const trLen = snap.transcript.length;
  check('失败的 user 消息只留一条', snap.transcript.filter((t) => t.role === 'user').length === 1);
  failMode = false;
  const r2 = await s.retry();
  check('重试成功', r2.ok === true);
  const snap2 = s.snapshot();
  check('回滚后没有重复消息', snap2.transcript.filter((t) => t.role === 'user').length === 1, JSON.stringify(snap2.transcript.map((t) => t.role)));
  check('旧 transcript 被截掉', snap2.transcript.length < trLen + 3);
  check('重试后不再标记', snap2.retryable === false);
}

// ── 5. 上下文裁剪 ──
{
  console.log('上下文裁剪');
  const s = createSession(baseCtx(async () => okStream(), { contextTokens: 200 }));
  // 塞一段很长的历史（估算下每条 ~1300 token，预算只有 ~1k → 前两条都会被裁掉）
  s.restore({
    messages: [
      { role: 'user', content: '旧消息'.repeat(1200) },
      { role: 'assistant', content: '旧回复'.repeat(1200) },
      { role: 'user', content: '新问题' },
    ],
    transcript: [],
    usage: { prompt: 0, completion: 0, total: 0 },
  });
  const peek = await s.peekContext();
  check('系统提示在最前', peek[0].role === 'system');
  check('只保住最新一条历史', peek.length === 2 && peek[1].content === '新问题', `len=${peek.length}`);
  check('标记了裁剪条数', s.snapshot().trimmed === 2, `trimmed=${s.snapshot().trimmed}`);

  // tool 配对不被拆散
  const msgs = [
    { role: 'user', content: '问'.repeat(300) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_chart', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
    { role: 'user', content: '再来一条'.repeat(100) },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '最后' },
  ];
  const trimmed = trimMessages(msgs, 50);
  const first = trimmed.messages[0];
  check('切口不落在 tool / tool_calls 上', !(first.role === 'tool') && !(first.role === 'assistant' && first.tool_calls?.length), first.role);
  const keptTools = trimmed.messages.filter((m) => m.role === 'tool');
  const keptCalls = trimmed.messages.filter((m) => m.tool_calls?.length);
  check('tool 与 tool_calls 成对保留', keptTools.length === keptCalls.length);
}

// ── 6. 分支（sliceTo） ──
{
  console.log('分支');
  const s = createSession(baseCtx(async () => okStream()));
  await s.send('第一条');
  await s.send('第二条');
  const snap = s.snapshot();
  const idx = snap.transcript.findIndex((t) => t.role === 'user' && t.text === '第一条');
  const slice = s.sliceTo(idx);
  check('截到第一条 user 为止', slice.messages.length === 1 && slice.messages[0].content === '第一条');
  check('transcript 同步截断', slice.transcript.length === 1);
}

// ── 7. 花费限额 ──
{
  console.log('花费限额');
  let called = false;
  const s = createSession(
    baseCtx(async () => {
      called = true;
      return okStream();
    }, { priceIn: 1, priceOut: 2, spendLimit: 0.000001 }),
  );
  // 先积累一些用量
  s.restore({ messages: [], transcript: [], usage: { prompt: 100000, completion: 100000, total: 200000 } });
  const r = await s.send('应该被拦');
  check('超限额被拦截', r.ok === false && r.reason === 'limit' && !called);
  check('错误里有提示', s.error?.kind === 'limit');
}

// ── 8. 多对话存储 ──
{
  console.log('多对话存储');
  const store = createConversationStore({ createSession: () => createSession(baseCtx(async () => okStream())) });
  check('初始有一个空对话', store.list().length === 1);
  const chart = {};
  await store.bind(chart);
  check('bind 生成 projectId', typeof chart.projectId === 'string' && chart.projectId.length > 8);

  const s1 = store.activeSession();
  await s1.send('对话一的内容');
  const id1 = store.activeId;
  const id2 = store.create();
  check('新建并切换', id2 !== id1 && store.activeId === id2);
  check('新对话是空的', store.activeSession().snapshot().transcript.length === 0);
  store.switchTo(id1);
  check('切回后消息还在', store.activeSession().snapshot().transcript.some((t) => t.text === '对话一的内容'));

  store.rename(id1, '我的对话');
  check('改名生效', store.list().find((c) => c.id === id1).title === '我的对话');

  // 分支：从对话一第一条消息分出
  const idx = store.activeSession().snapshot().transcript.findIndex((t) => t.role === 'user');
  const slice = store.activeSession().sliceTo(idx);
  const id3 = store.branchFrom(slice);
  check('分支创建新对话', id3 !== id1 && id3 !== id2);
  check('分支带上了截断的历史', store.activeSession().snapshot().transcript.length === 1);

  // 序列化与导入合并
  store.flush();
  const archive = store.exportArchive();
  check('存档格式正确', isConversationArchive(archive) && archive.format === ARCHIVE_FORMAT);
  const store2 = createConversationStore({ createSession: () => createSession(baseCtx(async () => okStream())) });
  check('导入存档成功', store2.importArchive(archive) && store2.list().length === store.list().length);
  store2.switchTo(id1);
  check('导入后历史可恢复', store2.activeSession().snapshot().transcript.some((t) => t.text === '对话一的内容'));

  // 删除
  store2.remove(id3);
  check('删除对话', !store2.list().some((c) => c.id === id3));
  store2.remove(id1);
  store2.remove(id2);
  check('删光后自动补空对话', store2.list().length === 1 && store2.activeSession().snapshot().transcript.length === 0);
}

// ── 9. tokens 工具函数 ──
{
  console.log('token 估算');
  check('中文估算', estimateTokens('你好世界') > 0 && estimateTokens('你好世界') < 6);
  check('英文估算', estimateTokens('hello world, this is a test') >= 5);
  check('费用计算', Math.abs(costOf({ prompt: 1e6, completion: 0.5e6 }, { priceIn: 2, priceOut: 4 }) - 4) < 1e-9);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
