import { shellLock } from '../../resources/file-lock.cjs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ensurePrivateDir } from '../private_fs';
import { CommandRefusedError } from '../pi_rejection';
import { descendantProcesses, killVerified, newProcessTag, PROCESS_TAG, signalProcessGroup, taggedProcesses } from '../process_cleanup';
import { kind, type LaunchSpec, wireCommand } from './protocol';
import { isRuntimeEvent, parseRuntimeEvent, runtimeEventResult, type RuntimeEvent } from './runtime_events';

export interface Request { command: any; requestType: string; snapshotState: any }

export interface WorkerObserver {
  /** Settles when the event is handled. The worker stops reading Pi's output while too many events wait. */
  event(event: any): Promise<void>;
  /** Settles when Piop handled an event that Pi waits on. A rejection goes back to Pi, which reports it as the hook's error. */
  runtimeEvent(event: RuntimeEvent): Promise<void>;
  response(event: any, request: Request): any;
  stderr(line: string): void;
  diagnostic(line: string): void;
  finished(): void;
  /** status describes how Pi ended, for example "exit code 1" or "signal SIGKILL"; null when it has not exited. */
  disconnectError(status: string | null): string;
}

interface Pending extends Request { resolve(value: any): void; reject(error: Error): void }

/** Events that may wait for the session before the worker stops reading Pi's output, by count and by size. */
const BACKLOG_EVENTS = 1000;
const BACKLOG_BYTES = 16 * 1024 * 1024;

