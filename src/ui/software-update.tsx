import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopApi, UpdateChannel, UpdateConfiguration, UpdateStatus } from '../shared/contracts';

declare global { interface Window { nettools: DesktopApi } }

const api = window.nettools;
const stateNames: Record<UpdateStatus['state'], string> = {
  'configuration-required': '需要配置在线更新', idle: '等待检查', checking: '正在检查更新', current: '已是最新版本',
  available: '发现可用更新', downloading: '正在下载', paused: '下载已暂停', ready: '更新已下载',
  installing: '正在安装', error: '更新失败',
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '更新操作失败。';
}

function UpdateProgress({ progress }: { progress?: number }) {
  const bar = useRef<HTMLSpanElement>(null);
  const lastProgress = useRef(0);
  useLayoutEffect(() => {
    const value = progress ?? 0;
    const delta = value - lastProgress.current;
    const duration = delta > 0 ? Math.max(500, Math.min(3000, Math.round(delta * 5000))) : 0;
    bar.current?.style.setProperty('--update-progress', `${value}%`);
    bar.current?.style.setProperty('--update-progress-duration', `${duration}ms`);
    lastProgress.current = value;
  }, [progress]);
  return <div className={`update-progress-track${progress === undefined ? ' indeterminate' : progress > 50 ? ' majority' : ''}`}
    role="progressbar" aria-label="更新下载进度" aria-valuenow={progress === undefined ? undefined : Math.floor(progress)}>
    <span ref={bar} />
  </div>;
}

