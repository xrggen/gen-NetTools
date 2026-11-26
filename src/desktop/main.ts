import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { chooseBrandRule, chooseBrandRuleBatch, getBrandKnowledge, getHistory, getProtectedModelKey, getSettings, insertRules, openStore, recordSuccess, saveModelSettings } from '../core/storage';
import { completionEndpoint } from '../core/chat-api';
import { openSmokeEndpoint } from './smoke-endpoint';
import { huaweiDocumentDirectory, parseHuaweiPage, parseUpdate } from '../core/huawei-rules';
import { protectedName } from '../core/input';
import { Deployment } from '../core/deployment';
import { templateFile } from '../core/deployment-script';
import { OtaProtocol } from '../core/ota-protocol';
import { OtaUpdates } from './ota-updates';
import { verifier } from '../../ota-backend/manifest.mjs';
import type { DeploymentPlan, TemplateKind } from '../shared/deployment';
import { brandNames, dataLimit, minimumModelContext, parseBrand, routeChangeLabels, type AiPreviewRequest, type AiSettings, type AnalysisFeature, type Brand, type KeyChange, type Request, type RouteFilter, type RuleBatchPreference, type Source, type UpdateConfiguration, type WorkerRequest, type WorkerSource } from '../shared/contracts';

declare const NETTOOLS_OTA_CA_PEM: string;
declare const NETTOOLS_OTA_VERIFIER_PEM: string;

function tolerateClosedPipe(stream: NodeJS.WritableStream) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // Electron may log an IPC rejection after the launching console has disconnected.
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
  });
}

tolerateClosedPipe(process.stdout);
tolerateClosedPipe(process.stderr);
app.setName('gen-NetTools');
let window: BrowserWindow | undefined;
let worker: Worker | undefined;
let guard: ChildProcessWithoutNullStreams | undefined;
let pending: { resolve: (message: any) => void; reject: (error: Error) => void } | undefined;
const selected = new Map<string, { path: string; directory: boolean }>();
const dist = __dirname;
const machineHelper = join(dist, 'machine-helper.exe');
const bundledSeed = join(dist, 'huawei-seed.json');
const developmentPath = process.env.NETTOOLS_DEV_DATA_DIR;
const systemPath = app.isPackaged ? spawnSync(machineHelper, ['program-data'], { windowsHide: true, encoding: 'utf8' }) : undefined;
const programData = systemPath?.status === 0 ? systemPath.stdout.trim() : undefined;
const runtimeDirectory = app.isPackaged
  ? programData && isAbsolute(programData) ? join(programData, 'gen-NetTools') : undefined
  : developmentPath && isAbsolute(developmentPath) ? resolve(developmentPath) : undefined;

let runtimeError: Error | undefined;
if (runtimeDirectory) {
  try {
    if (app.isPackaged) {
      const prepared = spawnSync(machineHelper, ['prepare-data'], { windowsHide: true, timeout: 8000 });
      if (prepared.status !== 0) throw new Error('无法准备共享目录。');
    }
    for (const [key, name] of [['userData', 'electron'], ['sessionData', 'session'], ['crashDumps', 'crash'], ['logs', 'logs']] as const) {
      const destination = join(runtimeDirectory, name);
      mkdirSync(destination, { recursive: true });
      app.setPath(key, destination);
    }
  } catch {
    runtimeError = new Error(app.isPackaged ? '无法写入全机共享目录 %ProgramData%\\gen-NetTools。请检查目录权限。' : '无法写入开发版的数据目录。');
  }
}

function localPath() {
  if (runtimeDirectory) return runtimeDirectory;
  throw new Error(app.isPackaged ? '找不到 Windows ProgramData 共享目录。' : '启动开发版前，请设置 NETTOOLS_DEV_DATA_DIR。');
}

