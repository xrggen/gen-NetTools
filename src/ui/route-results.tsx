import { useRef, useState } from 'react';
import { pageSize, routeChangeLabels, routePathFields, type Report, type RouteChangeKind, type RouteFilter,
  type RoutePage, type RoutePath, type RoutePathChange, type RoutePathField, type RouteReportDetails, type RouteRow } from '../shared/contracts';

const kinds = Object.keys(routeChangeLabels) as RouteChangeKind[];
const focusOptions = { default: '默认路由', nextHop: '下一跳变化', fewerPaths: '路径数减少' };
const formatCount = (value: number) => value.toLocaleString('zh-CN');
const pathValue = (path: RoutePath, field: RoutePathField) => path[field] === undefined || path[field] === '' ? '—' : path[field];
const fieldDelta = (before: RoutePath, after: RoutePath, field: RoutePathField) =>
  `${routePathFields[field]} ${pathValue(before, field)} → ${pathValue(after, field)}`;

function summarize(row: RouteRow) {
  const { before, after, pathChanges } = row;
  if (row.coverage) return `仅变更${row.coverage === 'before' ? '前' : '后'}覆盖 · ${before.length || after.length} 条路径`;
  if (row.change !== 'modified') return `${routeChangeLabels[row.change]} ${before.length || after.length} 条路径`;
  const summary: string[] = [];
  if (before.length !== after.length) summary.push(`路径数 ${before.length} → ${after.length}`);
  if (before.length === 1 && after.length === 1) {
    const fields = (Object.keys(routePathFields) as RoutePathField[]).filter(field => before[0][field] !== after[0][field]);
    summary.push(...fields.slice(0, 2).map(field => fieldDelta(before[0], after[0], field)));
  } else {
    const added = pathChanges.filter(path => path.change === 'added').length;
    const removed = pathChanges.filter(path => path.change === 'removed').length;
    const modified = pathChanges.filter(path => path.change === 'modified');
    if (added) summary.push(`新增 ${added} 条路径`);
    if (removed) summary.push(`删除 ${removed} 条路径`);
    if (modified.length === 1 && modified[0].change === 'modified') {
      const path = modified[0];
      summary.push(fieldDelta(path.before, path.after, path.fields[0]));
    } else if (modified.length) summary.push(`${modified.length} 条路径属性变化`);
  }
  return summary.join(' · ');
}

function PathDetails({ entry, coverage }: { entry: RoutePathChange; coverage: RouteRow['coverage'] }) {
  const path = entry.change === 'removed' ? entry.before : entry.after;
  const label = coverage ? (coverage === 'before' ? '仅变更前路径' : '仅变更后路径') :
    ({ added: '新增路径', removed: '删除路径', modified: '路径属性变化' })[entry.change];
  return <li className={coverage ? 'scopeOnly' : entry.change}>
    <div><strong>{label}</strong><code>{path.nextHop} → {path.interface}</code></div>
    {entry.change === 'modified'
      ? <><small>{path.protocol} · 变更前第 {entry.before.line} 行 → 变更后第 {path.line} 行</small>
          <table><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody>
            {entry.fields.map(field => <tr key={field}><th scope="row">{routePathFields[field]}</th>
              <td><code>{pathValue(entry.before, field)}</code></td><td><code>{pathValue(path, field)}</code></td></tr>)}
          </tbody></table></>
      : <><small>{path.protocol} · Pre {path.preference} · Cost {path.cost} · 标志 {path.flags || '—'} · 第 {path.line} 行</small>
          {(path.relayNextHop || path.tunnelId) && <small>递归下一跳 {path.relayNextHop ?? '—'} · 隧道 {path.tunnelId ?? '—'}</small>}</>}
  </li>;
}

