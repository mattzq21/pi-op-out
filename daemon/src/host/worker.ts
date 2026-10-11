import { shellLock } from '../../resources/file-lock.cjs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ensurePrivateDir } from '../private_fs';
import { kind, type LaunchSpec, wireCommand } from './protocol';

export interface Request { command: any; requestType: string; snapshotState: any }

export interface WorkerObserver {
  event(event: any): void;
  response(event: any, request: Request): any;
  stderr(line: string): void;
  diagnostic(line: string): void;
  finished(): void;
  disconnectError(): string;
}

interface Pending extends Request { resolve(value: any): void; reject(error: Error): void }

const running = new Set<ChildProcess>();
process.on('exit', () => { for (const child of running) { try { child.kill('SIGKILL'); } catch {} } });

function launchCommand(spec: LaunchSpec, identity: string, home: string): { program: string; args: string[] } {
  const claims = spec.env.PIOP_REMOTE_SESSION_CLAIMS;
  if (claims !== undefined) {
    const directory = join(join(home, claims), 'session-claims');
    ensurePrivateDir(directory);
    const hash = createHash('sha256').update(identity.toLowerCase()).digest('hex');
    return { program: 'sh', args: ['-c', 'exec 9<>"$1" || exit 1; shift; ' + shellLock(9, true) + '; code=$?; [ "$code" = 75 ] && exit 1; [ "$code" = 0 ] || exit "$code"; exec "$@"', 'piop-claim', join(directory, 'id-' + hash.slice(0, 40) + '.lock'), spec.program, ...spec.args] };
  }
  return { program: spec.program, args: [...spec.args] };
}

export class RuntimeWorker {
  private pending = new Map<string, Pending>();
  private exited = false;
  private closedFlag = false;
  private closedWaiters: Array<() => void> = [];
  private deadline: NodeJS.Timeout | undefined;

  private constructor(private child: ChildProcess, private observer: WorkerObserver, private timeout: number) {}

  static spawn(spec: LaunchSpec, identity: string, timeout: number, observer: WorkerObserver, home: string): RuntimeWorker {
    const command = launchCommand(spec, identity, home);
    const child = spawn(command.program, command.args, {
      cwd: spec.cwd ? spec.cwd : undefined,
      env: { ...process.env, ...spec.env, PIOP_BUN: process.execPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) {
      let message = 'No such file or directory (os error 2)';
      child.once('error', () => {});
      child.on('error', error => { message = error.message; });
      throw new Error(message);
    }
    running.add(child);
    const worker = new RuntimeWorker(child, observer, timeout);
    child.on('error', error => observer.diagnostic(error.message));
    child.stdin!.on('error', () => {});
    let open = 3;
    const done = () => { if (--open === 0) worker.close(); };
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => {
      let event: any;
      try { event = JSON.parse(line); } catch (error: any) { observer.diagnostic(error.message); return; }
      worker.receive(event);
    });
    lines.on('close', done);
    const errors = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    errors.on('line', line => observer.stderr(line));
    errors.on('close', done);
    child.on('close', () => { running.delete(child); if (worker.deadline) clearTimeout(worker.deadline); done(); });
    return worker;
  }

  private close(): void {
    this.exited = true;
    const error = this.observer.disconnectError();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(new Error(error));
    this.observer.finished();
    this.closedFlag = true;
    for (const waiter of this.closedWaiters.splice(0)) waiter();
  }

  private receive(event: any): void {
    if (kind(event) === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === 'pi-desktop-pause-state') {
      const statusText = event.statusText;
      if (typeof statusText !== 'string' || !statusText.startsWith('json:')) return;
      try { event = JSON.parse(statusText.slice(5)); } catch (error: any) { this.observer.diagnostic(error.message); return; }
    }
    if (kind(event) !== 'response') { this.observer.event(event); return; }
    const id = event?.id;
    if (typeof id !== 'string') return;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    try { request.resolve(this.observer.response(event, request)); } catch (error: any) { request.reject(error instanceof Error ? error : new Error(String(error))); }
  }

  /** Sends SIGKILL when hard is true; otherwise SIGTERM, then SIGKILL after five seconds. */
  private signal(hard: boolean): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (hard) { try { this.child.kill('SIGKILL'); } catch {} return; }
    try { this.child.kill('SIGTERM'); } catch {}
    if (!this.deadline) this.deadline = setTimeout(() => { this.deadline = undefined; try { this.child.kill('SIGKILL'); } catch {} }, 5000);
  }

  isClosed(): boolean { return this.exited; }

  send(packet: any): Promise<void> {
    if (this.isClosed()) return Promise.reject(new Error('Pi is not running'));
    return new Promise((resolve, reject) => {
      this.child.stdin!.write(JSON.stringify(packet) + '\n', error => error ? reject(new Error(error.message)) : resolve());
    });
  }

  async request(command: any, requestType: string, snapshotState: any): Promise<any> {
    if (this.isClosed()) throw new Error('Pi is not running');
    const id = randomUUID();
    const wire = wireCommand(command, id);
    const abort = kind(command) === 'abort';
    const timeout = abort ? 5000 : this.timeout;
    let entry!: Pending;
    const reply = new Promise<any>((resolve, reject) => { entry = { command, requestType, snapshotState, resolve, reject }; });
    reply.catch(() => {});
    this.pending.set(id, entry);
    try {
      await this.send(wire);
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { if (abort) this.signal(false); reject(new Error('Pi command timed out')); }, timeout);
      });
      try { return await Promise.race([reply, expired]); } finally { clearTimeout(timer); }
    } finally { this.pending.delete(id); }
  }

  async stop(): Promise<void> {
    if (this.closedFlag) return;
    this.signal(false);
    await new Promise<void>(resolve => { if (this.closedFlag) resolve(); else this.closedWaiters.push(resolve); });
  }
}
