import type { App } from './app';
import { anthropicUsage } from './provider_anthropic';
import { codexUsage } from './provider_codex';
import { opencodeGoUsage } from './provider_opencode';

const SOURCES: Record<'codex' | 'anthropic' | 'opencodeGo', UsageSource> = { codex: codexUsage, anthropic: anthropicUsage, opencodeGo: opencodeGoUsage };
export type Provider = keyof typeof SOURCES;
export const isUsageProvider = (value: string): value is Provider => Object.hasOwn(SOURCES, value);

export type UsageSource = () => Promise<unknown>;

export interface ProviderUsage { usage?: unknown; error?: string }
export type UsageSnapshot = Partial<Record<Provider, ProviderUsage>>;

export const USAGE_CHANGED = 'pi://usage-changed';
const INTERVAL_MS = Number(process.env.PIOP_USAGE_REFRESH_MS ?? 5 * 60_000);
const MIN_GAP_MS = 60_000;

export class UsageRuntime {
  private state: UsageSnapshot = {};
  private failures = new Map<Provider, string>();
  private running = new Map<Provider, Promise<void>>();
  private readAt = new Map<Provider, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  start(app: App): void {
    if (!(INTERVAL_MS > 0)) return;
    void this.refresh(app);
    this.timer = setInterval(() => void this.refresh(app), INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.running.values()]);
  }

  snapshot(): UsageSnapshot { return structuredClone(this.state); }

  async refresh(app: App, only?: Provider, all = false): Promise<UsageSnapshot> {
    const now = Date.now();
    const recent = (provider: Provider) => !all && !this.running.has(provider) && now - (this.readAt.get(provider) ?? -Infinity) < MIN_GAP_MS;
    const providers = only ? [only] : (Object.keys(SOURCES) as Provider[]).filter(provider => !recent(provider));
    await Promise.all(providers.map(provider => this.refreshProvider(app, provider)));
    return this.snapshot();
  }

  private refreshProvider(app: App, provider: Provider): Promise<void> {
    const current = this.running.get(provider);
    if (current) return current;
    if (this.stopped) return Promise.resolve();
    this.readAt.set(provider, Date.now());
    const work = SOURCES[provider]().then(
      usage => { this.failures.delete(provider); this.update(app, provider, usage === undefined ? undefined : { usage }); },
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

  private update(app: App, provider: Provider, next: ProviderUsage | undefined): void {
    if (JSON.stringify(this.state[provider]) === JSON.stringify(next)) return;
    if (next === undefined) delete this.state[provider]; else this.state[provider] = next;
    app.emit(USAGE_CHANGED, this.snapshot());
  }
}