export function RouteResults({ report, details, blocked, onPaging, onError }: {
  report: Report; details: RouteReportDetails; blocked: boolean; onPaging: (active: boolean) => void; onError: (value: unknown) => void;
}) {
  const [filter, setFilter] = useState<RouteFilter>({});
  const [prefix, setPrefix] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<RoutePage>(() => ({
    rows: report.rows.filter((row): row is RouteRow => 'prefix' in row), total: report.total, groups: details.groups,
  }));
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [pending, setPending] = useState(false);
  const requesting = useRef(false);
  const hasOneSidedCoverage = details.coverage.some(scope => scope.before === undefined || scope.after === undefined);
  const tables = [...new Set(details.coverage.map(scope => scope.table))];
  const pageTables = new Map<string, RouteRow[]>();
  for (const row of page.rows) {
    const list = pageTables.get(row.table);
    if (list) list.push(row);
    else pageTables.set(row.table, [row]);
  }

  async function show(next: RouteFilter, start = 0) {
    if (requesting.current || blocked) return;
    requesting.current = true;
    setPending(true);
    onPaging(true);
    try {
      const value = await window.nettools.routePage(start, next);
      setPage(value);
      setFilter(next);
      setOffset(start);
    } catch (error) { onError(error); }
    finally {
      requesting.current = false;
      setPending(false);
      onPaging(false);
    }
  }

  function toggleGroup(table: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }

  return <section className="panel route-results" aria-label="路由比对结果" aria-busy={pending}>
    <h2>路由比对结果</h2>
    <fieldset className="route-overview" disabled={blocked || pending} aria-label="按变化类型筛选">
      <button aria-pressed={filter.change === undefined} onClick={() => void show({ ...filter, change: undefined })}>
        全部<strong>{formatCount(report.total)}</strong></button>
      {kinds.map(kind => <button key={kind} className={kind} aria-pressed={filter.change === kind}
        onClick={() => void show({ ...filter, change: filter.change === kind ? undefined : kind })}>
        {routeChangeLabels[kind]}<strong>{formatCount(details.counts[kind])}</strong></button>)}
    </fieldset>
    <details className="route-coverage" open={hasOneSidedCoverage || undefined}>
      <summary>快照覆盖范围{hasOneSidedCoverage && <strong>含单侧覆盖</strong>}</summary>
      <table><thead><tr><th>路由表</th><th>地址族</th><th>变更前</th><th>变更后</th></tr></thead><tbody>
        {details.coverage.map(scope => <tr key={`${scope.family}/${scope.table}`} className={scope.before === undefined || scope.after === undefined ? 'scopeOnly' : undefined}>
          <td>{scope.table}</td><td>IPv{scope.family}</td><td>{scope.before === undefined ? '未覆盖' : `${formatCount(scope.before)} 个前缀`}</td>
          <td>{scope.after === undefined ? '未覆盖' : `${formatCount(scope.after)} 个前缀`}</td></tr>)}
      </tbody></table>
    </details>
    <form onSubmit={event => { event.preventDefault(); void show({ ...filter, prefix: prefix.trim() || undefined }); }}>
      <fieldset className="toolbar route-filters" disabled={blocked || pending}>
        <label>VRF<select value={filter.table ?? ''} onChange={event => void show({ ...filter, table: event.target.value || undefined })}>
          <option value="">全部路由表</option>{tables.map(table => <option key={table}>{table}</option>)}</select></label>
        <label>地址族<select value={filter.family ?? ''} onChange={event => void show({ ...filter, family: event.target.value ? Number(event.target.value) as 4 | 6 : undefined })}>
          <option value="">全部</option><option value="4">IPv4</option><option value="6">IPv6</option></select></label>
        <label>协议<select value={filter.protocol ?? ''} onChange={event => void show({ ...filter, protocol: event.target.value || undefined })}>
          <option value="">全部</option>{details.protocols.map(protocol => <option key={protocol}>{protocol}</option>)}</select></label>
        <label>快速筛选<select value={filter.focus ?? ''} onChange={event => void show({ ...filter, focus: event.target.value as RouteFilter['focus'] || undefined })}>
          <option value="">全部变化</option>{Object.entries(focusOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>前缀<input type="search" name="route-prefix" value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="例如 192.0.2.0/24" /></label>
        <button type="submit">搜索</button>
        <button type="button" onClick={() => { setPrefix(''); void show({}); }}>清除筛选</button>
      </fieldset>
    </form>
    <p className="dim route-result-count" aria-live="polite">{pending ? '正在筛选…' : `匹配 ${formatCount(page.total)} 个前缀`}</p>
    {!page.total && <p className="notice">{report.total ? '没有符合筛选条件的路由。' : '没有差异。'}</p>}
    {page.groups.filter(group => pageTables.has(group.table)).map(group => {
      const { table, counts } = group;
      const expanded = !collapsed.has(table);
      return <section className="route-group" key={table}>
        <h3><button aria-expanded={expanded} onClick={() => toggleGroup(table)}>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{table}
          {kinds.filter(kind => counts[kind]).map(kind => <small key={kind} className={kind}>{routeChangeLabels[kind]} {formatCount(counts[kind])}</small>)}
        </button></h3>
        {expanded && <ul className="route-rows">{pageTables.get(table)?.map(row => {
          const kind = row.coverage ? 'scopeOnly' : row.change;
          return <li key={row.prefix}><details>
            <summary><span className={`route-change ${kind}`}>{routeChangeLabels[kind]}</span><small>IPv{row.family}</small>
              <code>{row.prefix}</code><span className="route-delta">{summarize(row)}</span></summary>
            <ul className="route-paths">{row.pathChanges.map((entry, index) => <PathDetails key={index} entry={entry} coverage={row.coverage}/>)}</ul>
          </details></li>;
        })}</ul>}
      </section>;
    })}
    {page.total > pageSize && <footer className="pager">
      <button disabled={pending || blocked || offset === 0} onClick={() => void show(filter, offset - pageSize)}>上一页</button>
      <span>{formatCount(offset + 1)}–{formatCount(Math.min(offset + pageSize, page.total))} / {formatCount(page.total)}</span>
      <button disabled={pending || blocked || offset + pageSize >= page.total} onClick={() => void show(filter, offset + pageSize)}>下一页</button>
    </footer>}
  </section>;
}
