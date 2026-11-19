import { loadInput } from './input';
import { isIP } from 'node:net';
import { AnalysisEvidence, collectAnalysisEvidence, materialLineCount, type EvidenceSource } from './ai-evidence';
import { planAnalysis } from './ai-budget';
import { prepareAnalysisContext } from './ai-skills';
import type { AiPreviewRequest, AnalysisFeature, Knowledge, RedactionField, WorkerSource } from '../shared/contracts';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type FieldValue = { name: string; start: number; end: number; original: string };

function compactRouteFields(text: string, wanted: Map<string, RedactionField>): FieldValue[] {
  const results: FieldValue[] = [];
  let inTable = false;
  let hasPrefix = false;
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const value = line[0];
    if (/^\s*Destination\/Mask\s+Proto\s+Pre\s+Cost\s+Flags\s+NextHop\s+Interface\s*$/i.test(value)) {
      inTable = true;
      hasPrefix = false;
      continue;
    }
    if (!inTable || !value.trim()) continue;
    const tokens = [...value.matchAll(/\S+/g)];
    const prefix = /^[\d.]+\/\d{1,2}$/.test(tokens[0]?.[0] ?? '') ? tokens.shift() : undefined;
    const withFlags = tokens.length === 6;
    const nextHop = tokens[withFlags ? 4 : 3]?.[0];
    if ((!prefix && !hasPrefix) || (!withFlags && tokens.length !== 5) || !/^\d+$/.test(tokens[1][0]) ||
        !/^\d+$/.test(tokens[2][0]) || !nextHop || (!isIP(nextHop) && !/^[-*]+$/.test(nextHop))) {
      inTable = false;
      continue;
    }
    hasPrefix = true;
    const items = [prefix, ...tokens.slice(0, 3), withFlags ? tokens[3] : undefined, ...tokens.slice(-2)];
    ['Destination/Mask', 'Proto', 'Pre', 'Cost', 'Flags', 'NextHop', 'Interface'].forEach((name, index) => {
      const token = items[index];
      if (wanted.has(name) && token) results.push({ name, start: line.index + token.index,
        end: line.index + token.index + token[0].length, original: token[0] });
    });
  }
  return results;
}

function redactFieldValues(text: string, fields: RedactionField[], feature: AnalysisFeature) {
  const replacements = new Map<string, string>();
  const counts = new Map(fields.map(field => [field.name, 0]));
  let nextNumber = 1;
  const byName = new Map(fields.map(field => [field.name, field]));
  const encodedNames = [...byName.keys()].sort((left, right) => right.length - left.length).map(escapeRegex).join('|');
  if (!encodedNames) return { text, matches: [], redactEvidence: (value: string) => value };
  // A labelled value ends at a line or field delimiter. Quoted values may contain delimiters.
  const configSeparator = feature === 'config' ? String.raw`|(?<=^[ \t]*(?:${encodedNames}))[ \t]+` : '';
  const pattern = new RegExp(String.raw`(?<![\w./-])(${encodedNames})([ \t]*[=:][ \t]*${configSeparator})("[^"\r\n]*"|'[^'\r\n]*'|[^,;)\r\n]*?)(?=[ \t]{2,}[A-Za-z][\w .-]*[ \t]*[=:]|[,;)]|\r?$)`, 'gm');
  const values = feature === 'routes' ? compactRouteFields(text, byName) : [];
  for (const match of text.matchAll(pattern)) {
    const value = match[3];
    const trimmed = value.trim();
    const quoted = /^(["']).*\1$/.test(trimmed);
    const original = quoted ? trimmed.slice(1, -1) : trimmed;
    if (!original) continue;
    const start = match.index + match[1].length + match[2].length + value.indexOf(trimmed) + Number(quoted);
    values.push({ name: match[1], start, end: start + original.length, original });
  }
  values.sort((a, b) => a.start - b.start);
  for (const { name, original } of values) {
    const requested = byName.get(name)?.replacement;
    if (!requested) continue;
    const prior = replacements.get(original);
    if (prior && prior !== requested) throw new Error('同一字段值对应的自定义替换不同，请调整规则。');
    replacements.set(original, requested);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const { name, start, end, original } of values) {
    if (start < cursor) throw new Error('识别到重叠的脱敏字段，请调整规则后重新预览。');
    const replacement = replacements.get(original) ?? `[脱敏_${nextNumber++}]`;
    replacements.set(original, replacement);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    parts.push(text.slice(cursor, start), replacement);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  function redactEvidence(value: string) {
    // Protect any selected input value that also happens to occur in the reference text.
    const candidates = [...replacements.keys()].filter(original => value.includes(original)).sort((a, b) => b.length - a.length);
    return candidates.length ? value.replace(new RegExp(candidates.map(escapeRegex).join('|'), 'g'), original => replacements.get(original)!) : value;
  }
  return { text: parts.join(''), matches: [...counts].map(([name, count]) => ({ name, count })), redactEvidence };
}

export async function prepareAi(request: AiPreviewRequest<WorkerSource>, contextTokens?: number, knowledge?: Knowledge) {
  const context = prepareAnalysisContext(request.feature);
  const inputs = await Promise.all(request.inputs.map(loadInput));
  if (!inputs.some(input => input.trim())) throw new Error('请输入要分析的内容。');
  const comparisonPrefix = inputs.length === 2 ? `变更前\n${inputs[0]}\n\n变更后\n` : undefined;
  const text = comparisonPrefix === undefined ? inputs[0] : comparisonPrefix + inputs[1];
  let afterStartsAt: number | undefined;
  if (comparisonPrefix !== undefined) {
    afterStartsAt = 1;
    for (const _newline of comparisonPrefix.matchAll(/\r\n|\r|\n/g)) afterStartsAt++;
  }
  const prepared = redactFieldValues(text, request.fields, request.feature);
  const evidence = collectAnalysisEvidence(request.feature, inputs, prepared.redactEvidence, knowledge);
  const plan = planAnalysis(request.feature, context, prepared.text, evidence, contextTokens);
  const sources: Record<string, EvidenceSource> = afterStartsAt !== undefined
    ? { B: { start: 2, lines: materialLineCount(inputs[0]), label: '变更前' },
      A: { start: afterStartsAt, lines: materialLineCount(inputs[1]), label: '变更后' } }
    : { [request.feature === 'logs' ? 'L' : 'S']: { start: 1, lines: materialLineCount(prepared.text),
      label: request.scope === 'selection' ? '选中片段' : '日志原文' } };
  const evidenceIndex = new AnalysisEvidence(prepared.text, sources, plan.evidence);
  let characters = 0;
  for (const batch of plan.batches) {
    for (const _character of batch) characters++;
  }
  const requests = plan.batches.length === 1 ? 1 : plan.batches.length + 1;
  return { ...plan, context, scope: request.scope, requests, characters, matches: prepared.matches, evidenceIndex };
}
