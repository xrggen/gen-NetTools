import type { KeyObject } from 'node:crypto';

export type ReleaseManifest = {
  tag: string;
  version: string;
  channel: 'stable' | 'beta';
  installer: { fileName: string; size: number; sha256: string };
  minimumVersion?: string;
  mandatory?: boolean;
  notes?: string;
  releaseStage: 'stable' | 'beta' | 'ga';
  promotesFrom?: string[];
};

export function verifier(material: string | Buffer): KeyObject;
export function verifyRelease(bytes: Buffer, signature: Buffer, publicKey: KeyObject, tag: string, asset: { name: string }): {
  manifest: ReleaseManifest;
  manifestSha256: string;
};
