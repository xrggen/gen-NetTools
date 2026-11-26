import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { createOtaHandler } from './http.mjs';
import { verifier } from './manifest.mjs';
import { createProvider } from './providers.mjs';
import { host, parseVersion, port } from './version.mjs';

const materialDirectory = '/run/gen-nettools-ota';

function readMaterial(path, optional = false) {
  try { return readFileSync(join(materialDirectory, path)); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw new Error(`无法装载部署材料 ${path}（${error.code ?? 'read_failed'}）。`);
  }
}

function readAccess(path, minimum, optional = false) {
  const bytes = readMaterial(path, optional);
  if (bytes === undefined) return;
  const value = bytes.toString('utf8').trim();
  if (value.length < minimum || !/^[\x21-\x7e]{1,256}$/.test(value)) throw new Error(`部署材料 ${path} 的格式无效。`);
  return value;
}

function checkCertificate(cert) {
  const leaf = new X509Certificate(cert);
  if (!leaf.checkHost(host, { subject: 'never' }) ||
      Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) {
    throw new Error(`TLS 证书的 SAN 必须覆盖 ${host}，且证书必须在有效期内。`);
  }
}

export function createTlsOtaServer({ cert, tlsKey, access, minimumClientVersion, providers }) {
  checkCertificate(cert);
  const server = createServer({
    key: tlsKey, cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192, handshakeTimeout: 10_000,
    headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5000,
  }, createOtaHandler({ port, access, minimumClientVersion, providers }));
  server.maxHeadersCount = 32;
  return server;
}

export function start({ gitcodeFetch, listenPort = port, listenAddress = '0.0.0.0' } = {}) {
  const minimumClientVersion = process.env.NETTOOLS_OTA_MINIMUM_CLIENT_VERSION || undefined;
  if (minimumClientVersion && !parseVersion(minimumClientVersion)) throw new Error('OTA 最低客户端版本格式无效。');
  const cert = readMaterial('tls/fullchain.pem');
  const tlsKey = readMaterial('tls/server.pem');
  const publicKey = verifier(readMaterial('publisher/verification.pem'));
  const access = readAccess('client/access.txt', 32);
  const allowBootstrap = process.env.NETTOOLS_OTA_BOOTSTRAP_WITHOUT_UPSTREAM === '1';
  const gitcodeAccess = gitcodeFetch ? undefined : readAccess('upstream/gitcode.txt', 1, allowBootstrap);
  const githubAccess = gitcodeFetch || gitcodeAccess ? readAccess('upstream/github.txt', 1, true) : undefined;
  const providers = gitcodeFetch || gitcodeAccess ? {
    gitcode: createProvider('gitcode', { publicKey, readAccess: gitcodeAccess, fetchImpl: gitcodeFetch }),
    github: githubAccess || !gitcodeFetch
      ? createProvider('github', { publicKey, readAccess: githubAccess })
      : createProvider('github', { publicKey, fetchImpl: async () => new Response(null, { status: 503 }) }),
  } : undefined;
  const server = createTlsOtaServer({ cert, tlsKey, access, minimumClientVersion, providers });
  server.on('error', error => {
    process.stderr.write(`OTA 启动或监听失败（${error.code ?? 'listen_failed'}）。\n`);
    process.exitCode = 1;
  });
  server.listen(listenPort, listenAddress, () => process.stdout.write(`gen-NetTools OTA listening on port ${listenPort}\n`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close();
      setTimeout(() => server.closeAllConnections(), 8000).unref();
    });
  }
}

if (import.meta.main) {
  try { start(); }
  catch (error) {
    process.stderr.write(`OTA 启动失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
