import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { get } from 'node:https';
import test from 'node:test';
import { createOtaHandler } from './http.mjs';
import { digest, verifyRelease } from './manifest.mjs';
import { createProvider } from './providers.mjs';
import { createTlsOtaServer } from './server.mjs';
import { chooseUpdate, compareVersions, gaPolicy, host, installerName, manifestName, port, signatureName, withProviders } from './version.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const artifact = Buffer.from('synthetic installer fixture');
const beta = version => version.includes('-b');
function fixture(version, properties = {}) {
  const installer = { fileName: installerName(version), size: artifact.length, sha256: digest(artifact) };
  const item = { appId: 'gen-NetTools', schemaVersion: 1, version, tag: `v${version}`, channel: beta(version) ? 'beta' : 'stable',
    platform: 'win32', arch: 'x64', installer, ...properties };
  const bytes = Buffer.from(JSON.stringify(item, null, 2) + '\n');
  const signature = Buffer.from(sign(null, bytes, privateKey).toString('base64') + '\n');
  const asset = { name: installer.fileName, size: installer.size, digest: `sha256:${installer.sha256}`, id: 3 };
  return { bytes, signature, asset, tag: item.tag,
    record: { tag_name: item.tag, prerelease: beta(version), assets: [{ name: manifestName, id: 1 }, { name: signatureName, id: 2 }, asset] } };
}
const verified = (value, provider = 'gitcode') => ({
  ...verifyRelease(value.bytes, value.signature, publicKey, value.tag, value.asset), provider,
});
const sourceWith = values => ({
  byTag: async tag => values.find(release => release.manifest.tag === tag),
  latest: async channel => values.filter(release => release.manifest.channel === channel)
    .sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0],
});

test('release signature authenticates raw bytes, product identity, metadata and promotion fields', () => {
  const val = fixture('0.1.2-b7', { releaseStage: 'ga', promotionTarget: '0.1.2' });
  assert.equal(verified(val).manifest.releaseStage, 'ga');
  assert.throws(() => verified({ ...val, bytes: Buffer.concat([val.bytes, Buffer.from(' ')]) }), /invalid_signed_release/);
  assert.throws(() => verified({ ...val, asset: { ...val.asset, size: 9 } }), /invalid_signed_release/);
  assert.throws(() => verified(fixture('0.1.2-b7', { releaseStage: 'ga', promotionTarget: '0.1.3' })), /invalid_signed_release/);
  assert.throws(() => verified(fixture('0.1.2', { promotesFrom: ['0.1.1-b7'] })), /invalid_signed_release/);
  assert.throws(() => verified(fixture('0.1.2', { appId: 'gen_ScreenShare' })), /invalid_signed_release/);
});

test('GA only promotes approved precursors, before later betas and independently of latest stable', async () => {
  const releases = [
    fixture('0.1.2-b6'), fixture('0.1.2-b7', { releaseStage: 'ga', promotionTarget: '0.1.2' }),
    fixture('0.1.2', { promotesFrom: ['0.1.2-b7'] }), fixture('0.1.3'), fixture('0.1.3-b1'),
  ].map(value => verified(value));
  const policy = gaPolicy;
  const source = sourceWith(releases);
  const promotion = await chooseUpdate(source, { version: '0.1.2-b7', channel: 'beta', policy });
  assert.equal(promotion.release.manifest.version, '0.1.2');
  assert.equal(promotion.transition, 'ga-to-stable');
  assert.equal((await chooseUpdate(source, { version: '0.1.2-b7', channel: 'beta' })).release.manifest.version, '0.1.3-b1');
  assert.equal((await chooseUpdate(sourceWith(releases.slice(0, 3)), { version: '0.1.2-b6', channel: 'beta', policy })).release.manifest.version, '0.1.2-b7');
  assert.equal(await chooseUpdate(source, { version: '0.1.3', channel: 'beta', policy }), undefined);
  const leave = await chooseUpdate(sourceWith([releases[2]]), { version: '0.1.3-b1', channel: 'stable', policy });
  assert.equal(leave.transition, 'leave-beta');
});

test('GitCode checks the repository, verifies a signed release and never forwards provider access to CDN', async () => {
  const val = fixture('0.1.2');
  const source = createProvider('gitcode', { readAccess: 'synthetic-provider', publicKey, fetchImpl: async (address, options) => {
    const url = new URL(address);
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'file-cdn.gitcode.com') {
      assert.deepEqual(options.headers, {});
      return new Response(url.pathname.endsWith('.sig') ? val.signature : val.bytes);
    }
    assert.equal(url.hostname, 'api.gitcode.com');
    assert.equal(options.headers['private-token'], 'synthetic-provider');
    assert.match(url.pathname, /^\/api\/v5\/repos\/u010019490\/gen-NetTools\/releases/);
    if (url.pathname.endsWith('/latest')) {
      assert.equal(url.search, '?type=latest');
      return Response.json(val.record);
    }
    assert.match(url.pathname, /\/v0\.1\.2\/attach_files\/.+\/download$/);
    const fileName = url.pathname.split('/').at(-2);
    return new Response(null, { status: 302, headers: { location: `https://file-cdn.gitcode.com/${fileName}?synthetic=1` } });
  } });
  const release = await source.latest('stable');
  assert.equal(release.manifestSha256, digest(val.bytes));
  assert.equal((await source.download(release)).location, `https://file-cdn.gitcode.com/${val.asset.name}?synthetic=1`);
});

