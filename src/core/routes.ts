import { isIP } from 'node:net';
import { lineEntries } from './input';
import { pageSize, routePathFields, type RouteCounts, type RouteCoverage, type RouteFilter, type RoutePage,
  type RoutePath, type RoutePathChange, type RoutePathField, type RouteRow } from '../shared/contracts';

type Group = { family: 4 | 6; table: string; prefix: string; paths: RoutePath[] };
type Scope = { family: 4 | 6; table: string; prefixes: number };
const tablePattern = /^(?:Routing\s+Tables?|VPN[- ]Instance(?:\s+Name)?)\s*:\s*(\S+)/i;
const prefixPattern = /^([0-9a-f:.]+)\/(\d{1,3})(?:\s+|$)/i;
const rowPattern = /^(\S+)\s+(\d+)\s+(\d+)\s+(?:(\S+)\s+)?(\S+)\s+(\S+)$/;
const printTable = (value: string) => /^_?public_?$/i.test(value) ? 'Public' : value;
const scopeKey = (table: string, family: 4 | 6) => JSON.stringify([table, family]);
const collator = new Intl.Collator('en', { numeric: true });
const compareTables = (a: string, b: string) => Number(b === 'Public') - Number(a === 'Public') || collator.compare(a, b);

function parsePathColumns(value: string) {
  const row = rowPattern.exec(value);
  if (row && validNextHop(row[5])) return row;
  const compactInterface = value.replace(/([a-z][\w-]*)\s+(\d+(?:[/.]\d+)*)$/i, '$1$2');
  if (compactInterface !== value) {
    const compact = rowPattern.exec(compactInterface);
    if (compact && validNextHop(compact[5])) return compact;
  }
}

function validNextHop(hop: string) { return isIP(hop.split('%')[0]) || /^[-*]+$/.test(hop); }

function normalizeIp(value: string) {
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}
function routePrefix(address: string, length: string) {
  const family = isIP(address);
  if ((family !== 4 && family !== 6) || Number(length) > (family === 4 ? 32 : 128)) throw new Error('路由快照包含无效前缀。');
  return { family, prefix: `${normalizeIp(address)}/${Number(length)}` } as const;
}

