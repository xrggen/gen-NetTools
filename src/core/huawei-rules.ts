import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, parse as parsePath, resolve, sep } from 'node:path';
import { decode, protectedName, readLimited } from './input';
import { parseBrand, type Brand, type ImportRow, type Rule } from '../shared/contracts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function isElement(node: Node): node is Element { return 'tagName' in node; }
function attr(node: Element, name: string) { return node.attrs.find(item => item.name === name)?.value; }
function find(node: Node, check: (element: Element) => boolean): Element[] {
  const result = isElement(node) && check(node) ? [node] : [];
  if ('childNodes' in node) for (const child of node.childNodes) result.push(...find(child, check));
  return result;
}
function content(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return String(node.value);
  if (isElement(node) && ['script', 'style', 'noscript'].includes(node.tagName)) return '';
  if (!('childNodes' in node)) return '';
  const text = node.childNodes.map(content).join('');
  return isElement(node) && ['p', 'li', 'br', 'div'].includes(node.tagName) ? `${text}\n` : text;
}
function clean(value: string) { return value.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'); }

export function parseHuaweiPage(html: string, filename: string): Rule | undefined {
  const doc = parse(html);
  const meta = new Map(find(doc, el => el.tagName === 'meta').map(el => [attr(el, 'name')?.toLowerCase(), attr(el, 'content')]));
  if (meta.get('dc.type')?.toLowerCase() !== 'logref') return;
  const title = meta.get('dc.title')?.trim() ?? '';
  const id = /^([\w.-]+)\/(\d)\/([\w.-]+)$/.exec(title);
  const section = (className: string) => find(doc, el => (attr(el, 'class') ?? '').split(/\s+/).includes(className))[0];
  const sectionText = (className: string) => { const node = section(className); return node ? clean(content(node)) : ''; };
  const template = sectionText('logRefMessagebody').replace(/\n/g, ' ');
  if (!id && !template && /^dc_lsw_log_/.test(filename)) return;
  if (!id || Number(id[2]) > 7) throw new Error('无法识别模块、级别或事件标识。');
  const meaning = sectionText('logRefDescbody');
  if (!template || !meaning) throw new Error('缺少日志模板或日志含义。');
  const paramSection = section('logRefParamsbody');
  const parameters = paramSection ? find(paramSection, el => el.tagName === 'tr').flatMap(row => {
    const cells = find(row, el => el.tagName === 'td');
    return cells.length === 2 ? [{ name: clean(content(cells[0])), meaning: clean(content(cells[1])) }] : [];
  }).filter(parameter => parameter.name) : [];
  const stepHeading = find(doc, el => /^h[2-6]$/.test(el.tagName) && /^(处理步骤|处理建议)$/.test(clean(content(el))))[0];
  const parent = stepHeading?.parentNode;
  const steps = parent && 'childNodes' in parent ? clean(parent.childNodes.filter(node => node !== stepHeading).map(content).join('')) : '';
  return {
    vendor: 'Huawei', module: id[1], severity: id[2], event: id[3], template, meaning, parameters,
    causes: sectionText('logRefCausebody'), steps, source: [filename, meta.get('dc.identifier')].filter(Boolean).join(' · '),
  };
}

export function huaweiDocumentDirectory(directory: string) {
  const path = resolve(directory);
  const parts = path.slice(parsePath(path).root.length).split(sep);
  const product = parts.findLastIndex(part => !/^(?:resources|logs?|docs?|html?|v\d+r\d+(?:c\d+)?(?:[._-][\w.-]+)?)$/i.test(part));
  return parts.slice(Math.max(0, product)).join('/');
}

export async function collectHuaweiRules(directory: string, progress?: (message: string) => void,
  documentDirectory = huaweiDocumentDirectory(directory)) {
  const files = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const rules: Rule[] = [];
  const issues: ImportRow[] = [];
  let skipped = 0;
  for (const [index, file] of files.entries()) {
    if (index % 100 === 0) progress?.(`正在读取文档 ${index + 1} / ${files.length}`);
    if (!/\.html?$/i.test(file.name)) continue;
    if (protectedName.test(file.name) || !file.isFile()) { skipped++; continue; }
    const path = join(directory, file.name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) { skipped++; continue; }
      const rule = parseHuaweiPage(decode(await readLimited(path)), file.name);
      if (rule) rules.push({ ...rule, source: [documentDirectory, rule.source].filter(Boolean).join(' · ') });
      else skipped++;
    } catch (error) {
      issues.push({ name: file.name, reason: error instanceof Error ? error.message : '读取失败' });
    }
  }
  return { rules, issues, skipped };
}

type UpdateRule = Omit<Rule, 'vendor'> & { vendor: string; product?: unknown; version?: unknown };
function isRule(value: unknown): value is UpdateRule {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const nonempty = ['vendor', 'module', 'severity', 'event', 'template', 'meaning', 'source'];
  return nonempty.every(key => typeof row[key] === 'string' && !!row[key].trim()) && !!parseBrand(row.vendor) &&
    /^[\w.-]+$/.test(String(row.module)) && /^[0-7]$/.test(String(row.severity)) && /^[\w.-]+$/.test(String(row.event)) &&
    typeof row.causes === 'string' && typeof row.steps === 'string' && Array.isArray(row.parameters) && row.parameters.every((item: unknown) =>
      typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string' && item.name.trim() &&
      'meaning' in item && typeof item.meaning === 'string');
}

export function parseUpdate(value: unknown, brand?: Brand) {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('rules' in value) || !Array.isArray(value.rules)) throw new Error('无法识别字段库更新包。需要 schemaVersion: 1 和 rules 数组。');
  const rules: Rule[] = [];
  const issues: ImportRow[] = [];
  value.rules.forEach((row: unknown, index: number) => {
    if (!isRule(row)) { issues.push({ name: `第 ${index + 1} 项`, reason: '条目字段、类型或品牌不受支持。' }); return; }
    const vendor = parseBrand(row.vendor)!;
    if (brand && brand !== vendor) { issues.push({ name: `第 ${index + 1} 项`, reason: '条目的品牌与当前选择不一致。' }); return; }
    const source = [row.product, row.version, row.source].filter(part => typeof part === 'string' && part.trim()).join(' · ');
    rules.push({ vendor, module: row.module, severity: row.severity, event: row.event, template: row.template, meaning: row.meaning,
      source, causes: row.causes, steps: row.steps,
      parameters: row.parameters.map(parameter => ({ name: parameter.name, meaning: parameter.meaning })) });
  });
  return { rules, issues };
}

export async function readUpdate(path: string, brand: Brand) {
  if (protectedName.test(basename(path))) throw new Error('该文件名称属于受保护范围。');
  const bytes = await readLimited(path);
  let value: unknown;
  try { value = JSON.parse(decode(bytes, 'utf-8')); }
  catch { throw new Error('更新包必须是有效的 UTF-8 JSON。'); }
  return { ...parseUpdate(value, brand), skipped: 0 };
}
