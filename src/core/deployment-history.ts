import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DeploymentRecord, DeviceProgress } from '../shared/deployment';

const roundName = /^\d{13}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ownFile = /^(?:round\.json(?:\.new)?|device-\d{1,6}\.log)$/;
const keepRounds = 3;

function actualPathMatches(expected: string, actual: string) {
  return resolve(expected).toLowerCase() === resolve(actual).toLowerCase();
}

export class DeploymentHistory {
  private readonly directory: string;

  constructor(workspace: string) {
    this.directory = join(workspace, 'deployment-transcripts');
  }

  private async root() {
    await mkdir(this.directory, { recursive: true });
    if (!actualPathMatches(this.directory, await realpath(this.directory))) throw new Error('下发回显目录不能通过链接访问。');
    return this.directory;
  }

  private async rounds() {
    const root = await this.root();
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && roundName.test(entry.name))
      .map(entry => entry.name).sort().reverse();
  }

  async locate(id: string) {
    if (!roundName.test(id)) throw new Error('无效的下发记录编号。');
    const path = join(await this.root(), id);
    const item = await lstat(path);
    if (!item.isDirectory() || item.isSymbolicLink() || !actualPathMatches(path, await realpath(path))) {
      throw new Error('下发记录目录不可用。');
    }
    return path;
  }

  async list(): Promise<DeploymentRecord[]> {
    const results: DeploymentRecord[] = [];
    for (const id of (await this.rounds()).slice(0, keepRounds)) {
      const path = await this.locate(id);
      const meta = join(path, 'round.json');
      const info = await lstat(meta).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info?.isFile() && !info.isSymbolicLink()) {
        const stored = JSON.parse(await readFile(meta, 'utf8')) as Omit<DeploymentRecord, 'path'>;
        results.push({ ...stored, id, path });
      } else if (!info) {
        results.push({ id, startedAt: new Date(Number(id.slice(0, 13))).toISOString(), devices: [], path });
      }
    }
    return results;
  }

  async start(devices: DeviceProgress[]): Promise<DeploymentRecord> {
    const prior = await this.rounds();
    const now = Date.now();
    const sequence = Math.max(now, prior.length ? Number(prior[0].slice(0, 13)) + 1 : 0);
    const id = `${String(sequence).padStart(13, '0')}-${randomUUID()}`;
    const path = join(await this.root(), id);
    await mkdir(path);
    const record = { id, startedAt: new Date(now).toISOString(), devices, path };
    try {
      await this.save(record);
      for (const old of prior.slice(keepRounds - 1)) await this.remove(old);
    } catch (error) {
      await this.remove(id).catch(() => undefined);
      throw error;
    }
    return record;
  }

  async save(record: DeploymentRecord) {
    const path = await this.locate(record.id);
    const next = join(path, 'round.json.new');
    const { id, startedAt, finishedAt, devices } = record;
    await writeFile(next, JSON.stringify({ id, startedAt, finishedAt, devices }), { encoding: 'utf8', flag: 'wx' });
    try { await rename(next, join(path, 'round.json')); }
    catch (error) { await unlink(next).catch(() => undefined); throw error; }
  }

  async openDeviceOutput(id: string, index: number) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 999_999) throw new Error('设备输出编号不可用。');
    const path = await this.locate(id);
    return open(join(path, `device-${String(index).padStart(3, '0')}.log`), 'wx');
  }

  async finishDeviceOutput(id: string, index: number, header: string, status: string) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 999_999) throw new Error('设备输出编号不可用。');
    const path = join(await this.locate(id), 'device-' + String(index).padStart(3, '0') + '.log');
    const item = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (item && (!item.isFile() || item.isSymbolicLink())) throw new Error('设备回显文件不可用。');
    await writeFile(path, item ? status : header + status, { encoding: 'utf8', flag: item ? 'a' : 'wx' });
  }

  private async remove(id: string) {
    const path = await this.locate(id);
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !ownFile.test(entry.name))) {
      throw new Error('旧回显目录含额外文件或链接，应用无法安全轮换。请检查该轮目录。');
    }
    for (const entry of entries) await unlink(join(path, entry.name));
    await rmdir(path);
  }
}
