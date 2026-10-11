import { spawn } from 'node:child_process';
import { STORAGE_DIRECTORY } from './config';
import { remoteLoginCommand, ssh, type Host } from './host_connection';
import { nodeCommand } from './node_command';
import { shellQuote, spawnOptions, type Output } from './process_io';

export function runHostScript(host: Host, script: string, args: string[], options: { maxOutputBytes: number; signal?: AbortSignal }): Promise<Output> {
  const command = host.kind === 'local'
    ? nodeCommand(['-e', script, ...args])
    : ssh(host.host, remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${shellQuote(STORAGE_DIRECTORY)} bun -e ${[script, ...args].map(shellQuote).join(' ')}`));
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(new Error('Host script aborted; outcome is unknown')); return; }
    const grouped = process.platform !== 'win32';
    const child = spawn(command.program, command.args ?? [], spawnOptions(command, { stdio: ['ignore', 'pipe', 'pipe'], detached: grouped }));
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid === undefined) return;
      try { if (grouped) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error: any) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const abort = () => stop(new Error('Host script aborted; outcome is unknown'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) { stop(new Error('Host script output exceeded its limit; outcome is unknown')); return; }
      stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, 64 * 1024 - stderrBytes));
      stderrBytes += kept.length;
      if (kept.length) stderr.push(kept);
    });
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, signalName) => {
      signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      resolve({ status: { code, signal: signalName, success: code === 0 }, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}
