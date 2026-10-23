export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  get isLocked(): boolean { return this.locked; }

  async lock(): Promise<() => void> {
    if (!this.locked) { this.locked = true; return this.releaser(); }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    return this.releaser();
  }

  tryLock(): (() => void) | undefined {
    if (this.locked) return undefined;
    this.locked = true;
    return this.releaser();
  }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = await this.lock();
    try { return await operation(); } finally { release(); }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); else this.locked = false;
    };
  }
}

export class RwLock {
  private readers = 0;
  private writer = false;
  private queue: Array<{ write: boolean; resolve: () => void }> = [];

  tryRead(): (() => void) | undefined {
    if (this.writer || this.queue.some(entry => entry.write)) return undefined;
    this.readers += 1;
    return this.readRelease();
  }

  tryWrite(): (() => void) | undefined {
    if (this.writer || this.readers > 0) return undefined;
    this.writer = true;
    return this.writeRelease();
  }

  async read(): Promise<() => void> {
    const release = this.tryRead();
    if (release) return release;
    await new Promise<void>(resolve => this.queue.push({ write: false, resolve }));
    return this.readRelease();
  }

  async write(): Promise<() => void> {
    const release = this.tryWrite();
    if (release) return release;
    await new Promise<void>(resolve => this.queue.push({ write: true, resolve }));
    return this.writeRelease();
  }

  async writeWithin(ms: number, message: string): Promise<() => void> {
    const release = this.tryWrite();
    if (release) return release;
    await new Promise<void>((resolve, reject) => {
      const entry = { write: true, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new Error(message));
        this.drain();
      }, ms);
      this.queue.push(entry);
    });
    return this.writeRelease();
  }

  private readRelease(): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.readers -= 1; this.drain(); };
  }

  private writeRelease(): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.writer = false; this.drain(); };
  }

  private drain(): void {
    while (this.queue.length) {
      const next = this.queue[0]!;
      if (next.write) {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        next.resolve();
        return;
      }
      if (this.writer) return;
      this.queue.shift();
      this.readers += 1;
      next.resolve();
    }
  }
}

export class Notify {
  private waiters: Array<() => void> = [];
  private permit = false;

  notified(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.permit) { this.permit = false; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  notifyOne(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.permit = true;
  }

  notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export class Channel<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  send(item: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item); else this.items.push(item);
    return true;
  }

  recv(): Promise<T | undefined> {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  tryRecv(): T | undefined { return this.items.shift(); }

  get length(): number { return this.items.length; }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = await this.recv();
      if (item === undefined) return;
      yield item;
    }
  }
}
