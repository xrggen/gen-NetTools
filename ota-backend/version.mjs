export const appId = 'gen-NetTools';
export const host = 'ota.12306.gd.cn';
export const port = 23887;
export const manifestName = 'gen-NetTools-update.json';
export const signatureName = 'gen-NetTools-update.sig';
export const gaPolicy = 'ga-promotion-v1';

const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-b([1-9]\d{0,8}))?$/;

export class OtaError extends Error {
  constructor(status, code, { unavailable = false } = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.unavailable = unavailable;
  }
}

export function parseVersion(value) {
  if (typeof value !== 'string') return;
  const match = versionPattern.exec(value);
  if (!match) return;
  return { value, core: match.slice(1, 4).map(Number), beta: match[4] === undefined ? undefined : Number(match[4]),
    base: match.slice(1, 4).join('.') };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid release version');
  return a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2] ||
    ((a.beta ?? Infinity) === (b.beta ?? Infinity) ? 0 : (a.beta ?? Infinity) > (b.beta ?? Infinity) ? 1 : -1);
}

export function installerName(version) {
  return `${appId}-${version}-win-x64-setup.exe`;
}

export async function chooseUpdate(source, request) {
  const { version, channel, policy } = request;
  const current = parseVersion(version);
  if (channel === 'stable') {
    const release = await source.latest('stable');
    if (!release) return;
    if (current.beta !== undefined || compareVersions(release.manifest.version, version) > 0) {
      return { release, transition: current.beta === undefined ? undefined : 'leave-beta' };
    }
    return;
  }
  if (current.beta !== undefined && policy === gaPolicy) {
    const currentRelease = await source.byTag(`v${version}`);
    if (currentRelease?.manifest.releaseStage === 'ga') {
      const target = await source.byTag(`v${currentRelease.manifest.promotionTarget}`);
      if (target?.manifest.channel === 'stable' && target.manifest.promotesFrom?.includes(version) &&
          compareVersions(target.manifest.version, version) > 0) return { release: target, transition: 'ga-to-stable' };
    }
  }
  const candidates = [await source.latest('beta')];
  if (current.beta === undefined && policy === gaPolicy) candidates.push(await source.latest('stable'));
  const best = candidates.filter(release => release && compareVersions(release.manifest.version, version) > 0)
    .sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
  if (best) return { release: best };
}

export async function withProviders(providers, action) {
  try { return await action(providers.gitcode); }
  catch (error) {
    if (!(error instanceof OtaError) || !error.unavailable) throw error;
    return action(providers.github);
  }
}
