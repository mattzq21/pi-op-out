import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory } from './harness';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an open shell keeps a daemon without clients running only until its unused delay ends', async () => {
  const daemon = await startDaemon({ env: { PIOP_UNUSED_STOP_MS: '2000' } });
  const directory = temporaryDirectory('piop-terminal-stop-');
  // A shell that ignores the Ctrl+C sent at the last disconnect, like an interactive shell at its prompt.
  writeFileSync(join(daemon.home, '.bashrc'), 'exec sh ./.terminal-script\n');
  writeFileSync(join(directory, '.terminal-script'), "trap '' INT\necho $$ > pid\nprintf READY\nwhile :; do sleep 1; done\n");
  try {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    await daemon.invoke('start_pi', { runtimeId: 'stop-session', clientId: 'stop-owner', cwd: chat.cwd, sessionId: chat.sessionId });
    const args = { clientId: 'stop-owner', sessionKey: 'local:' + chat.sessionId, hostId: 'local', sharedTerminalId: 'stop-terminal' };
    await daemon.invoke('shared_terminal', { ...args, action: 'start', cwd: directory, cols: 80, rows: 24 });
    await daemon.waitEvent('pi://event', event => event.type === 'terminal_output' && event.data.includes('READY'));
    const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'));
    daemon.close();
    await Bun.sleep(1000);
    expect(alive(pid)).toBe(true);
    for (let tries = 0; alive(pid) && tries < 100; tries++) await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  } finally { await daemon.stop(); }
}, 30_000);
