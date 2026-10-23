import { Mutex, errorText } from '../util/sync';

export type FastModelScanResult =
  | Readonly<{ provider: string; status: 'ok'; supportedModelIds: readonly string[]; context: string }>
  | Readonly<{ provider: string; status: 'error'; message: string; context?: string }>;

/**
 * Finds the models that accept fast mode, with one host's model runtime and logins.
 * Omit provider to scan all registered providers that the module supports; supply it to scan one.
 * Unsupported providers produce no result; an unknown provider produces an error result.
 * context identifies the provider's account and configuration at the end of the scan.
 * An error result has no context when the login could not be read; the saved login is then unchanged.
 * Failures that stop the whole scan reject. Every call attempts discovery.
 */
export interface FastModelDiscovery {
  scan(provider?: string): Promise<readonly FastModelScanResult[]>;
}

/** What the host knows about fast models. ready is false until the first full scan finishes. */
export type FastModelSnapshot = {
  ready: boolean;
  providers: Record<string, { supportedModelIds: string[]; error?: string }>;
  error?: string;
};

type Saved = { context: string; supportedModelIds: string[]; error?: string };

/** Saves one host's fast model results per provider and account/configuration context. */
export class FastModelStore {
  private saved = new Map<string, Saved>();
  private ready = false;
  private failure: string | undefined;
  private scans = new Mutex();

  constructor(private discovery: FastModelDiscovery, private changed: () => void) {}

  /** Scans and saves the results. A failed scan is reported in the snapshot; the last good results stay. */
  scan(provider?: string): Promise<void> {
    return this.scans.run(() => this.scanNow(provider));
  }

  private async scanNow(provider?: string): Promise<void> {
    const before = JSON.stringify(this.snapshot());
    try {
      const results = await this.discovery.scan(provider);
      for (const result of results) this.apply(result);
      if (provider === undefined) {
        const scanned = new Set(results.map(result => result.provider));
        for (const id of [...this.saved.keys()]) if (!scanned.has(id)) this.saved.delete(id);
        this.ready = true;
      }
      this.failure = undefined;
    } catch (error) {
      this.failure = 'Fast model scan failed: ' + errorText(error);
    }
    if (JSON.stringify(this.snapshot()) !== before) this.changed();
  }

  private apply(result: FastModelScanResult): void {
    if (result.status === 'ok') {
      this.saved.set(result.provider, { context: result.context, supportedModelIds: [...result.supportedModelIds] });
      return;
    }
    const previous = this.saved.get(result.provider);
    const context = result.context ?? previous?.context;
    const kept = previous !== undefined && previous.context === context ? previous.supportedModelIds : [];
    this.saved.set(result.provider, { context: context ?? '', supportedModelIds: kept, error: result.message });
  }

  snapshot(): FastModelSnapshot {
    const providers: FastModelSnapshot['providers'] = {};
    for (const [id, saved] of [...this.saved].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      providers[id] = saved.error === undefined ? { supportedModelIds: [...saved.supportedModelIds] } : { supportedModelIds: [...saved.supportedModelIds], error: saved.error };
    }
    return this.failure === undefined ? { ready: this.ready, providers } : { ready: this.ready, providers, error: this.failure };
  }
}
