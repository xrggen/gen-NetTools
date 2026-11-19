import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function openSmokeEndpoint() {
  const challenge = `test-${randomUUID()}`;
  let received = 0;
  let logSystemContext: string | undefined;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${challenge}`) {
      response.writeHead(401).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const value = JSON.parse(body);
        const [system, user] = value.messages;
        const instructions = system.content;
        const input = JSON.parse(user.content);
        if (value.model !== 'synthetic-model' || value.messages.length !== 2 || system.role !== 'system' ||
            user.role !== 'user' || user.name !== 'network_engineer' || !instructions.includes('gen-NetTools') ||
            !instructions.includes('网络工程师') || instructions.includes('SOURCE_LOST') || 'user_role' in value ||
            JSON.stringify(input).includes('192.0.2.123')) throw new Error();
        if (instructions.includes('网络日志关联诊断')) {
          const context = instructions.slice(0, instructions.lastIndexOf('\n'));
          logSystemContext ??= context;
          if (context !== logSystemContext || !context.includes('匹配华为字段知识库') || !context.includes('模型负责串联时间线')) {
            throw new Error();
          }
        }
        if (input.material === 'SYNTHETIC_CONTEXT_LIMIT') {
          if (input.scope !== 'selection') throw new Error();
          response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'context_length_exceeded' } }));
          return;
        }
        if (input.scope !== 'full') throw new Error();
        let content: string;
        if (instructions.includes('配置变更影响分析')) {
          if (input.phase !== 'whole' || input.sources.B.lines !== 3 || input.sources.A.lines !== 3 ||
              !instructions.includes('逐行差异和证据位置') || !instructions.includes('解释配置语义') ||
              !input.material.includes('description OLD') || !input.material.includes('description NEW')) throw new Error();
          content = '接口描述从 OLD 改为 NEW。[B:3] [A:3]';
        } else if (instructions.includes('路由快照变化分析')) {
          const change = JSON.parse(input.evidence).locations[0];
          if (input.phase !== 'whole' || change.before[0] !== 'B:5' || change.after[0] !== 'A:5' ||
              !instructions.includes('整理路径差异与采集范围') || !instructions.includes('ECMP 路径变化') ||
              /192\.0\.2\./.test(JSON.stringify(input))) throw new Error();
          content = '下一跳发生变化。[B:5] [A:5]';
        } else if (input.phase === 'whole') {
          if (!instructions.includes('网络日志关联诊断') || [...input.material].length !== 9000 || input.accumulatedNotes ||
              JSON.parse(input.evidence).entries[0]?.identifier !== 'NTP/4/SOURCE_LOST') throw new Error();
          content = 'NTP 同步源丢失。[L:1]';
        } else if (input.phase === 'part' && input.batch === 1) {
          if (!input.material.includes('SOURCE_LOST') || input.material.includes('PEER_SELE') || input.accumulatedNotes ||
              !input.material.includes('IpAddress=已替换')) throw new Error();
          content = JSON.stringify({ summary: '第1行观测到同步源丢失，根因未确认。[L:1] [L:999999]', retain: ['L:1'], lookup: ['L:1', 'L:999999', 'B:1'] });
        } else if (input.phase === 'part' && input.batch === 2) {
          if (!input.material.includes('PEER_SELE') || !input.accumulatedNotes?.includes('根因未确认') ||
              !input.accumulatedNotes.includes('[证据待核实]') || input.accumulatedNotes.includes('L:999999') ||
              input.unavailableEvidence?.join() !== 'L:999999,B:1' ||
              input.recalled?.length !== 1 || !input.recalled[0].text.includes('SOURCE_LOST') ||
              !input.recalled[0].text.includes('IpAddress=已替换')) throw new Error();
          content = JSON.stringify({ summary: '第3行观测到重新选源。[L:3]', retain: ['L:3'], lookup: ['L:3'] });
        } else if (input.phase === 'report') {
          if (input.material !== undefined || input.accumulatedNotes !== '第3行观测到重新选源。[L:3]' ||
              !input.recalled?.some((item: { id: string; text: string }) => item.id === 'L:1' && item.text.includes('SOURCE_LOST')) ||
              !input.recalled?.some((item: { id: string; text: string }) => item.id === 'L:3' && item.text.includes('PEER_SELE')) ||
              !instructions.includes('覆盖整个任务')) throw new Error();
          content = '同步源丢失后重新选源。[L:1] [L:3] 手册释义。[K:1] 根因待核实。[L:999999]';
        } else throw new Error();
        received++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(400).end(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动验证用模拟接口。');
  return { server, count: () => received, settings: { url: `http://127.0.0.1:${address.port}/v1`, challenge } };
}
