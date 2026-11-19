import { createHash, createPublicKey, verify } from 'node:crypto';
import { appId, compareVersions, installerName, OtaError, parseVersion } from './version.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const shaPattern = /^[0-9a-f]{64}$/;
const validSize = size => Number.isSafeInteger(size) && size > 0;

export function verifier(material) {
  const key = createPublicKey(material);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('OTA 公钥必须使用 Ed25519。');
  return key;
}

export function verifyRelease(bytes, encodedSignature, publicKey, expectedTag, asset) {
  const sig = encodedSignature.toString('utf8').trim();
  const signature = Buffer.from(sig, 'base64');
  const fail = () => { throw new OtaError(502, 'invalid_signed_release'); };
  if (signature.length !== 64 || signature.toString('base64') !== sig || !verify(null, bytes, publicKey, signature)) fail();
  let item;
  try { item = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(); }
  const version = parseVersion(item?.version);
  if (!version || item.schemaVersion !== 1 || item.appId !== appId || item.tag !== expectedTag ||
      item.tag !== `v${version.value}` || item.platform !== 'win32' || item.arch !== 'x64' ||
      item.channel !== (version.beta === undefined ? 'stable' : 'beta')) fail();
  const { installer, minimumVersion, mandatory, notes } = item;
  if (!installer || installer.fileName !== installerName(version.value) || !shaPattern.test(installer.sha256 ?? '') ||
      typeof installer.sha256 !== 'string' || !validSize(installer.size) ||
      !asset || asset.name !== installer.fileName || (asset.size != null && asset.size !== installer.size) ||
      (asset.digest !== undefined && asset.digest !== `sha256:${installer.sha256}`)) fail();
  if ((minimumVersion !== undefined && (!parseVersion(minimumVersion) || compareVersions(minimumVersion, version.value) > 0)) ||
      (mandatory !== undefined && typeof mandatory !== 'boolean') ||
      (notes !== undefined && (typeof notes !== 'string' || notes.length > 12000))) fail();
  const stage = item.releaseStage ?? item.channel;
  if (item.channel === 'beta') {
    if (!['beta', 'ga'].includes(stage) || item.promotesFrom !== undefined ||
        (stage === 'ga' ? item.promotionTarget !== version.base : item.promotionTarget !== undefined)) fail();
  } else {
    if (stage !== 'stable' || item.promotionTarget !== undefined) fail();
    if (item.promotesFrom !== undefined &&
        (!Array.isArray(item.promotesFrom) || item.promotesFrom.length > 32 ||
          new Set(item.promotesFrom).size !== item.promotesFrom.length ||
          item.promotesFrom.some(value => {
            const prior = parseVersion(value);
            return !prior || prior.beta === undefined || prior.base !== version.base;
          }))) fail();
  }
  return { manifest: { ...item, releaseStage: stage }, manifestBytes: bytes.toString('base64'), signature: sig, manifestSha256: digest(bytes), asset };
}