function acquire(directory: string) {
  return new Promise<void>((done, fail) => {
    const child = spawn(machineHelper, ['lock', join(directory, 'instance.lock')], { windowsHide: true });
    guard = child;
    tolerateClosedPipe(child.stdin);
    let acquired = false;
    child.stderr.resume();
    child.on('error', fail);
    child.stdout.once('data', chunk => {
      if (chunk.toString().trim() !== 'ready') { fail(new Error('另一个 Windows 用户或会话正在运行 gen-NetTools。')); return; }
      acquired = true;
      done();
    });
    child.on('exit', () => {
      if (acquired && guard === child) app.quit();
      else if (!acquired) fail(new Error('无法取得全机运行锁，请检查是否已有实例或没有共享目录权限。'));
    });
  });
}

function requestWorker(path: string, message: object) {
  if (pending) throw new Error('已有后台任务正在运行。');
  if (!worker) {
    const current = new Worker(join(dist, 'worker.cjs'), { workerData: { path } });
    worker = current;
    current.on('message', (reply) => {
      if (worker !== current) return;
      if (reply.type === 'progress') { if (!window?.isDestroyed()) window?.webContents.send('progress', reply.message); return; }
      const task = pending;
      pending = undefined;
      if (reply.type === 'error') task?.reject(new Error(reply.message));
      else task?.resolve(reply);
    });
    const interrupted = () => {
      if (worker !== current) return;
      worker = undefined;
      pending?.reject(new Error('后台任务中断。'));
      pending = undefined;
    };
    current.on('error', interrupted);
    current.on('exit', interrupted);
  }
  const current = worker;
  return new Promise<any>((resolve, reject) => { pending = { resolve, reject }; current.postMessage(message); });
}

async function cancel() {
  const current = worker;
  const task = pending;
  if (!current || !task) return;
  worker = undefined;
  await current.terminate();
  if (pending === task) pending = undefined;
  task.reject(new Error('任务已取消。'));
}

function assertBrand(value: unknown) {
  const brand = parseBrand(value);
  if (!brand) throw new Error('请选择受支持的设备品牌。');
  return brand;
}

function selectedPath(id: string, directory: boolean) {
  const selection = selected.get(id);
  if (!selection || selection.directory !== directory) throw new Error('请选择输入文件或目录。');
  return selection.path;
}

function source(input: Source): WorkerSource {
  if ('text' in input && typeof input.text === 'string' && Buffer.byteLength(input.text) <= dataLimit) return { text: input.text };
  if ('file' in input && ['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'].includes(input.encoding)) {
    return { path: selectedPath(input.file, false), encoding: input.encoding };
  }
  throw new Error('输入无效或超过 50 MB。');
}

function resolveRequest(request: Request): WorkerRequest {
  if (request.feature === 'logs') return { feature: 'logs', input: source(request.input), brand: assertBrand(request.brand) };
  if (request.feature === 'knowledge') {
    if (request.format !== 'json' && request.format !== 'html') throw new Error('不支持的导入格式。');
    return { feature: 'knowledge', format: request.format, directory: selectedPath(request.directory, request.format === 'html'),
      brand: assertBrand(request.brand) };
  }
  const before = source(request.before);
  const after = source(request.after);
  if (request.feature === 'config' && request.mode === 'exact') return { feature: 'config', before, after, mode: 'exact' };
  if (request.feature === 'routes') return { feature: 'routes', before, after,
    beforeScope: request.beforeScope?.trim().slice(0, 160), afterScope: request.afterScope?.trim().slice(0, 160) };
  throw new Error('未知任务类型。');
}

function validateSettings(value: AiSettings): AiSettings {
  const remembered: AiSettings['remembered'] = {};
  for (const feature of ['logs', 'config', 'routes'] as const) {
    const scope = value.remembered[feature];
    if (scope === 'selection' || scope === 'full') remembered[feature] = scope;
  }
  const baseUrl = value.baseUrl.trim();
  const model = value.model.trim();
  if (baseUrl) completionEndpoint(baseUrl);
  if (value.enabled && (!baseUrl || !model)) throw new Error('启用接口需填写地址与模型。');
  const contextTokens = value.contextTokens;
  if (contextTokens !== undefined && (!Number.isSafeInteger(contextTokens) || contextTokens < minimumModelContext)) {
    throw new Error(`请输入至少 ${minimumModelContext} 的模型上下文 Token 数。`);
  }
  return { enabled: Boolean(value.enabled), baseUrl, model, contextTokens, remembered };
}

