export const host: string;
export const port: number;
export const gaPolicy: string;
export function parseVersion(value: unknown): { value: string; beta?: number; base: string } | undefined;
export function compareVersions(left: string, right: string): number;
