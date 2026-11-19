export type CommandLine = { line: number; text: string };
export type DeviceState = 'queued' | 'connecting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type DeviceProgress = {
  id: string;
  label: string;
  state: DeviceState;
  completed: number;
  total: number;
  line?: number;
  error?: string;
};
export type DeploymentRecord = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  devices: DeviceProgress[];
  path: string;
};
export type DeviceInfo = { id: string; label: string; username: string; keyAlias?: string };
export type DeviceTest = {
  id: string;
  state: 'pending' | 'testing' | 'passed' | 'failed' | 'trust-required' | 'cancelled';
  detail?: string;
  fingerprint?: string;
};
export type DeploymentScript = { id: string; name: string; count: number };
export type DeploymentPlan = {
  common: string;
  overrides: Record<string, string>;
  intervalMs: number;
  concurrency: number;
  autoYes: boolean;
};
export type DeploymentEvent =
  | { type: 'test'; result: DeviceTest }
  | { type: 'round'; record: DeploymentRecord }
  | { type: 'progress'; update: DeviceProgress };
export type TemplateKind = 'devices' | 'commands';

export interface DeploymentApi {
  importDevices(): Promise<{ name: string; devices: DeviceInfo[] } | null>;
  importScript(): Promise<DeploymentScript | null>;
  releaseScript(id: string): Promise<void>;
  addKey(alias: string, passphrase: string): Promise<boolean>;
  download(kind: TemplateKind): Promise<void>;
  test(concurrency: number): Promise<DeviceTest[]>;
  trust(id: string, fingerprint: string): Promise<void>;
  run(plan: DeploymentPlan): Promise<DeploymentRecord>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  history(): Promise<DeploymentRecord[]>;
  reveal(id: string): Promise<void>;
  onEvent(listener: (event: DeploymentEvent) => void): () => void;
}
