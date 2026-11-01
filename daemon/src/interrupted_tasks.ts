import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { buildPiCommand, launchSpec } from './pi_launch';
import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import * as Registry from './session_registry';
import { errorText } from './util/sync';
import type { App } from './app';

export async function resumeInterruptedTasks(app: App): Promise<void> {
  const ids = Registry.runningTasks(join(homeDir(), STORAGE_DIRECTORY));
  if (!ids.length) return;
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, app.broker, settings, 'local');
  await Promise.all(ids.map(async id => {
    try {
      const location = await connection.request({ type: 'orchestration', action: 'locate', sessionKey: id }).catch(() => null);
      const packet: any = { type: 'orchestration', action: 'resume', sessionKey: id };
      if (typeof location?.sessionPath === 'string' && typeof location?.cwd === 'string' && location.archived !== true) {
        packet.spec = launchSpec(buildPiCommand(settings, 'local', { kind: 'rpc', cwd: location.cwd, sessionPath: location.sessionPath }, connection.remotePort));
        packet.cwd = location.cwd;
      }
      await connection.request(packet);
    } catch (error) {
      const line = 'Could not start again the interrupted task of chat ' + id + ': ' + errorText(error);
      console.error(line);
      app.emit('pi://daemon-error', { hostId: 'local', line });
    }
  }));
}
