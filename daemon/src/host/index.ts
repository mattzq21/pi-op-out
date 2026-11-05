import { Host } from './controller';
import { HostServices } from './services';
import type { HostEvents } from './events';
import type { BrokerCall } from '../broker';

export { Host } from './controller';
export type { HostEvents, SessionClosedReport, SessionStateReport } from './events';
export type { AttachRequest, HostConfiguration, MutationEnd, MutationRequest, OrchestrationRequest } from './requests';
export { restartConfiguration, saveConfiguration, validateConfiguration } from './plugins';
export { resolveProviderAuth } from './provider_sdk';

// Starts the Host, which runs the Pi sessions of this daemon. The daemon calls its methods and hears from it through events.
export function startHost(home: string, storage: string, events: HostEvents, broker: BrokerCall): Promise<Host> {
  return Host.create(home, storage, new HostServices(), events, broker);
}
