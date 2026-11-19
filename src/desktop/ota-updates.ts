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
  crypt(operation: 'protect' | 'unprotect', buffer: Buffer): Buffer;
  cache(): string;
  install(path: string, release: OtaRelease): Promise<boolean>;
  notify(status: UpdateStatus): void;
};

const accessPattern = /^[\x21-\x7e]{32,256}$/;

export class OtaUpdates {
  private status: UpdateStatus;
  private candidate?: OtaRelease;
  private completeInstaller?: string;
  private task?: AbortController;

  constructor(private readonly options: Options) {
    const { version, protocol } = options;
    const storedChannel = this.preference('ota-channel');
    const channel: UpdateChannel = storedChannel === 'stable' || storedChannel === 'beta' ? storedChannel :
      parseVersion(version)?.beta === undefined ? 'stable' : 'beta';
    const hasAccess = Boolean(this.preference('ota-access'));
    this.status = {
      version, channel, source: 'online', sources: ['online'], hasAccess,
      state: protocol && hasAccess ? 'idle' : 'configuration-required',
      ...(!protocol ? { message: '此构建未配置 OTA 信任材料。' } : {}),
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
    if (!value || value.source !== 'online' || !['stable', 'beta'].includes(value.channel)) throw new Error('更新通道设置无效。');
    const { access } = value;
    let protectedAccess: Buffer | undefined;
    if (access?.mode === 'replace') {
      if (typeof access.value !== 'string' || !accessPattern.test(access.value)) throw new Error('请填写 32 至 256 位控制面访问凭据。');
      protectedAccess = this.options.crypt('protect', Buffer.from(access.value));
    } else if (access !== undefined && access?.mode !== 'clear') throw new Error('控制面访问凭据操作无效。');
    if (value.channel === this.status.channel && !access) return this.status;

    const db = this.options.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const save = db.prepare('INSERT INTO preferences VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content');
      if (protectedAccess) save.run('ota-access', protectedAccess.toString('base64'));
      if (access?.mode === 'clear') db.prepare('DELETE FROM preferences WHERE name = ?').run('ota-access');
      save.run('ota-channel', value.channel);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { protectedAccess?.fill(0); }
    const hasAccess = Boolean(this.preference('ota-access'));
    this.candidate = undefined;
    this.completeInstaller = undefined;
    return this.publish({ channel: value.channel, hasAccess, state: hasAccess && this.options.protocol ? 'idle' : 'configuration-required',
      latestVersion: undefined, notes: undefined, mandatory: undefined, downloaded: undefined, size: undefined,
      message: this.options.protocol ? undefined : '此构建未配置 OTA 信任材料。' });
  }

  private withAccess() {
    const { protocol } = this.options;
    const stored = this.preference('ota-access');
    if (!protocol) throw new Error('此构建未配置 OTA 信任材料。');
    if (!stored) throw new Error('请先在软件更新中保存控制面访问凭据。');
    const decrypted = this.options.crypt('unprotect', Buffer.from(stored, 'base64'));
    try {
      const access = decrypted.toString('utf8');
      if (!accessPattern.test(access)) throw new Error('已保存的控制面访问凭据无效。');
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

  dispose() { this.task?.abort(); }

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