test('GitHub fallback is permitted for availability only and supports asset API bytes', async () => {
  const val = fixture('0.1.2');
  let calls = 0;
  const github = createProvider('github', { publicKey, fetchImpl: async (address, options) => {
    calls++;
    const url = new URL(address);
    assert.match(url.href, /^https:\/\/api\.github\.com\/repos\/xrggen\/gen-NetTools\/releases/);
    if (url.pathname.endsWith('/latest')) return Response.json(val.record);
    assert.equal(options.headers.accept, 'application/octet-stream');
    const id = url.pathname.split('/').at(-1);
    return new Response({ 1: val.bytes, 2: val.signature, 3: artifact }[id]);
  } });
  for (const status of [401, 403]) {
    const gitcode = createProvider('gitcode', { publicKey, fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(withProviders({ gitcode, github }, source => source.latest('stable')), /release_source_access_denied/);
  }
  const tlsError = createProvider('gitcode', { publicKey, fetchImpl: async () => {
    throw new TypeError('network', { cause: { code: 'CERT_HAS_EXPIRED' } });
  } });
  await assert.rejects(withProviders({ gitcode: tlsError, github }, source => source.latest('stable')), /release_source_transport_rejected/);
  const invalidCdn = createProvider('gitcode', { publicKey, fetchImpl: async address => address.includes('/latest')
    ? Response.json(val.record)
    : new Response(null, { status: 302, headers: { location: 'https://file-cdn.gitcode.com.invalid/update.json' } }),
  });
  await assert.rejects(withProviders({ gitcode: invalidCdn, github }, source => source.latest('stable')), /untrusted_source_redirect/);
  assert.equal(calls, 0);
  const timeout = createProvider('gitcode', { publicKey, fetchImpl: async () => new Response(null, { status: 503 }) });
  const release = await withProviders({ gitcode: timeout, github }, source => source.latest('stable'));
  assert.equal(release.provider, 'github');
  assert.deepEqual(Buffer.from(await (await github.download(release)).response.arrayBuffer()), artifact);
});

test('control API binds release, installer and digest, protects client queries and beta downloads', async t => {
  const release = verified(fixture('0.1.2-b1'));
  const access = 'synthetic-access-value';
  const source = { ...sourceWith([release]), download: async (_value, range) => range
    ? { response: new Response(artifact.subarray(2, 6), {
        status: 206, headers: { 'content-range': `bytes 2-5/${artifact.length}` },
      }) }
    : { response: new Response(artifact) } };
  const handler = createOtaHandler({ port, access, minimumClientVersion: '0.1.1', providers: { gitcode: source, github: source } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const send = (path, headers = {}) => new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { host: `${host}:${port}`, ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
  const check = '/api/v3/client-update/check?version=0.1.1&channel=beta&platform=win32&arch=x64';
  const client = { authorization: `Bearer ${access}` };
  assert.equal((await send('/healthz')).status, 200);
  assert.equal((await send('/healthz', { host: 'elsewhere.invalid' })).status, 421);
  assert.equal((await send(check)).status, 401);
  assert.equal((await send(check, client)).status, 403);
  assert.equal((await send(check + '&arch=x64', client)).status, 400);
  assert.equal((await send(check.replace('0.1.1', '0.1.0') + '&developer_opt_in=1', client)).status, 426);
  const result = JSON.parse((await send(check + '&developer_opt_in=1', client)).body);
  assert.equal(result.provider, 'gitcode');
  assert.equal(result.manifestBase64, release.manifestBytes);
  const pinned = result.downloadPath + '?developer_opt_in=1';
  assert.equal((await send(result.downloadPath, client)).status, 403);
  assert.equal((await send(pinned.replace(release.manifestSha256, '0'.repeat(64)), client)).status, 409);
  assert.deepEqual((await send(pinned, client)).body, artifact);
  const slice = await send(pinned, { ...client, range: 'bytes=2-5' });
  assert.equal(slice.status, 206);
  assert.deepEqual(slice.body, artifact.subarray(2, 6));
});

test('production HTTPS listener requires the fixed certificate hostname', {
  skip: !process.env.NETTOOLS_OTA_TEST_OPENSSL,
}, async t => {
  const result = spawnSync(process.env.NETTOOLS_OTA_TEST_OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc',
    '-subj', '/CN=gen-NetTools-OTA-Loopback-Test', '-addext', `subjectAltName=DNS:${host}`,
    '-days', '1', '-keyout', '-', '-out', '-'], { encoding: 'utf8', windowsHide: true, timeout: 12_000 });
  assert.equal(result.status, 0, 'In-memory TLS fixture creation failed');
  const cert = result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  const tlsKey = result.stdout.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
  assert.ok(cert && tlsKey, 'In-memory TLS fixture has no certificate pair');
  const server = createTlsOtaServer({ cert, tlsKey, access: 'synthetic-access-value', providers: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const send = servername => new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: server.address().port, servername, ca: cert,
      headers: { host: `${host}:${port}` }, path: '/healthz' }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(await send(host), 200);
  await assert.rejects(send('example.invalid'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('bootstrap exposes TLS readiness independently and denies update queries pending provider access', async t => {
  const access = 'synthetic-bootstrap-access';
  const server = createServer(createOtaHandler({ port, access }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const send = (path, authorized = false) => new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { host: `${host}:${port}`, ...(authorized ? { authorization: `Bearer ${access}` } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }).on('error', reject).end();
  });
  const status = await send('/healthz');
  assert.equal(status.status, 200);
  assert.equal(status.body.upstream, 'unconfigured');
  const check = '/api/v3/client-update/check?version=0.1.1&channel=stable&platform=win32&arch=x64';
  assert.equal((await send(check)).status, 401);
  assert.deepEqual(await send(check, true), { status: 503, body: { code: 'upstream_not_configured' } });
});