const running = new Map<ChildProcess, string>();
process.on('exit', () => {
  for (const [child, tag] of running) {
    const processes = child.pid === undefined ? [] : descendantProcesses(child.pid, child.pid);
    processes.push(...taggedProcesses(tag));
    if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL');
    killVerified(processes);
  }
});

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
  private descendants: ReturnType<typeof descendantProcesses> = [];
  private exitStatus: string | null = null;
  private lines: ReturnType<typeof createInterface> | undefined;
  private backlog = 0;
  private backlogBytes = 0;
  private paused = false;

  private constructor(private child: ChildProcess, private tag: string, private observer: WorkerObserver, private timeout: number) {}

  static spawn(spec: LaunchSpec, identity: string, timeout: number, observer: WorkerObserver, home: string): RuntimeWorker {
    const command = launchCommand(spec, identity, home);
    // Pi starts tools in new process sessions, so they leave its process tree when Pi dies. The tag finds them after that.
    const tag = newProcessTag();
    const child = spawn(command.program, command.args, {
      cwd: spec.cwd ? spec.cwd : undefined,
      env: { ...process.env, ...spec.env, PIOP_BUN: process.execPath, [PROCESS_TAG]: tag },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid === undefined) {
      child.on('error', error => observer.diagnostic('Could not start ' + command.program + ': ' + error.message));
      throw new Error('Could not start ' + command.program);
    }
    running.set(child, tag);
    const worker = new RuntimeWorker(child, tag, observer, timeout);
    child.on('error', error => observer.diagnostic(error.message));
    child.stdin!.on('error', error => observer.diagnostic(error.message));
    let open = 3;
    const done = () => { if (--open === 0) worker.close(); };
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    worker.lines = lines;
    lines.on('line', line => {
      let event: any;
      try { event = JSON.parse(line); } catch (error: any) { observer.diagnostic(error.message); return; }
      worker.receive(event, line.length);
    });
    lines.on('close', done);
    const errors = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    errors.on('line', line => observer.stderr(line));
    errors.on('close', done);
    child.on('exit', (code, signal) => {
      worker.exitStatus = signal !== null ? 'signal ' + signal : 'exit code ' + code;
      worker.signal(false);
    });
    child.on('close', () => { worker.signal(true); running.delete(child); if (worker.deadline) clearTimeout(worker.deadline); done(); });
    return worker;
  }

  private close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.exited = true;
    const error = this.observer.disconnectError(this.exitStatus);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(new Error(error));
    this.observer.finished();
    for (const waiter of this.closedWaiters.splice(0)) waiter();
  }

  private receive(event: any, size: number): void {
    if (kind(event) === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === 'pi-desktop-pause-state') {
      const statusText = event.statusText;
      if (typeof statusText !== 'string' || !statusText.startsWith('json:')) return;
      try { event = JSON.parse(statusText.slice(5)); } catch (error: any) { this.observer.diagnostic(error.message); return; }
    }
    if (isRuntimeEvent(event)) { this.track(this.answerRuntimeEvent(event), size); return; }
    if (kind(event) !== 'response') { this.track(this.observer.event(event), size); return; }
    const id = event?.id;
    if (typeof id !== 'string') return;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    try { request.resolve(this.observer.response(event, request)); } catch (error: any) { request.reject(error instanceof Error ? error : new Error(String(error))); }
  }

  /** Answers an event that Pi waits on, after Piop handled it. A malformed event gets its error back, so Pi reports it. */
  private async answerRuntimeEvent(value: any): Promise<void> {
    let event: RuntimeEvent;
    try { event = parseRuntimeEvent(value); } catch (error: any) {
      this.observer.diagnostic(error.message);
      if (typeof value?.id === 'string') await this.write(runtimeEventResult(value.id, error.message)).catch(failure => this.observer.diagnostic(failure.message));
      return;
    }
    let failure: string | undefined;
    try { await this.observer.runtimeEvent(event); }
    catch (error: any) { failure = error instanceof Error ? error.message : String(error); }
    await this.write(runtimeEventResult(event.id, failure)).catch(error => this.observer.diagnostic('Could not answer Pi runtime event ' + event.name + ': ' + error.message));
  }

  /** Pauses reading Pi's output while the backlog is over its limit, and resumes at half of it. */
  private track(handled: Promise<void>, size: number): void {
    this.backlog += 1;
    this.backlogBytes += size;
    if (!this.paused && (this.backlog > BACKLOG_EVENTS || this.backlogBytes > BACKLOG_BYTES)) {
      this.paused = true;
      this.lines?.pause();
    }
    handled.catch(() => {}).finally(() => {
      this.backlog -= 1;
      this.backlogBytes -= size;
      if (this.paused && this.backlog <= BACKLOG_EVENTS / 2 && this.backlogBytes <= BACKLOG_BYTES / 2) {
        this.paused = false;
        this.lines?.resume();
      }
    });
  }

  /** Sends SIGKILL when hard is true; otherwise SIGTERM, then SIGKILL after five seconds. */
  private signal(hard: boolean): void {
    this.exited = true;
    if (this.child.pid === undefined) return;
    if (hard) {
      this.descendants.push(...this.processes());
      signalProcessGroup(this.child.pid, 'SIGKILL');
      killVerified(this.descendants);
      this.descendants = [];
      return;
    }
    if (this.deadline || this.closedFlag) return;
    this.descendants = this.processes();
    signalProcessGroup(this.child.pid, 'SIGTERM');
    killVerified(this.descendants, 'SIGTERM');
    this.deadline = setTimeout(() => {
      this.signal(true);
      this.deadline = setTimeout(() => {
        this.deadline = undefined;
        this.observer.diagnostic('Pi output pipes did not close after SIGKILL; closing them');
        this.child.stdin!.destroy();
        this.child.stdout!.destroy();
        this.child.stderr!.destroy();
        this.close();
      }, 1000);
    }, 5000);
  }

  /** Pi's process tree, and the processes it started that have since left that tree. */
  private processes(): ReturnType<typeof descendantProcesses> {
    return [...descendantProcesses(this.child.pid!, this.child.pid!), ...taggedProcesses(this.tag)];
  }

  isClosed(): boolean { return this.exited; }

  private write(packet: any): Promise<void> {
    if (this.isClosed()) return Promise.reject(new CommandRefusedError('Pi is not running', 'daemon'));
    return new Promise((resolve, reject) => {
      this.child.stdin!.write(JSON.stringify(packet) + '\n', error => error ? reject(new Error(error.message)) : resolve());
    });
  }

  async request(command: any, requestType: string, snapshotState: any): Promise<any> {
    if (this.isClosed()) throw new CommandRefusedError('Pi is not running', 'daemon');
    const id = randomUUID();
    const wire = wireCommand(command, id);
    const abort = kind(command) === 'abort';
    const timeout = abort ? 5000 : this.timeout;
    // After a timed-out queued prompt, Pi may still accept it. A retry with the same queue ID would then add it twice,
    // so Pi stops; the next start reconciles the queue with the saved transcript.
    const stopOnTimeout = abort || requestType === 'queue_prompt';
    let entry!: Pending;
    const reply = new Promise<any>((resolve, reject) => { entry = { command, requestType, snapshotState, resolve, reject }; });
    reply.catch(() => {});
    this.pending.set(id, entry);
    try { return await this.withDeadline(written => this.write(wire).then(() => { written(); return reply; }), timeout, stopOnTimeout); }
    finally { this.pending.delete(id); }
  }

  send(packet: any): Promise<void> {
    return this.withDeadline(() => this.write(packet), this.timeout);
  }

  private async withDeadline<T>(operation: (written: () => void) => Promise<T>, timeout: number, stopOnTimeout = false): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let written = false;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!written) {
          this.observer.diagnostic('Pi stopped reading its input; stopping it');
          this.signal(false);
          reject(new Error('Pi stopped reading its input'));
          return;
        }
        if (stopOnTimeout) { this.observer.diagnostic('Pi did not answer in time; stopping it'); this.signal(false); }
        reject(new Error('Pi command timed out'));
      }, timeout);
    });
    try { return await Promise.race([operation(() => { written = true; }), expired]); }
    finally { clearTimeout(timer); }
  }

  async stop(): Promise<void> {
    if (this.closedFlag) return;
    this.signal(false);
    await new Promise<void>(resolve => { if (this.closedFlag) resolve(); else this.closedWaiters.push(resolve); });
  }
}
