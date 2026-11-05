import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { serveWorker } from '../resources/main-thread.cjs';
import './main_thread_changes';
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BUILD_ID, STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { CANCELLED, QUEUED, type HostOperationName, type WorkerJob, type WorkerReply } from './host_operation_protocol';
import { logFailure } from './util/sync';

export type HostOperationFailure = 'not-started' | 'failed' | 'unknown';

export class HostOperationError extends Error {
  constructor(
    public readonly kind: HostOperationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HostOperationError';
  }
}

type Lane = 'storage' | 'general' | 'agents';

export interface HostOperation<Request, Result> {
  name: HostOperationName;
  lane: Lane;
  timeout: number;
  read(value: unknown): Result;
  readonly request?: Request;
}

export const DEFAULT_TIMEOUT = 2 * 60 * 1000;
export const STORAGE_TIMEOUT = 10 * 60 * 1000;

// An operation that runs in a worker thread. Its answer is checked with the schema before the caller gets it.
export function hostOperation<Request, Result>(name: HostOperationName, lane: Lane, timeout: number, answer: z.ZodType<Result>): HostOperation<Request, Result> {
  const read = (value: unknown): Result => {
    const parsed = answer.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid answer of ${name}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  };
  return { name, lane, timeout, read };
}

export function profileRoot(): string { return join(homeDir(), STORAGE_DIRECTORY); }

interface Job {
  id: number;
  operation: HostOperation<unknown, unknown>;
  input: unknown;
  progress: Int32Array;
  env?: Record<string, string>;
  storage?: { root: string };
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  done: Promise<void>;
  finish(): void;
  slot?: Slot;
  cleanup(): void;
}

interface Slot { worker: Worker; job?: Job; fresh: boolean; changes: MessagePort }

let sequence = 0;
let closed = false;
const running = new Set<Job>();

function workerEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  environment.PIOP_STORAGE_DIRECTORY = STORAGE_DIRECTORY;
  return { ...environment, ...extra };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

class WorkerLane {
  private slots = new Set<Slot>();
  private queue: Job[] = [];

  constructor(private readonly name: Lane, private readonly limit: number, private readonly fresh: boolean) {}

  submit(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  withdraw(job: Job): boolean {
    const index = this.queue.indexOf(job);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    notifyIdle();
    return true;
  }

  busy(): boolean { return [...this.slots].some(slot => slot.job !== undefined) || this.queue.length > 0; }

  rejectQueued(message: string): void {
    for (const job of this.queue.splice(0)) settle(job, new HostOperationError('not-started', message));
  }

  terminate(): void {
    for (const slot of [...this.slots]) this.drop(slot, new HostOperationError('unknown', 'The daemon stopped while ' + slot.job?.operation.name + ' was running; its outcome is unknown'));
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.fresh ? undefined : [...this.slots].find(item => item.job === undefined);
      if (!slot) {
        if (this.slots.size >= this.limit) return;
        try { slot = this.spawn(this.queue[0]!.env); }
        catch (error) {
          const job = this.queue.shift()!;
          settle(job, new HostOperationError('not-started', 'Could not start a worker for ' + job.operation.name + ': ' + errorMessage(error)));
          job.cleanup();
          continue;
        }
      }
      const job = this.queue.shift()!;
      slot.job = job;
      job.slot = slot;
      const message: WorkerJob = { id: job.id, name: job.operation.name, input: job.input, progress: job.progress.buffer as SharedArrayBuffer, storage: job.storage };
      try { slot.worker.postMessage(message); }
      catch (error) { this.drop(slot, new HostOperationError('not-started', 'Could not send ' + job.operation.name + ' to its worker: ' + errorMessage(error))); }
    }
  }