export function parseHuaweiSnapshot(text: string, explicitTable?: string) {
  const override = explicitTable?.trim();
  const fallbackTable = printTable(override || 'Public');
  let table = fallbackTable;
  const groups = new Map<string, Group>();
  const scopes = new Map<string, Scope>();
  let current: ReturnType<typeof routePrefix> | undefined;
  let isTableBody = false;
  let pending = '';
  let parsed = 0;
  let expected: number | undefined;
  let tableStart = 0;
  let familyHint: 4 | 6 | undefined;
  let block: { line: number; fields: Map<string, string> } | undefined;
  function recordScope(family: 4 | 6) {
    const key = scopeKey(table, family);
    let scope = scopes.get(key);
    if (!scope) { scope = { table, family, prefixes: 0 }; scopes.set(key, scope); }
    return scope;
  }
  function addRoute(destination: ReturnType<typeof routePrefix>, path: RoutePath) {
    if (familyHint && familyHint !== destination.family) throw new Error(`第 ${path.line} 行的地址族与命令不一致。`);
    const scope = recordScope(destination.family);
    const key = JSON.stringify([table, destination.family, destination.prefix]);
    let group = groups.get(key);
    if (!group) { group = { ...destination, table, paths: [] }; groups.set(key, group); scope.prefixes++; }
    group.paths.push(path);
    parsed++;
  }
  function flushBlock() {
    if (!block) return;
    const { fields, line } = block;
    const required = ['destination', 'prefixlength', 'nexthop', 'preference', 'cost', 'protocol', 'interface'];
    if (required.some(name => !fields.has(name)) || !/^\d{1,3}$/.test(fields.get('prefixlength')!) ||
        !/^\d+$/.test(fields.get('preference')!) || !/^\d+$/.test(fields.get('cost')!)) {
      throw new Error(`第 ${line} 行的 IPv6 条目不完整。`);
    }
    const route = routePrefix(fields.get('destination')!, fields.get('prefixlength')!);
    const hop = fields.get('nexthop')!;
    if (route.family !== 6 || !isIP(hop.split('%')[0])) throw new Error(`第 ${line} 行不符合普通 IPv6 输出。`);
    const relay = fields.get('relaynexthop');
    addRoute(route, { protocol: fields.get('protocol')!, preference: Number(fields.get('preference')), cost: Number(fields.get('cost')),
      flags: fields.get('flags') ?? '', nextHop: normalizeIp(hop), interface: fields.get('interface')!, line,
      relayNextHop: relay ? normalizeIp(relay) : undefined, tunnelId: fields.get('tunnelid') });
    block = undefined;
  }
  function checkCount() {
    flushBlock();
    if (pending || (expected !== undefined && parsed - tableStart !== expected)) throw new Error('路由快照的行数与声明不符，请检查是否包含全部输出。');
  }
  for (const { line, text: raw } of lineEntries(text)) {
    const value = raw.trim();
    if (!value || /^[-=]+$/.test(value)) continue;
    if (/^(?:\S+\s+)?display\s+ip(?:v6)?\s+routing-table\b/i.test(value)) {
      if (/\sverbose\s*$/i.test(value)) throw new Error('首版仅支持普通路由输出。');
      checkCount(); isTableBody = false; current = undefined; expected = undefined; tableStart = parsed;
      familyHint = /\bipv6\b/i.test(value) ? 6 : 4;
      const vpn = /\bvpn-instance\s+(\S+)/i.exec(value);
      table = vpn && !override ? printTable(vpn[1]) : fallbackTable;
      continue;
    }
    const heading = tablePattern.exec(value);
    if (heading) { checkCount(); expected = undefined; tableStart = parsed; table = printTable(heading[1]); current = undefined; isTableBody = false; continue; }
    const counts = /^(?:(?:Destinations?\s*:\s*\d+\s+)?Routes?|Summary Count)\s*:\s*(\d+)(?:\s+Configured Routes\s*:\s*\d+)?$/i.exec(value);
    if (counts) { expected = Number(counts[1]); if (expected === 0 && familyHint) recordScope(familyHint); continue; }
    if (/^Destination(?:\/Mask)?\s+Proto\b/i.test(value)) { isTableBody = true; continue; }
    if (/^\S+[>#\]]$/.test(value)) { checkCount(); isTableBody = false; continue; }
    if (/^Destination\s*:/i.test(value)) {
      flushBlock();
      block = { line, fields: new Map() };
    }
    if (block) {
      const parts = [...value.matchAll(/(?:^|\s{2,})([\w ]+?)\s*:\s*(\S*)/g)];
      const allowed = /^(?:destination|prefixlength|nexthop|preference|cost|protocol|relaynexthop|tunnelid|interface|flags)$/i;
      if (!parts.length || parts.some(part => !allowed.test(part[1]))) throw new Error(`第 ${line} 行不符合普通 IPv6 路由输出。`);
      for (const part of parts) block.fields.set(part[1].toLowerCase(), part[2]);
      continue;
    }
    const prefix = prefixPattern.exec(value);
    if (prefix) current = routePrefix(prefix[1], prefix[2]);
    if (!isTableBody && !prefix) continue;
    const body = prefix ? value.slice(prefix[0].length).trim() : value;
    if (prefix && pending) throw new Error(`第 ${line} 行之前有未完成的路由条目。`);
    if (prefix && !body) { pending = 'prefix'; continue; }
    const candidate = pending && pending !== 'prefix' ? `${pending} ${body}` : body;
    const row = parsePathColumns(candidate);
    if (!row || !current) {
      if (current && !pending && /^\S+\s+\d+\s+\d+(?:\s+\S+){0,2}$/.test(body)) { pending = body; continue; }
      throw new Error(`第 ${line} 行无法解析为普通路由条目，请检查快照是否完整。`);
    }
    pending = '';
    addRoute(current, { protocol: row[1], preference: Number(row[2]), cost: Number(row[3]), flags: row[4] ?? '',
      nextHop: normalizeIp(row[5]), interface: row[6], line });
  }
  checkCount();
  if (!scopes.size) throw new Error('没有识别到可比较的华为普通路由表。');
  return { groups, scopes };
}

const fields = Object.keys(routePathFields) as RoutePathField[];
const pathValues = (path: RoutePath) => JSON.stringify(fields.map(field => path[field]));
const pathIdentity = (path: RoutePath) => JSON.stringify([path.protocol, path.nextHop, path.interface]);

function unmatchedPaths(source: Map<string, RoutePath>, other: Map<string, RoutePath>) {
  const groups = new Map<string, RoutePath[]>();
  for (const [key, path] of source) {
    if (other.has(key)) continue;
    const identity = pathIdentity(path);
    const group = groups.get(identity);
    if (group) group.push(path);
    else groups.set(identity, [path]);
  }
  return groups;
}

function comparePaths(before: RoutePath[], after: RoutePath[]) {
  if (before.length === 1 && after.length === 1 && fields.every(field => before[0][field] === after[0][field])) return;
  const oldPaths = new Map(before.map(path => [pathValues(path), path]));
  const newPaths = new Map(after.map(path => [pathValues(path), path]));
  const removed = unmatchedPaths(oldPaths, newPaths);
  const added = unmatchedPaths(newPaths, oldPaths);
  const pathChanges: RoutePathChange[] = [];
  for (const key of new Set([...removed.keys(), ...added.keys()])) {
    const oldGroup = removed.get(key) ?? [];
    const newGroup = added.get(key) ?? [];
    if (oldGroup.length === 1 && newGroup.length === 1) {
      const [previous] = oldGroup;
      const [next] = newGroup;
      pathChanges.push({ change: 'modified', before: previous, after: next, fields: fields.filter(field => previous[field] !== next[field]) });
    } else {
      for (const path of oldGroup) pathChanges.push({ change: 'removed', before: path });
      for (const path of newGroup) pathChanges.push({ change: 'added', after: path });
    }
  }
  if (pathChanges.length) return { before: [...oldPaths.values()], after: [...newPaths.values()], pathChanges };
}

export function compareRoutes(before: string, after: string, beforeScope?: string, afterScope?: string) {
  const left = parseHuaweiSnapshot(before, beforeScope);
  const right = parseHuaweiSnapshot(after, afterScope);
  if ((beforeScope?.trim() || afterScope?.trim()) &&
      (left.scopes.size !== right.scopes.size || [...left.scopes.keys()].some(scope => !right.scopes.has(scope)))) {
    throw new Error('两份快照覆盖的地址族或路由表不同，请提供同一范围的前后快照。');
  }
  const rows: RouteRow[] = [];
  for (const key of new Set([...left.groups.keys(), ...right.groups.keys()])) {
    const a = left.groups.get(key);
    const b = right.groups.get(key);
    const paths = comparePaths(a?.paths ?? [], b?.paths ?? []);
    if (!paths) continue;
    const { family, table, prefix } = (a ?? b)!;
    const scope = scopeKey(table, family);
    const coverage = !right.scopes.has(scope) ? 'before' : !left.scopes.has(scope) ? 'after' : undefined;
    rows.push({ family, table, prefix, ...paths, coverage,
      change: a && b ? 'modified' : a ? 'removed' : 'added' });
  }
  const coverage: RouteCoverage[] = [];
  for (const key of new Set([...left.scopes.keys(), ...right.scopes.keys()])) {
    const a = left.scopes.get(key);
    const b = right.scopes.get(key);
    const { family, table } = (a ?? b)!;
    coverage.push({ family, table, before: a?.prefixes, after: b?.prefixes });
  }
  const byTable = (a: Pick<RouteCoverage, 'table' | 'family'>, b: Pick<RouteCoverage, 'table' | 'family'>) =>
    compareTables(a.table, b.table) || a.family - b.family;
  return { rows: rows.sort(byTable), coverage: coverage.sort(byTable) };
}

function matchesRoute(row: RouteRow, filter: RouteFilter, prefix: string) {
  return (!filter.change || filter.change === (row.coverage ? 'scopeOnly' : row.change)) &&
    (!filter.table || filter.table === row.table) && (!filter.family || filter.family === row.family) &&
    (!prefix || row.prefix.toLowerCase().includes(prefix)) &&
    (!filter.protocol || row.before.some(path => path.protocol === filter.protocol) || row.after.some(path => path.protocol === filter.protocol)) &&
    (filter.focus !== 'default' || row.prefix === '0.0.0.0/0' || row.prefix === '::/0') &&
    (filter.focus !== 'fewerPaths' || (row.change === 'modified' && row.before.length > row.after.length)) &&
    (filter.focus !== 'nextHop' || (row.change === 'modified' && (
      row.before.some(path => !row.after.some(next => next.nextHop === path.nextHop)) ||
      row.after.some(path => !row.before.some(previous => previous.nextHop === path.nextHop)))));
}

export function pageRoutes(all: RouteRow[], offset: number, filter: RouteFilter) {
  const prefix = filter.prefix?.trim().toLowerCase() ?? '';
  const counts: RouteCounts = { added: 0, removed: 0, modified: 0, scopeOnly: 0 };
  const groups = new Map<string, RouteCounts>();
  const rows: RouteRow[] = [];
  let total = 0;
  for (const row of all) {
    if (!matchesRoute(row, filter, prefix)) continue;
    const change = row.coverage ? 'scopeOnly' : row.change;
    let group = groups.get(row.table);
    if (!group) { group = { added: 0, removed: 0, modified: 0, scopeOnly: 0 }; groups.set(row.table, group); }
    group[change]++;
    counts[change]++;
    if (total >= offset && rows.length < pageSize) rows.push(row);
    total++;
  }
  const page: RoutePage = { rows, total, groups: [...groups].map(([table, counts]) => ({ table, counts })) };
  return { page, counts };
}
