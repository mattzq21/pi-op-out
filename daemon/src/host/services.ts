import { kind, text } from './json';
import { PluginService } from './plugins';
import { ProviderService } from './providers';
import type { Host } from './controller';

/** Groups the provider login service and the plugin service that one host uses. */
export class HostServices {
  private providers: ProviderService;
  private plugins: PluginService;

  constructor(executable: string) {
    this.providers = new ProviderService(executable);
    this.plugins = new PluginService(executable);
  }

  bind(host: Host): void {
    this.plugins.bind(host);
    this.providers.bind(host);
  }

  initialize(): Promise<void> { return this.plugins.initialize(); }

  async handle(packet: any): Promise<any> {
    switch (kind(packet)) {
      case 'provider_auth': return this.providers.handle(text(packet, 'owner'), packet.request ?? null);
      case 'plugin_call': case 'plugin_status': case 'plugin_idle': case 'prepare_daemon_restart': return this.plugins.handle(packet);
      case 'provider_auth_cancel_owner': await this.providers.cancelOwner(text(packet, 'owner')); return null;
      default: throw new Error('Unknown host service operation');
    }
  }

  refreshProviders(): Promise<number> { return this.providers.refresh(); }

  async shutdown(): Promise<void> {
    await this.plugins.shutdown();
    await this.providers.shutdown();
  }
}
