import { Notify, sleep } from './util/sync';
import * as daemonRestart from './daemon_restart';
import type { App } from './app';

/** Counts connected clients and decides when an unattended daemon may stop. */
export class DaemonClients {
  private count = 0;
  private closingFlag = false;
  private automaticFlag = process.argv.includes('--exit-on-disconnect') || process.env.PIOP_RESTART_AUTOMATIC !== undefined;
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

  automatic(): boolean { return this.automaticFlag; }

  persist(): void {
    if (this.closingFlag) throw new Error('Piop daemon is shutting down');
    this.automaticFlag = false;
  }

  stop(): void { this.closingFlag = true; this.stopped.notifyOne(); }

  connect(): { release(): void } {
    if (this.closingFlag) throw new Error('Piop daemon is shutting down');
    this.count += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.count -= 1;
        if (this.automaticFlag && this.count === 0) this.stopped.notifyOne();
      },
    };
  }

  closing(): boolean { return this.closingFlag; }

  private unattended(): boolean { return this.automaticFlag && this.count === 0; }

  private wait(ms: number): Promise<void> { const controller = new AbortController(); return Promise.race([this.stopped.notified(controller.signal), sleep(ms)]).finally(() => controller.abort()); }

  async waitForShutdown(app: App): Promise<void> {
    await this.wait(30_000);
    for (;;) {
      if (this.closingFlag) return;
      if (this.unattended() && await this.stopIfIdle(app)) return;
      await this.wait(1000);
    }
  }

  private async stopIfIdle(app: App): Promise<boolean> {
    const release = app.restart.gate.tryWrite();
    if (!release) return false;
    try {
      try { await daemonRestart.ensureLocalIdle(app); } catch { return false; }
      if (this.unattended()) { this.stop(); return true; }
      return false;
    } finally { release(); }
  }
}
