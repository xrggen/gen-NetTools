import { compareVersions, installerName, manifestName, OtaError, parseVersion, signatureName } from './version.mjs';
import { verifyRelease } from './manifest.mjs';

export const repositories = {
  gitcode: 'u010019490/gen-NetTools',
  github: 'xrggen/gen-NetTools',
};
export const sourceDefinitions = {
  gitcode: { api: 'https://api.gitcode.com/api/v5', cdn: ['file-cdn.gitcode.com'] },
  github: { api: 'https://api.github.com', cdn: ['release-assets.githubusercontent.com', 'objects.githubusercontent.com',
    'github-releases.githubusercontent.com', 'github-production-release-asset-2e65be.s3.amazonaws.com'] },
};
const pageSize = 20;
const maxPages = 50;
const bad = code => new OtaError(502, code);
const connectionErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function availabilityError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const multiple = cause?.errors;
  if (error?.name === 'TimeoutError' || connectionErrors.has(code) ||
      (Array.isArray(multiple) && multiple.length && multiple.every(item => connectionErrors.has(item.code)))) {
    return new OtaError(503, 'release_source_unavailable', { unavailable: true });
  }
  return bad('release_source_transport_rejected');
}

async function dispose(response) { await response.body?.cancel().catch(() => {}); }

async function requireStatus(response, allowed) {
  if (allowed.includes(response.status)) return response;
  const status = response.status;
  await dispose(response);
  if (status === 408 || status === 429 || status >= 500) {
    throw new OtaError(503, 'release_source_unavailable', { unavailable: true });
  }
  throw bad(status === 401 || status === 403 ? 'release_source_access_denied' : 'unexpected_source_response');
}

async function readBounded(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await dispose(response);
    throw bad('invalid_source_size');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) { throw availabilityError(error); }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel().catch(() => {}); throw bad('invalid_source_size'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  if (length === 0) throw bad('invalid_source_size');
  return Buffer.concat(chunks, length);
}

function validRedirect(allowed, value) {
  let url;
  try { url = new URL(value); } catch { throw bad('untrusted_source_redirect'); }
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw bad('untrusted_source_redirect');
  }
  return url.href;
}

function versionFromTag(tag) {
  return typeof tag === 'string' && tag.startsWith('v') ? parseVersion(tag.slice(1)) : undefined;
}

function getAsset(assets, name) {
  const matches = assets.filter(value => value?.name === name);
  if (matches.length !== 1) throw bad('invalid_release_assets');
  const { id, size, digest } = matches[0];
  const normalized = typeof digest === 'string' && digest ? (digest.startsWith('sha256:') ? digest : `sha256:${digest}`) : undefined;
  return { name, id, size, digest: normalized };
}

