import { useEffect, useState } from 'react';
import { DeploymentPage } from './deployment';
import { RouteResults } from './route-results';
import { AiReport } from './ai-report';
import { SoftwareUpdate } from './software-update';
import { createRoot } from 'react-dom/client';
import { brandNames, featureNames, minimumModelContext, pageSize, type AiAnalysis, type AiPreview, type AiSettings, type AnalysisFeature, type AnalysisScope, type Brand, type DesktopApi, type Encoding,
  type HistoryRecord, type KeyChange, type Knowledge, type LogRow, type Picked, type PublicAiSettings, type Report, type ReportRow, type Request,
  type RuleBatchPreference, type RuleImportBatch,
  type Rule, type RuleConflict, type Source } from '../shared/contracts';

declare global { interface Window { nettools: DesktopApi } }

const api = window.nettools;
const names = { ...featureNames, deployment: '自动化下发', history: '最近结果', settings: '设置' };
type Screen = keyof typeof names;
type Input = { text: string; file: Picked | null; encoding: Encoding };
const blank: Input = { text: '', file: null, encoding: 'auto' };
const changeNames = { added: '新增', removed: '删除', modified: '修改' };
const labels = { matched: '完整匹配', partial: '部分匹配', unmatched: '未知事件', conflict: '待选释义' };
const source = (input: Input): Source => input.file ? { file: input.file.id, encoding: input.encoding } : { text: input.text };

function Summary({ items }: { items: Report['summary'] }) {
  return <div className="metrics">{items.map(item => <span key={item.label}>{item.label}<strong>{item.value.toLocaleString('zh-CN')}</strong></span>)}</div>;
}

function TextInput({ title, input, setInput, onError, onSelectText }: {
  title: string; input: Input; setInput: (value: Input) => void; onError: (error: unknown) => void; onSelectText: (value: string) => void;
}) {
  async function pick() {
    try {
      const file = await api.pickFile();
      if (file) { if (input.file) await api.release(input.file.id); setInput({ ...blank, file }); }
    } catch (error) { onError(error); }
  }
  return <div className="input-box"><div className="input-title"><strong>{title}</strong><button onClick={pick}>选择文件</button></div>
    {input.file ? <div className="file"><code>{input.file.name}</code><label>编码<select value={input.encoding} onChange={event => setInput({ ...input, encoding: event.target.value as Encoding })}>
      <option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option>
    </select></label><button onClick={() => { void api.release(input.file!.id); setInput(blank); }}>移除</button></div> :
      <textarea aria-label={title} placeholder="粘贴文本，或选择本地文件" value={input.text} onChange={event => setInput({ ...input, text: event.target.value })}
        onSelect={event => { const area = event.currentTarget; const text = area.value.slice(area.selectionStart, area.selectionEnd); if (text) onSelectText(text); }} spellCheck={false} />}
  </div>;
}

function RuleSources({ rule }: { rule: Rule }) {
  return <span className="rule-sources">{[rule.source, ...(rule.additionalSources ?? [])].map(entry => <code key={entry}>{entry}</code>)}</span>;
}

function RuleDetail({ rule, fields, observed, showTemplate }: { rule: Rule; fields?: LogRow['fields']; observed?: LogRow['observed']; showTemplate?: boolean }) {
  return <><header><h3>字段解读</h3><code>{rule.module}/{rule.severity}/{rule.event}</code></header>
    <h4>日志含义</h4><p>{rule.meaning}</p>
    {showTemplate && <><h4>日志模板</h4><p><code>{rule.template}</code></p></>}
    {rule.parameters.length > 0 && <table><thead><tr><th>字段</th>{fields && <th>值</th>}<th>含义</th></tr></thead><tbody>
      {rule.parameters.map((parameter, index) => <tr key={`${parameter.name}-${index}`}><td><code>{parameter.name}</code></td>
        {fields && <td><code>{fields.find(field => field.name === parameter.name)?.value ?? '未提取'}</code></td>}<td>{parameter.meaning}</td></tr>)}</tbody></table>}
    {rule.causes && <><h4>可能原因</h4><p>{rule.causes}</p></>}{rule.steps && <><h4>处理步骤</h4><p>{rule.steps}</p></>}
    {Boolean(observed?.length) && <><h4>正文中的其他字段</h4><ul className="paths">{observed?.map((field, index) =>
      <li key={index}><code>{field.name} = {field.value}</code></li>)}</ul></>}
    <div className="origin"><strong>规则来源</strong><span>{brandNames[rule.vendor]}</span><RuleSources rule={rule}/></div></>;
}

