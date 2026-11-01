import { Notify, sleep } from './util/sync';
import * as daemonRestart from './daemon_restart';
import type { App } from './app';
import { DEVELOPMENT } from './config';

/**
 * How long a daemon without clients keeps running before it stops. Debug builds stop after 5 seconds; test daemons set PIOP_UNUSED_STOP_MS.
 * Release daemons never stop by themselves.
 */
function unusedStopDelay(): number | undefined {
  const value = process.env.PIOP_UNUSED_STOP_MS;
  if (value !== undefined) {
    const delay = Number(value);
    if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error('PIOP_UNUSED_STOP_MS must be a positive whole number of milliseconds');
    return delay;
  }
  return DEVELOPMENT ? 5_000 : undefined;
}

/** Counts connected clients and decides when an unattended daemon may stop. */
export class DaemonClients {
  constructor(private readonly onStop: () => void, private readonly onLastDisconnect: () => void, private readonly unusedDelay = unusedStopDelay()) {}

  private count = 0;
  private closingFlag = false;
  /** When the last client left, or when the daemon started. */
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

  /** Milliseconds until a daemon without clients may stop: 0 when it may stop now, undefined when only a client change or stop() can change it. */
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

  /**
   * Resolves when the daemon should stop. Wakes on stop(), on the last client leaving and when the unused delay ends. A short retry timer runs only
   * while an unattended daemon still has work (an agent, a storage operation or a plugin) that keeps it from stopping. Terminals do not keep it running.
   */
  async waitForShutdown(app: App, ensureIdle: () => Promise<void> = () => daemonRestart.ensureUnattendedIdle(app)): Promise<void> {
    for (;;) {
      if (this.closingFlag) return;
      if (this.unattended() && await this.stopIfIdle(app, ensureIdle)) return;
      // An unattended daemon that still has work tries again each second; otherwise it wakes when its unused delay ends.
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
