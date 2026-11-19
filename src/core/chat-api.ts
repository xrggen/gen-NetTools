import type { AiAnalysis } from '../shared/contracts';
import type { prepareAi } from './ai-preview';
import { DiagnosisSession } from './ai-session';

export function completionEndpoint(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的模型接口地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('模型接口需要 HTTPS。本机回环地址可以使用 HTTP。地址不能包含账户、查询参数或片段。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.href;
}

type ChatConfig = { endpoint: string; model: string; key: string };

async function responseText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型返回空响应。');
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      bytes += value.length;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw new Error('模型响应超过客户端处理上限。');
      }
      output += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function complete(config: ChatConfig, messages: ReturnType<DiagnosisSession['messages']>, outputTokens?: number) {
  const response = await fetch(config.endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model: config.model, stream: false, max_tokens: outputTokens, messages }),
  });
  if (!response.ok) {
    if (response.status === 413) {
      await response.body?.cancel();
      throw new Error('接口拒绝了请求体大小，请调低模型上下文预算后重新预览。');
    }
    if (response.status === 400 || response.status === 422) {
      const errorBody = await responseText(response).catch(() => '');
      if (/context[_ -]length[_ -]exceeded|maximum context|context window|input.{0,24}too long/i.test(errorBody)) {
        throw new Error('输入超出接口的模型上下文，请调低预算后重新预览。');
      }
    } else { await response.body?.cancel(); }
    throw new Error(`接口返回 HTTP ${response.status}。`);
  }
  let body: { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
  const responseBody = await responseText(response);
  try { body = JSON.parse(responseBody); } catch { throw new Error('接口响应不是有效的 Chat Completions JSON。'); }
  const answer = body?.choices?.[0];
  const text = answer?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回空解读结果。');
  return { text, complete: !answer?.finish_reason || answer.finish_reason === 'stop' };
}

export async function analyzeBatches(config: ChatConfig,
  plan: Awaited<ReturnType<typeof prepareAi>>,
  progress: (message: string) => void): Promise<AiAnalysis> {
  const { batches, evidence, evidenceIndex, context, scope, notesBudget, recallBudget, outputTokens, requests: total } = plan;
  const session = new DiagnosisSession(evidenceIndex, context);
  const answers: AiAnalysis['answers'] = [];
  const whole = batches.length === 1;
  let completed = 0;
  let line = 1;
  for (let index = 0; index < total; index++) {
    const batch = batches[index];
    const report = batch === undefined;
    const step = whole ? '全文分析' : report ? '汇总报告' : `材料第 ${index + 1} / ${batches.length} 批`;
    progress(`已完成 ${completed} / ${total} 次请求，正在进行${step}…`);
    try {
      const phase = whole ? 'whole' : report ? 'report' : 'part';
      const messages = session.messages(phase, {
        phase, scope, batch: report ? undefined : index + 1, batches: batches.length,
        materialStartLine: report ? undefined : line, material: batch,
        sources: evidenceIndex.sources, evidence: evidence || undefined,
      }, recallBudget);
      const answer = await complete(config, messages, outputTokens);
      if (!answer.complete) {
        if (!report && !whole) answers.push({ index: index + 1, text: answer.text });
        return { total, completed, answers, notice: `${step}未完整返回。` };
      }
      completed++;
      if (whole || report) return { total, completed, answers, ...session.verifyReport(answer.text) };
      const summary = session.advance(answer.text, notesBudget);
      answers.push({ index: index + 1, text: summary });
      for (const _newline of batch.matchAll(/\r\n|\r|\n/g)) line++;
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? '接口请求超时。'
        : error instanceof TypeError ? '接口连接失败或接口试图重定向。' : error instanceof Error ? error.message : '模型请求失败。';
      return { total, completed, answers, notice: `${step}失败。${reason}` };
    }
  }
  return { total, completed, answers };
}
