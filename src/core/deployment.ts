import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { utils, type ParsedKey } from 'ssh2';
import type { CommandLine, DeploymentEvent, DeploymentPlan, DeviceInfo, DeviceProgress, DeviceTest } from '../shared/deployment';
import { DeploymentHistory } from './deployment-history';
import { deployRound, type DeviceJob } from './deployment-runner';
import { aliasPattern, readCommands, readDevices, type ImportedDevice } from './deployment-script';
import { HostTrustError, openHuaweiShell } from './huawei-ssh';
import { readLimited } from './input';

function limit(concurrency: number) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  return concurrency;
}

export class Deployment {
  readonly history: DeploymentHistory;
  private devices: ImportedDevice[] = [];
  private readonly scripts = new Map<string, CommandLine[]>();
  private readonly keys = new Map<string, ParsedKey>();
  private tests = new Map<string, DeviceTest>();
  private readonly trusted = new Map<string, string>();
  private active?: { aborter: AbortController; work: Promise<unknown> };

  constructor(directory: string, private emit: (event: DeploymentEvent) => void) {
    this.history = new DeploymentHistory(directory);
  }

  private checkIdle() {
    if (this.active) throw new Error('当前有一轮 SSH 操作正在进行。');
  }

  private operate<T>(operation: (signal: AbortSignal) => Promise<T>) {
    this.checkIdle();
    const aborter = new AbortController();
    const work = Promise.resolve().then(() => operation(aborter.signal)).finally(() => { this.active = undefined; });
    this.active = { aborter, work };
    return work;
  }

  async importDevices(path: string) {
    this.checkIdle();
    const devices = await readDevices(path);
    this.checkIdle();
    this.devices = devices;
    this.tests.clear();
    this.trusted.clear();
    return {
      name: basename(path),
      devices: devices.map(({ id, label, username, keyAlias }): DeviceInfo => ({ id, label, username, keyAlias })),
    };
  }

  async importScript(path: string) {
    this.checkIdle();
    const commands = await readCommands(path);
    this.checkIdle();
    const id = randomUUID();
    this.scripts.set(id, commands);
    return { id, name: basename(path), count: commands.length };
  }

  releaseScript(id: string) {
    this.checkIdle();
    this.scripts.delete(id);
  }

