import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import type { App } from './app';

export async function dispatch(app: App, operation: string, args: any): Promise<any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Plugin arguments must be an object');
  const connected = await connection(app);
  return connected.request({ ...args, type: operation });
}

export async function connection(app: App): Promise<daemon.Daemon> {
  const settings = await loadAppSettings(app);
  return daemon.connect(app, app.pi, app.broker, settings, 'local');
}
