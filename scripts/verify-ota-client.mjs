import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { shared } from './stage-windows.mjs';

const task = await realpath(process.argv[2]);
const within = relative(await realpath(join(shared, 'codex_temp-script')), task);
if (!within || within.startsWith('..') || isAbsolute(within) || !basename(task).startsWith('gen-NetTools-')) {
  throw new Error('请在共享临时目录下使用该任务的独占目录。');
}
const bundle = await build({
  stdin: { contents: `export * from './src/core/ota-protocol';
    export * from './src/core/ota-download'; export * from './src/desktop/ota-updates';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
});
const { OtaProtocol, OtaUpdates, saveInstaller } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const access = 'synthetic-client-test-000000000001';
const origin = 'https://ota.12306.gd.cn:23887';
const data = Buffer.from('Synthetic installer payload used solely for a read-and-verify test.');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const signal = new AbortController().signal;

function response(statusCode, body, headers = {}) {
  return Object.assign(Readable.from(body instanceof Uint8Array ? [body] : body), { headers, statusCode });
}

function releaseBody(version = '0.1.2', extra = {}, fields = {}) {
  const channel = version.includes('-b') ? 'beta' : 'stable';
  const fileName = `gen-NetTools-${version}-win-x64-setup.exe`;
  const tag = `v${version}`;
  const manifest = {
    schemaVersion: 1, appId: 'gen-NetTools', platform: 'win32', arch: 'x64',
    channel, version, tag, installer: { fileName, sha256: sha256(data), size: data.length }, ...extra,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = sha256(bytes);
  return { updateAvailable: true, provider: 'gitcode', requestedChannel: 'stable', channel, manifestSha256: digest,
    manifestBase64: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64'),
    downloadPath: `/api/v3/client-update/download/gitcode/release/${tag}/${fileName}/${digest}`, ...fields };
}

const check = async (body, version = '0.1.1', channel = 'stable', statusCode = 200) => {
  const protocol = new OtaProtocol('pinned test CA', publicKey, async (url, headers, _signal, ca) => {
    assert.equal(url.origin, origin);
    assert.equal(url.searchParams.get('version'), version);
    assert.equal(url.searchParams.get('developer_opt_in'), channel === 'beta' ? '1' : null);
    assert.equal(url.searchParams.get('ota_policy'), 'ga-promotion-v1');
    assert.equal(headers.authorization, `Bearer ${access}`);
    assert.equal(ca, 'pinned test CA');
    return response(statusCode, Buffer.from(JSON.stringify(body)));
  });
  return protocol.check(version, channel, access, signal);
};

const latest = releaseBody();
const candidate = await check(latest);
assert.equal(candidate.manifest.version, '0.1.2');
assert.equal(await check({ requestedChannel: 'stable', updateAvailable: false }), undefined);
assert.equal((await check(latest, '0.1.1', 'stable', 426)).mandatory, true);
assert.equal((await check(releaseBody('0.1.2', { promotesFrom: ['0.1.2-b1'] }, { requestedChannel: 'beta', transition: 'ga-to-stable' }),
  '0.1.2-b1', 'beta')).manifest.releaseStage, 'stable');
assert.equal((await check(releaseBody('0.1.2', {}, { transition: 'leave-beta' }), '0.1.3-b1')).manifest.channel, 'stable');
assert.equal((await check(releaseBody('0.1.2-b1', {}, { requestedChannel: 'beta' }), '0.1.1', 'beta')).download.searchParams.get('developer_opt_in'), '1');
await assert.rejects(check(releaseBody('0.1.2', {}, { requestedChannel: 'beta', transition: 'ga-to-stable' }), '0.1.2-b1', 'beta'), /晋级校验/);
await assert.rejects(check(releaseBody('0.1.0')), /晋级校验/);
await assert.rejects(check({ ...latest, signature: Buffer.alloc(64).toString('base64') }), /签名/);
await assert.rejects(check({ ...latest, downloadPath: '//redirect.invalid/setup.exe' }), /下载地址/);
await assert.rejects(check({ code: 'upstream_not_configured' }, '0.1.1', 'stable', 503), /发布源尚未接入/);

let cdnCalls = 0;
const cdnProtocol = new OtaProtocol('pinned test CA', publicKey, async (url, headers, _signal, ca) => {
  assert.equal(headers.range, 'bytes=8-');
  if (url.origin === origin) {
    assert.equal(headers.authorization, `Bearer ${access}`);
    assert.equal(ca, 'pinned test CA');
    return response(302, [], { location: 'https://file-cdn.gitcode.com/test' });
  }
  assert.equal(url.hostname, 'file-cdn.gitcode.com');
  assert.equal(headers.authorization, undefined);
  assert.equal(ca, undefined);
  return response(++cdnCalls === 1 ? 403 : 206, []);
});
assert.equal((await cdnProtocol.download(candidate, access, 8, signal)).statusCode, 206);
assert.equal(cdnCalls, 2);
const hostile = new OtaProtocol('pinned test CA', publicKey, async () => response(302, [], { location: 'https://redirect.invalid/download' }));
await assert.rejects(hostile.download(candidate, access, 0, signal), /不受信/);

const cache = await mkdtemp(join(task, 'ota-client-cache-'));
async function* disconnected() {
  yield data.subarray(0, 8);
  throw new Error('simulated disconnection');
}
await assert.rejects(saveInstaller(cache, candidate, async from => {
  assert.equal(from, 0);
  return response(200, disconnected(), { 'content-length': String(data.length) });
}, signal, () => {}), /disconnection/);
const cached = await saveInstaller(cache, candidate, async from => {
  assert.equal(from, 8);
  return response(206, data.subarray(from), { 'content-length': String(data.length - from), 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` });
}, signal, () => {});
assert.deepEqual(await readFile(cached), data);
const invalidCache = await mkdtemp(join(task, 'ota-client-cache-'));
await assert.rejects(saveInstaller(invalidCache, candidate, async () => response(200, Buffer.alloc(data.length)), signal, () => {}), /SHA-256/);
await assert.rejects(stat(join(invalidCache, candidate.sha, candidate.manifest.installer.fileName)), { code: 'ENOENT' });

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE preferences (name TEXT PRIMARY KEY, content TEXT NOT NULL)');
const states = [];
let sawInstall = false;
try {
  const legacyAccess = 'synthetic-legacy-test-000000000001';
  let expectedAccess = legacyAccess;
  const protocol = new OtaProtocol('pinned test CA', publicKey, async (url, headers) => {
    assert.equal(headers.authorization, `Bearer ${expectedAccess}`);
    return url.pathname.endsWith('/check') ? response(200, Buffer.from(JSON.stringify(latest))) : response(200, data);
  });
  const options = { version: '0.1.1', db, protocol, cache: () => cache,
    unprotect: buffer => Buffer.from(buffer), notify: status => states.push(status.state),
    install: async (path, release) => {
      assert.equal(path, cached);
      assert.equal(release.manifest.installer.sha256, sha256(await readFile(path)));
      sawInstall = true;
      return false;
    },
  };
  assert.equal(new OtaUpdates(options).getStatus().state, 'configuration-required');
  db.prepare('INSERT INTO preferences VALUES (?, ?)').run('ota-access', Buffer.from(legacyAccess).toString('base64'));
  const legacy = new OtaUpdates(options);
  assert.equal((await legacy.check()).state, 'available');
  legacy.dispose();

  expectedAccess = access;
  const updates = new OtaUpdates({ ...options, readManagedAccess: () => Buffer.from(access) });
  assert.throws(() => updates.configure({ source: 'online', channel: 'stable', access: { mode: 'replace', value: access } }), /由部署方管理/);
  assert.throws(() => updates.configure({ source: 'online', channel: 'stable', access: { mode: 'clear' } }), /由部署方管理/);
  assert.equal(updates.configure({ source: 'online', channel: 'beta' }).channel, 'beta');
  const configured = updates.configure({ source: 'online', channel: 'stable' });
  assert.equal(configured.hasAccess, true);
  assert.equal(Object.hasOwn(configured, 'access'), false);
  assert.equal((await updates.check()).state, 'available');
  const inProgress = updates.download();
  updates.pause();
  assert.equal((await inProgress).state, 'paused');
  assert.equal((await updates.download()).state, 'ready');
  assert.equal((await updates.install()).state, 'ready');
  assert.equal(sawInstall, true);
  assert.ok(states.includes('checking') && states.includes('downloading') && states.includes('installing'));
  updates.dispose();
} finally { db.close(); }

console.log(JSON.stringify({
  signedManifest: 'pass', channelsAndPromotion: 'pass', redirectAndCredentialBoundaries: 'pass',
  downloadResumeAndDigest: 'pass', stateAndInstallHandoff: 'pass',
}));