function VisibleLine({ text }: { text?: string }) {
  if (text === undefined) return <span className="dim">—</span>;
  const ending = /\r\n$|[\r\n]$/.exec(text)?.[0];
  const suffix = ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : ending === '\n' ? 'LF' : '无换行';
  return <code className="visible-line">{ending ? text.slice(0, -ending.length) : text}<small>{suffix}</small></code>;
}

function Results({ report, offset, selectPage }: { report: Report; offset: number; selectPage: (offset: number) => void }) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [report.rows]);
  const row = report.rows[selected] as LogRow | undefined;
  return <section className="panel results"><Summary items={report.summary}/>{report.notice && <p className="notice">{report.notice}</p>}
    {report.feature === 'logs' && <div className="result-split"><div className="result-list"><h3>日志原文</h3>
      {report.rows.map((item, index) => {
        const log = item as LogRow;
        return <button key={log.line} className={index === selected ? 'chosen log-row' : 'log-row'} onClick={() => setSelected(index)}>
          <span className="dim">第 {log.line} 行</span><span>{labels[log.status]}</span><code>{log.text}</code></button>;
      })}</div><div className="detail">{row?.rule ? <RuleDetail rule={row.rule} fields={row.fields} observed={row.observed} /> :
        <><h3>字段解读</h3><p className="dim">{row?.status === 'conflict' ? '此标识有多个释义，请先在字段知识库选择。' : row ? '所选品牌的知识库中没有该事件。' : '暂无日志事件。'}</p></>}</div></div>}
    {report.feature === 'config' && <table><thead><tr><th>变化</th><th>变更前</th><th>变更后</th></tr></thead><tbody>
      {report.rows.map((item, index) => 'beforeLine' in item && <tr key={index} className={item.change}>
        <td>{changeNames[item.change]}</td><td><small>{item.beforeLine && `第 ${item.beforeLine} 行`}</small><VisibleLine text={item.before} /></td>
        <td><small>{item.afterLine && `第 ${item.afterLine} 行`}</small><VisibleLine text={item.after} /></td></tr>)}</tbody></table>}
    {report.feature === 'knowledge' && report.rows.length > 0 && <table><thead><tr><th>条目</th><th>失败原因</th></tr></thead><tbody>
      {report.rows.map((item, index) => 'reason' in item && <tr key={index}><td><code>{item.name}</code></td><td>{item.reason}</td></tr>)}</tbody></table>}
    {!report.total && report.feature === 'config' && <p className="notice">没有差异。</p>}
    {report.total > pageSize && <footer className="pager"><button disabled={offset === 0} onClick={() => selectPage(offset - pageSize)}>上一页</button>
      <span>{offset + 1}–{Math.min(offset + pageSize, report.total)} / {report.total}</span>
      <button disabled={offset + pageSize >= report.total} onClick={() => selectPage(offset + pageSize)}>下一页</button></footer>}
  </section>;
}

