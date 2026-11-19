import { randomUUID } from 'node:crypto';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { fitAnalysisNotes } from './ai-budget';
import type { AnalysisEvidence } from './ai-evidence';
import { systemMessage, type AnalysisContext, type AnalysisStage } from './ai-skills';
import type { AiCitation } from '../shared/contracts';

const citationPattern = () => /\[([A-Z]{1,4}:\d{1,10})\]/g;
const referencePattern = /^[LBASK]:[1-9]\d{0,9}$/;
const maxReferences = 24;
type Checkpoint = { summary: string; retained: string[]; lookups: string[] };

function readReferences(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, maxReferences).filter((item): item is string =>
    typeof item === 'string' && referencePattern.test(item)) : [];
}

function decodeStage(text: string): Checkpoint {
  const candidate = text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, '');
  try {
    const result = JSON.parse(candidate);
    if (typeof result?.summary === 'string' && result.summary.trim()) {
      return { summary: result.summary, retained: readReferences(result.retain), lookups: readReferences(result.lookup) };
    }
  } catch { /* Some compatible endpoints still return plain text. */ }
  return { summary: text, retained: [], lookups: [] };
}

export class DiagnosisSession {
  private readonly session = Session.create(SessionId(randomUUID()));
  private checkpointSeq?: number;

  constructor(private readonly evidence: AnalysisEvidence, private readonly context: AnalysisContext) {}

  private get checkpoint(): Checkpoint | undefined {
    const block = this.session.deriveMessages().at(-1)?.content[0];
    return block?.type === 'text' ? JSON.parse(block.text) : undefined;
  }

  advance(text: string, budget: number) {
    const stage = decodeStage(text);
    const summary = fitAnalysisNotes(stage.summary.replace(citationPattern(), (mention, id: string) =>
      this.evidence.lookup(id) ? mention : '[证据待核实]'), budget);
    const newRefs = [...summary.matchAll(citationPattern())].map(match => match[1]);
    const earlier = this.checkpoint?.retained ?? [];
    const retained = [...new Set([...earlier.slice(0, 6), ...stage.retained, ...newRefs, ...earlier.slice(6)])]
      .filter(id => this.evidence.lookup(id)).slice(0, maxReferences);
    const checkpoint: Checkpoint = { summary, retained, lookups: [...new Set(stage.lookups)] };
    const previous = this.checkpointSeq;
    const event = this.session.append('user/message', {
      id: randomUUID() as ReturnType<Session['deriveMessages']>[number]['id'],
      role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: JSON.stringify(checkpoint) }],
    }, previous === undefined ? { surfaceOp: 'append' } : {
      surfaceOp: { op: 'replace', start: previous, end: previous }, sourceEventSeqs: [previous],
    });
    this.checkpointSeq = event.seq;
    return summary;
  }

  private requestContext(budget: number, report: boolean) {
    const checkpoint = this.checkpoint;
    if (!checkpoint) return {};
    const recalled: { id: string; text: string }[] = [];
    const ids = new Set([...checkpoint.lookups, ...checkpoint.retained, ...(report ? this.evidence.preferred : [])]);
    let remaining = budget - 2;
    const unavailableEvidence: string[] = [];
    for (const id of checkpoint.lookups) {
      if (this.evidence.lookup(id)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(id), 'utf8') + (unavailableEvidence.length ? 1 : 2);
      if (bytes > remaining || unavailableEvidence.length >= 4) break;
      unavailableEvidence.push(id);
      remaining -= bytes;
    }
    for (const id of ids) {
      const citation = this.evidence.lookup(id);
      if (!citation) continue;
      const delimiter = Number(recalled.length > 0);
      const overhead = Buffer.byteLength(JSON.stringify({ id, text: '' }), 'utf8') + delimiter;
      const excerptBudget = Math.min(750, remaining - overhead);
      if (excerptBudget < 48) break;
      const item = { id, text: fitAnalysisNotes(citation.text, excerptBudget, '…') };
      const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + delimiter;
      recalled.push(item);
      remaining -= bytes;
      if (recalled.length === 8) break;
    }
    return { accumulatedNotes: checkpoint.summary, recalled: recalled.length ? recalled : undefined,
      unavailableEvidence: unavailableEvidence.length ? unavailableEvidence : undefined };
  }

  messages(phase: AnalysisStage, input: object, budget: number) {
    return [
      systemMessage(this.context, phase),
      { ...this.context.user, content: JSON.stringify({ ...input, ...this.requestContext(budget, phase === 'report') }) },
    ] as const;
  }

  verifyReport(text: string) {
    const citations = new Map<string, AiCitation>();
    let unverified = 0;
    const report = text.replace(citationPattern(), (mention, id: string) => {
      const citation = citations.get(id) ?? (citations.size < 50 ? this.evidence.lookup(id) : undefined);
      if (!citation) { unverified++; return '[证据待核实]'; }
      citations.set(id, citation);
      return mention;
    });
    const evidenceNotice = unverified ? `${unverified} 处引用无法定位，相关结论待核实。`
      : citations.size ? undefined : '模型未附可定位证据，关键结论待核实。';
    return { report, citations: [...citations.values()], evidenceNotice };
  }
}