  async addKey(alias: string, path: string, passphrase: string) {
    this.checkIdle();
    if (typeof alias !== 'string' || !aliasPattern.test(alias) || typeof passphrase !== 'string') throw new Error('私钥别名或口令无效。');
    const contents = await readLimited(path, 1_048_576);
    try {
      const parsed = utils.parseKey(contents, passphrase || undefined);
      if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) {
        throw new Error('无法读取 SSH 私钥，请检查文件格式或口令。');
      }
      this.checkIdle();
      this.keys.set(alias, parsed);
      for (const item of this.devices) if (item.keyAlias === alias) this.tests.delete(item.id);
    } finally { contents.fill(0); }
  }

  trust(id: string, fingerprint: string) {
    this.checkIdle();
    const item = this.tests.get(id);
    if (item?.state !== 'trust-required' || item.fingerprint !== fingerprint || this.trusted.has(id)) {
      throw new Error('该主机指纹需要重新测试。');
    }
    this.trusted.set(id, fingerprint);
    this.tests.set(id, { id, state: 'pending', detail: '已记录指纹，请重新测试连接和认证。' });
  }

  private sshTarget(item: ImportedDevice) {
    const { host, port, username, password, keyAlias } = item;
    const privateKey = keyAlias ? this.keys.get(keyAlias) : undefined;
    if (keyAlias && !privateKey) throw new Error('请先在界面导入对应别名的 SSH 私钥。');
    return { host, port, username, password, privateKey };
  }

  test(concurrency: number) {
    limit(concurrency);
    if (!this.devices.length) throw new Error('请先导入设备清单。');
    return this.operate(async signal => {
      this.tests = new Map();
      let index = 0;
      const publish = (result: DeviceTest) => {
        this.tests.set(result.id, result);
        this.emit({ type: 'test', result });
      };
      const take = async () => {
        while (!signal.aborted && index < this.devices.length) {
          const item = this.devices[index++];
          const { id } = item;
          publish({ id, state: 'testing' });
          try {
            const session = await openHuaweiShell(this.sshTarget(item), { fingerprint: this.trusted.get(id), signal });
            await session.close();
            signal.throwIfAborted();
            publish({ id, state: 'passed' });
          } catch (error) {
            if (signal.aborted) publish({ id, state: 'cancelled' });
            else if (error instanceof HostTrustError && !error.changed) {
              publish({ id, state: 'trust-required', detail: error.message, fingerprint: error.fingerprint });
            } else publish({ id, state: 'failed', detail: error instanceof Error ? error.message : 'SSH 测试失败。' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, this.devices.length) }, take));
      for (; index < this.devices.length; index++) publish({ id: this.devices[index].id, state: 'cancelled' });
      return Array.from(this.tests.values());
    });
  }

  run(plan: DeploymentPlan) {
    this.checkIdle();
    const { common, overrides, intervalMs, concurrency, autoYes } = plan;
    limit(concurrency);
    if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) throw new Error('命令间隔必须为有效的非负毫秒数。');
    if (typeof autoYes !== 'boolean' || typeof common !== 'string' || !overrides || typeof overrides !== 'object') throw new Error('下发参数无效。');
    const jobs: DeviceJob<ImportedDevice>[] = [];
    const files = new Map(this.devices.map(({ id }, index) => [id, index + 1]));
    if (files.size > 999_999) throw new Error('单轮下发的设备数量超出记录编号范围。');
    const states = new Map<string, DeviceProgress>();
    for (const item of this.devices) {
      const { id, label } = item;
      const result = this.tests.get(id);
      const script = this.scripts.get(Object.hasOwn(overrides, id) ? overrides[id] : common);
      if (result?.state !== 'passed' || !this.trusted.has(id)) {
        states.set(id, { id, label, state: 'skipped', completed: 0, total: script?.length ?? 0, error: '未通过连接和认证测试。' });
        continue;
      }
      if (!script?.length) throw new Error(label + ' 缺少可下发的脚本。');
      states.set(id, { id, label, state: 'queued', completed: 0, total: script.length });
      jobs.push({ id, label, target: item, commands: script });
    }
    if (!jobs.length) throw new Error('至少需要一台通过连接和认证测试的设备。');

    return this.operate(async signal => {
      const record = await this.history.start(Array.from(states.values()));
      this.emit({ type: 'round', record });
      const header = (device: DeviceProgress) => '设备 ' + device.label + '\r\n轮次 ' + record.startedAt + '\r\n\r\n';
      const onProgress = (update: DeviceProgress) => {
        states.set(update.id, update);
        this.emit({ type: 'progress', update });
      };
      await deployRound({
        jobs, intervalMs, concurrency, signal, onProgress,
        connect: async ({ id, target }) => {
          const output = await this.history.openDeviceOutput(record.id, files.get(id)!);
          try {
            await output.writeFile(header(states.get(id)!));
            const session = await openHuaweiShell(this.sshTarget(target), {
              signal, autoYes, fingerprint: this.trusted.get(id),
              output: async bytes => {
                for (let start = 0; start < bytes.length;) {
                  const { bytesWritten } = await output.write(bytes, start, bytes.length - start);
                  if (!bytesWritten) throw new Error('写入回显失败。');
                  start += bytesWritten;
                }
              },
            });
            return { send: session.send, async close() { try { await session.close(); } finally { await output.close(); } } };
          } catch (error) {
            await output.close().catch(() => undefined);
            throw error;
          }
        },
      });
      for (const device of states.values()) {
        const status = '\r\n\r\n状态 ' + device.state + ' · ' + device.completed + '/' + device.total
          + (device.error ? '\r\n' + device.error : '') + '\r\n';
        try { await this.history.finishDeviceOutput(record.id, files.get(device.id)!, header(device), status); }
        catch {
          const error = [device.error, '无法完整保存回显记录。'].filter(Boolean).join(' ');
          onProgress({ ...device, state: device.state === 'completed' ? 'failed' : device.state, error });
        }
      }
      record.devices = Array.from(states.values());
      record.finishedAt = new Date().toISOString();
      await this.history.save(record);
      this.emit({ type: 'round', record });
      return record;
    }).finally(() => {
      this.tests.clear();
      this.keys.clear();
    });
  }

  cancel() { this.active?.aborter.abort(); }

  async waitForIdle() { await this.active?.work.catch(() => undefined); }

  get busy() { return Boolean(this.active); }

  reset() {
    this.checkIdle();
    this.devices = [];
    this.scripts.clear();
    this.keys.clear();
    this.tests.clear();
    this.trusted.clear();
  }
}
