import { Notify, sleep } from '../util/sync';
import * as daemonRestart from '../restart';
import type { App } from '../app';
import { UNUSED_STOP_MS } from '../config';

export class DaemonClients {
  constructor(private readonly onStop: () => void, private readonly onLastDisconnect: () => void, private readonly unusedDelay = UNUSED_STOP_MS) {}

  private count = 0;
  private closingFlag = false;
  private unusedSince = Date.now();
  private stopped = new Notify();
  private requests = 0;
  private drained = new Set<() => void>();

  beginRequest(): () => void {
    this.ensureOpen();
    this.requests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.requests -= 1;
      if (!this.requests) for (const resolve of this.drained) resolve();
    };
  }

  ensureOpen(): void {
    if (this.closingFlag) throw new Error('Piop daemon is shutting down');
  }

  async drain(ms: number): Promise<void> {
    if (!this.requests) return;
    let done!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        done = resolve;
        this.drained.add(done);
        timer = setTimeout(() => reject(new Error('Daemon requests did not finish within ' + ms + ' ms')), ms);
      });
    } finally { clearTimeout(timer); this.drained.delete(done); }
  }

  stop(): void {
    if (this.closingFlag) return;
    this.onStop();
    this.closingFlag = true;
    this.stopped.notifyOne();
  }

  connect(): { release(): void } {
    if (this.closingFlag) throw new Error('Piop daemon is shutting down');
    this.count += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.count -= 1;
        if (this.count === 0) {
          this.unusedSince = Date.now();
          try { this.onLastDisconnect(); }
          finally { if (this.unusedDelay !== undefined) this.stopped.notifyOne(); }
        }
      },
    };
  }

  closing(): boolean { return this.closingFlag; }

  private untilUnattended(): number | undefined {
    if (this.count > 0) return undefined;
    if (this.unusedDelay === undefined) return undefined;
    return Math.max(0, this.unusedSince + this.unusedDelay - Date.now());
  }

  private unattended(): boolean { return this.untilUnattended() === 0; }

  private wait(ms?: number): Promise<void> {
    if (ms === undefined) return this.stopped.notified();
    const controller = new AbortController();
    return Promise.race([this.stopped.notified(controller.signal), sleep(ms)]).finally(() => controller.abort());
  }

  async waitForShutdown(app: App, ensureIdle: () => Promise<void> = () => daemonRestart.ensureUnattendedIdle(app)): Promise<void> {
    for (;;) {
      if (this.closingFlag) return;
      if (this.unattended() && await this.stopIfIdle(app, ensureIdle)) return;
      const remaining = this.untilUnattended();
      await this.wait(remaining === 0 ? 1000 : remaining);
    }
  }

  private async stopIfIdle(app: App, ensureIdle: () => Promise<void>): Promise<boolean> {
    const release = app.restart.gate.tryWrite();
    if (!release) return false;
    try {
      try { await ensureIdle(); } catch { return false; }
      if (this.unattended()) { this.stop(); return true; }
      return false;
    } finally { release(); }
  }
}
