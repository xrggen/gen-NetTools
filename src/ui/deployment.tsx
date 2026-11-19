import { useEffect, useState } from 'react';
import type { DeploymentApi, DeploymentRecord, DeploymentScript, DeviceInfo, DeviceProgress, DeviceTest, TemplateKind } from '../shared/deployment';

const testLabels: Record<DeviceTest['state'], string> = {
  pending: '待测试', testing: '正在连接', passed: '通过', failed: '未通过', 'trust-required': '待核验指纹', cancelled: '已取消',
};
const runLabels: Record<DeviceProgress['state'], string> = {
  queued: '等待', connecting: '连接中', running: '下发中', completed: '完成', failed: '失败', cancelled: '已取消', skipped: '已跳过',
};

export function DeploymentPage({ api, onBusy }: { api: DeploymentApi; onBusy(value: boolean): void }) {
  const [deviceFile, setDeviceFile] = useState('');
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [common, setCommon] = useState<DeploymentScript>();
  const [overrides, setOverrides] = useState<Record<string, DeploymentScript>>({});
  const [different, setDifferent] = useState(false);
  const [interval, setInterval] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [autoYes, setAutoYes] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'file' | 'test' | 'run'>();
  const [tests, setTests] = useState<Record<string, DeviceTest>>({});
  const [statuses, setStatuses] = useState<Record<string, DeviceProgress>>({});
  const [round, setRound] = useState<DeploymentRecord>();
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [expanded, setExpanded] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [alias, setAlias] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const showError = (error: unknown) => setMessage(
    (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''),
  );

  useEffect(() => {
    let active = true;
    void api.history().then(items => { if (active) setHistory(items); }).catch(error => { if (active) showError(error); });
    const stop = api.onEvent(event => {
      if (event.type === 'test') setTests(items => ({ ...items, [event.result.id]: event.result }));
      if (event.type === 'progress') setStatuses(items => ({ ...items, [event.update.id]: event.update }));
      if (event.type === 'round') {
        setRound(event.record);
        setStatuses(Object.fromEntries(event.record.devices.map(item => [item.id, item])));
      }
    });
    return () => { active = false; stop(); };
  }, [api]);

  const count = Number(concurrency);
  const gap = Number(interval);
  const validCount = concurrency.trim() !== '' && Number.isSafeInteger(count) && count > 0;
  const validInterval = interval.trim() !== '' && Number.isSafeInteger(gap) && gap >= 0 && gap <= 2_147_483_647;
  const aliases = Array.from(new Set(devices.flatMap(device => device.keyAlias ? [device.keyAlias] : [])));
  const effective = (id: string) => (different ? overrides[id] : undefined) ?? common;
  const passed = devices.filter(device => tests[device.id]?.state === 'passed');
  const canRun = validCount && validInterval && passed.length > 0 && passed.every(device => effective(device.id));

  async function perform(mode: NonNullable<typeof busy>, operation: () => Promise<unknown>) {
    setBusy(mode); onBusy(true); setMessage(''); setConfirm(false);
    try { await operation(); }
    catch (error) { showError(error); }
    finally { setBusy(undefined); onBusy(false); }
  }
  function importDevices() {
    void perform('file', async () => {
      const list = await api.importDevices();
      if (!list) return;
      await Promise.all(Object.values(overrides).map(script => api.releaseScript(script.id)));
      setDeviceFile(list.name); setDevices(list.devices); setTests({}); setStatuses({}); setOverrides({});
      setAlias(''); setPassphrase('');
    });
  }
  function importScript(device?: string) {
    void perform('file', async () => {
      const script = await api.importScript();
      if (!script) return;
      const prior = device ? overrides[device] : common;
      if (prior) await api.releaseScript(prior.id);
      if (device) setOverrides(items => ({ ...items, [device]: script }));
      else setCommon(script);
    });
  }
  function removeOverride(id: string) {
    void perform('file', async () => {
      await api.releaseScript(overrides[id].id);
      setOverrides(items => { const next = { ...items }; delete next[id]; return next; });
    });
  }
  function chooseKey() {
    void perform('file', async () => {
      try {
        if (!await api.addKey(alias, passphrase)) return;
        setKeys(items => [...new Set([...items, alias])]);
        setTests(items => {
          const next = { ...items };
          for (const item of devices) if (item.keyAlias === alias) delete next[item.id];
          return next;
        });
      } finally { setPassphrase(''); }
    });
  }
  function test() {
    void perform('test', async () => {
      setTests({});
      setTests(Object.fromEntries((await api.test(count)).map(result => [result.id, result])));
    });
  }
  function trust(id: string, fingerprint: string) {
    void perform('file', async () => {
      await api.trust(id, fingerprint);
      setTests(items => ({ ...items, [id]: { id, state: 'pending', detail: '已核验，请重新测试连接和认证。' } }));
    });
  }
  function run() {
    if (!canRun || !confirm) return;
    const plan = {
      common: common?.id ?? '', intervalMs: gap, concurrency: count, autoYes,
      overrides: different ? Object.fromEntries(Object.entries(overrides).map(([id, script]) => [id, script.id])) : {},
    };
    setAutoYes(false);
    void perform('run', async () => {
      setStatuses({});
      try { setRound(await api.run(plan)); }
      finally {
        setTests({}); setKeys([]);
        const records = await api.history().catch(showError);
        if (records) setHistory(records);
      }
    });
  }
  const download = (kind: TemplateKind) => void perform('file', () => api.download(kind));
  const reveal = (id: string) => void api.reveal(id).catch(showError);

  return <div className="deployment">
    {message && <p className="notice error" role="alert">{message}</p>}
    <div className="two-columns deployment-inputs">
      <section className="panel"><fieldset disabled={Boolean(busy)}>
        <h2>设备与认证</h2>
        <p className="dim">CSV、TXT、XLS 或 XLSX。第一行填写 <code>host,username,token</code>。</p>
        <div className="toolbar"><button onClick={importDevices}>导入设备清单</button><button onClick={() => download('devices')}>下载设备模板</button></div>
        {deviceFile && <p><code>{deviceFile}</code> · {devices.length} 台</p>}
        <small>host 支持 IP 或主机名，可指定 SSH 端口。token 填密码或 <code>key:别名</code>。Excel 凭证列请使用文本格式。</small>
        {!!aliases.length && <div className="deployment-keys">
          <label>私钥别名<select value={alias} onChange={event => { setAlias(event.target.value); setPassphrase(''); }}>
            <option value="">选择清单中的别名</option>
            {aliases.map(value => <option key={value} value={value}>{value}{keys.includes(value) ? ' · 已加载' : ''}</option>)}
          </select></label>
          <label>私钥口令<input type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)}/></label>
          <button disabled={!alias} onClick={chooseKey}>选择私钥文件</button>
        </div>}
      </fieldset></section>
      <section className="panel"><fieldset disabled={Boolean(busy)}>
        <h2>命令脚本</h2>
        <p className="dim">TXT、LOG 每行一条命令。CSV、XLS、XLSX 使用 <code>command</code> 表头，Excel 读取首个工作表。</p>
        <div className="toolbar"><button onClick={() => importScript()}>导入公共脚本</button><button onClick={() => download('commands')}>下载脚本模板</button></div>
        {common && <p><code>{common.name}</code> · {common.count} 条</p>}
        <label className="deployment-check"><input type="checkbox" checked={different} onChange={event => { setDifferent(event.target.checked); setConfirm(false); }}/>
          差异化脚本下发</label>
        {different && <small>在下表为设备单独上传脚本，其余设备使用公共脚本。</small>}
      </fieldset></section>
    </div>
    <section className="panel">
      <fieldset disabled={Boolean(busy)}>
        <h2>测试与下发</h2>
        <div className="toolbar deployment-options">
          <label>并发会话数<input type="number" min={1} step={1} value={concurrency} onChange={event => { setConcurrency(event.target.value); setConfirm(false); }}/></label>
          <label>命令最小间隔（ms）<input type="number" min={0} max={2_147_483_647} step={1} value={interval} onChange={event => { setInterval(event.target.value); setConfirm(false); }}/></label>
          <label className="deployment-risk"><input type="checkbox" checked={autoYes} onChange={event => { setAutoYes(event.target.checked); setConfirm(false); }}/>Y/N 自动允许（高风险）</label>
        </div>
        <small>每条命令等待华为 CLI 提示符返回，遇到分页自动翻页。自动允许会向明确的 Y/N 提示回复 Y，每轮独立开启。</small>
        <div className="toolbar action">
          <button disabled={!devices.length || !validCount} onClick={test}>测试连接和认证</button>
          <button className="primary" disabled={!canRun} onClick={() => setConfirm(true)}>准备下发</button>
          {!!devices.length && <span className="dim">{passed.length} / {devices.length} 台设备通过本轮测试</span>}
        </div>
        {confirm && <div className={'notice' + (autoYes ? ' error' : '')}>
          <p>将向已通过测试的 {passed.length} 台设备下发，最多同时连接 {Math.min(count, passed.length)} 台，命令最小间隔 {gap} ms。
            {autoYes ? ' 本轮启用高风险自动回复 Y。' : ' 遇到 Y/N 提示会停止对应设备。'}</p>
          <div className="toolbar"><button className="primary" onClick={run}>确认下发</button><button onClick={() => setConfirm(false)}>返回</button></div>
        </div>}
      </fieldset>
      {(busy === 'test' || busy === 'run') && <div className="progress" role="status">
        <span>{busy === 'test' ? '正在测试连接和认证' : '正在执行本轮下发'}</span>
        <button onClick={() => void api.cancel().catch(showError)}>取消本轮</button>
      </div>}
      {!!devices.length && <div className="deployment-table"><table><thead><tr>
        <th>设备</th><th>连接测试</th><th>下发脚本</th><th>下发状态</th>
      </tr></thead><tbody>{devices.map(device => {
        const result = tests[device.id];
        const current = statuses[device.id];
        const selected = effective(device.id);
        return <tr key={device.id}>
          <td><code>{device.label}</code><small>{device.username}</small></td>
          <td><span className={'deployment-test ' + (result?.state ?? 'pending')}>{testLabels[result?.state ?? 'pending']}</span>
            {result?.detail && <small>{result.detail}</small>}
            {result?.fingerprint && <><code className="deployment-fingerprint">{result.fingerprint}</code>
              <button disabled={Boolean(busy)} onClick={() => trust(device.id, result.fingerprint!)}>指纹已核验</button></>}
          </td>
          <td>{selected ? <><code>{selected.name}</code><small>{selected.count} 条命令</small></> : <span className="dim">待上传</span>}
            {different && <div className="deployment-device-actions"><button disabled={Boolean(busy)} onClick={() => importScript(device.id)}>上传设备脚本</button>
              {overrides[device.id] && <button disabled={Boolean(busy)} onClick={() => removeOverride(device.id)}>改用公共脚本</button>}</div>}</td>
          <td>{current ? <DeviceStatus item={current}/> : <span className="dim">待下发</span>}</td>
        </tr>;
      })}</tbody></table></div>}
    </section>
    <section className="panel">
      <h2>设备回显记录</h2>
      {round && !history.some(item => item.id === round.id) && <p>当前轮目录 <code>{round.path}</code></p>}
      {!history.length && <p className="dim">完成一轮下发后可在此查看回显，最多保留三轮。</p>}
      {history.map(item => <article key={item.id} className="history-entry">
        <div className="toolbar">
          <strong>{new Date(item.startedAt).toLocaleString('zh-CN')}</strong>
          <span className="dim">{item.devices.length} 台设备 · {item.devices.filter(device => device.state === 'completed').length} 台下发完成</span>
          <button onClick={() => reveal(item.id)}>在文件管理器中显示</button>
          <button aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? '' : item.id)}>
            {expanded === item.id ? '收起设备状态' : '查看设备状态'}</button>
        </div>
        <code>{item.path}</code>
        {expanded === item.id && <div className="deployment-table"><table><thead><tr><th>设备</th><th>回显文件</th><th>下发状态</th></tr></thead>
          <tbody>{item.devices.map((device, index) => <tr key={device.id}>
            <td><code>{device.label}</code></td><td><code>{'device-' + String(index + 1).padStart(3, '0') + '.log'}</code></td>
            <td><DeviceStatus item={device}/></td>
          </tr>)}</tbody></table></div>}
      </article>)}
    </section>
  </div>;
}

function DeviceStatus({ item }: { item: DeviceProgress }) {
  return <><span className={'deployment-test ' + item.state}>{runLabels[item.state]} · {item.completed}/{item.total}</span>
    {item.line !== undefined && <small>脚本第 {item.line} 行</small>}
    {item.error && <small>{item.error}</small>}</>;
}
