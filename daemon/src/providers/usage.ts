import type { App } from '../app';
import { anthropicUsage } from './anthropic';
import { codexUsage } from './codex';
import { opencodeGoUsage } from './opencode';
import { opencodexUsage } from './opencodex';
import { isUsageIndicator, USAGE_INDICATORS, type UsageIndicator } from '../settings';

const SOURCES: Record<UsageIndicator, UsageSource> = { codex: codexUsage, anthropic: anthropicUsage, opencodeGo: opencodeGoUsage, opencodex: opencodexUsage };
export type Provider = UsageIndicator;
export const isUsageProvider = isUsageIndicator;

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
  private hidden = new Set<Provider>();

  start(app: App, hidden: readonly Provider[]): void {
    this.hidden = new Set(hidden);
    app.listenAny('pi://settings-changed', change => {
      const list = change?.settings?.hiddenUsageIndicators;
      if (Array.isArray(list)) this.setHidden(app, list.filter(isUsageIndicator));
    });
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

  private setHidden(app: App, list: Provider[]): void {
    if (this.stopped) return;
    const next = new Set(list);
    const shown = USAGE_INDICATORS.filter(provider => this.hidden.has(provider) && !next.has(provider));
    const hidden = USAGE_INDICATORS.filter(provider => !this.hidden.has(provider) && next.has(provider));
    this.hidden = next;
    for (const provider of hidden) {
      this.failures.delete(provider);
      if (provider in this.state) { delete this.state[provider]; app.emit(USAGE_CHANGED, this.snapshot()); }
    }
    for (const provider of shown) void this.refreshProvider(app, provider);
  }

  snapshot(): UsageSnapshot { return structuredClone(this.state); }

  async refresh(app: App, only?: Provider, all = false): Promise<UsageSnapshot> {
    const now = Date.now();
    const recent = (provider: Provider) => !all && !this.running.has(provider) && now - (this.readAt.get(provider) ?? -Infinity) < MIN_GAP_MS;
    const providers = (only ? [only] : USAGE_INDICATORS.filter(provider => !recent(provider))).filter(provider => !this.hidden.has(provider));
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
    if (this.hidden.has(provider)) return;
    if (JSON.stringify(this.state[provider]) === JSON.stringify(next)) return;
    if (next === undefined) delete this.state[provider]; else this.state[provider] = next;
    app.emit(USAGE_CHANGED, this.snapshot());
  }
}
