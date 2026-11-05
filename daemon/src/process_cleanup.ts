import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isMissing } from './util/sync';
import { processesEnded, startTime } from './util/process_exit';

export const PROCESS_TAG = 'PIOP_PROCESS_TAG';

let ownerPrefix: string | undefined;

export function newProcessTag(): string {
  if (ownerPrefix === undefined) {
    const started = startTime(process.pid);
    if (started === undefined) throw new Error('Could not read the start time of the Piop daemon from /proc');
    ownerPrefix = process.pid + '.' + started + '.';
  }
  return ownerPrefix + randomUUID();
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
    } catch (error) { if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
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

const TAG_PREFIX = Buffer.from('\0' + PROCESS_TAG + '=');

function tagged(): Array<{ pid: number; started: string; tag: string }> {
  const found: Array<{ pid: number; started: string; tag: string }> = [];
  let entries: string[] = [];
  try { entries = readdirSync('/proc'); } catch (error: any) { console.error('Could not list processes: ' + error.message); return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environment: Buffer;
    try { environment = readFileSync(`/proc/${entry}/environ`); } catch { continue; }
    const padded = Buffer.concat([Buffer.from('\0'), environment, Buffer.from('\0')]);
    const at = padded.indexOf(TAG_PREFIX);
    if (at < 0) continue;
    const start = at + TAG_PREFIX.length;
    const tag = padded.subarray(start, padded.indexOf(0, start)).toString('utf8');
    const started = startTime(pid);
    if (started !== undefined) found.push({ pid, started, tag });
  }
  return found;
}

export function taggedProcesses(tag: string): Array<{ pid: number; started: string }> {
  return tagged().filter(item => item.tag === tag).map(({ pid, started }) => ({ pid, started }));
}

export async function stopOrphanedProcesses(): Promise<boolean> {
  const orphans = tagged().filter(({ tag }) => {
    const [pid, started] = tag.split('.');
    const owner = Number(pid);
    if (!Number.isInteger(owner) || owner <= 0 || !started) { console.error('Ignoring a process with an invalid ' + PROCESS_TAG + ': ' + tag); return false; }
    return owner !== process.pid && startTime(owner) !== started;
  });
  if (!orphans.length) return true;
  console.error('Stopping processes left by a stopped Piop daemon: ' + orphans.map(({ pid }) => pid).join(', '));
  killVerified(orphans);
  await processesEnded(orphans, 2000);
  const remaining = orphans.filter(({ pid, started }) => startTime(pid) === started);
  if (remaining.length) console.error('Processes left by a stopped Piop daemon did not exit after SIGKILL: ' + remaining.map(({ pid }) => pid).join(', '));
  return remaining.length === 0;
}

export function killVerified(processes: Array<{ pid: number; started: string }>, signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const { pid, started } of processes) {
    if (startTime(pid) !== started) continue;
    try { process.kill(pid, signal); } catch (error: any) { if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to process ${pid}: ${error.message}`); }
  }
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error: any) {
    if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to process group ${pid}: ${error.message}`);
    return false;
  }
}

