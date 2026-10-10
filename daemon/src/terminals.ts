import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MAX_TERMINALS } from './config';
import { isDirectory } from './environment';
import { loadAppSettings } from './settings';
import { remoteHost, userSshConfig } from './pi_launch';
import { shellQuote } from './process_io';
import { waitForExit } from './process_cleanup';
import * as terminalLookup from './terminal_lookup';
import type { App } from './app';

const MAX_INPUT_BYTES = 1024 * 1024;
const INPUT_QUEUE = 32;

/** Python program that runs a command in a pseudo-terminal (PTY). It relays stdin and stdout and reads "rows cols" lines on fd 3 to resize. */
const PTY_HELPER = [
  'import os, sys, pty, fcntl, termios, struct, select, signal',
  'rows, cols = int(sys.argv[1]), int(sys.argv[2]); argv = sys.argv[3:]',
  'def size(fd, r, c): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))',
  'pid, master = pty.fork()',
  'if pid == 0:',
  '    try: size(0, rows, cols)',
  '    except Exception: pass',
  '    try: os.execvp(argv[0], argv)',
  '    except Exception as error: sys.stderr.write(str(error) + "\\n"); os._exit(127)',
  'def stop(*_):',
  '    try: os.killpg(pid, signal.SIGHUP)',
  '    except Exception: pass',
  '    try: os.kill(pid, signal.SIGKILL)',
  '    except Exception: pass',
  '    os._exit(0)',
  'signal.signal(signal.SIGTERM, stop)',
  'signal.signal(signal.SIGHUP, stop)',
  'inputs = [0, 3, master]; pending = b""; control = b""',
  'while True:',
  '    writers = [master] if pending else []',
  '    try: readable, writable, _ = select.select(inputs, writers, [])',
  '    except InterruptedError: continue',
  '    if master in writable:',
  '        try: pending = pending[os.write(master, pending):]',
  '        except OSError: pending = b""',
  '    if master in readable:',
  '        try: data = os.read(master, 65536)',
  '        except OSError: data = b""',
  '        if not data: break',
  '        view = memoryview(data)',
  '        while view: view = view[os.write(1, view):]',
  '    if 0 in readable:',
  '        data = os.read(0, 65536)',
  '        if data: pending += data',
  '        else: inputs.remove(0)',
  '    if 3 in readable:',
  '        data = os.read(3, 4096)',
  '        if not data: inputs.remove(3)',
  '        control += data',
  '        while b"\\n" in control:',
  '            line, control = control.split(b"\\n", 1)',
  '            try: r, c = map(int, line.split()); size(master, r, c); os.kill(pid, signal.SIGWINCH)',
  '            except Exception: pass',
  'try: os.waitpid(pid, 0)',
  'except Exception: pass',
].join('\n');

export interface TerminalProcess {
  generation: string;
  sessionKey: string;
  cwd: string;
  hostId: string;
  windowLabel: string;
  child: ChildProcess;
  rows: number;
  cols: number;
  queued: number;
  exited: boolean;
}

/** State for all running shell terminals and their saved output. */
export class TerminalRuntime {
  processes = new Map<string, TerminalProcess>();
  history = new Map<string, terminalLookup.Transcript>();

