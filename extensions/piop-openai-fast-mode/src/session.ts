import type { FastModeSession } from "./types";

type Subscriber = { listener: (enabled: boolean) => void; onError: (error: Error) => void };

const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));

/** Keeps the saved choice for the current Pi session and tells subscribers about changes. */
export class FastModeSessionState implements FastModeSession {
  private enabled = false;
  private loaded!: Promise<void>;
  private settle!: (error?: Error) => void;
  private settled = true;
  private subscribers = new Set<Subscriber>();

  constructor(private save: (enabled: boolean) => void, private changed: (enabled: boolean) => void) {
    this.reset();
  }

  /** Holds requests until the next load, for example when Pi switches to another session. */
  reset(): void {
    if (!this.settled) return;
    this.settled = false;
    this.loaded = new Promise((resolve, reject) => { this.settle = error => error ? reject(error) : resolve(); });
    this.loaded.catch(() => undefined);
  }

  load(enabled: boolean): void {
    const changed = enabled !== this.enabled;
    this.enabled = enabled;
    if (!this.settled) { this.settled = true; this.settle(); } else this.loaded = Promise.resolve();
    if (changed) this.publish();
  }

  fail(cause: unknown): void {
    const error = asError(cause);
    if (!this.settled) { this.settled = true; this.settle(error); }
    else this.loaded = Promise.reject(error);
    this.loaded.catch(() => undefined);
    for (const subscriber of [...this.subscribers]) subscriber.onError(error);
  }

  async getEnabled(): Promise<boolean> {
    await this.loaded;

    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.loaded;

    if (enabled === this.enabled) return;
    this.save(enabled);
    this.enabled = enabled;
    this.publish();
  }

  subscribe(listener: (enabled: boolean) => void, onError: (error: Error) => void): () => void {
    const subscriber = { listener, onError };
    this.subscribers.add(subscriber);
    this.loaded.then(() => { if (this.subscribers.has(subscriber)) this.send(subscriber); }, error => { if (this.subscribers.has(subscriber)) onError(asError(error)); });

    return () => { this.subscribers.delete(subscriber); };
  }

  private send(subscriber: Subscriber): void {
    try { subscriber.listener(this.enabled); } catch (cause) { subscriber.onError(asError(cause)); }
  }

  private publish(): void {
    this.changed(this.enabled);
    for (const subscriber of [...this.subscribers]) this.send(subscriber);
  }
}
