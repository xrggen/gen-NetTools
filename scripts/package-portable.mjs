import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { stageWindows, ensureNewArtifact, writeChecksum } from './stage-windows.mjs';

const { parent, stagingRoot, stage, version, locales } = await stageWindows(process.argv[2]);
const output = resolve('release', `gen-NetTools-${version}-win-x64-portable.zip`);
await ensureNewArtifact(output);
await mkdir(dirname(output), { recursive: true });
await writeFile(join(stage, 'README-zh-CN.txt'), [
  `gen-NetTools ${version} Windows x64 绿色版`,
  '解压整个 gen-NetTools 目录后，运行其中的 gen-NetTools.exe。',
  '和安装版共用 %ProgramData%\\gen-NetTools。建议测试时退出旧版本。',
  '在设置 → 软件更新可以查看当前版本。在线更新服务尚未接入。',
].join('\r\n'), 'utf8');
const tar = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
const archived = spawnSync(tar, ['-a', '-cf', output, '-C', stagingRoot, 'gen-NetTools'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, TEMP: parent, TMP: parent },
});
if (archived.error || archived.status !== 0) throw new Error('Windows ZIP 打包失败。', { cause: archived.error });
console.log(JSON.stringify({ ...await writeChecksum(output), stagingRoot, locales }));
