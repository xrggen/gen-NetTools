import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseVersion } from '../ota-backend/version.mjs';

export const shared = 'C:\\Users\\Administrator\\Desktop\\VibeCoding\\env';
const localeFile = /^(?:en|zh)(?:-[a-z\d]+)*\.pak$/i;

export async function stageWindows(taskDirectory, versionOverride) {
  const temporaryRoot = join(shared, 'codex_temp-script');
  if (!taskDirectory || !isAbsolute(taskDirectory)) throw new Error('请提供共享临时目录中的绝对任务路径。');
  const parent = await realpath(taskDirectory);
  const insideTemporaryRoot = relative(await realpath(temporaryRoot), parent);
  if (!insideTemporaryRoot || insideTemporaryRoot.startsWith('..') || isAbsolute(insideTemporaryRoot) ||
      !basename(parent).startsWith('gen-NetTools-')) throw new Error('任务路径必须是共享 codex_temp-script 下的 gen-NetTools 独占目录。');

  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const version = versionOverride ?? manifest.version;
  if (manifest.productName !== 'gen-NetTools' || !parseVersion(version)) throw new Error('产品名或版本格式无效。');
  const electron = dirname(createRequire(import.meta.url)('electron'));
  const stagingRoot = await mkdtemp(join(parent, 'stage-'));
  const stage = join(stagingRoot, manifest.productName);
  await cp(electron, stage, { recursive: true, filter: path => {
    const parts = relative(electron, path).split(sep);
    if (parts[0].toLowerCase() === 'locales' && parts.length > 1) return parts.length === 2 && localeFile.test(parts[1]);
    return basename(path) !== 'default_app.asar';
  } });
  const locales = (await readdir(join(stage, 'locales'))).sort();
  if (!locales.includes('zh-CN.pak') || !locales.includes('en-US.pak') || locales.some(name => !localeFile.test(name))) {
    throw new Error('Electron 中文、英文语言资源校验失败。');
  }
  await rename(join(stage, 'electron.exe'), join(stage, 'gen-NetTools.exe'));
  const app = join(stage, 'resources', 'app');
  const dist = join(app, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName,
    version, main: manifest.main }), 'utf8');
  const runtimeFiles = ['main.cjs', 'preload.cjs', 'worker.cjs', 'renderer.js', 'index.html', 'theme.css', 'machine-helper.exe', 'huawei-seed.json', 'DSH-NOTICES.txt'];
  await Promise.all(runtimeFiles.map(file => copyFile(join('dist', file), join(dist, file))));
  return { parent, stagingRoot, stage, version, locales };
}

export async function ensureNewArtifact(output) {
  try { await stat(output); throw new Error('已有同名交付文件，请先保留或区分旧的构建产物。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function writeChecksum(output) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(output)) digest.update(bytes);
  const sha256 = digest.digest('hex');
  await writeFile(`${output}.sha256`, `${sha256} *${basename(output)}\n`, 'utf8');
  return { output, sha256, bytes: (await stat(output)).size };
}
