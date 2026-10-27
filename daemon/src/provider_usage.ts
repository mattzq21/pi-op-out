import type { App } from './app';
import { anthropicUsage } from './provider_anthropic';
import { codexUsage } from './provider_codex';
import { opencodeGoUsage } from './provider_opencode';

const SOURCES = { codex: codexUsage, anthropic: anthropicUsage, opencodeGo: opencodeGoUsage };
type Provider = keyof typeof SOURCES;

/** The last usage a provider reported, if any. error: why the latest refresh failed, so the usage is stale. */
export interface ProviderUsage { usage?: unknown; error?: string }
export type UsageSnapshot = Partial<Record<Provider, ProviderUsage>>;

export const USAGE_CHANGED = 'pi://usage-changed';
const INTERVAL_MS = Number(process.env.PIOP_USAGE_REFRESH_MS ?? 30_000);

/**
 * Plan usage of every provider, shared by all clients of this daemon. It refreshes at start, every 30 seconds
 * and when a client asks; one refresh per provider runs at a time.
 */
export class UsageRuntime {
  private state: UsageSnapshot = {};
  private failures = new Map<Provider, string>();
  private running = new Map<Provider, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  start(app: App): void {
    if (!(INTERVAL_MS > 0)) return;
    void this.refresh(app);
    this.timer = setInterval(() => void this.refresh(app), INTERVAL_MS);
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  snapshot(): UsageSnapshot { return structuredClone(this.state); }

  async refresh(app: App): Promise<UsageSnapshot> {
    await Promise.all((Object.keys(SOURCES) as Provider[]).map(provider => this.refreshProvider(app, provider)));
    return this.snapshot();
  }

  private refreshProvider(app: App, provider: Provider): Promise<void> {
    const current = this.running.get(provider);
    if (current) return current;
    const work = SOURCES[provider]().then(
      usage => { this.failures.delete(provider); this.update(app, provider, { usage }); },
      error => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures.get(provider) !== message) console.error('Usage of ' + provider + ' could not refresh: ' + message);
        this.failures.set(provider, message);
        const previous = this.state[provider]?.usage;
        this.update(app, provider, previous === undefined ? { error: message } : { usage: previous, error: message });
      },
    ).finally(() => this.running.delete(provider));
    this.running.set(provider, work);
    return work;
  }

  private update(app: App, provider: Provider, next: ProviderUsage): void {
    if (JSON.stringify(this.state[provider]) === JSON.stringify(next)) return;
    this.state[provider] = next;
    app.emit(USAGE_CHANGED, this.snapshot());
  }
}
