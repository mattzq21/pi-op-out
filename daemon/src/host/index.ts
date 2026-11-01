import { errorText } from '../util/sync';
import { Host } from './controller';
import { HostServices } from './services';
import type { BrokerCall } from '../broker';

export { restartConfiguration, validateConfiguration } from './plugins';
export { resolveProviderAuth } from './provider_sdk';

export interface Supervisor {
  input(packet: any): void;
  finished: Promise<void>;
}

export async function start(home: string, storage: string, executable: string, output: (packet: any) => void, broker: BrokerCall): Promise<Supervisor> {
  const host = await Host.create(home, storage, new HostServices(executable), output, broker);
  let stopping = false;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const input = (packet: any) => {
    if (stopping) return;
    if (packet?.type === 'shutdown') {
      stopping = true;
      host.shutdown().catch(error => console.error('Host shutdown failed: ' + errorText(error))).finally(finish);
      return;
    }
    const id = packet && typeof packet === 'object' && Object.hasOwn(packet, 'id') ? packet.id : undefined;
    void (async () => {
      let response: any;
      try { response = { type: 'response', data: await host.handle(packet) ?? null }; } catch (error) { response = { type: 'response', error: errorText(error) }; }
      if (stopping) return;
      if (id !== undefined) response.id = id;
      host.output(response);
    })();
  };
  return { input, finished };
}
