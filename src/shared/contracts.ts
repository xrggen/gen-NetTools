import type { DeploymentApi } from './deployment';

export const featureNames = {
  logs: '日志分析', config: '配置比对', routes: '路由比对', knowledge: '字段知识库',
} as const;

export type Feature = keyof typeof featureNames;
export type AnalysisFeature = Exclude<Feature, 'knowledge'>;
export type AnalysisScope = 'selection' | 'full';
export type Encoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';
export const dataLimit = 50_000_000;
export const pageSize = 50;
export const minimumModelContext = 4096;

export type Source = { text: string } | { file: string; encoding: Encoding };
export type WorkerSource = { text: string } | { path: string; encoding: Encoding };
export type Picked = { id: string; name: string };
export const brandNames = { Huawei: '华为（HUAWEI）' } as const;
export type Brand = keyof typeof brandNames;
export function parseBrand(value: unknown): Brand | undefined {
  return typeof value === 'string' ? (Object.keys(brandNames) as Brand[]).find(brand => brand.toLowerCase() === value.trim().toLowerCase()) : undefined;
}
export type Rule = {
  vendor: Brand;
  module: string; severity: string; event: string; template: string;
  meaning: string; parameters: { name: string; meaning: string }[];
  causes: string; steps: string; source: string; additionalSources?: string[];
};
export type RuleConflict = { identifier: string; candidates: { id: number; rule: Rule }[] };
export type RuleBatchPreference = 'existing' | 'incoming';
export type RuleImportBatch = {
  id: number; name: string; at: string; pending: number; existing: number; incoming: number;
};
export type Knowledge = { rows: Rule[]; conflicts: RuleConflict[]; batches: RuleImportBatch[] };
export type LogRow = {
  line: number; text: string; identifier?: string; rule?: Rule;
  fields?: { name: string; value: string; meaning: string }[];
  observed?: { name: string; value: string }[];
  status: 'matched' | 'partial' | 'unmatched' | 'conflict';
};
export type ConfigRow = {
  change: 'added' | 'removed' | 'modified'; beforeLine?: number; afterLine?: number;
  before?: string; after?: string;
};
export type RoutePath = { protocol: string; preference: number; cost: number; flags: string; nextHop: string; interface: string; relayNextHop?: string; tunnelId?: string; line: number };
export const routePathFields = {
  nextHop: '下一跳', interface: '出口', protocol: '协议', preference: 'Pre', cost: 'Cost',
  flags: '标志', relayNextHop: '递归下一跳', tunnelId: '隧道',
} satisfies Record<Exclude<keyof RoutePath, 'line'>, string>;
export type RoutePathField = keyof typeof routePathFields;
export type RoutePathChange =
  | { change: 'added'; after: RoutePath }
  | { change: 'removed'; before: RoutePath }
  | { change: 'modified'; before: RoutePath; after: RoutePath; fields: RoutePathField[] };
export const routeChangeLabels = { added: '新增', removed: '删除', modified: '修改', scopeOnly: '仅一侧覆盖' } as const;
export type RouteChangeKind = keyof typeof routeChangeLabels;
export type RouteRow = {
  change: ConfigRow['change']; family: 4 | 6; table: string; prefix: string;
  before: RoutePath[]; after: RoutePath[]; pathChanges: RoutePathChange[];
  coverage?: 'before' | 'after';
};
export type RouteCoverage = { family: 4 | 6; table: string; before?: number; after?: number };
export type RouteCounts = Record<RouteChangeKind, number>;
export type RouteResultGroup = { table: string; counts: RouteCounts };
export type RouteFilter = {
  change?: RouteChangeKind; table?: string; family?: 4 | 6; protocol?: string; prefix?: string;
  focus?: 'default' | 'nextHop' | 'fewerPaths';
};
export type RoutePage = { rows: RouteRow[]; total: number; groups: RouteResultGroup[] };
export type RouteReportDetails = { coverage: RouteCoverage[]; counts: RouteCounts; protocols: string[]; groups: RouteResultGroup[] };
export type ImportRow = { name: string; reason: string };
export type ReportRow = LogRow | ConfigRow | RouteRow | ImportRow;