function dpapi(operation: 'protect' | 'unprotect', input: Buffer, ota = false) {
  try {
    const result = spawnSync(machineHelper, [ota ? `ota-${operation}` : operation], { input, windowsHide: true, maxBuffer: 32768, timeout: 8000 });
    if (result.status !== 0 || !result.stdout?.length) throw new Error(ota ? 'Windows DPAPI 无法处理控制面访问凭据。' : 'Windows DPAPI 无法处理共享模型密钥。');
    return result.stdout;
  } finally { input.fill(0); }
}

async function start() {
  if (runtimeError) throw runtimeError;
  const directory = localPath();
  await mkdir(directory, { recursive: true });
  await acquire(directory);
  const dbPath = join(directory, 'workspace.sqlite3');
  const db = openStore(dbPath);
  const deployment = new Deployment(directory, event => {
    if (window && !window.isDestroyed()) window.webContents.send('deployment-event', event);
  });
  const updates = new OtaUpdates({ version: app.getVersion(), db, unprotect: input => dpapi('unprotect', input, true),
    readManagedAccess: () => {
      if (!app.isPackaged) return;
      const result = spawnSync(machineHelper, ['ota-read-managed'], { windowsHide: true, maxBuffer: 8192, timeout: 8000 });
      if (result.status === 3) return;
      if (result.status !== 0 || !result.stdout?.length) throw new Error('无法读取本机在线更新授权。');
      return result.stdout;
    },
    protocol: NETTOOLS_OTA_CA_PEM && NETTOOLS_OTA_VERIFIER_PEM ? new OtaProtocol(NETTOOLS_OTA_CA_PEM, verifier(NETTOOLS_OTA_VERIFIER_PEM)) : undefined,
    notify: status => { if (window && !window.isDestroyed()) window.webContents.send('update-event', status); },
    cache: () => {
      const result = spawnSync(machineHelper, ['ota-cache'], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
      if (result.status !== 0 || !result.stdout?.trim()) throw new Error('无法取得当前账户的安装包暂存目录。');
      return result.stdout.trim();
    },
    install: async (file, release) => {
      if (!window || pending || deployment.busy) throw new Error('有任务正在运行，请等待任务结束后再安装。');
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '安装 gen-NetTools 更新',
        message: `安装 gen-NetTools ${release.manifest.version}？`,
        detail: '应用将在安装器启动后退出。安装需要 Windows 管理员授权。', buttons: ['稍后', '安装并退出'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return false;
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(machineHelper, ['ota-install', file, release.manifest.installer.sha256], { windowsHide: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (code === 1223) return false;
      if (code !== 0) throw new Error(code === 68 ? '安装包未通过启动前校验。请重新检查和下载。' : '未能启动 Windows 安装器。');
      setImmediate(() => app.quit());
      return true;
    },
  });
  let aiDraft: { id: string; feature: AnalysisFeature; endpoint: string; model: string; contextTokens?: number } | undefined;
  try {
    const data = await readFile(bundledSeed, 'utf8');
    const seed = parseUpdate(JSON.parse(data));
    if (seed.issues.length) throw new Error('内置华为规则校验失败。');
    insertRules(db, seed.rules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || app.isPackaged) throw error;
  }
  app.on('will-quit', () => { updates.dispose(); db.close(); const child = guard; guard = undefined; child?.stdin.end(); void worker?.terminate(); });
  let quitting = false;
  app.on('before-quit', event => {
    if (!deployment.busy) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    deployment.cancel();
    void deployment.waitForIdle().then(() => app.quit());
  });
  const setup = <T extends unknown[]>(name: string, handle: (...args: T) => unknown) => ipcMain.handle(name, (event: IpcMainInvokeEvent, ...args: T) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口请求。');
    return handle(...args);
  });
  async function pick(directory: boolean) {
    const choice = await dialog.showOpenDialog(window!, { properties: [directory ? 'openDirectory' : 'openFile'],
      title: directory ? '选择华为日志 HTML 目录' : '选择文本文件或字段库更新包' });
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return null;
    const actual = await realpath(path);
    if (resolve(path).toLowerCase() !== resolve(actual).toLowerCase() || (await lstat(path)).isSymbolicLink()) throw new Error('请选择实体文件或目录。');
    for (const segment of actual.split(/[\\/]/)) if (protectedName.test(segment)) throw new Error('所选路径包含受保护的名称。');
    const id = randomUUID();
    selected.set(id, { path: actual, directory });
    return { id, name: basename(actual) };
  }
  setup('pick-file', () => pick(false));
  setup('pick-folder', () => pick(true));
  async function deploymentFile(title: string, extensions: string[]) {
    const choice = await dialog.showOpenDialog(window!, { title, properties: ['openFile'],
      filters: [{ name: title, extensions }] });
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return undefined;
    const actual = await realpath(path);
    const info = await lstat(path);
    if (resolve(path).toLowerCase() !== resolve(actual).toLowerCase() || info.isSymbolicLink() || !info.isFile()) {
      throw new Error('请选择本轮使用的实体文件。');
    }
    return actual;
  }
  setup('deployment-import-devices', async () => {
    const path = await deploymentFile('选择 SSH 设备清单', ['csv', 'txt', 'xls', 'xlsx']);
    return path ? deployment.importDevices(path) : null;
  });
  setup('deployment-import-script', async () => {
    const path = await deploymentFile('选择命令脚本', ['csv', 'txt', 'xls', 'xlsx', 'log']);
    return path ? deployment.importScript(path) : null;
  });
  setup('deployment-release-script', (id: string) => deployment.releaseScript(id));
  setup('deployment-add-key', async (alias: string, passphrase: string) => {
    const path = await deploymentFile('选择此别名对应的 SSH 私钥', ['*']);
    if (!path) return false;
    await deployment.addKey(alias, path, passphrase);
    return true;
  });
  setup('deployment-download', async (kind: TemplateKind) => {
    if (kind !== 'commands' && kind !== 'devices') throw new Error('无效的模板类型。');
    const name = kind === 'devices' ? 'SSH-设备清单模板' : 'SSH-命令脚本模板';
    const choice = await dialog.showSaveDialog(window!, { title: '下载' + name, defaultPath: name + '.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }] });
    if (choice.canceled || !choice.filePath) return;
    await writeFile(choice.filePath, templateFile(kind, extname(choice.filePath).toLowerCase()));
  });
  setup('deployment-test', (concurrency: number) => deployment.test(concurrency));
  setup('deployment-trust', (id: string, fingerprint: string) => deployment.trust(id, fingerprint));
  setup('deployment-run', (plan: DeploymentPlan) => deployment.run(plan));
  setup('deployment-cancel', () => deployment.cancel());
  setup('deployment-reset', () => deployment.reset());
  setup('deployment-history', () => deployment.history.list());
  setup('deployment-reveal', async (id: string) => {
    const path = await deployment.history.locate(id);
    shell.showItemInFolder(join(path, 'round.json'));
  });
  setup('release', (id: string) => { selected.delete(id); });
  setup('run', async (request: Request) => {
    aiDraft = undefined;
    const resolved = resolveRequest(request);
    const reply = await requestWorker(dbPath, { type: 'run', request: resolved });
    if (reply.type === 'import' && resolved.feature === 'knowledge') {
      const { added, duplicates, conflicts, tracked } = insertRules(db, reply.rules, {
        brand: resolved.brand, format: resolved.format,
        name: resolved.format === 'html' ? huaweiDocumentDirectory(resolved.directory) : basename(resolved.directory),
      });
      const summary = [{ label: '新增', value: added }, { label: '重复跳过', value: duplicates },
        { label: '待选释义', value: conflicts }, { label: '无效条目', value: reply.issues }, { label: '跳过文件', value: reply.skipped }];
      if (reply.rules.length && !reply.issues && !conflicts && !tracked) recordSuccess(db, 'knowledge', summary);
      const notice = [tracked ? `本批次关联了 ${tracked} 条待选释义，可在列表下方批量选择。` : '',
        reply.issues ? '有效条目已处理，失败项见下方。' : ''].filter(Boolean).join(' ');
      return { feature: 'knowledge', summary, rows: reply.rows, total: reply.total, notice };
    }
    if (reply.record) recordSuccess(db, request.feature, reply.value.summary);
    return reply.value;
  });
  setup('page', async (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !worker) return [];
    return (await requestWorker(dbPath, { type: 'page', offset })).rows;
  });
  setup('route-page', async (offset: number, filter: RouteFilter) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !filter || typeof filter !== 'object' ||
        (filter.change !== undefined && !Object.hasOwn(routeChangeLabels, filter.change)) ||
        (filter.family !== undefined && filter.family !== 4 && filter.family !== 6) ||
        (filter.focus !== undefined && !['default', 'nextHop', 'fewerPaths'].includes(filter.focus)) ||
        [filter.table, filter.protocol, filter.prefix].some(value => value !== undefined && typeof value !== 'string')) {
      throw new Error('路由筛选条件无效。');
    }
    if (!worker) return { rows: [], total: 0, groups: [] };
    return (await requestWorker(dbPath, { type: 'route-page', offset, filter })).value;
  });
  setup('clear-results', async () => {
    if (pending) return;
    const current = worker;
    worker = undefined;
    aiDraft = undefined;
    await current?.terminate();
  });
  setup('cancel', () => { aiDraft = undefined; return cancel(); });
  setup('brands', () => Object.keys(brandNames) as Brand[]);
  setup('knowledge', (brand: Brand) => getBrandKnowledge(db, assertBrand(brand)));
  setup('choose-rule', (brand: Brand, id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('请选择有效的释义。');
    chooseBrandRule(db, assertBrand(brand), id);
  });
  setup('choose-rule-batch', (brand: Brand, id: number, preference: RuleBatchPreference) => {
    if (!Number.isSafeInteger(id) || id <= 0 || (preference !== 'existing' && preference !== 'incoming')) {
      throw new Error('请选择有效的导入批次和释义版本。');
    }
    return chooseBrandRuleBatch(db, assertBrand(brand), id, preference);
  });
  setup('update-status', () => updates.getStatus());
  setup('update-configure', (value: UpdateConfiguration) => updates.configure(value));
  setup('update-check', () => updates.check());
  setup('update-download', () => updates.download());
  setup('update-pause', () => updates.pause());
  setup('update-install', () => updates.install());
  setup('history', () => getHistory(db));
  const publicSettings = () => ({ ...getSettings(db), hasKey: Boolean(getProtectedModelKey(db)) });
  setup('settings', publicSettings);
  setup('settings-save', (value: AiSettings, change?: KeyChange) => {
    const previous = getSettings(db);
    const next = validateSettings(value);
    if (change && change.mode !== 'replace' && change.mode !== 'clear') throw new Error('无效的密钥操作。');
    const existing = Boolean(getProtectedModelKey(db));
    const beforeEndpoint = previous.baseUrl ? completionEndpoint(previous.baseUrl) : '';
    const afterEndpoint = next.baseUrl ? completionEndpoint(next.baseUrl) : '';
    if (!change && existing && beforeEndpoint !== afterEndpoint) throw new Error('更换接口地址时，请重新填写或清除共享 API Key。');
    if (change?.mode === 'replace' && (!afterEndpoint || typeof change.value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(change.value))) {
      throw new Error('请输入接口地址及有效的 API Key，密钥不能包含空白字符。');
    }
    if (change || beforeEndpoint !== afterEndpoint || previous.model !== next.model ||
        previous.contextTokens !== next.contextTokens || previous.enabled !== next.enabled) aiDraft = undefined;
    const protectedKey = change?.mode === 'replace' ? dpapi('protect', Buffer.from(change.value, 'utf8')) : change?.mode === 'clear' ? null : undefined;
    saveModelSettings(db, next, protectedKey);
    return publicSettings();
  });
  setup('ai-preview', async (value: AiPreviewRequest) => {
    const settings = getSettings(db);
    if (!settings.enabled || !['logs', 'config', 'routes'].includes(value.feature) ||
        !['selection', 'full'].includes(value.scope)) throw new Error('请先在设置中启用模型接口。');
    const expectedInputs = value.scope === 'selection' || value.feature === 'logs' ? 1 : 2;
    if (!Array.isArray(value.inputs) || value.inputs.length !== expectedInputs) throw new Error('预览输入不完整。');
    const brand = value.feature === 'logs' && value.brand !== undefined ? parseBrand(value.brand) : undefined;
    if (value.feature === 'logs' && value.brand !== undefined && !brand) throw new Error('请选择有效的日志品牌。');
    if (value.scope === 'selection' && !('text' in value.inputs[0])) throw new Error('需要明确选定文本片段。');
    if (!Array.isArray(value.fields) || value.fields.length > 32) throw new Error('最多可预览 32 个脱敏字段。');
    const fieldNames = new Set<string>();
    for (const field of value.fields) {
      if (!/^[a-zA-Z][a-zA-Z\d_ ./-]{0,63}$/.test(field.name) || fieldNames.has(field.name) ||
          (field.replacement !== undefined && (typeof field.replacement !== 'string' || /[\r\n]/.test(field.replacement) || field.replacement.length > 128))) {
        throw new Error('请检查重复字段名和替换文本。');
      }
      fieldNames.add(field.name);
    }
    const endpoint = completionEndpoint(settings.baseUrl);
    const id = randomUUID();
    aiDraft = undefined;
    const result = (await requestWorker(dbPath, { type: 'ai-preview', id, contextTokens: settings.contextTokens,
      request: { ...value, brand, inputs: value.inputs.map(source) } })).value;
    aiDraft = { id, endpoint, model: settings.model, contextTokens: settings.contextTokens, feature: value.feature };
    return { ...result, id, endpoint, model: settings.model, contextTokens: settings.contextTokens };
  });
  setup('ai-preview-batch', async (id: string, index: number) => {
    if (!aiDraft || id !== aiDraft.id || !Number.isSafeInteger(index) || index < 0) throw new Error('请先预览要发送的内容。');
    return (await requestWorker(dbPath, { type: 'ai-preview-batch', id, index })).value;
  });
  setup('ai-send', async (id: string) => {
    const draft = aiDraft;
    const settings = getSettings(db);
    if (pending || !draft || draft.id !== id || !settings.enabled || settings.model !== draft.model ||
        settings.contextTokens !== draft.contextTokens || completionEndpoint(settings.baseUrl) !== draft.endpoint) {
      throw new Error('预览已失效，请重新准备后再发送。');
    }
    const protectedKey = getProtectedModelKey(db);
    if (!protectedKey) throw new Error('请先在设置中保存共享 API Key。');
    const secret = dpapi('unprotect', protectedKey);
    const key = secret.toString('utf8');
    secret.fill(0);
    aiDraft = undefined;
    const result = (await requestWorker(dbPath, { type: 'ai-send', id, config: { key, endpoint: draft.endpoint, model: draft.model } })).value;
    if (result.completed === result.total && result.total > 0) {
      recordSuccess(db, draft.feature, [{ label: 'AI 完成请求', value: result.completed }]);
    }
    return result;
  });

  const smoke = !app.isPackaged && process.argv.includes('--smoke');
  const frame = new BrowserWindow({ width: 1440, height: 950, minWidth: 980, minHeight: 700, title: 'gen-NetTools', show: !smoke,
    backgroundColor: '#ecf1f7', webPreferences: { preload: join(dist, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window = frame;
  frame.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  frame.webContents.on('will-navigate', event => event.preventDefault());
  frame.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const loaded = frame.loadFile(join(dist, 'index.html'));
  if (smoke) {
    await loaded;
    const script = await readFile(join(dist, 'smoke.js'), 'utf8');
    const rule = getBrandKnowledge(db, 'Huawei').rows[0];
    if (!rule) throw new Error('验证需要预先构建华为规则。');
    const fixture = join(directory, 'fixture-update.json');
    const sample = { ...rule, event: 'SYNTHETIC_REGRESSION_CHECK', vendor: 'HUAWEI' };
    const legacyCopy = { ...sample, product: 'Old Product', version: 'V1' };
    const conflicting = { ...sample, meaning: '手动选择的替代释义', source: '冲突测试样例' };
    await writeFile(fixture, JSON.stringify({ schemaVersion: 1, rules: [rule, sample, legacyCopy, conflicting, { event: null }] }), 'utf8');
    const id = randomUUID();
    selected.set(id, { path: fixture, directory: false });
    const demo = (event: string, meaning: string) => ({ ...rule, event, meaning, source: '批量释义测试' });
    const incoming = ['BATCH_EXISTING', 'BATCH_OTHER', 'BATCH_INDIVIDUAL', 'BATCH_MULTIPLE', 'BATCH_NEW'].map(event => demo(event, '导入释义'));
    const legacy = demo('BATCH_LEGACY', '旧版导入的替代释义');
    insertRules(db, [demo('BATCH_EXISTING', '其他旧资料的释义'), demo('BATCH_EXISTING', '原有生效释义'),
      demo('BATCH_OTHER', '原有生效释义'), demo('BATCH_INDIVIDUAL', '原有生效释义'),
      demo('BATCH_MULTIPLE', '原有候选一'), demo('BATCH_MULTIPLE', '原有候选二'),
      demo('BATCH_LEGACY', '原有生效释义'), legacy,
      demo('BATCH_UNRELATED', '原有生效释义'), demo('BATCH_UNRELATED', '仍待选择的替代释义')]);
    async function saveSmokeImport(name: string, rules: typeof incoming) {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify({ schemaVersion: 1, rules }), 'utf8');
      const id = randomUUID();
      selected.set(id, { path, directory: false });
      return id;
    }
    const htmlPage = (event: string, cause: string) => `<meta name="DC.Type" content="logref"><meta name="DC.Title" content="AAA/6/${event}">
      <meta name="DC.Identifier" content="SYNTHETIC_LOGREF">
      <div class="logRefMessagebody">测试日志正文</div><div class="logRefDescbody">测试释义</div><div class="logRefCausebody">${cause}</div>`;
    const pageName = 'source-reference.html';
    const same = htmlPage('SYNTHETIC_SOURCE_REFERENCE', '测试原因一');
    const different = htmlPage('SYNTHETIC_SOURCE_REFERENCE', '测试原因二');
    insertRules(db, [parseHuaweiPage(same, pageName)!, parseHuaweiPage(different, pageName)!]);
    async function saveSmokeDocuments(path: string, pages: Record<string, string>) {
      await mkdir(path, { recursive: true });
      await Promise.all(Object.entries(pages).map(([name, html]) => writeFile(join(path, name), html, 'utf8')));
      const id = randomUUID();
      selected.set(id, { path, directory: true });
      return id;
    }
    const imports = {
      incoming: await saveSmokeImport('fixture-batch.json', incoming), legacy: await saveSmokeImport('fixture-legacy.json', [legacy]),
      parentProduct: await saveSmokeDocuments(join(directory, 'CloudEngine XH9000, XH8000_V300R026C00', 'resources', 'v300r026c00', 'log'), {
        [pageName]: same, 'new-reference.html': htmlPage('SYNTHETIC_NEW_SOURCE_REFERENCE', '测试原因'),
      }),
      selectedProduct: await saveSmokeDocuments(join(directory, 'CloudEngine 9800, 8800, 6800, 5800_V200R025C00'), {
        [pageName]: different, 'identical-rule.html': same,
      }),
    };
    const mock = await openSmokeEndpoint();
    try {
      const state = await frame.webContents.executeJavaScript(`(${script.trim()})(${JSON.stringify(id)},${JSON.stringify(mock.settings)},${JSON.stringify(imports)})`);
      if (mock.count() !== 6) throw new Error('实际模型请求次数与确认次数不符。');
      console.log(JSON.stringify({ ...state, modelBatchRequests: mock.count(), version: process.versions.electron }));
    } finally { mock.server.close(); }
    app.quit();
  } else {
    await loaded;
    if (app.isPackaged) void updates.check();
  }
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(start).catch(error => {
  if (process.argv.includes('--smoke')) console.error(error);
  else dialog.showErrorBox('gen-NetTools 启动失败', error instanceof Error ? error.message : '发生内部错误。');
  app.exit(1);
});
