import type { McpServerConnection } from '@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js';
import { patchMethod } from '../pi/index.ts';

type ConnectionListener = (connection: McpServerConnection) => void;

const key = Symbol.for('piop.mcp-connections');
const shared = globalThis as typeof globalThis & { [key]?: Set<ConnectionListener> };
const listeners = shared[key] ??= new Set();
const installed = new WeakSet<typeof McpServerConnection>();

function subscribeConnections(listener: ConnectionListener): () => boolean {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function installConnectionEvents(Connection: typeof McpServerConnection): void {
  if (installed.has(Connection)) return;
  patchMethod(Connection.prototype, 'changed', changed => function (this: any, ...args) {
    const result = changed.apply(this, args);
    for (const listener of listeners) listener(this);
    return result;
  });
  installed.add(Connection);
}

export { installConnectionEvents, subscribeConnections };
