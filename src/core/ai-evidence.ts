import { compareConfig } from './config';
import { huaweiEventEvidence } from './logs';
import { compareRoutes, pageRoutes } from './routes';
import type { AiCitation, AnalysisFeature, Knowledge } from '../shared/contracts';

const indexStep = 256;
const newlinePattern = () => /\r\n|\r|\n/g;
const lineRef = (side: 'B' | 'A', line?: number) => line === undefined ? undefined : `${side}:${line}`;

export function materialLineCount(text: string) {
  let lines = 0;
  let end = 0;
  for (const newline of text.matchAll(newlinePattern())) { lines++; end = newline.index + newline[0].length; }
  return lines + Number(end < text.length);
}

export type EvidenceSource = { start: number; lines: number; label: string };

export class AnalysisEvidence {
  private readonly offsets: number[] = [0];
  private readonly references = new Map<string, AiCitation>();
  readonly preferred: string[] = [];

  constructor(private readonly text: string, readonly sources: Record<string, EvidenceSource>, attached: string) {
    let lines = 0;
    for (const newline of text.matchAll(newlinePattern())) {
      if (++lines % indexStep === 0) this.offsets.push(newline.index + newline[0].length);
    }
    if (!attached) return;
    const evidence = JSON.parse(attached);
    for (const entry of evidence.entries ?? []) {
      if (entry.meaning) {
        this.references.set(entry.reference, {
          id: entry.reference, label: `华为字段知识库 · ${entry.documentedIdentifier ?? entry.identifier}`,
          text: entry.meaning + (entry.possibleCauses ? `\n手册列出的可能原因：${entry.possibleCauses}` : ''),
        });
      }
      this.preferred.push(entry.firstRef);
      if (entry.lastRef !== entry.firstRef) this.preferred.push(entry.lastRef);
    }
    for (const location of evidence.locations ?? []) {
      if ('beforeRef' in location || 'afterRef' in location) {
        if (location.beforeRef) this.preferred.push(location.beforeRef);
        if (location.afterRef) this.preferred.push(location.afterRef);
      } else {
        this.preferred.push(...location.before, ...location.after);
      }
    }
  }

  lookup(id: string): AiCitation | undefined {
    const known = this.references.get(id);
    if (known) return known;
    const match = /^([LBAS]):([1-9]\d{0,9})$/.exec(id);
    if (!match) return;
    const source = this.sources[match[1]];
    const line = Number(match[2]);
    if (!source || line > source.lines) return;
    const row = source.start + line - 2;
    const block = Math.floor(row / indexStep);
    let start = this.offsets[block];
    const pattern = newlinePattern();
    pattern.lastIndex = start;
    for (let index = block * indexStep; index < row; index++) {
      if (!pattern.exec(this.text)) return;
      start = pattern.lastIndex;
    }
    // Bound each excerpt, including single-line snapshots or log bodies larger than the model budget.
    const excerpt = this.text.slice(start, start + 601).split(/\r\n|\r|\n/, 1)[0];
    if (!excerpt.trim()) return;
    const end = /[\uD800-\uDBFF]$/.test(excerpt.slice(0, 600)) ? 599 : 600;
    const text = excerpt.length <= 600 ? excerpt : excerpt.slice(0, end) + '…';
    return { id, label: `${source.label} · 第 ${line} 行`, text };
  }
}

export function collectAnalysisEvidence(feature: AnalysisFeature, inputs: string[], redactReference: (text: string) => string, knowledge?: Knowledge) {
  if (feature === 'logs' && knowledge) {
    const report = huaweiEventEvidence(inputs[0], knowledge.rows, new Set(knowledge.conflicts.map(conflict => conflict.identifier)));
    if (!report) return '';
    const entries = report.entries.map((entry, index) => ({ ...entry,
      reference: `K:${index + 1}`, firstRef: `L:${entry.first}`, lastRef: `L:${entry.last}`,
      meaning: entry.meaning && redactReference(entry.meaning),
      possibleCauses: entry.possibleCauses && redactReference(entry.possibleCauses),
    }));
    return JSON.stringify({ kind: '华为字段知识库与日志事件索引', ...report, entries }, null, 2);
  }
  if (inputs.length !== 2) return '';
  const [before, after] = inputs;
  if (before.length + after.length > 2_000_000) return '';
  if (feature === 'config') {
    const result = compareConfig(before, after);
    const counts = { added: 0, removed: 0, modified: 0 };
    for (const row of result.rows) counts[row.change]++;
    return JSON.stringify({
      kind: '本地逐行配置比对', counts, alignmentLimited: result.alignmentLimited,
      note: '以下最多列出前 24 处差异的行号。逐行配对仅供定位，配置语义需结合上下文判断。',
      locations: result.rows.slice(0, 24).map(({ change, beforeLine, afterLine }) => ({
        change, beforeLine, afterLine, beforeRef: lineRef('B', beforeLine), afterRef: lineRef('A', afterLine),
      })),
    }, null, 2);
  }
  if (feature !== 'routes') return '';
  try {
    const result = compareRoutes(before, after);
    const { counts } = pageRoutes(result.rows, 0, {});
    return JSON.stringify({
      kind: '本地路由快照比对', counts,
      note: '单侧覆盖单独统计。以下最多列出前 16 条变化在快照中的路径来源行。',
      locations: result.rows.slice(0, 16).map(row => ({
        family: row.family, change: row.coverage ? 'scopeOnly' : row.change,
        before: row.before.slice(0, 6).map(path => lineRef('B', path.line)),
        after: row.after.slice(0, 6).map(path => lineRef('A', path.line)),
      })),
    }, null, 2);
  } catch {
    return JSON.stringify({ kind: '本地路由快照比对', note: '未获得可确认的结构化快照比对。分析时指出采集范围与解析不确定性。' }, null, 2);
  }
}
