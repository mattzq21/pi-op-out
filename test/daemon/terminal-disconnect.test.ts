import { expect, test } from 'bun:test';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory } from './harness';

test('only the last client disconnect sends Ctrl+C to retained session terminals', async () => {
  const daemon = await startDaemon();
  const other = await daemon.connect();
  const directory = temporaryDirectory('piop-terminal-interrupt-');
  const marker = join(directory, 'interrupted');
  writeFileSync(join(daemon.home, '.bashrc'), 'exec sh ./.terminal-script\n');
  writeFileSync(join(directory, '.terminal-script'), "trap 'echo interrupted > interrupted; exit 0' INT\nprintf READY\nwhile IFS= read -r line; do printf 'ACK:%s\\n' \"$line\"; done\n");
  try {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    await daemon.invoke('start_pi', { runtimeId: 'interrupt-session', clientId: 'interrupt-owner', cwd: chat.cwd, sessionId: chat.sessionId });
    const args = { clientId: 'interrupt-owner', sessionKey: 'local:' + chat.sessionId, hostId: 'local', sharedTerminalId: 'interrupt-terminal' };
    await daemon.invoke('shared_terminal', { ...args, action: 'start', cwd: directory, cols: 80, rows: 24 });
    await daemon.waitEvent('pi://event', event => event.type === 'terminal_output' && event.data.includes('READY'));
    other.close();
    await daemon.invoke('shared_terminal', { ...args, action: 'write', data: 'still connected\n' });
    await daemon.waitEvent('pi://event', event => event.type === 'terminal_output' && event.data.includes('ACK:still connected'));
    expect(existsSync(marker)).toBe(false);
    const interrupted = new Promise<void>((resolve, reject) => {
      const watcher = watch(directory, () => { if (existsSync(marker)) finish(); });
      const timer = setTimeout(() => finish(new Error('Last disconnect did not send Ctrl+C')), 3000);
      function finish(error?: Error) { clearTimeout(timer); watcher.close(); if (error) reject(error); else resolve(); }
    });
    daemon.close();
    await interrupted;
  } finally { other.close(); await daemon.stop(); }
}, 30_000);
