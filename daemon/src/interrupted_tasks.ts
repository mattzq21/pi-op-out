import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { buildPiCommand, launchSpec } from './pi_launch';
import { loadAppSettings } from './settings';
import { localHost } from './local_host';
import type { OrchestrationRequest } from './host/index';
import * as Registry from './session_registry';
import { errorText, logFailure } from './util/sync';
import type { App } from './app';

export async function resumeInterruptedTasks(app: App): Promise<void> {
  const ids = Registry.runningTasks(join(homeDir(), STORAGE_DIRECTORY));
  if (!ids.length) return;
  const settings = await loadAppSettings(app);
  const host = localHost(app).host;
  await Promise.all(ids.map(async id => {
    try {
      const location = await host.orchestrate({ action: 'locate', sessionKey: id }).catch(error => { logFailure('Could not find the chat of interrupted task ' + id)(error); return null; });
      const request: OrchestrationRequest = { action: 'resume', sessionKey: id };
      if (typeof location?.sessionPath === 'string' && typeof location?.cwd === 'string' && location.archived !== true) {
        request.spec = launchSpec(await buildPiCommand(settings, { kind: 'rpc', cwd: location.cwd, sessionPath: location.sessionPath }));
        request.cwd = location.cwd;
      }
      await host.orchestrate(request);
    } catch (error) {
      const line = 'Could not start again the interrupted task of chat ' + id + ': ' + errorText(error);
      console.error(line);
      app.emit('pi://daemon-error', { hostId: 'local', line });
    }
  }));
}
