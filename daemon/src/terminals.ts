import type { Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { descendantProcesses, killVerified, signalProcessGroup, sleep } from './process_cleanup';
import { MAX_TERMINALS } from './config';
import { isDirectory } from './environment';
import { loadAppSettings } from './settings';
import { remoteHost, userSshConfig } from './pi_launch';
import { shellQuote } from './process_io';
import * as terminalSessions from './terminal_sessions';
import type { App } from './app';

const MAX_INPUT_BYTES = 1024 * 1024;
/** Input accepted since the PTY last reported it was drained. */
const INPUT_PENDING_BYTES = 4 * 1024 * 1024;
/** Output chunks are merged for this long before one terminal_output event is sent. */
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 256 * 1024;

export interface TerminalProcess {
  generation: string;
  sessionKey: string;
  cwd: string;
  hostId: string;
  windowLabel: string;
  /** The shell process. It runs in a Bun pseudo-terminal (PTY), available as child.terminal. */
  child: Subprocess;
  processSessionId: number;
  rows: number;
  cols: number;
  /** Input bytes written since the last drain. Bun reports a drain each time its input queue is empty again, also after a write it did not buffer. */
  pendingInput: number;
  exited: boolean;
  stopping?: Promise<void>;
}

/** State for all running shell terminals and their saved output. */
export class TerminalRuntime {
  processes = new Map<string, TerminalProcess>();
  history = new Map<string, terminalSessions.Transcript>();

  runningCount(): number { return this.processes.size; }
  ensureOwner(id: string, owner: string): void {
    const process = this.processes.get(id);
    if (process && process.windowLabel !== owner) throw new Error('Terminal belongs to another connection');
  }
  /** True when no other connection runs this terminal. Shared session terminals of this connection count as its own. */
  ownedByConnection(id: string, owner: string): boolean {
    const label = this.processes.get(id)?.windowLabel;
    return label === undefined || label === owner || label.startsWith('shared:' + owner + ':');
  }
  containsProcess(id: string): boolean { return this.processes.has(id); }
  workingDirectories(hostId: string): string[] { return [...this.processes.values()].filter(terminal => terminal.hostId === hostId).map(terminal => terminal.cwd); }
}

export interface StartTerminalOptions { terminalId: string; sessionKey: string; cwd: string; cols: number; rows: number; hostId?: string | null }

interface ShellCommand { program: string; args: string[]; cwd?: string }

function dimensionValue(value: any): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('Invalid terminal size');
  return Math.max(1, number);
}

export function startTerminalForOwner(app: App, owner: string, runtime: TerminalRuntime, options: StartTerminalOptions): Promise<void> {
  return app.pi.lifecycle.run(() => launchTerminalForOwner(app, owner, runtime, options));
}

