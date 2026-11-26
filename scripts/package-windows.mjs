import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { shared, stageWindows, ensureNewArtifact, writeChecksum } from './stage-windows.mjs';
import { parseVersion } from '../ota-backend/version.mjs';

const [taskDirectory, option, value, ...extra] = process.argv.slice(2);
const testVersion = option === '--ota-test-version' && /^\d+\.\d+\.\d+$/.test(value ?? '') ? value : undefined;
const releaseSubdir = option === '--release-subdir' && /^[a-z\d][a-z\d.-]{0,63}$/i.test(value ?? '') ? value : undefined;
if (extra.length || (option !== undefined && testVersion === undefined && releaseSubdir === undefined)) {
  throw new Error('请指定任务目录。可另加 --ota-test-version <版本> 或 --release-subdir <目录名>。');
}
const { version: projectVersion } = JSON.parse(await readFile('package.json', 'utf8'));
const release = parseVersion(testVersion ?? projectVersion);
if (!release) throw new Error('安装器版本格式无效。');
const versionParts = [...release.core, release.beta ?? 0];
if (versionParts.some(part => part > 65535)) throw new Error('Windows 文件版本的各字段必须小于 65536。');
if (testVersion || releaseSubdir || release.beta !== undefined) {
  const trust = JSON.parse(await readFile('dist/ota-build-status.json', 'utf8'));
  const mainSha256 = createHash('sha256').update(await readFile('dist/main.cjs')).digest('hex');
  if (trust.enabled !== true || trust.mainSha256 !== mainSha256) throw new Error('OTA 安装包需要已配置可信材料的最新客户端构建。');
}
const { parent, stage, version, locales } = await stageWindows(taskDirectory, testVersion);
const compiler = join(shared, 'tools', 'nsis', '3.12', 'makensis.exe');
const output = resolve('release', releaseSubdir ?? '', `gen-NetTools-${version}-win-x64${testVersion ? '-ota-test' : ''}-setup.exe`);
await ensureNewArtifact(output);
await mkdir(dirname(output), { recursive: true });
const compiled = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', `/DOUTPUT=${output}`, `/DSTAGE=${stage}`,
  `/DVERSION=${version}`, `/DVERSION_NUMERIC=${versionParts.join('.')}`, resolve('installer/gen-NetTools.nsi')], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, TEMP: parent, TMP: parent },
});
if (compiled.error || compiled.status !== 0) throw new Error('NSIS 离线安装包构建失败。', { cause: compiled.error });
console.log(JSON.stringify({ ...await writeChecksum(output), stage, locales }));
