import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';

const out = 'dist';
const rawOtaCa = process.env.NETTOOLS_OTA_CA_PEM?.trim() ?? '';
const rawOtaVerifier = process.env.NETTOOLS_OTA_VERIFIER_PEM?.trim() ?? '';
if (Boolean(rawOtaCa) !== Boolean(rawOtaVerifier)) throw new Error('OTA 构建需要同时提供 TLS 根证书和 Ed25519 验签公钥。');
const otaCa = rawOtaCa ? new X509Certificate(rawOtaCa) : undefined;
if (otaCa && (!/^-----BEGIN CERTIFICATE-----[\s\w+/=]+-----END CERTIFICATE-----$/.test(rawOtaCa) || !otaCa.ca)) {
  throw new Error('OTA TLS 材料需要是单张 CA 公有证书。');
}
if (rawOtaVerifier && !/^-----BEGIN PUBLIC KEY-----[\s\w+/=]+-----END PUBLIC KEY-----$/.test(rawOtaVerifier)) {
  throw new Error('OTA 验签材料需要是 Ed25519 公钥 PEM。');
}
const otaKey = rawOtaVerifier ? createPublicKey(rawOtaVerifier) : undefined;
if (otaKey && otaKey.asymmetricKeyType !== 'ed25519') throw new Error('OTA 验签材料需要是 Ed25519 公钥。');
const dshDirectory = resolve('..', 'env', 'packages', 'dsh-session-0.0.1-rc.1-node24');
const fromShared = createRequire(join(dshDirectory, 'package.json'));
const dshName = '@deepseek-ai/dsh-session';
const dshPackage = fromShared(`${dshName}/package.json`);
if (dshPackage.version !== '0.0.1-rc.1') throw new Error('已登记的 DSH 会话依赖版本不匹配。');
const dshLlmEntry = fromShared.resolve('@deepseek-ai/dsh-llm');
const dshLlmVersion = fromShared('@deepseek-ai/dsh-llm/package.json').version;
const dshMetadata = {
  name: 'dsh-bundle-metadata',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path }) => {
      if (path !== dshLlmEntry) return;
      const source = await readFile(path, 'utf8');
      // The CommonJS bundle has no per-package import.meta.url to locate this manifest.
      const manifestRead = /const\s*\{\s*version\s*\}\s*=\s*createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\);/;
      if (!manifestRead.test(source)) throw new Error('DSH 依赖入口已变化，请核对版本元数据。');
      return { contents: source.replace(manifestRead, `const version = ${JSON.stringify(dshLlmVersion)};`), loader: 'js' };
    });
  },
};

async function writeDshNotices() {
  const lock = JSON.parse(await readFile(join(dshDirectory, 'package-lock.json'), 'utf8'));
  const notices = await Promise.all(Object.keys(lock.packages).filter(path => path.startsWith('node_modules/')).map(async path => {
    const dependency = join(dshDirectory, path);
    const manifest = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
    const license = await readFile(join(dependency, 'LICENSE'), 'utf8');
    return `${manifest.name}@${manifest.version}\n\n${license.trim()}\n`;
  }));
  await writeFile(join(out, 'DSH-NOTICES.txt'), notices.join('\n---\n\n'), 'utf8');
}

await mkdir(out, { recursive: true });
await Promise.all([
  build({ entryPoints: { main: 'src/desktop/main.ts', worker: 'src/desktop/worker.ts', preload: 'src/desktop/preload.ts', seed: 'src/core/seed.ts' },
    bundle: true, outdir: out, outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node24', external: ['electron', 'cpu-features'],
    define: { NETTOOLS_OTA_CA_PEM: JSON.stringify(otaCa?.toString() ?? ''),
      NETTOOLS_OTA_VERIFIER_PEM: JSON.stringify(otaKey?.export({ type: 'spki', format: 'pem' }) ?? '') },
    alias: { [dshName]: fromShared.resolve(dshName) }, plugins: [dshMetadata] }),
  build({ entryPoints: ['src/ui/renderer.tsx'], bundle: true, outfile: join(out, 'renderer.js'),
    platform: 'browser', target: 'chrome140', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }),
  ...['index.html', 'theme.css'].map(file => copyFile(join('src', 'ui', file), join(out, file))),
  copyFile('scripts/verify-desktop.js', join(out, 'smoke.js')),
  writeDshNotices(),
]);

const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const native = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/r:System.Security.dll', `/out:${resolve(out, 'machine-helper.exe')}`, resolve('src/windows/MachineHelper.cs')], { stdio: 'inherit' });
if (native.error || native.status !== 0) throw new Error('无法使用 Windows 自带 C# 编译器构建实例锁辅助程序。', { cause: native.error });

if (process.env.NETTOOLS_HUAWEI_LOG_DIR) {
  const seed = spawnSync(process.execPath, [join(out, 'seed.cjs'), process.env.NETTOOLS_HUAWEI_LOG_DIR, join(out, 'huawei-seed.json')], { stdio: 'inherit' });
  if (seed.error || seed.status !== 0) throw new Error('内置华为日志规则生成失败。', { cause: seed.error });
}

const mainSha256 = createHash('sha256').update(await readFile(join(out, 'main.cjs'))).digest('hex');
await writeFile(join(out, 'ota-build-status.json'), JSON.stringify({ enabled: Boolean(otaCa && otaKey), mainSha256 }), 'utf8');
