import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import type { App } from './app';

export async function dispatch(app: App, operation: string, args: any): Promise<any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Plugin arguments must be an object');
  if (JSON.stringify(args).length > 5 * 1024 * 1024) throw new Error('Plugin request is too large');
  if (operation === 'plugin_call') {
    const client = args.clientId;
    if (typeof client !== 'string' || !client || client.length > 200) throw new Error('Missing plugin client identity');
    if (!args.request || typeof args.request !== 'object' || Array.isArray(args.request)) throw new Error('Plugin request must be an object');
    args.request.clientId = client;
  }
  const connected = await connection(app);
  args.type = operation;
  const result = await connected.request(args);
  if (operation === 'plugin_call' && args.pluginId === 'markdown') notifyNoteChange(app, args, result);
  return result;
}

const NOTE_MUTATIONS = new Set(['save', 'claim', 'takeover', 'release']);

/** Tells every client that a chat note or its ownership changed, so viewers refresh without polling. */
function notifyNoteChange(app: App, args: any, result: any): void {
  const sessionId = args.request?.sessionId;
  if (typeof sessionId !== 'string') return;
  if (!NOTE_MUTATIONS.has(args.request?.action) && result?.deleted !== true && result?.disabled !== true) return;
  app.emit('pi://event', { type: 'note_changed', hostId: typeof args.hostId === 'string' ? args.hostId : 'local', sessionId });
}

export async function connection(app: App): Promise<daemon.Daemon> {
  const settings = await loadAppSettings(app);
  return daemon.connect(app, app.pi, app.broker, settings, 'local');
}
