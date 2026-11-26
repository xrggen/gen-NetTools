import { isAbsolute } from 'node:path';
import type { UpdateChannel, UpdateConfiguration, UpdateStatus } from '../shared/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { parseVersion } from '../../ota-backend/version.mjs';
import { saveInstaller } from '../core/ota-download';
import { OtaProtocol, type OtaRelease } from '../core/ota-protocol';

type Options = {
  version: string;
  db: DatabaseSync;
  protocol?: OtaProtocol;
  readManagedAccess?(): Buffer | undefined;
  unprotect(buffer: Buffer): Buffer;
  cache(): string;
  install(path: string, release: OtaRelease): Promise<boolean>;
  notify(status: UpdateStatus): void;
};

const accessPattern = /^[\x21-\x7e]{32,256}$/;
const unconfiguredMessage = '本机尚未获得在线更新授权。';

export class OtaUpdates {
  private status: UpdateStatus;
  private candidate?: OtaRelease;
  private completeInstaller?: string;
  private task?: AbortController;
  private readonly protectedAccess?: Buffer;
  private readonly configurationMessage?: string;

  constructor(private readonly options: Options) {
    const { version, protocol } = options;
    const storedChannel = this.preference('ota-channel');
    const channel: UpdateChannel = storedChannel === 'stable' || storedChannel === 'beta' ? storedChannel :
      parseVersion(version)?.beta === undefined ? 'stable' : 'beta';
    let readFailed = false;
    try {
      const managed = options.readManagedAccess?.();
      const legacy = managed ? undefined : this.preference('ota-access');
      this.protectedAccess = managed ?? (legacy ? Buffer.from(legacy, 'base64') : undefined);
    } catch {
      readFailed = true;
    }
    const hasAccess = Boolean(this.protectedAccess);
    this.configurationMessage = !protocol ? '此构建未配置 OTA 信任材料。' :
      readFailed ? '无法读取本机在线更新授权。请联系部署管理员。' : !hasAccess ? unconfiguredMessage : undefined;
    this.status = {
      version, channel, source: 'online', sources: ['online'], hasAccess,
      state: protocol && hasAccess ? 'idle' : 'configuration-required',
      message: this.configurationMessage,
    };
  }

  private preference(name: string) {
    return this.options.db.prepare('SELECT content FROM preferences WHERE name = ?').get(name)?.content as string | undefined;
  }

  private publish(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.options.notify(this.status);
    return this.status;
  }

  getStatus() { return this.status; }

  configure(value: UpdateConfiguration) {
    if (this.task) throw new Error('请先暂停下载或等待更新操作完成。');
    if (!value || typeof value !== 'object' || value.source !== 'online' || !['stable', 'beta'].includes(value.channel)) {
      throw new Error('更新通道设置无效。');
    }
    if ('access' in value) throw new Error('在线更新授权由部署方管理。');
    if (value.channel === this.status.channel) return this.status;

    this.options.db.prepare('INSERT INTO preferences VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content')
      .run('ota-channel', value.channel);
    this.candidate = undefined;
    this.completeInstaller = undefined;
    const { hasAccess } = this.status;
    return this.publish({ channel: value.channel, state: hasAccess && this.options.protocol ? 'idle' : 'configuration-required',
      latestVersion: undefined, notes: undefined, mandatory: undefined, downloaded: undefined, size: undefined,
      message: this.configurationMessage });
  }

  private withAccess() {
    const { protocol } = this.options;
    if (!protocol) throw new Error('此构建未配置 OTA 信任材料。');
    if (!this.protectedAccess) throw new Error(this.configurationMessage ?? unconfiguredMessage);
    const decrypted = this.options.unprotect(Buffer.from(this.protectedAccess));
    try {
      const access = decrypted.toString('utf8');
      if (!accessPattern.test(access)) throw new Error('本机在线更新授权无效。');
      return { protocol, access };
    } finally { decrypted.fill(0); }
  }

  async check() {
    if (this.task) return this.status;
    if (!this.options.protocol || !this.status.hasAccess) return this.status;
    this.candidate = undefined;
    this.completeInstaller = undefined;
    return this.run({ state: 'checking', message: undefined, latestVersion: undefined, notes: undefined, mandatory: undefined,
      size: undefined, downloaded: undefined }, async signal => {
      const { protocol, access } = this.withAccess();
      const release = await protocol.check(this.status.version, this.status.channel, access,
        AbortSignal.any([signal, AbortSignal.timeout(24_000)]));
      if (!release) return this.publish({ state: 'current', message: '当前通道没有可用更新。' });
      this.candidate = release;
      return this.publish({ state: 'available', latestVersion: release.manifest.version, notes: release.manifest.notes,
        mandatory: release.mandatory, size: release.manifest.installer.size, downloaded: 0 });
    });
  }

  async download() {
    if (this.task) return this.status;
    const release = this.candidate;
    if (!release || !['available', 'paused', 'error'].includes(this.status.state)) throw new Error('请先检查可用更新。');
    return this.run({ state: 'downloading', message: undefined }, async signal => {
      const { protocol, access } = this.withAccess();
      const directory = this.options.cache();
      if (!isAbsolute(directory)) throw new Error('无法取得安装包安全暂存目录。');
      let reported = 0;
      this.completeInstaller = await saveInstaller(directory, release, from => protocol.download(release, access, from, signal),
        signal, downloaded => {
          const now = Date.now();
          if (now - reported < 175 && downloaded !== release.manifest.installer.size && downloaded !== 0) {
            this.status = { ...this.status, downloaded };
            return;
          }
          reported = now;
          this.publish({ downloaded });
        });
      return this.publish({ state: 'ready', message: '安装包签名清单和文件完整性校验通过。' });
    });
  }

  pause() {
    if (this.status.state === 'downloading') this.task?.abort();
    return this.status;
  }

  async install() {
    if (this.task || this.status.state !== 'ready' || !this.completeInstaller || !this.candidate) {
      throw new Error('请先下载并验证安装包。');
    }
    const installer = this.completeInstaller;
    const release = this.candidate;
    return this.run({ state: 'installing', message: undefined }, async () => {
      if (!await this.options.install(installer, release)) return this.publish({ state: 'ready', message: '安装已取消。' });
      return this.status;
    }, 'ready');
  }

  dispose() { this.task?.abort(); this.protectedAccess?.fill(0); }

  private async run(patch: Partial<UpdateStatus>, work: (signal: AbortSignal) => Promise<UpdateStatus>, errorState: 'error' | 'ready' = 'error') {
    const controller = new AbortController();
    this.task = controller;
    this.publish(patch);
    try { return await work(controller.signal); }
    catch (error) {
      if (controller.signal.aborted && patch.state === 'downloading') return this.publish({ state: 'paused', message: '已暂停下载，可以继续。' });
      if (controller.signal.aborted) return this.status;
      const message = error instanceof Error ? error.message : '更新操作失败。';
      return this.publish({ state: errorState, message });
    } finally { this.task = undefined; }
  }
}