function Preferences({ onError }: { onError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<PublicAiSettings>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  useEffect(() => { void api.settings().then(setSettings).catch(onError); }, []);
  if (!settings) return <p>正在读取设置…</p>;
  const update = (patch: Partial<AiSettings>) => { setSaved(false); setSettings({ ...settings, ...patch }); };
  async function save() {
    if (!settings) return;
    setSaving(true);
    const change: KeyChange | undefined = keyInput.trim() ? { mode: 'replace', value: keyInput.trim() } : removeKey ? { mode: 'clear' } : undefined;
    try { setSettings(await api.saveSettings(settings, change)); setKeyInput(''); setRemoveKey(false); setSaved(true); }
    catch (error) { onError(error); }
    finally { setSaving(false); }
  }
  return <><section className="panel form"><h2>模型接口配置</h2><fieldset disabled={saving}>
    <label className="check"><input type="checkbox" checked={settings.enabled} onChange={event => update({ enabled: event.target.checked })} />启用 AI 接口</label>
    <label>接口地址<input type="url" value={settings.baseUrl} placeholder="https://api.deepseek.com" onChange={event => update({ baseUrl: event.target.value })}/></label>
    <label>模型 ID<input value={settings.model} placeholder="填写服务提供的模型 ID" onChange={event => update({ model: event.target.value })}/></label>
    <label>模型上下文（Token）<input type="number" min={minimumModelContext} step={1} value={settings.contextTokens ?? ''}
      placeholder="填写供应商提供的上下文容量" aria-describedby="model-context-help"
      onChange={event => update({ contextTokens: event.target.value === '' ? undefined : event.target.valueAsNumber })}/>
      <small id="model-context-help">按 UTF-8 字节保守估算并预留输出空间。留空时沿用每批 8,000 字符的兼容预算。</small></label>
    <label>共享 API Key <input type="password" value={keyInput} autoComplete="off" spellCheck={false}
      placeholder={settings.hasKey ? '已保存，填写以替换' : '输入接口提供的 API Key'}
      onChange={event => { setSaved(false); setRemoveKey(false); setKeyInput(event.target.value); }}/></label>
    {settings.hasKey && <label className="check"><input type="checkbox" checked={removeKey} onChange={event => { setSaved(false); setKeyInput(''); setRemoveKey(event.target.checked); }}/>保存时清除共享密钥</label>}
    <h3>各功能记住的分析范围</h3><div className="toolbar">{(['logs', 'config', 'routes'] as AnalysisFeature[]).map(feature => <label key={feature}>{featureNames[feature]}
      <select value={settings.remembered[feature] ?? ''} onChange={event => {
        const remembered = { ...settings.remembered };
        if (event.target.value === 'selection' || event.target.value === 'full') remembered[feature] = event.target.value;
        else delete remembered[feature];
        update({ remembered });
      }}><option value="">不记住</option><option value="selection">选中片段</option><option value="full">全文分析</option></select></label>)}</div>
    <div className="toolbar"><button className="primary" onClick={() => void save()}>保存设置</button>
      {saved && <span role="status">设置已保存</span>}</div></fieldset></section><SoftwareUpdate onError={onError}/></>;
}

function History({ onError }: { onError: (error: unknown) => void }) {
  const [items, setItems] = useState<HistoryRecord[]>([]);
  useEffect(() => { void api.history().then(setItems).catch(onError); }, []);
  return <div className="history">{Object.entries(featureNames).map(([feature, label]) => <section key={feature} className="panel"><h2>{label}</h2>
    {items.some(item => item.feature === feature) ? items.filter(item => item.feature === feature).map(item => <div className="history-entry" key={item.id}>
      <time>{new Date(item.at).toLocaleString('zh-CN')}</time><Summary items={item.summary}/></div>) : <p className="dim">暂无成功结果</p>}</section>)}</div>;
}

function AiPreparation({ feature, brand, inputs, selectedText, progress, onError, onBusy }: {
  feature: AnalysisFeature; brand?: Brand; inputs: [Input, Input]; selectedText: string; progress: string; onError: (error: unknown) => void; onBusy: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<PublicAiSettings>();
  const [scope, setScope] = useState<AnalysisScope | ''>('');
  const [remember, setRemember] = useState(false);
  const [selection, setSelection] = useState('');
  const [fields, setFields] = useState<{ name: string; replacement: string }[]>([]);
  const [redact, setRedact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AiPreview>();
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchText, setBatchText] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [analysis, setAnalysis] = useState<AiAnalysis>();
  const [answerIndex, setAnswerIndex] = useState(0);
  useEffect(() => {
    void api.settings().then(value => {
      setSettings(value);
      setScope(value.remembered[feature] ?? '');
      setRemember(Boolean(value.remembered[feature]));
    }).catch(onError);
  }, [feature]);
  useEffect(() => { setPreview(undefined); setConfirmation(false); setAnalysis(undefined); }, [scope, selection, inputs, fields, redact, brand]);
  async function prepare() {
    if (!scope || !settings) return;
    setBusy(true); onBusy(true); setConfirmation(false); setPreview(undefined); setAnalysis(undefined);
    try {
      const sources = scope === 'selection' ? [{ text: selection }] : feature === 'logs' ? [source(inputs[0])] : inputs.map(source);
      const value = await api.previewAi({ feature, scope, inputs: sources, brand: feature === 'logs' ? brand : undefined,
        fields: redact ? fields.filter(field => field.name.trim()).map(field => ({ name: field.name.trim(), replacement: field.replacement || undefined })) : [] });
      const saved = { ...settings.remembered };
      if (remember) saved[feature] = scope;
      else delete saved[feature];
      if (saved[feature] !== settings.remembered[feature]) setSettings(await api.saveSettings({ ...settings, remembered: saved }));
      setPreview(value); setBatchIndex(0); setBatchText(value.firstBatch);
    } catch (error) { onError(error); }
    finally { setBusy(false); onBusy(false); }
  }
  async function viewBatch(index: number) {
    if (!preview) return;
    setBusy(true); onBusy(true);
    try { const text = await api.aiPreviewBatch(preview.id, index); setBatchIndex(index); setBatchText(text); }
    catch (error) { onError(error); }
    finally { setBusy(false); onBusy(false); }
  }
  async function send() {
    if (!preview || !confirmation) return;
    setBusy(true); onBusy(true); setAnalysis(undefined); setConfirmation(false);
    try { setAnalysis(await api.sendAi(preview.id)); setAnswerIndex(0); }
    catch (error) { onError(error); }
    finally { setPreview(undefined); setBusy(false); onBusy(false); }
  }
  if (!settings?.enabled) return null;
  const inputsPresent = scope === 'selection' ? selection.trim() !== ''
    : feature === 'logs' ? Boolean(inputs[0].text || inputs[0].file) : inputs.every(input => input.text || input.file);
  return <section className="panel form ai-analysis"><h2>AI 模型解读</h2><fieldset disabled={busy}>
    <div className="toolbar"><label>分析范围<select value={scope} onChange={event => setScope(event.target.value as AnalysisScope | '')}>
      <option value="">选择分析范围</option><option value="selection">选中片段</option><option value="full">全文分析</option>
    </select></label><label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>记住选择</label>
    <label><input type="checkbox" checked={redact} onChange={event => setRedact(event.target.checked)}/>按字段名脱敏</label></div>
    {scope === 'selection' && <><div className="toolbar"><button onClick={() => {
      const text = window.getSelection()?.toString() || selectedText;
      if (text) setSelection(text);
    }}>使用已选文本</button></div><textarea aria-label="选中片段" placeholder="粘贴要交给模型的片段" value={selection} onChange={event => setSelection(event.target.value)}/></>}
    {redact && <div className="redaction">{fields.map((field, index) => <div className="toolbar" key={index}>
      <input aria-label={`字段名 ${index + 1}`} placeholder="字段名，如 IpAddress" value={field.name} onChange={event => setFields(current => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/>
      <input aria-label={`替换文本 ${index + 1}`} placeholder="自定义替换（可选）" value={field.replacement} onChange={event => setFields(current => current.map((item, i) => i === index ? { ...item, replacement: event.target.value } : item))}/>
      <button onClick={() => setFields(current => current.filter((_, i) => index !== i))}>移除</button></div>)}
      <button disabled={fields.length >= 32} onClick={() => setFields(current => [...current, { name: '', replacement: '' }])}>添加脱敏字段</button></div>}
    <button className="primary" disabled={!scope || !inputsPresent || (redact && !fields.some(field => field.name.trim()))} onClick={() => void prepare()}>本地预览</button>
    {preview && <div className="origin ai-preview"><strong>{preview.characters.toLocaleString('zh-CN')} 字符 · {preview.requests} 次模型请求</strong>
      <code>{preview.endpoint}</code><span>模型 {preview.model} · {preview.skill}</span>
      <details><summary>预设上下文</summary><small>用户身份标记 <code>{preview.context.userName}</code></small><pre>{preview.context.system}</pre></details>
      <small>{preview.batches === 1 ? '单次分析' : `${preview.batches} 批关联分析 + 1 次汇总，可回查已预览材料`}
        {preview.contextTokens === undefined ? ' · 兼容预算' : ` · 上下文预算 ${preview.contextTokens.toLocaleString('zh-CN')} Token`}</small>
      {preview.matches.map(field => <small key={field.name}>{field.name} · {field.count ? `替换 ${field.count} 处` : '未识别对应字段值'}</small>)}
      {preview.batches > 1 && <div className="toolbar"><button disabled={batchIndex === 0} onClick={() => void viewBatch(batchIndex - 1)}>上一批</button>
        <strong>第 {batchIndex + 1} / {preview.batches} 批</strong><button disabled={batchIndex + 1 === preview.batches} onClick={() => void viewBatch(batchIndex + 1)}>下一批</button></div>}
      <pre>{batchText}</pre>
      {preview.evidence && <details><summary>随材料发送的本地证据</summary><pre>{preview.evidence}</pre></details>}
      <label className="check"><input type="checkbox" checked={confirmation} onChange={event => setConfirmation(event.target.checked)}/>
        确认向上述接口发送预览材料{preview.evidence ? '和本地证据' : ''}，共 {preview.requests} 次请求
        {preview.batches > 1 ? '，包含批次摘要和最终汇总' : ''}</label>
      <div className="toolbar"><button className="primary" disabled={!confirmation || !settings.hasKey} onClick={() => void send()}>发送</button>
        {!settings.hasKey && <span>请先在设置中保存共享 API Key。</span>}</div></div>}
    </fieldset>{busy && <div className="progress" role="status"><span>{progress || '正在处理…'}</span><button onClick={() => void api.cancel().catch(onError)}>取消</button></div>}
    {analysis && <div className="origin ai-preview"><h3>AI 解读结果</h3><span>完成 {analysis.completed} / {analysis.total} 次请求</span>
      {analysis.notice && <p className="notice">{analysis.notice}</p>}
      {analysis.report && <AiReport report={analysis.report} citations={analysis.citations} notice={analysis.evidenceNotice}/>}
      {analysis.answers.length > 0 && <details open={!analysis.report || undefined}><summary>阶段摘要</summary>
        <div className="toolbar"><button disabled={answerIndex === 0} onClick={() => setAnswerIndex(answerIndex - 1)}>上一批</button>
          <strong>第 {analysis.answers[answerIndex].index} 批</strong><button disabled={answerIndex + 1 === analysis.answers.length}
            onClick={() => setAnswerIndex(answerIndex + 1)}>下一批</button></div>
        <pre>{analysis.answers[answerIndex].text}</pre></details>}</div>}
  </section>;
}

function BatchRuleChoice({ batches, busy, onApply }: {
  batches: RuleImportBatch[]; busy: boolean; onApply: (id: number, preference: RuleBatchPreference) => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [preference, setPreference] = useState<RuleBatchPreference | ''>('');
  const batch = batches.find(item => String(item.id) === selectedId) ?? (batches.length === 1 ? batches[0] : undefined);
  const count = batch && preference ? batch[preference] : 0;
  return <fieldset className="rule-batch" disabled={busy}>
    <h4>按导入批次选择</h4>
    <label>导入批次 <select value={batch?.id ?? ''} onChange={event => { setSelectedId(event.target.value); setPreference(''); }}>
      <option value="" disabled>选择导入批次</option>
      {batches.map(item => <option key={item.id} value={item.id}>{item.name} · {new Date(item.at).toLocaleString('zh-CN')} · {item.pending} 条</option>)}
    </select></label>
    <label>冲突释义 <select value={preference} disabled={!batch} onChange={event => setPreference(event.target.value as RuleBatchPreference | '')}>
      <option value="" disabled>选择生效版本</option>
      <option value="existing" disabled={!batch?.existing}>保留原有释义{batch ? `（${batch.existing} 条）` : ''}</option>
      <option value="incoming" disabled={!batch?.incoming}>使用本批导入释义{batch ? `（${batch.incoming} 条）` : ''}</option>
    </select></label>
    {batch && preference && count < batch.pending && <small>该批次另有 {batch.pending - count} 条需要逐条选择。</small>}
    <button className="primary" disabled={!count} onClick={() => {
      if (batch && preference && count) onApply(batch.id, preference);
    }}>{count ? `应用到该批次的 ${count} 条待选释义` : '应用批量选择'}</button>
  </fieldset>;
}

const emptyKnowledge: Knowledge = { rows: [], conflicts: [], batches: [] };

function Workspace() {
  const [screen, setScreen] = useState<Screen>('logs');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brand, setBrand] = useState<Brand>();
  const [inputs, setInputs] = useState<[Input, Input]>([blank, blank]);
  const [scopes, setScopes] = useState<[string, string]>(['', '']);
  const [selectedImport, setSelectedImport] = useState<{ file: Picked; format: 'html' | 'json' }>();
  const [knowledge, setKnowledge] = useState<Knowledge>(emptyKnowledge);
  const [filter, setFilter] = useState('');
  const [selectedRule, setSelectedRule] = useState<Rule>();
  const [selectedConflict, setSelectedConflict] = useState<RuleConflict>();
  const [candidateId, setCandidateId] = useState<number>();
  const [batchStatus, setBatchStatus] = useState('');
  const [report, setReport] = useState<Report>();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preparingAi, setPreparingAi] = useState(false);
  const [routePaging, setRoutePaging] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const onError = (value: unknown) => setError((value instanceof Error ? value.message : String(value)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
  useEffect(() => {
    void api.brands().then(values => { setBrands(values); setBrand(values.length === 1 ? values[0] : undefined); }).catch(onError);
    return api.onProgress(setProgress);
  }, []);
  useEffect(() => {
    let active = true;
    setSelectedRule(undefined);
    setSelectedConflict(undefined);
    setCandidateId(undefined);
    setKnowledge(emptyKnowledge);
    setBatchStatus('');
    if (screen === 'knowledge' && brand) void api.knowledge(brand).then(value => { if (active) setKnowledge(value); }).catch(onError);
    return () => { active = false; };
  }, [screen, brand, report?.feature === 'knowledge' ? report : null]);
  function navigate(next: Screen) {
    if (busy || preparingAi || routePaging || deploying || next === screen) return;
    if (screen === 'deployment') void api.deployment.reset().catch(onError);
    inputs.forEach(input => { if (input.file) void api.release(input.file.id); });
    if (selectedImport) void api.release(selectedImport.file.id);
    void api.clearResults().catch(onError);
    setSelectedText('');
    setScreen(next); setInputs([blank, blank]); setScopes(['', '']); setReport(undefined); setSelectedImport(undefined);
    setOffset(0); setError(''); setProgress(''); setFilter('');
  }
  function updateInput(index: 0 | 1, value: Input) { setInputs(current => index === 0 ? [value, current[1]] : [current[0], value]); }
  async function pickImport(format: 'html' | 'json') {
    try {
      const file = await (format === 'html' ? api.pickFolder() : api.pickFile());
      if (file) {
        if (selectedImport) await api.release(selectedImport.file.id);
        setSelectedImport({ file, format });
        setError('');
      }
    } catch (value) { onError(value); }
  }
  async function run() {
    let request: Request;
    if (screen === 'logs' && brand) request = { feature: 'logs', input: source(inputs[0]), brand };
    else if (screen === 'config') request = { feature: 'config', before: source(inputs[0]), after: source(inputs[1]), mode: 'exact' };
    else if (screen === 'routes') request = { feature: 'routes', before: source(inputs[0]), after: source(inputs[1]), beforeScope: scopes[0], afterScope: scopes[1] };
    else if (screen === 'knowledge' && selectedImport && brand) request = { feature: 'knowledge', directory: selectedImport.file.id, format: selectedImport.format, brand };
    else return;
    setBusy(true); setError(''); setReport(undefined); setOffset(0); setProgress('正在准备…');
    try { setReport(await api.run(request)); }
    catch (value) { onError(value); }
    finally { setBusy(false); setProgress(''); }
  }
  async function selectPage(next: number) {
    if (!report) return;
    try { const rows: ReportRow[] = await api.page(next); setReport({ ...report, rows }); setOffset(next); }
    catch (value) { onError(value); }
  }
  const isAnalysis = screen === 'logs' || screen === 'config' || screen === 'routes';
  const hasInput = (input: Input) => Boolean(input.file || input.text.length);
  const foundRules = knowledge.rows.filter(rule => `${rule.module}/${rule.severity}/${rule.event} ${rule.meaning}`.toLowerCase().includes(filter.toLowerCase()));
  const conflicts = knowledge.conflicts.filter(item => item.identifier.toLowerCase().includes(filter.toLowerCase()));
  const candidate = selectedConflict?.candidates.find(item => item.id === candidateId);
  async function activateCandidate() {
    if (!brand || !candidate || busy) return;
    setBusy(true);
    try {
      await api.chooseRule(brand, candidate.id);
      setKnowledge(await api.knowledge(brand));
      setSelectedConflict(undefined); setCandidateId(undefined); setSelectedRule(candidate.rule); setError('');
    } catch (value) { onError(value); }
    finally { setBusy(false); }
  }
  async function activateBatch(id: number, preference: RuleBatchPreference) {
    if (!brand || busy) return;
    setBusy(true); setError(''); setBatchStatus(''); setProgress('正在更新生效释义…');
    try {
      const count = await api.chooseRuleBatch(brand, id, preference);
      const updated = await api.knowledge(brand);
      setKnowledge(updated);
      setSelectedConflict(current => updated.conflicts.find(item => item.identifier === current?.identifier));
      setCandidateId(undefined);
      setBatchStatus(`已批量确定 ${count} 条释义。`);
    } catch (value) { onError(value); }
    finally { setBusy(false); setProgress(''); }
  }
  const brandSelect = <label>设备品牌 <select value={brand ?? ''} onChange={event => {
    setBrand(brands.find(value => value === event.target.value)); setReport(undefined); setOffset(0);
  }}><option value="">选择品牌</option>{brands.map(item => <option key={item} value={item}>{brandNames[item]}</option>)}</select></label>;
  return <div className="app"><aside><div className="brand"><span>NT</span><strong>gen-NetTools</strong></div><nav aria-label="功能">
    {(Object.keys(names) as Screen[]).map((key, index) => <button key={key} disabled={busy || preparingAi || routePaging || deploying} className={screen === key ? 'active' : ''}
      aria-current={screen === key ? 'page' : undefined} onClick={() => navigate(key)}><span aria-hidden="true">{['☷', '⇄', '⇶', '▤', '⇥', '◷', '⚙'][index]}</span>{names[key]}</button>)}</nav>
    <span className="rail-footer">Windows · x64</span></aside>
    <main><div className="hero"><div><h1>{names[screen]}</h1><p>{({ logs: '按华为官方文档解释事件、字段与可能原因。', config: '按原文比较，保留空白、大小写、注释、换行和顺序差异。',
      routes: '比较华为 IPv4 / IPv6 普通路由快照，支持 VRF 与多下一跳。', knowledge: '检索华为日志规则，导入官方 HTML 目录或 UTF-8 JSON 更新包。',
      deployment: '通过 SSH 测试华为设备，按脚本顺序下发命令并保存回显。', history: '每个功能保留最近三次成功结果。', settings: '管理共享的模型接口设置。' })[screen]}</p></div>
      {isAnalysis && <span className="badge">本地处理</span>}</div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {screen === 'history' && <History onError={onError}/>}{screen === 'settings' && <Preferences onError={onError}/>}
    {screen === 'deployment' && <DeploymentPage api={api.deployment} onBusy={setDeploying}/>}
    {isAnalysis && <section className="panel"><fieldset disabled={busy || preparingAi || routePaging}>
      {screen === 'logs' && <div className="toolbar">{brandSelect}</div>}
      <div className={screen === 'logs' ? '' : 'two-columns'}><TextInput title={screen === 'logs' ? '日志输入' : '变更前'} input={inputs[0]} setInput={value => updateInput(0, value)} onError={onError} onSelectText={setSelectedText}/>
        {screen !== 'logs' && <TextInput title="变更后" input={inputs[1]} setInput={value => updateInput(1, value)} onError={onError} onSelectText={setSelectedText}/>}</div>
      {screen === 'routes' && <>
        <div className="two-columns scope">{(['变更前 VRF（可选）', '变更后 VRF（可选）'] as const).map((label, index) => <label key={label}>{label}<input placeholder="留空默认 Public" value={scopes[index]}
          aria-describedby="route-scope-help" onChange={event => setScopes(index === 0 ? [event.target.value, scopes[1]] : [scopes[0], event.target.value])}/></label>)}</div>
        <small id="route-scope-help">两侧留空时比较快照中的全部路由表，未标明 VRF 的条目归入 Public。</small>
      </>}
      <div className="toolbar action"><button className="primary" onClick={() => void run()} disabled={!hasInput(inputs[0]) || (screen === 'logs' ? !brand : !hasInput(inputs[1]))}>{screen === 'logs' ? '开始分析' : '开始比对'}</button></div>
    </fieldset></section>}
    {screen === 'knowledge' && <><section className="panel"><fieldset disabled={busy}><div className="toolbar">{brandSelect}<button onClick={() => void pickImport('html')}>选择 HTML 目录</button>
      <button onClick={() => void pickImport('json')}>选择 JSON 更新包</button></div>
      {selectedImport && <div className="toolbar import"><code>{selectedImport.file.name}</code>
        <button className="primary" disabled={!brand} onClick={() => void run()}>导入</button></div>}</fieldset></section>
      <section className="panel result-split"><div className="result-list"><h3>生效规则 <span className="dim">{knowledge.rows.length}</span></h3>
        <input type="search" placeholder="搜索模块、事件或含义" value={filter} onChange={event => setFilter(event.target.value)}/>
        {!!knowledge.conflicts.length && <h3>待选释义 <span className="dim">{knowledge.conflicts.length}</span></h3>}
        <div className="rule-list">{conflicts.map(item => <button key={item.identifier} onClick={() => {
          setSelectedConflict(item); setSelectedRule(undefined); setCandidateId(undefined);
        }}><code>{item.identifier}</code> · {item.candidates.length} 条候选</button>)}
        {foundRules.slice(0, 100).map(rule => <button key={`${rule.module}/${rule.severity}/${rule.event}`} onClick={() => {
          setSelectedRule(rule); setSelectedConflict(undefined); setCandidateId(undefined);
        }}><code>{rule.module}/{rule.severity}/{rule.event}</code></button>)}</div>
        {foundRules.length > 100 && <p className="dim">显示前 100 项，可搜索缩小范围。</p>}
        {!!knowledge.batches.length && <BatchRuleChoice batches={knowledge.batches} busy={busy} onApply={(id, preference) => void activateBatch(id, preference)}/>}
        {knowledge.conflicts.length > knowledge.batches.reduce((total, batch) => total + batch.pending, 0) &&
          <p className="rule-batch-note dim">旧版导入的冲突可逐条选择，也可重新导入对应资料以关联批次。</p>}
        {batchStatus && <p className="rule-batch-note" role="status">{batchStatus}</p>}
        </div><div className="detail">
        {selectedConflict ? <><h3>{selectedConflict.identifier} · 选择生效释义</h3>
          <fieldset disabled={busy} className="rule-options">{selectedConflict.candidates.map(item => <label key={item.id}>
            <input type="radio" name="rule-choice" checked={candidateId === item.id} onChange={() => setCandidateId(item.id)}/>
            <span>{item.rule.meaning}<small><RuleSources rule={item.rule}/></small></span></label>)}
            {candidate && <RuleDetail rule={candidate.rule} showTemplate/>}
            <button className="primary" disabled={!candidate} onClick={() => void activateCandidate()}>采用所选释义</button>
          </fieldset></> : selectedRule ? <RuleDetail rule={selectedRule}/> : <p className="dim">选择条目查看解释。</p>}
      </div></section></>}
    {busy && <div className="progress" role="status"><span>{progress}</span><button onClick={() => void api.cancel().catch(onError)}>取消</button></div>}
    {report && (report.routes ? <RouteResults report={report} details={report.routes} blocked={busy || preparingAi} onPaging={setRoutePaging} onError={onError} /> :
      <Results report={report} offset={offset} selectPage={next => void selectPage(next)} />)}
    {isAnalysis && <fieldset disabled={busy || routePaging}><AiPreparation key={screen} feature={screen} brand={brand} inputs={inputs} selectedText={selectedText} progress={progress}
      onError={onError} onBusy={value => { setProgress(''); setPreparingAi(value); }}/></fieldset>}
    </main></div>;
}

createRoot(document.getElementById('root')!).render(<Workspace/>);
