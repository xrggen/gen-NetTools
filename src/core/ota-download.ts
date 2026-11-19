import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import type { OtaRelease } from './ota-protocol';

type InstallerSource = (from: number) => Promise<IncomingMessage>;

async function checkedDirectory(path: string) {
  await mkdir(path, { recursive: true });
  if (resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase() || !(await lstat(path)).isDirectory()) {
    throw new Error('安装包暂存路径包含重解析点。');
  }
}

async function fileSize(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
  if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error('安装包暂存位置包含非普通文件。');
  return entry?.size;
}

async function fileSha(path: string, signal: AbortSignal) {
  const sha = createHash('sha256');
  for await (const bytes of createReadStream(path, { signal })) sha.update(bytes);
  return sha.digest('hex');
}

export async function saveInstaller(
  directory: string, release: OtaRelease, fetch: InstallerSource, signal: AbortSignal, report: (size: number) => void,
) {
  const { fileName, size, sha256 } = release.manifest.installer;
  await checkedDirectory(directory);
  const candidateDir = join(directory, release.sha);
  await checkedDirectory(candidateDir);
  const installer = join(candidateDir, fileName);
  const partial = join(candidateDir, `${fileName}.partial`);
  const existing = await fileSize(installer);
  if (existing !== undefined) {
    if (existing === size && await fileSha(installer, signal) === sha256) { report(size); return installer; }
    await unlink(installer);
  }
  let from = await fileSize(partial) ?? 0;
  if (from > size || (from === size && await fileSha(partial, signal) !== sha256)) {
    await unlink(partial);
    from = 0;
  }
  report(from);
  signal.throwIfAborted();
  if (from < size) await transfer(partial, from, size, fetch, signal, report);
  if (await fileSha(partial, signal) !== sha256) {
    await unlink(partial);
    report(0);
    throw new Error('安装包 SHA-256 与已验签清单不一致。');
  }
  signal.throwIfAborted();
  await rename(partial, installer);
  return installer;
}

async function transfer(path: string, from: number, size: number, fetch: InstallerSource, signal: AbortSignal, report: (size: number) => void) {
  const response = await fetch(from);
  try {
    const status = response.statusCode;
    if (status !== 200 && status !== 206) throw new Error(`更新源无法返回安装包（HTTP ${status ?? '未知'}）。`);
    const { 'content-length': length, 'content-range': range, 'content-encoding': encoding } = response.headers;
    if (encoding && encoding !== 'identity') throw new Error('安装包返回了不受支持的内容编码。');
    if (status === 200) {
      if (range) throw new Error('安装包返回了意外的文件范围。');
      from = 0;
    } else if (from === 0 || range !== `bytes ${from}-${size - 1}/${size}`) {
      throw new Error('续传起点与已下载的安装包数据不一致。');
    }
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== size - from)) throw new Error('安装包响应长度与清单不一致。');
    signal.throwIfAborted();
    report(from);

    const file = await open(path, from > 0 ? 'a' : 'w', 0o600);
    let total = from;
    try {
      if ((await file.stat()).size !== from) throw new Error('安装包的部分文件已发生变化。');
      for await (const chunk of response) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        if (total + bytes.length > size) throw new Error('安装包超出了签名清单指定的长度。');
        await file.writeFile(bytes);
        total += bytes.length;
        report(total);
      }
      if (total !== size) throw new Error('安装包下载中断，可以继续下载。');
    } finally { await file.close(); }
  } finally { if (!response.complete) response.destroy(); }
}
