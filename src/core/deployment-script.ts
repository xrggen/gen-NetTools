import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import * as XLSX from 'xlsx';
import type { Encoding } from '../shared/contracts';
import type { CommandLine, DeviceInfo, TemplateKind } from '../shared/deployment';
import { decode, lineEntries, readLimited } from './input';

export type ScriptRow = { line: number; cells: string[] };
export type ImportedDevice = DeviceInfo & { host: string; port: number; password?: string };
const headers = { devices: ['host', 'username', 'token'], commands: ['command'] };
export const aliasPattern = /^[\p{L}\p{N}_.-]{1,64}$/u;

function parseCsv(text: string): ScriptRow[] {
  const rows: ScriptRow[] = [];
  let line = 1;
  let rowLine = 1;
  let cells: string[] = [];
  let value = '';
  let inQuotes = false;
  let closedQuote = false;
  let hasData = false;

  function endCell() { cells.push(value); value = ''; closedQuote = false; }
  function endRow() { endCell(); rows.push({ line: rowLine, cells }); cells = []; hasData = false; }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const newline = ch === '\r' || ch === '\n';
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { inQuotes = false; closedQuote = true; }
      } else if (newline) {
        value += (ch === '\r' && text[i + 1] === '\n') ? ch + text[++i] : ch;
        line++;
      } else value += ch;
      continue;
    }

    if (newline) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow(); rowLine = ++line;
      continue;
    }
    hasData = true;
    if (ch === ',') { endCell(); continue; }
    if (closedQuote) throw new Error(`CSV 第 ${line} 行的引号后应为逗号或换行。`);
    if (ch === '"') {
      if (value) throw new Error(`CSV 第 ${line} 行包含位置无效的引号。`);
      inQuotes = true;
    } else value += ch;
  }
  if (inQuotes) throw new Error(`CSV 第 ${rowLine} 行开始的引号未闭合。`);
  if (hasData || cells.length) endRow();
  return rows;
}

export async function readDeploymentText(path: string, encoding: Encoding): Promise<ScriptRow[]> {
  const format = extname(path).toLowerCase();
  if (!['.txt', '.log', '.csv'].includes(format)) throw new Error('此读取方式仅适用于 TXT、LOG 或 CSV。');
  const text = decode(await readLimited(path), encoding);
  if (format === '.csv') return parseCsv(text);
  return Array.from(lineEntries(text), entry => ({ line: entry.line, cells: [entry.text] }));
}

async function workbookRows(path: string, kind: TemplateKind) {
  const book = XLSX.read(await readLimited(path), { type: 'buffer', cellFormula: true, sheets: 0 });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet?.['!ref']) return [];
  const rows = new Map<number, string[]>();
  const columns = headers[kind].length;
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!') || !cell || (cell.v == null && !cell.f && !cell.F)) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (c >= columns) throw new Error('Excel 第 ' + (r + 1) + ' 行有模板之外的列。');
    if (cell.f || cell.F || cell.t === 'e') throw new Error('Excel 第 ' + (r + 1) + ' 行包含公式或错误值，请改成文本。');
    let cells = rows.get(r);
    if (!cells) {
      cells = Array<string>(columns).fill('');
      rows.set(r, cells);
    }
    cells[c] = XLSX.utils.format_cell(cell);
  }
  return Array.from(rows, ([index, cells]) => ({ line: index + 1, cells })).sort((a, b) => a.line - b.line);
}

async function tabularRows(path: string, kind: TemplateKind) {
  const ext = extname(path).toLowerCase();
  if (ext === '.xls' || ext === '.xlsx') return workbookRows(path, kind);
  if (kind === 'devices' && ext === '.txt') {
    const text = decode(await readLimited(path));
    if (text.slice(0, text.search(/[\r\n]|$/)).includes('\t')) {
      return Array.from(lineEntries(text), row => ({ line: row.line, cells: row.text.split('\t') }));
    }
    return parseCsv(text);
  }
  if (ext === '.csv') return readDeploymentText(path, 'auto');
  throw new Error('请选择模板支持的文件格式。');
}

function dataRows(rows: ScriptRow[], kind: TemplateKind) {
  const names = headers[kind];
  const header = rows[0];
  if (!header || header.line !== 1 || header.cells.length !== names.length
    || names.some((value, index) => header.cells[index].trim().toLowerCase() !== value)) {
    throw new Error('文件第一行应为 ' + names.join(',') + '。');
  }
  return rows.slice(1).filter(row => row.cells.some(value => value.length > 0)).map(row => {
    if (row.cells.length !== names.length) throw new Error('第 ' + row.line + ' 行应包含 ' + names.length + ' 列。');
    return row;
  });
}

function endpoint(value: string, line: number) {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  const hostPort = /^([^:]+):(\d+)$/.exec(value);
  const host = bracket?.[1] ?? hostPort?.[1] ?? value;
  const port = Number(bracket?.[2] ?? hostPort?.[2] ?? 22);
  if ((!isIP(host) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*\.?$/i.test(host))
    || (bracket && isIP(host) !== 6) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('设备清单第 ' + line + ' 行的 host 无效。IPv6 指定端口时使用 [IPv6]:端口。');
  }
  return { host, port };
}

export async function readDevices(path: string): Promise<ImportedDevice[]> {
  const rows = dataRows(await tabularRows(path, 'devices'), 'devices');
  if (!rows.length) throw new Error('设备清单没有可测试的设备。');
  const seen = new Set<string>();
  return rows.map(({ line, cells: [address, account, token] }) => {
    const label = address.trim();
    const username = account.trim();
    const target = endpoint(label, line);
    if (!username || /[\x00-\x1f\x7f]/.test(username) || !token || /[\r\n\0]/.test(token)) {
      throw new Error('设备清单第 ' + line + ' 行需要有效的 username 和 token。');
    }
    const identity = target.host.toLowerCase() + ':' + target.port;
    if (seen.has(identity)) throw new Error('设备清单第 ' + line + ' 行重复指定同一个设备地址。');
    seen.add(identity);
    const keyAlias = token.startsWith('key:') ? token.slice(4) : undefined;
    if (keyAlias !== undefined && !aliasPattern.test(keyAlias)) throw new Error('设备清单第 ' + line + ' 行的私钥别名无效。');
    return { id: randomUUID(), label, username, keyAlias, password: keyAlias === undefined ? token : undefined, ...target };
  });
}

export async function readCommands(path: string): Promise<CommandLine[]> {
  const format = extname(path).toLowerCase();
  const rows = format === '.txt' || format === '.log'
    ? await readDeploymentText(path, 'auto')
    : dataRows(await tabularRows(path, 'commands'), 'commands');
  const commands = rows.filter(row => row.cells[0].trim()).map(row => {
    const text = row.cells[0];
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(text)) throw new Error('脚本第 ' + row.line + ' 行包含换行或控制字符，请每行填写一条命令。');
    return { line: row.line, text };
  });
  if (!commands.length) throw new Error('脚本没有可下发的命令。');
  return commands;
}

export function templateFile(kind: TemplateKind, extension: string) {
  if (extension === '.csv') return Buffer.from('\ufeff' + headers[kind].join(',') + '\r\n', 'utf8');
  if (extension !== '.xlsx') throw new Error('模板请保存为 XLSX 或 CSV。');
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers[kind]]);
  sheet['!cols'] = headers[kind].map(() => ({ wch: kind === 'commands' ? 60 : 25 }));
  XLSX.utils.book_append_sheet(book, sheet, kind === 'devices' ? 'Devices' : 'Commands');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
