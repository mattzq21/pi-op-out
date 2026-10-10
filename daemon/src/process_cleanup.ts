import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { sleep } from './util/sync';

function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }

function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const index = stat.lastIndexOf(')');
    if (index < 0) return undefined;
    return stat.slice(index + 1).trim().split(/\s+/)[19];
  } catch { return undefined; }
}

export function descendantProcesses(parent: number): Array<{ pid: number; started: string }> {
  if (process.platform !== 'linux') return [];
  const processes = new Map<number, { ppid: number; started: string }>();
  let entries: string[] = [];
  try { entries = readdirSync('/proc'); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const index = stat.lastIndexOf(')');
      if (index < 0) continue;
      const fields = stat.slice(index + 1).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      const started = fields[19];
      if (Number.isFinite(ppid) && started) processes.set(Number(entry), { ppid, started });
    } catch {}
  }
  const descendants = new Set([parent]);
  for (;;) {
    const previous = descendants.size;
    for (const [pid, { ppid }] of processes) if (descendants.has(ppid)) descendants.add(pid);
    if (descendants.size === previous) break;
  }
  descendants.delete(parent);
  return [...descendants].map(pid => ({ pid, started: processes.get(pid)!.started }));
}

export function killVerified(processes: Array<{ pid: number; started: string }>, signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const { pid, started } of processes) {
    if (startTime(pid) !== started) continue;
    try { process.kill(pid, signal); } catch {}
  }
}

export function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(exited(child)); }, ms);
    function done() { clearTimeout(timer); resolve(true); }
    child.once('exit', done);
  });
}

export async function stopMessageWorker(child: ChildProcess): Promise<void> {
  if (exited(child) || child.pid === undefined) return;
  const descendants = descendantProcesses(child.pid);
  try { child.kill('SIGTERM'); } catch {}
  await waitForExit(child, 5000);
  killVerified(descendants);
  if (!exited(child)) { try { child.kill('SIGKILL'); } catch {} }
  await waitForExit(child, 5000);
}

export { sleep };