export async function launchTerminalForOwner(app: App, owner: string, runtime: TerminalRuntime, options: StartTerminalOptions): Promise<void> {
  if (typeof options?.terminalId !== 'string' || typeof options.sessionKey !== 'string' || typeof options.cwd !== 'string') throw new Error('Invalid terminal options');
  const hostId = options.hostId ?? 'local';
  const cwd = options.cwd;
  let command: ShellCommand;
  if (hostId === 'local') {
    if (!isDirectory(cwd)) throw new Error('Terminal working directory does not exist: ' + cwd);
    command = { program: '/bin/bash', args: [], cwd };
  } else {
    const settings = await loadAppSettings(app);
    const host = remoteHost(settings, hostId);
    const args: string[] = [];
    const config = userSshConfig();
    if (config) args.push('-F', config);
    args.push('-tt', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', host.target, 'cd ' + shellQuote(cwd) + ' && exec "$' + '{SHELL:-/bin/bash}" -l');
    command = { program: 'ssh', args };
  }
  startTerminalWith(runtime, { terminalId: options.terminalId, sessionKey: options.sessionKey, cwd, cols: dimensionValue(options.cols), rows: dimensionValue(options.rows), hostId, windowLabel: owner },
    command, packet => app.emit('pi://event', packet));
}

function terminalAlreadyRunning(runtime: TerminalRuntime, terminalId: string, owner: string): boolean {
  const item = runtime.history.get(terminalId);
  if (item && item.owner !== owner) throw new Error('Terminal belongs to another connection');
  const process = runtime.processes.get(terminalId);
  if (!process) return false;
  if (process.windowLabel !== owner) throw new Error('Terminal belongs to another connection');
  if (process.stopping || process.exited || process.child.exitCode !== null || process.child.signalCode !== null) throw new Error('Terminal is still closing; try again in a moment');
  return true;
}

interface TerminalLaunch { terminalId: string; sessionKey: string; cwd: string; cols: number; rows: number; hostId: string; windowLabel: string }

function startTerminalWith(runtime: TerminalRuntime, launch: TerminalLaunch, command: ShellCommand, emit: (packet: any) => void): void {
  const { terminalId, sessionKey, cwd, cols, rows, hostId, windowLabel } = launch;
  if (terminalAlreadyRunning(runtime, terminalId, windowLabel)) return;
  if ([...runtime.processes.values()].filter(process => process.sessionKey === sessionKey).length >= MAX_TERMINALS) throw new Error('At most ' + MAX_TERMINALS + ' terminals may run for one conversation');
  const generation = randomUUID();
  const current = () => runtime.processes.get(terminalId)?.generation === generation;
  const decoder = new TextDecoder('utf-8');
  let pendingOutput = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const data = pendingOutput;
    pendingOutput = '';
    if (!data || !current()) return;
    terminalSessions.record(runtime.history, terminalId, data);
    emit(terminalSessions.event(runtime.history, terminalId, { type: 'terminal_output', terminalId, data }));
  };
  const output = (data: string) => {
    if (!data) return;
    pendingOutput += data;
    if (pendingOutput.length >= OUTPUT_FLUSH_BYTES) { flush(); return; }
    flushTimer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
  };
  let terminal: TerminalProcess | undefined;
  let ptyEnded!: () => void;
  const ptyClosed = new Promise<void>(resolve => { ptyEnded = resolve; });
  let child: Subprocess;
  try {
    child = Bun.spawn([command.program, ...command.args], {
      cwd: command.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      terminal: {
        cols, rows, name: 'xterm-256color',
        data: (_pty, chunk) => output(decoder.decode(chunk, { stream: true })),
        drain: () => { if (terminal) terminal.pendingInput = 0; },
        exit: () => ptyEnded(),
      },
    });
  } catch (error: any) { throw new Error('Could not start terminal shell: ' + (error?.message ?? error)); }
  const started: TerminalProcess = { generation, sessionKey, cwd, hostId, windowLabel, child, processSessionId: child.pid, rows, cols, pendingInput: 0, exited: false };
  terminal = started;
  terminalSessions.start(runtime, terminalId, sessionKey, cwd, hostId, windowLabel, generation);
  const size = '\u001b[8;' + rows + ';' + cols + 't';
  terminalSessions.record(runtime.history, terminalId, size);
  emit(terminalSessions.event(runtime.history, terminalId, { type: 'terminal_output', terminalId, data: size }));
  void child.exited.then(async () => {
    // Let the PTY deliver the last output before the terminal closes.
    await Promise.race([ptyClosed, new Promise(resolve => setTimeout(resolve, 1000))]);
    await stopTerminalProcess(started);
    try { child.terminal?.close(); } catch (error) { console.error('Could not close terminal PTY ' + terminalId + ':', error); }
    started.exited = true;
    output(decoder.decode());
    flush();
    if (!current()) return;
    runtime.processes.delete(terminalId);
    const packet = terminalSessions.event(runtime.history, terminalId, { type: 'terminal_exit', terminalId });
    terminalSessions.finish(runtime.history, terminalId);
    emit(packet);
  }).catch(error => console.error('Terminal exit cleanup failed for ' + terminalId + ':', error));
  runtime.processes.set(terminalId, started);
}

export function queueInput(process: TerminalProcess, data: string, busy: string): void {
  const pty = process.child.terminal;
  if (!pty || pty.closed || process.exited || process.stopping || process.child.exitCode !== null || process.child.signalCode !== null) throw new Error('Terminal is not running');
  const bytes = Buffer.byteLength(data);
  if (process.pendingInput + bytes > INPUT_PENDING_BYTES) throw new Error(busy);
  process.pendingInput += bytes;
  pty.write(data);
}

export function writeTerminal(runtime: TerminalRuntime, terminalId: string, data: string): void {
  const process = runtime.processes.get(terminalId);
  if (!process) throw new Error('Terminal is not running');
  if (typeof data !== 'string') throw new Error('Missing terminal input');
  if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Terminal input exceeds 1 MiB; paste a smaller block');
  queueInput(process, data, 'Terminal input is busy; wait or close the terminal');
}

