import { Host } from './controller';
import { HostServices } from './services';
import type { HostEvents } from './events';
import type { BrokerCall } from '../pi';

export { Host } from './controller';
export type { HostEvents, SessionClosedReport, SessionStateReport } from './events';
export type { AttachRequest, HostConfiguration, MutationEnd, MutationRequest, OrchestrationRequest } from './requests';
export { restartConfiguration, saveConfiguration, validateConfiguration, resolveProviderAuth, type FastModelSnapshot } from './services';
export { GOAL_COMMAND, QUEUE_TOOLS } from './goals';

// Starts the Host, which runs the Pi sessions of this daemon. The daemon calls its methods and hears from it through events.
export function startHost(home: string, storage: string, events: HostEvents, broker: BrokerCall): Promise<Host> {
  return Host.create(home, storage, new HostServices(), events, broker);
}
