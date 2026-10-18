import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

function publicChat(home: string, content: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content }),
  }));
}

test('a saved session can be renamed after the daemon restarts', async () => {
  let daemon = await startDaemon();
  try {
    const chat = publicChat(daemon.home, '');
    let runtimeId = crypto.randomUUID();
    await daemon.invoke('start_pi', { runtimeId, clientId: 'reopen-owner', cwd: daemon.home, sessionPath: chat.path });
    await daemon.invoke('stop_pi', { runtimeId });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    runtimeId = crypto.randomUUID();
    await daemon.invoke('start_pi', { runtimeId, clientId: 'reopen-owner', cwd: daemon.home, sessionPath: chat.path });
    await daemon.invoke('pi_command', { runtimeId, command: { type: 'set_session_name', name: 'After reopen' } });
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionName).toBe('After reopen');
    await daemon.invoke('stop_pi', { runtimeId });
  } finally { await daemon.stop(); }
}, 60000);
