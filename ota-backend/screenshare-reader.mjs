import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';

const origin = 'https://api.gitcode.com';
const releases = '/api/v5/repos/u010019490/gen-NetTools/releases';
const version = 'v(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})(?:-b[1-9]\\d{0,8})?';
const releasePath = new RegExp(`^/(?<tag>${version})(?:/attach_files/(?<asset>[^/]+)/download)?$`);
const digest = value => createHash('sha256').update(value).digest();

export function isReleaseRead(path, searchParams) {
  if (path === `${releases}/latest`) return searchParams.size === 1 && searchParams.get('type') === 'latest';
  if (path === releases) {
    if (searchParams.size === 0) return true;
    return searchParams.size === 2 && /^(?:[1-9]|[1-4]\d|50)$/.test(searchParams.get('page') ?? '') &&
      searchParams.get('per_page') === '20';
  }
  if (searchParams.size) return false;
  const match = path.startsWith(releases) && releasePath.exec(path.slice(releases.length));
  if (!match) return false;
  const { asset, tag } = match.groups;
  return !asset || asset === 'gen-NetTools-update.json' || asset === 'gen-NetTools-update.sig' ||
    asset === `gen-NetTools-${tag.slice(1)}-win-x64-setup.exe`;
}

export function createReader({ lease, upstreamAccess, fetchImpl = fetch, heartbeatMs = 45_000 }) {
  const expected = digest(`Bearer ${lease}`);
  const server = createServer({
    headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 3000, maxHeaderSize: 4096,
  }, async (request, response) => {
    if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === 'POST' && request.url === '/renew') {
      deadline.refresh();
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && request.url === '/stop') {
      response.once('finish', stop);
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'GET' || !request.url.startsWith(releases)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const target = new URL(origin + request.url);
      if (!isReleaseRead(target.pathname, target.searchParams)) {
        response.writeHead(403).end();
        return;
      }
      const headers = {
        accept: request.headers.accept === 'application/octet-stream' ? 'application/octet-stream' : 'application/json',
        'accept-encoding': 'identity',
        'private-token': upstreamAccess,
        'user-agent': 'gen-NetTools-release-reader',
      };
      if (/^bytes=\d{1,15}-$/.test(request.headers.range ?? '')) headers.range = request.headers.range;
      const aborted = new AbortController();
      response.once('close', () => aborted.abort());
      const upstream = await fetchImpl(target, {
        method: 'GET', headers, redirect: 'manual',
        signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(600_000)]),
      });
      const outgoing = Object.fromEntries(['content-type', 'content-range', 'location'].flatMap(name => {
        const value = upstream.headers.get(name);
        return value === null ? [] : [[name, value]];
      }));
      const length = upstream.headers.get('content-length');
      const encoding = upstream.headers.get('content-encoding');
      if (length !== null && (!encoding || encoding === 'identity')) outgoing['content-length'] = length;
      response.writeHead(upstream.status, outgoing);
      if (upstream.body) await pipeline(upstream.body, response);
      else response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    }
  });
  const stop = () => {
    clearTimeout(deadline);
    server.close();
    server.closeAllConnections();
  };
  const deadline = setTimeout(stop, heartbeatMs).unref();
  server.once('close', () => clearTimeout(deadline));
  return { server, stop };
}

// The host supervisor supplies this process's loopback lease over standard input.
if (process.argv[1] === 'gen-nettools-screenshare-reader') {
  const { port, lease } = JSON.parse(readFileSync(0, 'utf8'));
  const upstreamAccess = process.env.GITCODE_ACCESS_TOKEN;
  if (port !== 48123 || !/^[0-9a-f]{64}$/.test(lease) || !upstreamAccess) throw new Error('Release reader unavailable');
  const { server, stop } = createReader({ lease, upstreamAccess });
  server.once('error', () => { process.exitCode = 1; stop(); });
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
}
