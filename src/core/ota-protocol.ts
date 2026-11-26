import type { KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { get } from 'node:https';
import { verifyRelease, type ReleaseManifest } from '../../ota-backend/manifest.mjs';
import { compareVersions, gaPolicy, host, parseVersion, port } from '../../ota-backend/version.mjs';
import { sourceDefinitions } from '../../ota-backend/providers.mjs';
import type { UpdateChannel } from '../shared/contracts';

const origin = `https://${host}:${port}`;
const api = '/api/v3/client-update';
const maxMetadataBytes = 64 * 1024;
const maxInstallerBytes = 1024 ** 3;
export type OtaRequest = (url: URL, headers: IncomingHttpHeaders, signal: AbortSignal, ca?: string) => Promise<IncomingMessage>;
export type OtaRelease = { manifest: ReleaseManifest; sha: string; provider: keyof typeof sourceDefinitions; download: URL; mandatory: boolean };

export const requestOta: OtaRequest = (url, headers, signal, ca) => new Promise((resolve, reject) => {
  const request = get(url, { headers, signal, ca, rejectUnauthorized: true, agent: false }, resolve);
  request.setTimeout(20_000, () => request.destroy(new Error('OTA 请求超时。')));
  request.once('error', reject);
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新响应格式无效。');
  return value as Record<string, unknown>;
}

async function readMetadata(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += Buffer.byteLength(chunk);
    if (size > maxMetadataBytes) throw new Error('更新响应超过大小限制。');
    chunks.push(chunk);
  }
  return asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
}

export class OtaProtocol {
  constructor(private readonly ca: string, private readonly key: KeyObject, private readonly request: OtaRequest = requestOta) {}

  async check(version: string, channel: UpdateChannel, access: string, signal: AbortSignal): Promise<OtaRelease | undefined> {
    const url = new URL(`${api}/check`, origin);
    url.search = new URLSearchParams({ version, channel, platform: 'win32', arch: 'x64', ota_policy: gaPolicy }).toString();
    if (channel === 'beta') url.searchParams.set('developer_opt_in', '1');
    const response = await this.request(url, { authorization: `Bearer ${access}` }, signal, this.ca);
    const body = await readMetadata(response);
    const status = response.statusCode;
    if (status === 401) throw new Error('本机在线更新授权无效。请联系部署管理员。');
    if (status === 503 && body.code === 'upstream_not_configured') throw new Error('控制面已连接，发布源尚未接入。');
    if (status !== 200 && status !== 426) throw new Error(`控制面无法完成更新检查（HTTP ${status ?? '未知'}）。`);
    if (body.requestedChannel !== channel || typeof body.updateAvailable !== 'boolean') throw new Error('更新通道响应无效。');
    if (!body.updateAvailable) {
      if (status === 426) throw new Error('当前版本低于控制面要求，暂无可用安装包。');
      return;
    }
    return this.parseRelease(body, version, channel, status === 426);
  }

  private parseRelease(body: Record<string, unknown>, current: string, channel: UpdateChannel, required: boolean): OtaRelease {
    const { provider, manifestBase64, signature, manifestSha256, downloadPath, transition } = body;
    if ((provider !== 'gitcode' && provider !== 'github') || typeof manifestBase64 !== 'string' || typeof signature !== 'string') {
      throw new Error('控制面没有返回可验签的更新清单。');
    }
    const bytes = Buffer.from(manifestBase64, 'base64');
    if (bytes.toString('base64') !== manifestBase64) throw new Error('清单编码无效。');
    let verified: ReturnType<typeof verifyRelease>;
    try {
      const value = asRecord(JSON.parse(bytes.toString('utf8')));
      const installer = asRecord(value.installer);
      if (typeof value.tag !== 'string' || typeof installer.fileName !== 'string') throw new Error();
      verified = verifyRelease(bytes, Buffer.from(signature), this.key, value.tag, { name: installer.fileName });
    } catch { throw new Error('OTA 清单签名或版本信息校验失败。'); }
    const { manifest, manifestSha256: sha } = verified;
    const expected = `${api}/download/${provider}/release/${manifest.tag}/${manifest.installer.fileName}/${sha}`;
    if (sha !== manifestSha256 || expected !== downloadPath || body.channel !== manifest.channel || manifest.installer.size > maxInstallerBytes) {
      throw new Error('下载地址、安装包大小或清单摘要与签名不一致。');
    }
    const currentBeta = parseVersion(current)?.beta !== undefined;
    const isNewer = compareVersions(manifest.version, current) > 0;
    const stableSelection = channel === 'stable' && manifest.channel === 'stable' &&
      (currentBeta ? transition === 'leave-beta' : isNewer && transition === undefined);
    const betaSelection = channel === 'beta' && isNewer && (transition === 'ga-to-stable'
      ? currentBeta && manifest.channel === 'stable' && manifest.promotesFrom?.includes(current)
      : transition === undefined && (manifest.channel === 'beta' || !currentBeta));
    if (!stableSelection && !betaSelection) throw new Error('更新版本或通道晋级校验失败。');

    const download = new URL(expected, origin);
    if (manifest.channel === 'beta') download.searchParams.set('developer_opt_in', '1');
    const mandatory = required || manifest.mandatory === true ||
      (manifest.minimumVersion !== undefined && compareVersions(current, manifest.minimumVersion) < 0);
    return { manifest, sha, provider, download, mandatory };
  }

  async download(release: OtaRelease, access: string, start: number, signal: AbortSignal): Promise<IncomingMessage> {
    const headers: IncomingHttpHeaders = { 'accept-encoding': 'identity', ...(start > 0 ? { range: `bytes=${start}-` } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.request(release.download, { ...headers, authorization: `Bearer ${access}` }, signal, this.ca);
      if (response.statusCode !== 302) return response;
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('更新源未提供下载地址。');
      const cdn = new URL(location);
      if (cdn.protocol !== 'https:' || cdn.port || cdn.username || cdn.password || !sourceDefinitions[release.provider].cdn.includes(cdn.hostname)) {
        throw new Error('安装包下载被重定向到不受信地址。');
      }
      const direct = await this.request(cdn, headers, signal);
      if ((direct.statusCode !== 401 && direct.statusCode !== 403) || attempt > 0) return direct;
      direct.destroy();
    }
    throw new Error('安装包临时下载地址已失效。');
  }
}
