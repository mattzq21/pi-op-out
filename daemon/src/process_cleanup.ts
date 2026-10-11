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
    try { process.kill(pid, signal); } catch (error: any) { if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to process ${pid}: ${error.message}`); }
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

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error: any) {
    if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to process group ${pid}: ${error.message}`);
    return false;
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (exited(child)) return;
  try { child.kill(signal); }
  catch (error: any) { if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to process ${child.pid}: ${error.message}`); }
}

export async function stopMessageWorker(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const descendants = exited(child) ? [] : descendantProcesses(child.pid);
  if (!exited(child)) {
    if (!signalProcessGroup(child.pid, 'SIGTERM')) signalChild(child, 'SIGTERM');
    await waitForExit(child, 5000);
  }
  if (!exited(child)) signalProcessGroup(child.pid, 'SIGKILL');
  killVerified(descendants);
  signalChild(child, 'SIGKILL');
  if (!await waitForExit(child, 5000)) console.error(`Process ${child.pid} did not exit after SIGKILL`);
}

export { sleep };