export function SoftwareUpdate({ onError }: { onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [message, setMessage] = useState('');
  const edited = useRef(false);
  const onErrorRef = useRef(onError);

  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let eventsSeen = 0;
    let active = true;
    const unsubscribe = api.onUpdateStatus(value => {
      eventsSeen++;
      setStatus(value);
      if (value.state !== 'downloading') setPausing(false);
      if (!edited.current) {
        setChannel(value.channel);
      }
      if (value.message) setMessage(value.message);
    });
    void api.updateStatus().then(value => {
      if (!active) return;
      if (eventsSeen === 0) {
        setStatus(value);
        if (!edited.current) setChannel(value.channel);
        if (value.message) setMessage(value.message);
      }
    }).catch(error => { if (active) { setMessage(errorMessage(error)); onErrorRef.current(error); } });
    return () => { active = false; unsubscribe(); };
  }, []);

  if (!status) return <section className="panel form software-update" aria-label="软件更新"><h2>软件更新</h2><p className="dim">正在读取更新状态…</p></section>;

  const busyState = ['checking', 'downloading', 'installing'].includes(status.state);
  const locked = busy || busyState;
  const checking = status.state === 'checking';
  const ready = status.state === 'ready';
  const canCheck = !locked && status.state !== 'configuration-required';
  const canSave = !locked && edited.current;
  const downloaded = Math.max(0, status.downloaded ?? 0);
  const size = status.size;
  const progress = size && size > 0 ? Math.min(100, downloaded * 100 / size) : undefined;

  function markEdited() {
    edited.current = true;
    setMessage('');
    setStatus(current => current ? { ...current, message: undefined } : current);
  }

  async function configure(): Promise<UpdateStatus> {
    const configuration: UpdateConfiguration = { channel, source: 'online' };
    const next = await api.configureUpdate(configuration);
    setStatus(next);
    setChannel(next.channel);
    edited.current = false;
    if (next.message) setMessage(next.message);
    return next;
  }

  async function perform(action: () => Promise<UpdateStatus>) {
    setBusy(true);
    setMessage('');
    try {
      const next = await action();
      setStatus(next);
      if (next.message) setMessage(next.message);
    } catch (error) {
      setMessage(errorMessage(error));
      onErrorRef.current(error);
    } finally { setBusy(false); }
  }

  async function saveSettings() {
    await perform(configure);
  }

  async function check() {
    await perform(async () => {
      await configure();
      return api.checkUpdate();
    });
  }

  async function pause() {
    setPausing(true);
    setMessage('');
    try {
      // The download action owns busy until abort handling completes. Its IPC response
      // may still carry the old downloading state, so the status event is authoritative.
      await api.pauseUpdate();
    } catch (error) {
      setPausing(false);
      setMessage(errorMessage(error));
      onErrorRef.current(error);
    }
  }

  const stateMessage = status.message || message;
  const progressText = size ? `${formatBytes(downloaded)} / ${formatBytes(size)}` : formatBytes(downloaded);

  return <section className="panel form software-update" aria-label="软件更新">
    <div className="software-update-heading"><div><h2>软件更新</h2><p className="dim">检查并安装 gen-NetTools 更新</p></div>
      <span className={`update-state update-state-${status.state}`} role="status">{stateNames[status.state]}</span></div>

    <div className="update-current"><span>当前版本</span><strong>{status.version}</strong>
      <span className="update-divider" aria-hidden="true" />
      <span>当前通道</span><strong>{status.channel === 'beta' ? 'Beta 测试版' : '正式版'}</strong></div>

    <fieldset className="update-options" disabled={locked}>
      <label className="check update-beta"><input type="checkbox" checked={channel === 'beta'} onChange={event => {
        markEdited(); setChannel(event.target.checked ? 'beta' : 'stable');
      }}/>接收 Beta 测试更新</label>
      <div className="update-source-label"><span>更新来源</span><strong>在线更新服务</strong><small>应用启动时自动检查，也可手动触发。</small></div>
      <div className="update-actions">
        <button type="button" disabled={!canSave} onClick={() => void saveSettings()}>保存更新设置</button>
        <button className="primary" type="button" disabled={!canCheck} onClick={() => void check()}>
          {checking ? '正在检查…' : '检查更新'}
        </button>
        {checking && <span className="update-check-spinner" aria-hidden="true">
          <svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.4" pathLength="100" /></svg>
        </span>}
      </div>
    </fieldset>

    {status.latestVersion && <div key={ready ? 'ready' : 'release'} className={`update-release${ready ? ' update-release-ready' : ''}`}>
      <div className="update-release-heading">
        {ready && <span className="update-ready-orbit" aria-hidden="true"><span /></span>}
        <h3>{ready ? `版本 ${status.latestVersion} 已验证` : `版本 ${status.latestVersion}`}</h3>
        {status.mandatory && <span className="update-required">必需更新</span>}</div>
      {status.notes && <p className="update-notes">{status.notes}</p>}
    </div>}

    {(['downloading', 'paused'].includes(status.state) || (status.state === 'error' && Boolean(status.latestVersion))) && <div className="update-progress-block">
      <div className="update-progress-label"><strong>{status.state === 'paused' ? '下载已暂停' : status.state === 'error' ? '下载中断' : '正在下载更新'}</strong>
        <span>{progressText}{progress !== undefined ? ` · ${Math.floor(progress)}%` : ''}</span></div>
      <UpdateProgress progress={progress} />
    </div>}

    {stateMessage && <p className={`notice ${status.state === 'error' ? 'error' : ''}`} role={status.state === 'error' ? 'alert' : 'status'}>{stateMessage}</p>}

    {(status.state === 'available' || status.state === 'downloading' || status.state === 'paused' || status.state === 'ready' || status.state === 'installing' || (status.state === 'error' && Boolean(status.latestVersion))) &&
      <div className="update-actions update-task-actions">
        {status.state === 'available' && <button className="primary" type="button" disabled={busy} onClick={() => void perform(() => api.downloadUpdate())}>下载更新</button>}
        {status.state === 'downloading' && <button type="button" disabled={pausing} onClick={() => void pause()}>{pausing ? '正在暂停…' : '暂停下载'}</button>}
        {status.state === 'paused' && <button className="primary" type="button" disabled={busy} onClick={() => void perform(() => api.downloadUpdate())}>继续下载</button>}
        {status.state === 'error' && status.latestVersion && <button className="primary" type="button" disabled={busy} onClick={() => void perform(() => api.downloadUpdate())}>继续下载</button>}
        {status.state === 'ready' && <button className="primary" type="button" disabled={busy} onClick={() => void perform(() => api.installUpdate())}>安装更新</button>}
        {status.state === 'installing' && <span className="dim">安装程序即将启动…</span>}
      </div>}
  </section>;
}
