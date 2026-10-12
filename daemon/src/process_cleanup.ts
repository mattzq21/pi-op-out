import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { sleep } from './util/sync';

function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }

function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const index = stat.lastIndexOf(')');
    if (index < 0) return undefined;
    const fields = stat.slice(index + 1).trim().split(/\s+/);
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch { return undefined; }
}

export function descendantProcesses(parent: number, group?: number, session?: number): Array<{ pid: number; started: string }> {
  const processes = new Map<number, { ppid: number; group: number; session: number; started: string }>();
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
      if (Number.isFinite(ppid) && started && fields[0] !== 'Z') processes.set(Number(entry), { ppid, group: Number(fields[2]), session: Number(fields[3]), started });
    } catch {}
  }
  const descendants = new Set([parent]);
  if (group !== undefined) for (const [pid, entry] of processes) if (entry.group === group) descendants.add(pid);
  if (session !== undefined) for (const [pid, entry] of processes) if (entry.session === session) descendants.add(pid);
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
  const group = child.pid;
  if (group === undefined) return;
  const descendants = descendantProcesses(group, group);
  const signalled = signalProcessGroup(group, 'SIGTERM');
  killVerified(descendants, 'SIGTERM');
  signalChild(child, 'SIGTERM');
  const deadline = Date.now() + 5000;
  if (!exited(child)) await waitForExit(child, 5000);
  while (Date.now() < deadline && descendantProcesses(group, group).some(({ pid, started }) => startTime(pid) === started)) await sleep(50);
  descendants.push(...descendantProcesses(group, group));
  signalProcessGroup(group, 'SIGKILL');
  killVerified(descendants);
  signalChild(child, 'SIGKILL');
  if (!await waitForExit(child, 5000)) console.error(`Process ${group} did not exit after SIGKILL`);
  if (descendants.length) await sleep(100);
  const remaining = new Set([...descendants, ...descendantProcesses(group, group)].filter(({ pid, started }) => startTime(pid) === started).map(({ pid }) => pid));
  if (remaining.size) console.error(`Processes in worker group ${group} did not exit after SIGKILL: ${[...remaining].join(', ')}`);
}

export { sleep };