  runningCount(): number { return this.processes.size; }
  ensureOwner(id: string, owner: string): void {
    const process = this.processes.get(id);
    if (process && process.windowLabel !== owner) throw new Error('Terminal belongs to another connection');
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
  if (process.windowLabel === owner) return true;
  throw new Error('Terminal belongs to another connection');
}

interface TerminalLaunch { terminalId: string; sessionKey: string; cwd: string; cols: number; rows: number; hostId: string; windowLabel: string }

function startTerminalWith(runtime: TerminalRuntime, launch: TerminalLaunch, command: ShellCommand, emit: (packet: any) => void): void {
  const { terminalId, sessionKey, cwd, cols, rows, hostId, windowLabel } = launch;
  if (terminalAlreadyRunning(runtime, terminalId, windowLabel)) return;
  if ([...runtime.processes.values()].filter(process => process.sessionKey === sessionKey).length >= MAX_TERMINALS) throw new Error('At most ' + MAX_TERMINALS + ' terminals may run for one conversation');
  let child: ChildProcess;
  try {
    child = spawn('python3', ['-c', PTY_HELPER, String(rows), String(cols), command.program, ...command.args], {
      cwd: command.cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) { throw new Error('Could not start terminal shell: ' + (error?.message ?? error)); }
  const generation = randomUUID();
  const terminal: TerminalProcess = { generation, sessionKey, cwd, hostId, windowLabel, child, rows, cols, queued: 0, exited: false };
  child.stdin!.on('error', () => {});
  (child.stdio[3] as any)?.on?.('error', () => {});
  child.on('error', error => console.error('Terminal ' + terminalId + ' failed: ' + error.message));
  const current = () => runtime.processes.get(terminalId)?.generation === generation;
  terminalLookup.start(runtime, terminalId, sessionKey, cwd, hostId, windowLabel, generation);
  const size = '\u001b[8;' + rows + ';' + cols + 't';
  terminalLookup.record(runtime.history, terminalId, size);
  emit(terminalLookup.event(runtime.history, terminalId, { type: 'terminal_output', terminalId, data: size }));
  const decoder = new TextDecoder('utf-8');
  const output = (data: string) => {
    if (!data || !current()) return;
    terminalLookup.record(runtime.history, terminalId, data);
    emit(terminalLookup.event(runtime.history, terminalId, { type: 'terminal_output', terminalId, data }));
  };
  child.stdout!.on('data', (chunk: Buffer) => output(decoder.decode(chunk, { stream: true })));
  child.stderr!.on('data', (chunk: Buffer) => console.error('Terminal helper: ' + chunk.toString('utf8').trimEnd()));
  child.on('close', () => {
    terminal.exited = true;
    output(decoder.decode());
    if (!current()) return;
    runtime.processes.delete(terminalId);
    const packet = terminalLookup.event(runtime.history, terminalId, { type: 'terminal_exit', terminalId });
    terminalLookup.finish(runtime.history, terminalId);
    emit(packet);
  });
  runtime.processes.set(terminalId, terminal);
}

export function queueInput(process: TerminalProcess, data: string, busy: string): void {
  if (process.queued >= INPUT_QUEUE) throw new Error(busy);
  process.queued += 1;
  process.child.stdin!.write(data, () => { process.queued -= 1; });
}

export function writeTerminal(runtime: TerminalRuntime, terminalId: string, data: string): void {
  const process = runtime.processes.get(terminalId);
  if (!process) throw new Error('Terminal is not running');
  if (typeof data !== 'string') throw new Error('Missing terminal input');
  if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Terminal input exceeds 1 MiB; paste a smaller block');
  queueInput(process, data, 'Terminal input is busy; wait or close the terminal');
}

export function resizeProcess(process: TerminalProcess, cols: number, rows: number): void {
  process.cols = cols; process.rows = rows;
  (process.child.stdio[3] as any).write(rows + ' ' + cols + '\n');
}

export function resizeTerminal(runtime: TerminalRuntime, terminalId: string, cols: number, rows: number): void {
  const process = runtime.processes.get(terminalId);
  if (!process) throw new Error('Terminal is not running');
  resizeProcess(process, dimensionValue(cols), dimensionValue(rows));
}

export function closeTerminal(runtime: TerminalRuntime, terminalId: string): Promise<void> {
  return stopTerminals(runtime, [terminalId]);
}

export async function stopTerminalProcess(process: TerminalProcess): Promise<void> {
  if (process.exited) return;
  process.child.kill('SIGTERM');
  if (!(await waitForExit(process.child, 2000))) {
    process.child.kill('SIGKILL');
    await waitForExit(process.child, 2000);
  }
}

export async function stopTerminals(runtime: TerminalRuntime, terminalIds: string[]): Promise<void> {
  for (const id of terminalIds) {
    const process = runtime.processes.get(id);
    runtime.processes.delete(id);
    runtime.history.delete(id);
    if (process) {
      try { await stopTerminalProcess(process); }
      catch (error: any) { throw new Error('Could not close terminal ' + id + ': ' + (error?.message ?? error)); }
    }
  }
}

export async function detachOwner(runtime: TerminalRuntime, owner: string): Promise<void> {
  try { await terminalLookup.discardDrafts(runtime, 'shared:' + owner + ':'); } catch {}
  const ids = [...runtime.processes].filter(([, process]) => process.windowLabel === owner).map(([id]) => id);
  try { await stopTerminals(runtime, ids); } catch {}
  terminalLookup.detach(runtime, owner);
}

export async function shutdown(runtime: TerminalRuntime): Promise<void> {
  try { await stopTerminals(runtime, [...runtime.processes.keys()]); } catch {}
}
