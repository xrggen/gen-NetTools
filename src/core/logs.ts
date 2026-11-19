import { lineEntries } from './input';
import type { LogRow, Rule } from '../shared/contracts';

const eventPattern = /(?:%%\d{2}|^|[^\w.-])([\w.-]+)\/([0-7])\/([\w.-]+)(?:\([A-Za-z][\w-]{0,15}\))?(?:\s*\[\d+\])?\s*:/;
const documentedAliases = new Map([
  ['NTP/4/LEAP_CHANGE', 'NTP/4/NTP_LEAP_CHANGE'], ['NTP/4/PEER_SELE', 'NTP/4/NTP_PEER_SELE'],
  ['NTP/4/SOURCE_LOST', 'NTP/4/NTP_SOURCE_LOST'], ['NTP/4/STRATUM_CHANGE', 'NTP/4/NTP_STRATUM_CHANGE'],
  ['DEFD/4/CPCAR_DROP_MPU', 'CPUDEFEND/4/CPCAR_DROP_MPU'],
]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fieldKey = (name: string) => name.toLowerCase().replace(/[-_]/g, '');
const ruleIdentifier = (rule: Rule) => `${rule.module}/${rule.severity}/${rule.event}`;
const documentedIdentifier = (identifier: string, rules: ReadonlyMap<string, unknown>, conflicts: Set<string>) =>
  rules.has(identifier) || conflicts.has(identifier) ? identifier : documentedAliases.get(identifier) ?? identifier;

function* huaweiEvents(input: string) {
  for (const entry of lineEntries(input)) {
    const mark = eventPattern.exec(entry.text);
    if (mark) yield { line: entry.line, identifier: `${mark[1]}/${mark[2]}/${mark[3]}` };
  }
}

export function huaweiEventEvidence(input: string, rules: Rule[], conflicts: Set<string>) {
  const definitions = new Map(rules.map(rule => [ruleIdentifier(rule), rule]));
  const found = new Map<string, { count: number; first: number; last: number }>();
  let total = 0;
  for (const { identifier, line } of huaweiEvents(input)) {
    total++;
    const occurrence = found.get(identifier);
    if (occurrence) { occurrence.count++; occurrence.last = line; }
    else if (found.size < 20) found.set(identifier, { count: 1, first: line, last: line });
  }
  const entries = [...found].map(([identifier, occurrence]) => {
    const lookup = documentedIdentifier(identifier, definitions, conflicts);
    const rule = definitions.get(lookup);
    return {
      identifier, ...occurrence,
      status: conflicts.has(lookup) ? '释义待用户选择' : rule ? '匹配字段库' : '未命中字段库',
      documentedIdentifier: rule && lookup !== identifier ? lookup : undefined,
      meaning: rule?.meaning.slice(0, 180), possibleCauses: rule?.causes.slice(0, 180),
    };
  });
  return entries.length ? { note: '行号相对本次选用的日志材料，最多列出前 20 种事件。', total, entries } : undefined;
}

function compile(rule: Rule) {
  const identifiers = new Set(rule.parameters.map(parameter => parameter.name));
  const names: string[] = [];
  let last = 0;
  let pattern = '';
  const body = rule.template.replace(eventPattern, '').trim();
  // Each field is bounded by literal text from the document, not by user-supplied regex.
  for (const match of body.matchAll(/\[([^\[\]\r\n]+)\]/g)) {
    if (!identifiers.has(match[1])) continue;
    pattern += escape(body.slice(last, match.index)) + '(.+?)';
    names.push(match[1]);
    last = match.index + match[0].length;
  }
  pattern += escape(body.slice(last));
  if (['NTP_LEAP_CHANGE', 'NTP_STRATUM_CHANGE', 'LEAP_CHANGE', 'STRATUM_CHANGE'].includes(rule.event) && rule.module === 'NTP') {
    pattern = pattern.replace(/\bchanges\b/, '(?:changes|changed)');
  }
  return { rule, names, pattern: names.length && names.length <= 6 ? new RegExp(`^${pattern}$`, 'u') : undefined };
}

export function scanHuaweiLogs(input: string, rules: Rule[], conflicts = new Set<string>()) {
  const templates = new Map(rules.map(rule => [ruleIdentifier(rule), compile(rule)]));
  const result: LogRow[] = [];
  let matched = 0;
  let partial = 0;
  let unknown = 0;
  let unresolved = 0;
  let ordinary = 0;
  for (const entry of lineEntries(input)) {
    const mark = eventPattern.exec(entry.text);
    if (!mark) { ordinary++; continue; }
    const identifier = `${mark[1]}/${mark[2]}/${mark[3]}`;
    const lookup = documentedIdentifier(identifier, templates, conflicts);
    if (conflicts.has(lookup)) { unresolved++; result.push({ ...entry, identifier, status: 'conflict' }); continue; }
    const hit = templates.get(lookup);
    if (!hit) { unknown++; result.push({ ...entry, identifier, status: 'unmatched' }); continue; }
    const body = entry.text.slice(mark.index + mark[0].length).trim();
    // Prefer explicit key=value labels, then fall back to short, template-shaped bodies.
    const fields = new Map<string, string>();
    const explicit: { name: string; value: string }[] = [];
    if (body.length <= 8192) {
      for (const match of body.matchAll(/(?:^|[(,;\s])([\w.-]+)\s*[=:]\s*([^,;)\r\n]+)(?=[,;)]|$)/g)) {
        const value = match[2].trim();
        fields.set(fieldKey(match[1]), value);
        explicit.push({ name: match[1], value });
      }
    }
    const needsFallback = hit.names.some(name => !fields.has(fieldKey(name)));
    const captures = needsFallback && body.length <= 1024 && hit.names.length <= 6 ? hit.pattern?.exec(body) : undefined;
    hit.names.forEach((name, index) => { if (captures?.[index + 1]) fields.set(fieldKey(name), captures[index + 1]); });
    const values = hit.rule.parameters.flatMap(parameter => {
      const value = fields.get(fieldKey(parameter.name));
      return value === undefined ? [] : [{ ...parameter, value }];
    });
    const known = new Set(hit.rule.parameters.map(parameter => fieldKey(parameter.name)));
    const complete = hit.rule.parameters.length === values.length;
    if (complete) matched++; else partial++;
    result.push({ ...entry, identifier, rule: hit.rule, fields: values, observed: explicit.filter(field => !known.has(fieldKey(field.name))), status: complete ? 'matched' : 'partial' });
  }
  return { result, summary: [{ label: '完整匹配', value: matched }, { label: '部分匹配', value: partial },
    { label: '待选释义', value: unresolved }, { label: '未知标识', value: unknown }, { label: '非事件行', value: ordinary }] };
}
