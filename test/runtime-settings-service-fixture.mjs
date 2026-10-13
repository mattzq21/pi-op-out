import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonClient } from './daemon-client.mjs';

export async function runtimeSettingsPath(t) {
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('./fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home, cwd: home, content: '' }),
  }));
  const runtimeId = 'settings-bootstrap';
  await daemon.invoke('start_pi', { runtimeId, clientId: 'settings-bootstrap', cwd: home, sessionPath: chat.path, presence: { readOnly: true } });
  await daemon.invoke('stop_pi', { runtimeId });
  return join(home, '.piop', 'runtime-settings.json');
}
