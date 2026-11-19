import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { ensureNewArtifact } from './stage-windows.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('项目版本格式无效。');
const mode = process.argv[2];
if (mode && mode !== '--bootstrap') throw new Error('不支持的部署包模式。');
const suffix = mode === '--bootstrap' ? '-bootstrap' : '';
const output = resolve('release', `gen-NetTools-${version}-ota-backend-ubuntu-docker${suffix}.tar.gz`);
const files = [
  '.dockerignore', 'Dockerfile', 'compose.yaml', 'README.md', 'manifest.example.json',
  'server.mjs', 'http.mjs', 'health.mjs', 'version.mjs', 'providers.mjs', 'manifest.mjs', 'ota.test.mjs',
];
await ensureNewArtifact(output);
await ensureNewArtifact(`${output}.sha256`);
mkdirSync('release', { recursive: true });
const tar = process.platform === 'win32' ? join(process.env.WINDIR, 'System32', 'tar.exe') : 'tar';
const result = spawnSync(tar, ['-czf', output, ...files.map(file => `ota-backend/${file}`)], { stdio: 'inherit', windowsHide: true });
if (result.error || result.status !== 0) throw new Error('OTA 后端归档失败。', { cause: result.error });
const archive = readFileSync(output);
const sha256 = createHash('sha256').update(archive).digest('hex');
writeFileSync(`${output}.sha256`, `${sha256}  ${basename(output)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ output, bytes: archive.length, sha256 }));
