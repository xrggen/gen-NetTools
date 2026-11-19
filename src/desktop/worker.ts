import { parentPort, workerData } from 'node:worker_threads';
import { openStore, getBrandKnowledge } from '../core/storage';
import { loadInput } from '../core/input';
import { vendorAdapter } from '../core/vendors';
import { compareConfig } from '../core/config';
import { pageRoutes } from '../core/routes';
import { readUpdate } from '../core/huawei-rules';
import { prepareAi } from '../core/ai-preview';
import { analysisSkillName } from '../core/ai-skills';
import { analyzeBatches } from '../core/chat-api';
import { pageSize, routeChangeLabels, type Report, type ReportRow, type RouteChangeKind,
  type RouteReportDetails, type RouteRow, type WorkerRequest } from '../shared/contracts';

const port = parentPort!;
let rows: ReportRow[] = [];
let routeRows: RouteRow[] = [];
let draft: { id: string; plan: Awaited<ReturnType<typeof prepareAi>> } | undefined;

function aiKnowledge(brand: Parameters<typeof getBrandKnowledge>[1]) {
  const store = openStore(workerData.path);
  try { return getBrandKnowledge(store, brand); }
  finally { store.close(); }
}

async function run(request: WorkerRequest) {
  rows = [];
  routeRows = [];
  const progress = (message: string) => port.postMessage({ type: 'progress', message });
  const finish = (summary: Report['summary'], notice?: string, record = true, routes?: RouteReportDetails) => ({
    type: 'result', record, value: { feature: request.feature, summary, total: rows.length, rows: rows.slice(0, pageSize), notice, routes },
  });
  progress('正在读取输入…');
  if (request.feature === 'logs') {
    const text = await loadInput(request.input);
    if (!text.trim()) throw new Error('请输入日志内容。');
    const store = openStore(workerData.path);
    try {
      const knowledge = getBrandKnowledge(store, request.brand);
      if (!knowledge.rows.length && !knowledge.conflicts.length) throw new Error('所选品牌还没有日志规则。');
      progress('正在匹配官方日志规则…');
      const result = vendorAdapter(request.brand).scanLogs(text, knowledge.rows, new Set(knowledge.conflicts.map(row => row.identifier)));
      rows = result.result;
      return finish(result.summary, rows.length ? undefined : '未识别到华为事件标识。', rows.length > 0);
    } finally { store.close(); }
  }
  if (request.feature === 'knowledge') {
    const result = request.format === 'json' ? await readUpdate(request.directory, request.brand)
      : await vendorAdapter(request.brand).collectRules(request.directory, progress);
    // The main process owns the final transaction. A cancelled collection cannot modify the database.
    rows = result.issues;
    return { type: 'import', rules: result.rules, issues: result.issues.length,
      skipped: result.skipped, total: rows.length, rows: rows.slice(0, pageSize) };
  }
  const [before, after] = await Promise.all([loadInput(request.before), loadInput(request.after)]);
  progress('正在比较前后内容…');
  if (request.feature === 'routes') {
    const result = vendorAdapter('Huawei').compareRoutes(before, after, request.beforeScope, request.afterScope);
    rows = routeRows = result.rows;
    const { page, counts } = pageRoutes(routeRows, 0, {});
    const protocols = new Set<string>();
    for (const row of routeRows) {
      for (const path of row.before) protocols.add(path.protocol);
      for (const path of row.after) protocols.add(path.protocol);
    }
    const kinds = Object.keys(routeChangeLabels) as RouteChangeKind[];
    return finish(kinds.map(kind => ({ label: routeChangeLabels[kind], value: counts[kind] })), undefined, true,
      { coverage: result.coverage, counts, protocols: [...protocols].sort(), groups: page.groups });
  }
  const result = compareConfig(before, after);
  rows = result.rows;
  const notice = result.alignmentLimited ? '差异较大，改按前后行位置比对；移动的内容可能显示为多处变化。' : undefined;
  const totals = { added: 0, removed: 0, modified: 0 };
  for (const row of rows) if ('change' in row) totals[row.change]++;
  return finish([{ label: '新增', value: totals.added }, { label: '删除', value: totals.removed }, { label: '修改', value: totals.modified }], notice);
}

port.on('message', async message => {
  try {
    if (message.type === 'page') { port.postMessage({ type: 'page', rows: rows.slice(message.offset, message.offset + pageSize) }); return; }
    if (message.type === 'route-page') {
      port.postMessage({ type: 'route-page', value: pageRoutes(routeRows, message.offset, message.filter).page });
      return;
    }
    if (message.type === 'ai-preview') {
      draft = undefined;
      const request = message.request as Parameters<typeof prepareAi>[0];
      const knowledge = request.feature === 'logs' && request.brand ? aiKnowledge(request.brand) : undefined;
      const plan = await prepareAi(request, message.contextTokens, knowledge);
      const { batches, requests, characters, matches, evidence } = plan;
      draft = { id: message.id, plan };
      port.postMessage({ type: 'ai-preview', value: {
        batches: batches.length, requests,
        characters, firstBatch: batches[0], matches, evidence, skill: analysisSkillName(request.feature),
        context: { system: plan.context.system, userName: plan.context.user.name },
      } });
      return;
    }
    if (message.type === 'ai-preview-batch' || message.type === 'ai-send') {
      if (!draft || draft.id !== message.id) throw new Error('预览已失效，请重新准备后再发送。');
      if (message.type === 'ai-preview-batch') {
        const text = draft.plan.batches[message.index];
        if (typeof text !== 'string') throw new Error('批次不存在。');
        port.postMessage({ type: 'ai-preview-batch', value: text });
      } else {
        const active = draft;
        draft = undefined;
        const value = await analyzeBatches(message.config, active.plan,
          text => port.postMessage({ type: 'progress', message: text }));
        port.postMessage({ type: 'ai-result', value });
      }
      return;
    }
    draft = undefined;
    port.postMessage(await run(message.request));
  } catch (error) {
    if (message.type === 'run') { rows = []; routeRows = []; }
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : '本地任务失败。' });
  }
});