  private spawn(extraEnvironment: Record<string, string> | undefined): Slot {
    // The worker sends its database changes on this channel, and the main thread runs them.
    const { port1, port2 } = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    const worker = new Worker(new URL(import.meta.url), { workerData: { piopHostOperations: BUILD_ID, mainThread: { port: port2, signal } }, transferList: [port2], env: workerEnvironment(extraEnvironment) });
    serveWorker(port1, signal);
    const slot: Slot = { worker, fresh: this.fresh, changes: port1 };
    this.slots.add(slot);
    worker.on('message', (reply: WorkerReply) => this.receive(slot, reply));
    worker.on('error', error => this.drop(slot, error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => this.drop(slot, new Error('worker exited with code ' + code)));
    return slot;
  }

  private receive(slot: Slot, reply: WorkerReply): void {
    if ('fatal' in reply) { this.drop(slot, new Error(reply.fatal)); return; }
    const job = slot.job;
    if (!job || reply.id !== job.id) { console.error('Host operation worker (' + this.name + ') sent a reply for no running job'); return; }
    slot.job = undefined;
    if (reply.ok) {
      if (job.settled) { if (!reply.cancelled) console.error('Host operation ' + job.operation.name + ' finished after its caller stopped waiting'); }
      else if (reply.cancelled) settle(job, new HostOperationError('not-started', 'Host operation ' + job.operation.name + ' did not start'));
      else {
        try {
          const value = job.operation.read(reply.result);
          job.settled = true;
          job.resolve(value);
        } catch (error) { settle(job, new HostOperationError('unknown', 'Host operation ' + job.operation.name + ' gave an invalid result (' + errorMessage(error) + ')')); }
      }
    } else {
      const failure = new HostOperationError('failed', reply.error);
      if (job.settled) console.error('Host operation ' + job.operation.name + ' failed after its caller stopped waiting: ' + reply.error);
      else settle(job, failure);
    }
    job.cleanup();
    if (slot.fresh) this.retire(slot);
    this.pump();
    notifyIdle();
  }

  private drop(slot: Slot, error: Error | HostOperationError): void {
    if (!this.slots.delete(slot)) return;
    const job = slot.job;
    slot.job = undefined;
    slot.changes.close();
    void slot.worker.terminate().catch(logFailure('Could not stop a host operation thread'));
    if (job) {
      const failure = error instanceof HostOperationError ? error
        : Atomics.compareExchange(job.progress, 0, QUEUED, CANCELLED) === QUEUED
          ? new HostOperationError('not-started', 'Host operation ' + job.operation.name + ' did not start: ' + errorMessage(error))
          : new HostOperationError('unknown', 'Host operation ' + job.operation.name + ' stopped (' + errorMessage(error) + '); its outcome is unknown');
      if (job.settled) console.error(failure.message);
      else settle(job, failure);
      job.cleanup();
    } else if (!closed && !slot.fresh) console.error('Host operation worker (' + this.name + ') stopped: ' + errorMessage(error));
    this.pump();
    notifyIdle();
  }

  private retire(slot: Slot): void {
    this.slots.delete(slot);
    slot.changes.close();
    slot.worker.removeAllListeners();
    void slot.worker.terminate().catch(logFailure('Could not stop a host operation thread'));
  }

  abandonFresh(job: Job): void {
    const slot = job.slot;
    if (!slot || !slot.fresh || slot.job !== job) return;
    this.drop(slot, new HostOperationError('unknown', 'Stopped the worker of ' + job.operation.name + ' after its caller stopped waiting'));
  }
}

function settle(job: Job, error: HostOperationError): void {
  if (job.settled) return;
  job.settled = true;
  job.reject(error);
}

const lanes: Record<Lane, WorkerLane> = {
  storage: new WorkerLane('storage', 2, false),
  general: new WorkerLane('general', 3, false),
  agents: new WorkerLane('agents', 2, true),
};

function storageRoot(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(root);
}

export interface RunOptions {
  signal?: AbortSignal;
  env?: Record<string, string>;
  storageRoot?: string;
}

export function runHostOperation<Request, Result>(operation: HostOperation<Request, Result>, request: Request, options: RunOptions = {}): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    if (closed) { reject(new HostOperationError('not-started', 'The daemon is shutting down; ' + operation.name + ' did not start')); return; }
    if (options.signal?.aborted) { reject(new HostOperationError('not-started', 'Host operation ' + operation.name + ' was stopped before it started')); return; }
    let storage: Job['storage'];
    if (operation.lane === 'storage') {
      try {
        const root = storageRoot(options.storageRoot ?? profileRoot());
        storage = { root };
      } catch (error) { reject(new HostOperationError('not-started', 'Could not open the storage: ' + errorMessage(error))); return; }
    }
    let finish!: () => void;
    const done = new Promise<void>(release => { finish = release; });
    const lane = lanes[operation.lane];
    const job: Job = {
      id: ++sequence, operation: operation as HostOperation<unknown, unknown>, input: request,
      progress: new Int32Array(new SharedArrayBuffer(4)), env: options.env, storage, settled: false,
      resolve: value => { stop(); resolve(value as Result); },
      reject: error => { stop(); reject(error); },
      done, finish,
      cleanup: () => {
        job.storage = undefined;
        running.delete(job);
        finish();
      },
    };
    const giveUp = (reason: string) => {
      if (job.settled) return;
      if (lane.withdraw(job)) {
        settle(job, new HostOperationError('not-started', 'Host operation ' + operation.name + ' ' + reason + ' before it started'));
        job.cleanup();
        return;
      }
      const cancelled = Atomics.compareExchange(job.progress, 0, QUEUED, CANCELLED) === QUEUED;
      settle(job, cancelled
        ? new HostOperationError('not-started', 'Host operation ' + operation.name + ' ' + reason + ' before it started')
        : new HostOperationError('unknown', 'Host operation ' + operation.name + ' ' + reason + '; its result is unknown (writes may or may not have completed)'));
      if (operation.lane === 'agents') lane.abandonFresh(job);
    };
    const deadline = setTimeout(() => giveUp('timed out after ' + operation.timeout / 1000 + ' seconds'), operation.timeout);
    const abort = () => giveUp('was stopped');
    const stop = () => { clearTimeout(deadline); options.signal?.removeEventListener('abort', abort); };
    options.signal?.addEventListener('abort', abort, { once: true });
    running.add(job);
    lane.submit(job);
  });
}

export function hostOperationsBusy(): boolean { return Object.values(lanes).some(lane => lane.busy()); }

const idleWaiters = new Set<() => void>();

function notifyIdle(): void {
  if (hostOperationsBusy()) return;
  for (const wake of [...idleWaiters]) wake();
}

// True once no host operation runs or waits; false when ms pass first.
export function hostOperationsIdle(ms: number): Promise<boolean> {
  if (!hostOperationsBusy()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (idle: boolean) => { clearTimeout(timer); idleWaiters.delete(wake); resolve(idle); };
    const wake = () => finish(true);
    const timer = setTimeout(() => finish(!hostOperationsBusy()), ms);
    idleWaiters.add(wake);
  });
}

export async function shutdownHostOperations(wait = 10_000): Promise<void> {
  closed = true;
  for (const lane of Object.values(lanes)) lane.rejectQueued('The daemon is shutting down; the operation did not start');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = [...running].map(job => job.done);
  await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
  clearTimeout(timer);
  for (const lane of Object.values(lanes)) lane.terminate();
}