export type RequestWithSource<T> =
  | { feature: 'logs'; input: T; brand: Brand }
  | { feature: 'config'; before: T; after: T; mode: 'exact' }
  | { feature: 'routes'; before: T; after: T; beforeScope?: string; afterScope?: string }
  | { feature: 'knowledge'; directory: string; brand: Brand; format: 'html' | 'json' };
export type Request = RequestWithSource<Source>;
export type WorkerRequest = RequestWithSource<WorkerSource>;
export type Summary = { label: string; value: number }[];
export type Report = { feature: Feature; summary: Summary; total: number; rows: ReportRow[]; notice?: string; routes?: RouteReportDetails };
export type HistoryRecord = { id: number; feature: Feature; at: string; summary: Summary };
export type AiSettings = { enabled: boolean; baseUrl: string; model: string; contextTokens?: number; remembered: Partial<Record<AnalysisFeature, AnalysisScope>> };
export type PublicAiSettings = AiSettings & { hasKey: boolean };
export type KeyChange = { mode: 'replace'; value: string } | { mode: 'clear' };
export type RedactionField = { name: string; replacement?: string };
export type AiPreviewRequest<T = Source> = {
  feature: AnalysisFeature; scope: AnalysisScope; inputs: T[]; fields: RedactionField[]; brand?: Brand;
};
export type AiPreview = {
  id: string; batches: number; characters: number; firstBatch: string; matches: { name: string; count: number }[];
  endpoint: string; model: string; skill: string; evidence: string;
  context: { system: string; userName: string };
  requests: number; contextTokens?: number;
};
export type AiCitation = { id: string; label: string; text: string };
export type AiAnalysis = {
  total: number; completed: number; answers: { index: number; text: string }[];
  report?: string; citations?: AiCitation[]; evidenceNotice?: string; notice?: string;
};
export type UpdateChannel = 'stable' | 'beta';
export type UpdateSource = 'online' | 'local';
export type UpdateConfiguration = { channel: UpdateChannel; source: UpdateSource };
export type UpdateState = 'configuration-required' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'paused' | 'ready' | 'installing' | 'error';
export type UpdateStatus = {
  version: string;
  channel: UpdateChannel;
  source: UpdateSource;
  sources: UpdateSource[];
  hasAccess: boolean;
  state: UpdateState;
  latestVersion?: string;
  notes?: string;
  message?: string;
  mandatory?: boolean;
  downloaded?: number;
  size?: number;
};

export interface DesktopApi {
  deployment: DeploymentApi;
  pickFile(): Promise<Picked | null>;
  pickFolder(): Promise<Picked | null>;
  release(id: string): Promise<void>;
  run(request: Request): Promise<Report>;
  page(offset: number): Promise<ReportRow[]>;
  routePage(offset: number, filter: RouteFilter): Promise<RoutePage>;
  clearResults(): Promise<void>;
  cancel(): Promise<void>;
  brands(): Promise<Brand[]>;
  knowledge(brand: Brand): Promise<Knowledge>;
  chooseRule(brand: Brand, id: number): Promise<void>;
  chooseRuleBatch(brand: Brand, id: number, preference: RuleBatchPreference): Promise<number>;
  updateStatus(): Promise<UpdateStatus>;
  configureUpdate(value: UpdateConfiguration): Promise<UpdateStatus>;
  checkUpdate(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  pauseUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  history(): Promise<HistoryRecord[]>;
  settings(): Promise<PublicAiSettings>;
  saveSettings(settings: AiSettings, keyChange?: KeyChange): Promise<PublicAiSettings>;
  previewAi(request: AiPreviewRequest): Promise<AiPreview>;
  aiPreviewBatch(id: string, index: number): Promise<string>;
  sendAi(id: string): Promise<AiAnalysis>;
  onProgress(listener: (message: string) => void): () => void;
}