export function interruptTerminals(runtime: TerminalRuntime): void {
  for (const [id, process] of runtime.processes) {
    if (process.exited || process.stopping || process.child.exitCode !== null || process.child.signalCode !== null) continue;
    try { queueInput(process, '\u0003', 'Terminal input is busy'); }
    catch (error) { console.error('Could not interrupt terminal ' + id + ' after the last client disconnected:', error); }
  }
}

export function resizeProcess(process: TerminalProcess, cols: number, rows: number): void {
  process.cols = cols; process.rows = rows;
  const pty = process.child.terminal;
  if (pty && !pty.closed) pty.resize(cols, rows);
}

export function resizeTerminal(runtime: TerminalRuntime, terminalId: string, cols: number, rows: number): void {
  const process = runtime.processes.get(terminalId);
  if (!process) throw new Error('Terminal is not running');
  resizeProcess(process, dimensionValue(cols), dimensionValue(rows));
}

export function closeTerminal(runtime: TerminalRuntime, terminalId: string): Promise<void> {
  return stopTerminals(runtime, [terminalId]);
}

export function stopTerminalProcess(process: TerminalProcess): Promise<void> {
  return process.stopping ??= stopShell(process);
}

async function stopShell(process: TerminalProcess): Promise<void> {
  const child = process.child;
  const descendants = descendantProcesses(child.pid, child.pid, process.processSessionId);
  const signal = (value: NodeJS.Signals) => {
    descendants.push(...descendantProcesses(child.pid, child.pid, process.processSessionId));
    signalProcessGroup(child.pid, value);
    killVerified(descendants, value);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(value); } catch (error) { console.error('Could not signal terminal ' + child.pid + ':', error); }
    }
  };
  const alive = ({ pid, started }: { pid: number; started: string }) => {
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      return fields[0] !== 'Z' && fields[19] === started;
    } catch (error: any) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') console.error('Could not check terminal child ' + pid + ':', error);
      return false;
    }
  };
  const settled = () => (child.exitCode !== null || child.signalCode !== null) && !descendants.some(alive) && descendantProcesses(child.pid, child.pid, process.processSessionId).length === 0;
  const settle = async (ms: number) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (settled()) return true; await sleep(25); } return settled(); };
  signal('SIGHUP');
  if (!await settle(1000)) { signal('SIGTERM'); if (!await settle(500)) { signal('SIGKILL'); if (!await settle(2000)) console.error('Terminal shell ' + child.pid + ' did not exit after SIGKILL'); } }
  const remaining = new Set(descendants.filter(alive).map(({ pid }) => pid));
  if (remaining.size) console.error('Terminal children did not exit after SIGKILL: ' + [...remaining].join(', '));
  try { child.terminal?.close(); } catch (error) { console.error('Could not close terminal PTY ' + child.pid + ':', error); }
}

export async function stopTerminals(runtime: TerminalRuntime, terminalIds: string[]): Promise<void> {
  const results = await Promise.allSettled(terminalIds.map(async id => {
    const process = runtime.processes.get(id);
    if (process) {
      try { await stopTerminalProcess(process); }
      catch (error: any) { throw new Error('Could not close terminal ' + id + ': ' + (error?.message ?? error)); }
    }
    if (runtime.processes.get(id) === process) { runtime.processes.delete(id); runtime.history.delete(id); }
    else if (!runtime.processes.has(id)) runtime.history.delete(id);
  }));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error?.message ?? String(error)).join('; '));
}

export async function detachOwner(runtime: TerminalRuntime, owner: string): Promise<void> {
  try { await terminalSessions.discardDrafts(runtime, 'shared:' + owner + ':'); } catch (error) { console.error('Could not discard terminal drafts for ' + owner + ':', error); }
  const ids = [...runtime.processes].filter(([, process]) => process.windowLabel === owner).map(([id]) => id);
  try { await stopTerminals(runtime, ids); } catch (error) { console.error('Could not detach terminals for ' + owner + ':', error); }
  terminalSessions.detach(runtime, owner);
}

export async function shutdown(runtime: TerminalRuntime): Promise<void> {
  try { await stopTerminals(runtime, [...runtime.processes.keys()]); } catch (error) { console.error('Could not shut down terminals:', error); }
}
