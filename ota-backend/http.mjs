import { timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { digest, shaPattern } from './manifest.mjs';
import { appId, chooseUpdate, compareVersions, gaPolicy, host, OtaError, parseVersion, withProviders } from './version.mjs';

const api = '/api/v3/client-update';
const maxConcurrent = 32;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function readQuery(url, keys) {
  const result = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || Object.hasOwn(result, key)) throw new OtaError(400, 'invalid_query');
    result[key] = value;
  }
  return result;
}

function requireOptIn(channel, value) {
  if (value !== undefined && !['0', '1'].includes(value)) throw new OtaError(400, 'invalid_opt_in');
  if (channel === 'beta' && value !== '1') throw new OtaError(403, 'beta_opt_in_required');
}

function responseFor(selection, requestedChannel) {
  if (!selection) return { updateAvailable: false, requestedChannel };
  const { release, transition } = selection;
  const { manifest, provider, manifestBytes, signature, manifestSha256 } = release;
  return {
    updateAvailable: true, requestedChannel, channel: manifest.channel, provider, transition,
    manifestBase64: manifestBytes, signature, manifestSha256,
    downloadPath: `${api}/download/${provider}/release/${manifest.tag}/${manifest.installer.fileName}/${manifestSha256}`,
  };
}

async function serveAsset(outcome, manifest, range, output) {
  if (outcome.location) {
    output.writeHead(302, { location: outcome.location });
    output.end();
    return;
  }
  const response = outcome.response;
  const { size, fileName } = manifest.installer;
  if (response.status === 416) {
    await response.body?.cancel();
    output.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  const contentRange = response.headers.get('content-range');
  const contentLength = response.headers.get('content-length');
  const type = response.headers.get('content-encoding');
  let expected = size;
  let valid = response.body && (!type || type === 'identity');
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
    if (!range || !match) valid = false;
    else {
      const [first, last, total] = match.slice(1).map(Number);
      const [start, end] = range.slice(6).split('-');
      const requestedStart = start === '' ? Math.max(0, size - Number(end)) : Number(start);
      const requestedEnd = start === '' || end === '' ? size - 1 : Math.min(size - 1, Number(end));
      valid = valid && total === size && first <= last && first === requestedStart && last === requestedEnd;
      expected = last - first + 1;
    }
  }
  if (!valid || (contentLength !== null && Number(contentLength) !== expected)) {
    await response.body?.cancel();
    throw new OtaError(502, 'installer_size_mismatch');
  }
  output.writeHead(response.status, {
    'content-type': 'application/octet-stream', 'content-length': expected, 'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${fileName}"`,
    ...(response.status === 206 ? { 'content-range': contentRange } : {}),
  });
  let count = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > expected) callback(new Error('Asset larger than signed size'));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(count === expected ? undefined : new Error('Incomplete asset'));
    },
  }), output);
}

export function createOtaHandler({ port, access, minimumClientVersion, providers }) {
  const expectedHost = `${host}:${port}`;
  const expectedAccess = Buffer.from(digest(access), 'hex');
  let active = 0;

  return async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    let admitted = false;
    try {
      if (request.headers.host?.toLowerCase() !== expectedHost) throw new OtaError(421, 'wrong_host');
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        throw new OtaError(405, 'method_not_allowed');
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 4096 ||
          /[\\#]/.test(request.url)) throw new OtaError(400, 'invalid_path');
      const url = new URL(request.url, `https://${expectedHost}`);
      if (url.pathname === '/healthz' && !url.search) {
        return json(response, 200, { service: `${appId}-ota`, status: 'ready', upstream: providers ? 'configured' : 'unconfigured' });
      }
      const supplied = /^Bearer ([\x21-\x7e]{1,256})$/.exec(request.headers.authorization ?? '');
      if (!supplied || !timingSafeEqual(expectedAccess, Buffer.from(digest(supplied[1]), 'hex'))) {
        response.setHeader('www-authenticate', 'Bearer');
        throw new OtaError(401, 'access_required');
      }
      if (active >= maxConcurrent) throw new OtaError(503, 'server_busy');
      active++;
      admitted = true;
      if (url.pathname === `${api}/check`) {
        const query = readQuery(url, ['version', 'channel', 'platform', 'arch', 'developer_opt_in', 'ota_policy']);
        if (!parseVersion(query.version) || !['stable', 'beta'].includes(query.channel) || query.platform !== 'win32' ||
            query.arch !== 'x64' || (query.ota_policy !== undefined && query.ota_policy !== gaPolicy)) {
          throw new OtaError(400, 'invalid_client');
        }
        requireOptIn(query.channel, query.developer_opt_in);
        if (!providers) throw new OtaError(503, 'upstream_not_configured');
        const selection = await withProviders(providers, source =>
          chooseUpdate(source, { version: query.version, channel: query.channel, policy: query.ota_policy }));
        if (minimumClientVersion && compareVersions(query.version, minimumClientVersion) < 0) {
          return json(response, 426, { code: 'minimum_client_version', minimumClientVersion,
            ...responseFor(selection, query.channel) });
        }
        return json(response, 200, responseFor(selection, query.channel));
      }
      const match = /^\/api\/v3\/client-update\/download\/(gitcode|github)\/release\/(v[^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!match) throw new OtaError(404, 'route_not_found');
      const [, provider, tag, fileName, manifestSha256] = match;
      const version = parseVersion(tag.slice(1));
      if (!version || !shaPattern.test(manifestSha256)) throw new OtaError(400, 'invalid_download');
      const query = readQuery(url, ['developer_opt_in']);
      requireOptIn(version.beta === undefined ? 'stable' : 'beta', query.developer_opt_in);
      const range = request.headers.range;
      if (range && !/^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/.test(range)) throw new OtaError(400, 'invalid_range');
      if (!providers) throw new OtaError(503, 'upstream_not_configured');
      const source = providers[provider];
      const release = await source.byTag(tag);
      if (!release) throw new OtaError(404, 'release_not_found');
      if (manifestSha256 !== release.manifestSha256 || fileName !== release.manifest.installer.fileName) {
        throw new OtaError(409, 'release_binding_mismatch');
      }
      await serveAsset(await source.download(release, range), release.manifest, range, response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      json(response, error instanceof OtaError ? error.status : 500, {
        code: error instanceof OtaError ? error.code : 'server_error',
      });
    } finally {
      if (admitted) active--;
    }
  };
}
