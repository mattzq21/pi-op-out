import type { FastModelSnapshot } from './fast_models';
import { PluginService } from './plugins';
import { ProviderService } from './providers';
import type { Host } from '../controller';

export class HostServices {
  private providers: ProviderService;
  private plugins: PluginService;

  constructor() {
    this.providers = new ProviderService();
    this.plugins = new PluginService();
  }

  bind(host: Host): void {
    this.providers.bind(host);
  }

  initialize(): Promise<void> { return this.plugins.initialize(); }

  providerAuth(owner: string, request: unknown): Promise<any> { return this.providers.handle(owner, request ?? null); }

  cancelProviderAuth(owner: string): Promise<void> { return this.providers.cancelOwner(owner); }

  pluginStatus(): Promise<any> { return this.plugins.status(); }
  pluginClient(id: string): Promise<{ source: string }> { return this.plugins.client(id); }

  prepareRestart(request: { enabled: string[]; revision: string }): Promise<{ enabled: string[]; previous: string[] }> { return this.plugins.prepareRestart(request); }

  refreshProviders(): Promise<number> { return this.providers.refresh(); }

  fastModels(): FastModelSnapshot { return this.providers.fastModelSnapshot(); }

  async shutdown(): Promise<void> {
    await this.plugins.shutdown();
    await this.providers.shutdown();
  }
}