export function createProvider(name, { readAccess, publicKey, fetchImpl = fetch, ttl = 60_000 }) {
  const { api, cdn } = sourceDefinitions[name];
  const repository = repositories[name];
  const base = `${api}/repos/${repository}/releases`;
  const cache = new Map();
  const active = new Map();
  const accessHeaders = name === 'github'
    ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(readAccess ? { authorization: `Bearer ${readAccess}` } : {}) }
    : { accept: 'application/json', ...(readAccess ? { 'private-token': readAccess } : {}) };

  async function request(url, headers, timeout = 12_000) {
    try {
      return await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw availabilityError(error);
    }
  }

  async function metadata(suffix, allowMissing = false) {
    const response = await request(base + suffix, { ...accessHeaders, 'user-agent': 'gen-NetTools-ota/1' });
    if (allowMissing && response.status === 404) { await dispose(response); return; }
    await requireStatus(response, [200]);
    const bytes = await readBounded(response, 2 * 1024 * 1024);
    try { return JSON.parse(bytes); } catch { throw bad('invalid_source_metadata'); }
  }

  function cached(key, load) {
    const entry = cache.get(key);
    if (entry && entry.until > Date.now()) return Promise.resolve(entry.value);
    if (active.has(key)) return active.get(key);
    const pending = load().then(value => {
      cache.delete(key);
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: Date.now() + (value ? ttl : 5000) });
      return value;
    }).finally(() => active.delete(key));
    active.set(key, pending);
    return pending;
  }

  async function assetResponse(tag, asset, range, installer = false) {
    if (name === 'github' && (!Number.isSafeInteger(asset.id) || asset.id <= 0)) throw bad('invalid_release_assets');
    const endpoint = name === 'github' ? `${base}/assets/${asset.id}` :
      `${base}/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(asset.name)}/download`;
    const timeout = installer ? 600_000 : 12_000;
    const response = await request(endpoint, { ...accessHeaders, accept: 'application/octet-stream', 'user-agent': 'gen-NetTools-ota/1',
      ...(range ? { range } : {}) }, timeout);
    if (response.status === 302) {
      await dispose(response);
      const url = validRedirect(cdn, response.headers.get('location'));
      if (installer) return { location: url };
      // Provider credentials are scoped to the API origin.
      const redirected = await request(url, {});
      return { response: await requireStatus(redirected, [200]) };
    }
    if (installer && response.status === 416) return { response };
    await requireStatus(response, installer && range ? [200, 206] : [200]);
    if (response.headers.get('content-type')?.includes('application/json') && (installer || asset.name === signatureName)) {
      await dispose(response);
      throw bad('invalid_release_assets');
    }
    return { response };
  }

  async function signed(record, requestedTag, expectedChannel) {
    const version = versionFromTag(record?.tag_name);
    if (!version || (requestedTag && record.tag_name !== requestedTag) || record.draft || record.release_status === 'draft' ||
        !Array.isArray(record.assets) || typeof record.prerelease !== 'boolean' ||
        record.prerelease !== (version.beta !== undefined) ||
        (expectedChannel && (record.prerelease ? 'beta' : 'stable') !== expectedChannel)) throw bad('invalid_source_release');
    const tag = record.tag_name;
    const asset = getAsset(record.assets, installerName(version.value));
    const manifestAsset = getAsset(record.assets, manifestName);
    const signatureAsset = getAsset(record.assets, signatureName);
    const manifest = await readBounded((await assetResponse(tag, manifestAsset)).response, 64 * 1024);
    const signature = await readBounded((await assetResponse(tag, signatureAsset)).response, 1024);
    return { ...verifyRelease(manifest, signature, publicKey, tag, asset), provider: name };
  }

  function byTag(tag) {
    if (!versionFromTag(tag)) throw new OtaError(400, 'invalid_release_tag');
    return cached(`tag:${tag}`, async () => {
      const path = name === 'github' ? `/tags/${encodeURIComponent(tag)}` : `/${encodeURIComponent(tag)}`;
      const item = await metadata(path, true);
      return item === undefined ? undefined : signed(item, tag);
    });
  }

  async function beta() {
    const releases = [];
    const seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const records = await metadata(`?page=${page}&per_page=${pageSize}`);
      if (!Array.isArray(records) || records.length > pageSize) throw bad('invalid_release_listing');
      for (const record of records) {
        if (!record || typeof record.tag_name !== 'string' || typeof record.prerelease !== 'boolean' || seen.has(record.tag_name)) {
          throw bad('invalid_release_listing');
        }
        seen.add(record.tag_name);
        if (record.prerelease && !record.draft && record.release_status !== 'draft' &&
            versionFromTag(record.tag_name)?.beta !== undefined) releases.push(record);
      }
      if (records.length < pageSize) {
        const candidate = releases.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
        return candidate ? signed(candidate, undefined, 'beta') : undefined;
      }
    }
    throw bad('incomplete_release_listing');
  }

  return { byTag, latest: channel => cached(`latest:${channel}`, async () => {
    if (channel === 'beta') return beta();
    const record = await metadata(name === 'gitcode' ? '/latest?type=latest' : '/latest', true);
    return record === undefined ? undefined : signed(record, undefined, 'stable');
  }), download: (release, range) => assetResponse(release.manifest.tag, release.asset, range, true) };
}
