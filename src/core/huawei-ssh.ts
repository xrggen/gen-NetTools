import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig, type ParsedKey, type PublicKeyAuthMethod } from 'ssh2';
import type { CommandLine } from '../shared/deployment';

export type SshTarget = Pick<ConnectConfig, 'host' | 'port' | 'password'> & { username: string; privateKey?: ParsedKey };
export type ShellOptions = {
  signal: AbortSignal;
  fingerprint?: string;
  autoYes?: boolean;
  output?(chunk: Buffer): Promise<void>;
};

const prompt = /(?:^|\n)[ \t]*(?:<([^<>\[\]\s]{1,128})>|\[[~*]?([^<>\[\]\s]{1,128})\])[ \t]*$/;
const more = /(?:-+\s*More\s*-+|Press\s+['"]?SPACE['"]?\s+to continue)[ \t]*$/i;
const choice = /(?:[\[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]\s*[:?]|[?？][ \t]*[\[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]|(?:^|[\s:])y(?:es)?\s*\/\s*n(?:o)?\s*[:?])[ \t]*$/i;
const cliError = /(?:^|\n)[ \t]*(?:Error\s*:|%\s*(?:Unrecognized command|Incomplete command|Ambiguous command|Wrong parameter|Too many parameters)|(?:Unrecognized command|Incomplete command|Ambiguous command|Wrong parameter)\s+(?:found|at)\b)/i;
const terminalLimit = 8192;

export class HostTrustError extends Error {
  constructor(readonly fingerprint: string, readonly changed: boolean) {
    super(changed ? 'SSH 主机指纹与已核验的指纹不同。' : '首次连接，请核验 SSH 主机指纹后重新测试。');
  }
}

export async function openHuaweiShell(target: SshTarget, options: ShellOptions) {
  const { signal, output } = options;
  signal.throwIfAborted();
  const client = new Client();
  const decoder = new StringDecoder('utf8');
  let channel: ClientChannel | undefined;
  let observed = '';
  let error: Error | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { done(): void; fail(error: Error): void } | undefined;
  let tail = '';
  let sawError = false;
  const handledChoices = new Set<string>();
  let outputReady: Promise<void> = Promise.resolve();
  let authenticated = false;
  let promptName: string | undefined;
  let requestedName: string | undefined;
  let runningCommand = false;

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    channel?.destroy();
    client.destroy();
  }
  function stop(reason: Error) {
    if (error || closed) return;
    error = reason;
    active?.fail(reason);
    close();
  }
  function abort() { stop(new Error('用户取消。')); }
  function awaitOutput() {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new Error(runningCommand ? '等待命令回到 CLI 提示符超时。' : '等待华为 CLI 提示符超时。')), 45_000);
  }
  function untilPrompt(send?: string) {
    if (error) return Promise.reject(error);
    signal.throwIfAborted();
    tail = '';
    sawError = false;
    handledChoices.clear();
    runningCommand = send !== undefined;
    requestedName = send?.trim().match(/^sysname\s+(\S+)$/i)?.[1];
    return new Promise<void>((resolve, reject) => {
      active = {
        done() { clearTimeout(timer); active = undefined; resolve(); },
        fail(reason) { clearTimeout(timer); active = undefined; reject(reason); },
      };
      awaitOutput();
      if (send !== undefined) channel!.write(send + '\r');
    });
  }
  function processOutput(bytes: Buffer) {
    if (!active || closed) return;
    awaitOutput();
    tail = (tail + decoder.write(bytes)).slice(-terminalLimit);
    const clean = stripVTControlCharacters(tail).replace(/[\r\x00\x08]/g, '');
    if (cliError.test(clean)) sawError = true;
    if (more.test(clean)) {
      tail = '';
      channel!.write(' ');
    } else if (!clean.endsWith('\n') && choice.test(clean)) {
      const question = clean.slice(clean.lastIndexOf('\n') + 1).trim();
      if (!runningCommand || !options.autoYes || handledChoices.has(question)) stop(new Error('遇到 Y/N 提示，已停止该设备。'));
      else {
        handledChoices.add(question);
        tail = '';
        channel!.write('Y\r');
      }
    } else if (!clean.endsWith('\n')) {
      const match = prompt.exec(clean);
      const name = match?.[1] ?? match?.[2];
      if (name && (!promptName || name === promptName || name.startsWith(promptName + '-') || name === requestedName)) {
        if (sawError) stop(new Error('设备返回 CLI 命令错误，已停止该设备。'));
        else {
          if (!promptName || name === requestedName) promptName = name;
          active.done();
        }
      }
    }
  }
  function data(bytes: Buffer) {
    if (!output) { processOutput(bytes); return; }
    channel?.pause();
    outputReady = outputReady.then(() => output(bytes)).then(() => {
      processOutput(bytes);
      if (!closed) channel?.resume();
    }).catch(() => { stop(new Error('无法写入该设备的本地回显。')); });
  }
  const ready = new Promise<void>((resolve, reject) => {
    active = { done: resolve, fail: reject };
    signal.addEventListener('abort', abort, { once: true });
    client.on('error', (failure: Error & { level?: string }) => {
      if (observed && observed !== options.fingerprint) stop(new HostTrustError(observed, Boolean(options.fingerprint)));
      else if (failure.level === 'client-authentication') stop(new Error('SSH 认证失败，请检查用户名和凭证。'));
      else stop(new Error(authenticated ? 'SSH 会话已断开。' : '无法连接 SSH，请检查设备地址、端口和连通性。'));
    });
    client.on('close', () => stop(observed && observed !== options.fingerprint
      ? new HostTrustError(observed, Boolean(options.fingerprint)) : new Error('SSH 会话已关闭。')));
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      const challenge = prompts[0];
      if (target.password && prompts.length === 1 && !challenge.echo && /^\s*password\s*:\s*$/i.test(challenge.prompt)) {
        finish([target.password]);
      } else finish([]);
    });
    client.once('ready', () => {
      authenticated = true;
      timer = setTimeout(() => stop(new Error('等待 SSH CLI 通道超时。')), 15_000);
      client.shell({ term: 'vt100', cols: 160, rows: 24 }, (failure, stream) => {
        if (closed) { stream?.destroy(); return; }
        clearTimeout(timer);
        if (failure) { stop(new Error('SSH 已认证，无法打开华为 CLI。')); return; }
        channel = stream;
        channel.on('error', () => stop(new Error('SSH CLI 通道已断开。')));
        channel.on('close', () => stop(new Error('SSH CLI 通道已关闭。')));
        const initial = untilPrompt();
        channel.on('data', data);
        channel.stderr.on('data', data);
        void initial.then(resolve, reject);
      });
    });
    try {
      const { privateKey, ...login } = target;
      const publicKey: PublicKeyAuthMethod | undefined = privateKey && { type: 'publickey', username: target.username, key: privateKey };
      client.connect({
        ...login,
        authHandler: publicKey ? [publicKey] : undefined,
        readyTimeout: 15_000,
        tryKeyboard: Boolean(target.password),
        hostVerifier(key: Buffer) {
          observed = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          return observed === options.fingerprint;
        },
      });
    } catch { stop(new Error('SSH 连接配置无效。')); }
  });
  try { await ready; }
  catch (failure) { await outputReady; throw failure; }
  return {
    send(command: CommandLine) { return untilPrompt(command.text); },
    async close() { close(); await outputReady; },
  };
}
