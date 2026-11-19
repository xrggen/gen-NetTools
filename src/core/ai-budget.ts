import type { AnalysisFeature } from '../shared/contracts';
import { systemContextSize, type AnalysisContext } from './ai-skills';

const compatibilityCharacters = 8000;
const outputReserve = 8192;

function pointBytes(value: string, index: number) {
  const code = value.codePointAt(index)!;
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return code > 0xffff ? 4 : 3;
}

function prefixEnd(text: string, start: number, budget: number, escaped: boolean) {
  let end = start;
  while (end < text.length) {
    const bytes = escaped ? pointBytes(text, end) : 1;
    if (bytes > budget) break;
    budget -= bytes;
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  return end;
}

const escapedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

export function fitAnalysisNotes(notes: string, budget: number, suffix = '\n（摘要已截短）') {
  const limit = prefixEnd(notes, 0, budget, true);
  if (limit === notes.length) return notes;
  const trailer = escapedBytes(suffix) <= budget ? suffix : '';
  return notes.slice(0, prefixEnd(notes, 0, budget - escapedBytes(trailer), true)) + trailer;
}

function fitEvidence(value: string, budget: number) {
  if (!value || escapedBytes(value) <= budget) return value;
  const data = JSON.parse(value);
  const samples: unknown[] = data.entries ?? data.locations ?? [];
  data.truncated = true;
  let compact = JSON.stringify(data);
  while (escapedBytes(compact) > budget && samples.length) {
    samples.pop();
    compact = JSON.stringify(data);
  }
  return escapedBytes(compact) <= budget ? compact : '';
}

function splitBatches(feature: AnalysisFeature, text: string, limit: number, escaped: boolean) {
  const batches: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = prefixEnd(text, start, limit, escaped);
    if (end < text.length) {
      const half = start + Math.floor((end - start) / 2);
      // Prefer whole sections without letting a sparse boundary produce a very short batch.
      const region = text.slice(half, end);
      let line = 0;
      let section = 0;
      for (const match of region.matchAll(/\r\n|\r|\n/g)) {
        line = match.index + match[0].length;
        const next = region.slice(line, line + 32);
        if (/^(?:\r|\n|变更后)/.test(next) ||
            (feature === 'config' && /^[#!](?:\r|\n)/.test(next)) ||
            (feature === 'routes' && /^(?:Routing Table|VPN[- ]Instance|Routing Tables)/i.test(next))) section = line;
      }
      if (section || line) end = half + (section || line);
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
    }
    batches.push(text.slice(start, end));
    start = end;
  }
  return batches;
}

export function planAnalysis(feature: AnalysisFeature, context: AnalysisContext, material: string, evidence: string, contextTokens?: number) {
  if (contextTokens === undefined) {
    const batches = splitBatches(feature, material, compatibilityCharacters, false);
    return { batches, evidence: fitEvidence(evidence, 2400), notesBudget: 3600, recallBudget: 1600, outputTokens: undefined };
  }
  // Use escaped UTF-8 bytes as a conservative estimate compatible with unknown provider tokenizers.
  const outputTokens = Math.min(outputReserve, Math.floor(contextTokens / 4));
  const available = contextTokens - outputTokens - systemContextSize(context) - 512;
  if (available < 256) throw new Error('模型上下文预算太小，无法容纳诊断规则和输出。');
  const evidenceBudget = Math.min(12000, Math.floor(available / 3));
  evidence = fitEvidence(evidence, evidenceBudget);
  const remaining = available - escapedBytes(evidence);
  if (prefixEnd(material, 0, remaining, true) === material.length) {
    return { batches: [material], evidence, notesBudget: 0, recallBudget: 0, outputTokens };
  }
  const notesBudget = Math.min(6000, Math.floor(remaining / 3));
  const recallBudget = Math.min(2000, Math.floor(remaining / 5));
  return { batches: splitBatches(feature, material, remaining - notesBudget - recallBudget, true),
    evidence, notesBudget, recallBudget, outputTokens };
}
