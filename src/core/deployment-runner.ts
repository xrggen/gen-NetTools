import { setTimeout as wait } from 'node:timers/promises';
import type { CommandLine, DeviceProgress } from '../shared/deployment';

export type { CommandLine, DeviceProgress } from '../shared/deployment';
export type DeviceJob<T> = { id: string; label: string; target: T; commands: CommandLine[] };

type DeploymentSession = {
  send(command: CommandLine, signal: AbortSignal): Promise<void>;
  close(): Promise<void> | void;
};

type DeploymentOptions<T> = {
  jobs: DeviceJob<T>[];
  intervalMs: number;
  concurrency: number;
  signal: AbortSignal;
  connect(job: DeviceJob<T>, signal: AbortSignal): Promise<DeploymentSession>;
  onProgress(update: DeviceProgress): void;
};

export async function deployRound<T>(options: DeploymentOptions<T>): Promise<DeviceProgress[]> {
  const { jobs, concurrency, intervalMs, signal } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new Error('命令间隔必须为有效的非负毫秒数。');
  }
  if (!jobs.length || jobs.some(job => !job.commands.length) || new Set(jobs.map(job => job.id)).size !== jobs.length) {
    throw new Error('请为设备提供至少一条命令，并确保设备编号唯一。');
  }

  const states: DeviceProgress[] = jobs.map(job => ({
    id: job.id, label: job.label, state: 'queued', total: job.commands.length, completed: 0,
  }));
  let cursor = 0;
  function update(index: number, patch: Partial<DeviceProgress>) {
    const next = { ...states[index], ...patch };
    states[index] = next;
    options.onProgress(next);
  }

  async function runDevice(index: number) {
    const job = jobs[index];
    let session: DeploymentSession | undefined;
    try {
      signal.throwIfAborted();
      update(index, { state: 'connecting' });
      session = await options.connect(job, signal);
      let lastSentAt: number | undefined;
      for (const command of job.commands) {
        signal.throwIfAborted();
        if (lastSentAt !== undefined) {
          const remaining = Math.ceil(lastSentAt + intervalMs - performance.now());
          if (remaining > 0) await wait(remaining, undefined, { signal });
        }
        signal.throwIfAborted();
        update(index, { state: 'running', line: command.line });
        lastSentAt = performance.now();
        await session.send(command, signal);
        update(index, { completed: states[index].completed + 1 });
      }
      update(index, { state: 'completed', line: undefined });
    } catch (error) {
      update(index, signal.aborted ? { state: 'cancelled' } : {
        state: 'failed', error: error instanceof Error ? error.message : '下发失败。',
      });
    } finally {
      if (session) {
        try { await session.close(); } catch { /* Final device status is already available. */ }
      }
    }
  }

  async function takeJobs() {
    while (!signal.aborted && cursor < jobs.length) await runDevice(cursor++);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, takeJobs));
  for (; cursor < jobs.length; cursor++) update(cursor, { state: 'cancelled' });
  return states;
}
