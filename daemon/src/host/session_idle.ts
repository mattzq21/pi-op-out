import { errorText } from '../util/sync';
import { flag } from './json';
import type { Session, SessionHost } from './session';

const IDLE_STOP_DELAY_MS = 120_000;

/** Stops a session after it stays idle for two minutes, when the host allows it. */
export class IdleStop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private checkingValue = false;

  constructor(private session: Session, private host: SessionHost) {}

  /** True while the final idle check runs. Its own state requests must not cancel it. */
  checking(): boolean { return this.checkingValue; }

  cancel(): void {
    this.revision += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Starts the delay when the session is idle, and cancels it when the session is not idle. */
  schedule(): void {
    if (this.checkingValue) return;
    if (!this.session.idle()) { this.cancel(); return; }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.stop().catch(error => {
        this.host.output({ type: 'diagnostic', line: 'Could not stop idle session ' + this.session.key + ': ' + errorText(error) });
      });
    }, IDLE_STOP_DELAY_MS);
  }

  private async stop(): Promise<void> {
    const session = this.session;
    this.checkingValue = true;
    const revision = this.revision;
    const release = await session.queue.gate.lock();
    try {
      if (!session.idle() || !this.host.canStopIdle(session)) return;
      const state = await session.execute({ type: 'get_state' });
      if (revision !== this.revision) return;
      if (!session.idle() || session.busy(state) || flag(state, 'isPausing') || !this.host.canStopIdle(session)) return;
      await session.stop();
    } finally {
      this.checkingValue = false;
      release();
      if (revision !== this.revision) this.schedule();
    }
  }
}
