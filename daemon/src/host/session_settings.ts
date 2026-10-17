import { Mutex, errorText } from '../util/sync';
import { clone, jsonEqual, kind } from './json';
import type { Session, SessionHost } from './session';

/** Applies the host's saved settings to a running session while it is idle, and reports settings that cannot be applied. */
export class SessionSettings {
  private gate = new Mutex();
  private applied: any | null = null;
  private failure: string | null = null;
  private applyingValue = false;
  private autoCompaction: boolean | null = null;
  private autoRetry: boolean | null = null;

  constructor(private session: Session, private host: SessionHost) {}

  /** True when the host has settings that this session does not have yet. */
  pending(): boolean {
    const configuration = this.host.configuration();
    return configuration !== null && configuration !== undefined && !(this.applied !== null && jsonEqual(this.applied, configuration));
  }

  /** The error of the last failed attempt, while the settings are still not applied. */
  error(): string | null {
    const error = this.failure;
    return error !== null && this.pending() ? error : null;
  }

  /** The error of the last failed attempt. */
  lastError(): string | null { return this.failure; }

  applying(): boolean { return this.applyingValue; }

  /** Records the automatic options that a command sent to Pi sets. */
  remember(command: any): void {
    if (kind(command) === 'set_auto_compaction') this.autoCompaction = typeof command.enabled === 'boolean' ? command.enabled : null;
    if (kind(command) === 'set_auto_retry') this.autoRetry = typeof command.enabled === 'boolean' ? command.enabled : null;
  }

  /** Applies pending settings when the session is idle. After a failure, it waits for retry. */
  async reconcile(retry: boolean): Promise<void> {
    const session = this.session;
    if (retry) this.failure = null;
    if (session.transient() || session.closed() || session.stopping() || !this.pending()) return;
    const release = await this.gate.lock();
    try {
      if (this.failure !== null || session.busy(null) || !this.pending()) return;
      this.applyingValue = true;
      try { await this.apply(); } catch (error) { this.failed(errorText(error)); }
      this.applyingValue = false;
      session.publish({ type: 'settings_pending', pending: this.pending() }, null);
    } finally { release(); }
  }

  private failed(error: string): void {
    const session = this.session;
    if (session.closed() || session.stopping() || session.busy(null)) return;
    const message = 'Saved settings could not be applied: ' + error + '. Save again or reopen the conversation to retry.';
    this.failure = message;
    const revision = this.host.configuration()?.agentRevision;
    session.publish({ type: 'extension_error', error: message, agentRevision: typeof revision === 'number' ? revision : 0 }, null);
    if (!session.viewsList.length) this.host.output({ type: 'diagnostic', line: 'Could not apply settings to ' + session.key + ': ' + error });
  }

  private async apply(): Promise<void> {
    const session = this.session;
    const release = await session.queue.gate.lock();
    try {
      while (!session.closed() && !session.stopping() && this.pending()) {
        const observed = await session.raw({ type: 'get_state' });
        if (session.busy(observed)) return;
        const configuration = clone(this.host.configuration());
        if (configuration === null || configuration === undefined) return;
        const revision = typeof configuration.agentRevision === 'number' ? configuration.agentRevision : 0;
        await session.executeWorker({ type: 'context_cap_settings', settings: configuration.contextCapSettings });
        await this.applyAutomaticOptions(configuration);
        this.applied = configuration;
        session.publish({ type: 'settings_applied', agentRevision: revision }, null);
      }
    } finally { release(); }
  }

  private async applyAutomaticOptions(configuration: any): Promise<void> {
    const compaction = typeof configuration.autoCompaction === 'boolean' ? configuration.autoCompaction : null;
    const retry = typeof configuration.autoRetry === 'boolean' ? configuration.autoRetry : null;
    if (this.autoCompaction !== compaction) await this.session.executeWorker({ type: 'set_auto_compaction', enabled: configuration.autoCompaction ?? null });
    if (this.autoRetry !== retry) await this.session.executeWorker({ type: 'set_auto_retry', enabled: configuration.autoRetry ?? null });
  }
}
