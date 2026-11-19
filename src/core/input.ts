import { open } from 'node:fs/promises';
import { dataLimit, type Encoding, type WorkerSource } from '../shared/contracts';

export const protectedName = /key|pem|secret|token|auth|credential|password|certificate|\.env(?:\.|$)|^(?:miniProgram|tencentOBS|gen_ScreenShare-OTA)$/i;

export async function readLimited(path: string, limit = dataLimit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('请选择大小不超过 50 MB 的普通文件。');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('读取过程中输入文件已变化，请重新选择。');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export function decode(bytes: Uint8Array, encoding: Encoding = 'auto') {
  if (encoding !== 'auto') return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const header = Buffer.from(bytes.subarray(0, 1024));
  if (header[0] === 255 && header[1] === 254) return decode(bytes, 'utf-16le');
  if (header[0] === 254 && header[1] === 255) return decode(bytes, 'utf-16be');
  if (/charset\s*=\s*["']?\s*(?:gb2312|gbk|gb18030)/i.test(header.toString('ascii'))) return decode(bytes, 'gb18030');
  try { return decode(bytes, 'utf-8'); } catch { return decode(bytes, 'gb18030'); }
}

export async function loadInput(source: WorkerSource) {
  if ('path' in source) return decode(await readLimited(source.path), source.encoding);
  if (Buffer.byteLength(source.text, 'utf8') > dataLimit) throw new Error('文本超过 50 MB。');
  return source.text;
}

export function* lineEntries(value: string): Generator<{ line: number; text: string }> {
  const pattern = /\r\n|\r|\n/g;
  let index = 0;
  let line = 1;
  for (const match of value.matchAll(pattern)) {
    yield { line: line++, text: value.slice(index, match.index) };
    index = match.index + match[0].length;
  }
  if (index < value.length) yield { line, text: value.slice(index) };
}
