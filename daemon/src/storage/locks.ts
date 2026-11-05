import { AsyncLocalStorage } from 'node:async_hooks';
import { onMainThread, currentCaller, linkedWorker } from '../session-database/index.ts';

export interface LockOptions { shared?: boolean; wait?: boolean; timeoutMs?: number; busy?: string }


// The locks of the daemon's storage. Only the daemon changes its storage, so its locks are in memory: they are kept on
// the main thread, and worker threads ask for them there. A lock is shared or exclusive; waiters get it in turn.
// A worker that ends gives back the locks it holds. The main thread never waits for a lock: a worker that holds it may
// wait for the main thread. It takes a lock only when it is free, or waits with a promise.

const STATE = Symbol.for('piop.storage-locks');

type Owner = ReturnType<typeof currentCaller>;
interface Waiter { shared: boolean; owner: Owner; resolve: (token: number | null) => void; timer?: NodeJS.Timeout }
interface Lock { shared: number; exclusive: boolean; waiters: Waiter[] }
interface Held { name: string; shared: boolean; owner: Owner; finish: () => void }
interface LockState { locks: Map<string, Lock>; tokens: Map<number, Held>; next: number }

function state(): LockState {
  const shared = globalThis as typeof globalThis & { [STATE]?: LockState };
  if (!Object.hasOwn(shared, STATE)) Object.defineProperty(shared, STATE, { value: { locks: new Map(), tokens: new Map(), next: 0 } satisfies LockState });
  return shared[STATE]!;
}

function entry(name: string): Lock {
  const { locks } = state();
  let lock = locks.get(name);
  if (!lock) { lock = { shared: 0, exclusive: false, waiters: [] }; locks.set(name, lock); }
  return lock;
}

function free(lock: Lock, shared: boolean, waiting: Waiter[]): boolean {
  if (lock.exclusive) return false;
  if (shared) return !waiting.some(waiter => !waiter.shared);
  return lock.shared === 0;
}

function grant(name: string, lock: Lock, shared: boolean, owner: Owner): number {
  if (shared) lock.shared++; else lock.exclusive = true;
  const store = state();
  const token = ++store.next;
  const record = { name, shared, owner, finish: () => give(token) };
  store.tokens.set(token, record);
  owner?.end.add(record.finish);
  return token;
}

function give(token: number): void {
  const store = state();
  const record = store.tokens.get(token);
  if (!record) return;
  store.tokens.delete(token);
  record.owner?.end.delete(record.finish);
  const lock = store.locks.get(record.name)!;
  if (record.shared) lock.shared--; else lock.exclusive = false;
  while (lock.waiters.length && free(lock, lock.waiters[0].shared, [])) {
    const waiter = lock.waiters.shift()!;
    clearTimeout(waiter.timer);
    if (waiter.owner?.ended) { waiter.resolve(null); continue; }
    waiter.resolve(grant(record.name, lock, waiter.shared, waiter.owner));
  }
  if (!lock.shared && !lock.exclusive && !lock.waiters.length) store.locks.delete(record.name);
}

const tryTake = onMainThread('storage-locks.try', (name: string, shared: boolean) => {
  const lock = entry(name);
  if (!free(lock, shared, lock.waiters)) { if (!lock.shared && !lock.exclusive && !lock.waiters.length) state().locks.delete(name); return null; }
  return grant(name, lock, shared, currentCaller());
}, { inTransaction: true });

const take = onMainThread('storage-locks.take', (name: string, shared: boolean, timeoutMs?: number) => {
  const owner = currentCaller();
  const lock = entry(name);
  if (free(lock, shared, lock.waiters)) return grant(name, lock, shared, owner);
  return new Promise<number | null>(resolve => {
    const waiter: Waiter = { shared, owner, resolve, timer: undefined };
    if (timeoutMs !== undefined) waiter.timer = setTimeout(() => {
      lock.waiters.splice(lock.waiters.indexOf(waiter), 1);
      if (!lock.shared && !lock.exclusive && !lock.waiters.length) state().locks.delete(name);
      resolve(null);
    }, timeoutMs);
    lock.waiters.push(waiter);
  });
}, { inTransaction: true });

const giveBack = onMainThread('storage-locks.give', give, { inTransaction: true });

// The locks that each flow holds. A flow is one storage job; inside it, code that takes a lock the flow holds gets it
// again at once. Outside a flow, every take is a new one.
const flows = new AsyncLocalStorage<Map<string, { token: number; shared: boolean; count: number }>>();

// Runs operation as one flow.
function withinFlow<T>(operation: () => T): T { return flows.run(new Map(), operation); }

function release(held: Map<string, { token: number; shared: boolean; count: number }> | undefined, name: string, token: number): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const mine = held?.get(name);
    if (mine && --mine.count > 0) return;
    held?.delete(name);
    giveBack(token);
  };
}

function reentered(name: string, shared: boolean): (() => void) | undefined {
  const held = flows.getStore();
  const mine = held?.get(name);
  if (!mine || (!shared && mine.shared)) return undefined;
  mine.count++;
  return release(held, name, mine.token);
}

function taken(name: string, shared: boolean, token: number | null | undefined): (() => void) | undefined {
  if (token === null || token === undefined) return undefined;
  const held = flows.getStore();
  held?.set(name, { token, shared, count: 1 });
  return release(held, name, token);
}

// Takes the lock name and returns its release, or undefined when it is busy and wait is false or the time ended.
// The main thread cannot wait here: it fails with busy when the lock is taken.
function lockSync(name: string, { shared = false, wait = true, timeoutMs, busy = 'This storage is busy. Try again.' }: LockOptions = {}): (() => void) | undefined {
  const again = reentered(name, shared);
  if (again) return again;
  // A worker gets the answer of the main thread, not its promise.
  if (linkedWorker() && wait) return taken(name, shared, take(name, shared, timeoutMs) as number | null);
  const release = taken(name, shared, tryTake(name, shared));
  if (!release && wait && !linkedWorker()) throw new Error(busy);
  return release;
}

// Takes the lock name and returns its release, or undefined when it is busy and wait is false or the time ended.
async function lock(name: string, { shared = false, wait = true, timeoutMs }: Omit<LockOptions, 'busy'> = {}): Promise<(() => void) | undefined> {
  const again = reentered(name, shared);
  if (again) return again;
  if (!wait) return taken(name, shared, tryTake(name, shared));
  return taken(name, shared, await take(name, shared, timeoutMs));
}

export { lockSync, lock, withinFlow };
