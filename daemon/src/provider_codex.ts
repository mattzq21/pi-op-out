import { spawn } from 'node:child_process';
import { codexExecutable, homeDir } from './environment';

const VERSION = '0.1.0';

export interface CodexUsage { remainingPercent: number; resetAt?: number }

export function codexUsageValues(response: any): CodexUsage | undefined {
  const limits = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!limits || typeof limits !== 'object') return undefined;
  let best: [number, number | undefined] | undefined;
  for (const window of ['primary', 'secondary']) {
    const value = limits[window];
    const used = value?.usedPercent;
    if (typeof used !== 'number') continue;
    const reset = Number.isInteger(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt : undefined;
    if (!best || used >= best[0]) best = [used, reset];
  }
  if (!best) return undefined;
  const usage: CodexUsage = { remainingPercent: Math.round(100 - Math.min(100, Math.max(0, best[0]))) };
  if (best[1] !== undefined) usage.resetAt = best[1];
  return usage;
}

export function codexUsage(): Promise<CodexUsage> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(codexExecutable(), ['app-server'], { cwd: homeDir(), stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error: any) { reject(new Error('Could not start Codex: ' + error.message)); return; }
    let finished = false;
    const finish = (error: Error | undefined, value?: CodexUsage) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out')), 8000);
    child.on('error', error => finish(new Error('Could not start Codex: ' + error.message)));
    child.stdin!.on('error', () => {});
    const send = (value: any) => child.stdin!.write(JSON.stringify(value) + '\n');
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let value: any;
        try { value = JSON.parse(line); } catch { continue; }
        if (value?.id === 1) {
          if (value.error !== undefined) { finish(new Error(JSON.stringify(value.error))); return; }
          send({ method: 'initialized' });
          send({ method: 'account/rateLimits/read', id: 2 });
        } else if (value?.id === 2) {
          if (value.error !== undefined) { finish(new Error(JSON.stringify(value.error))); return; }
          if (value.result === undefined) { finish(new Error('Codex returned no usage data')); return; }
          const usage = codexUsageValues(value.result);
          if (usage) finish(undefined, usage); else finish(new Error('Codex usage is unavailable'));
          return;
        }
      }
    });
    child.on('close', () => finish(new Error('Codex usage request timed out')));
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'piop', title: 'piop', version: VERSION }, capabilities: null } });
  });
}
