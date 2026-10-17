import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeTerminals } from '../../clients/ui/lib/nativeTerminals.ts';

test('a terminal list answered before the terminal restarts shows only the new terminal output', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const old = Promise.withResolvers(), fresh = Promise.withResolvers(), held = Promise.withResolvers(), release = Promise.withResolvers();
  let output = '', holding = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('old-output')) old.resolve();
    if (output.includes('fresh-output')) fresh.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    if (holding && args.command === 'shared_terminal' && args.args.action === 'list') {
      holding = false;
      held.resolve();
      await release.promise;
    }
    return result;
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  let listing;
  try {
    await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'old-' 'output'\r", 'write');
    await old.promise;
    const [before] = await nativeTerminals.list(session, 'local');
    assert.equal(before.output.includes('old-output'), true);
    holding = true;
    listing = nativeTerminals.list(session, 'local');
    await held.promise;
    await nativeTerminals.close(terminal);
    await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
    release.resolve();
    const restarted = await listing;
    assert.equal(restarted.length, 1);
    assert.notEqual(restarted[0].generation, before.generation);
    assert.equal(restarted[0].output.includes('old-output'), false);
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'fresh-' 'output'\r", 'write');
    await fresh.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.generation, restarted[0].generation);
    assert.equal(listed.output.includes('old-output'), false);
    assert.equal(listed.output.split('fresh-output').length - 1, 1);
  } finally {
    release.resolve();
    await listing?.catch(() => undefined);
    await nativeTerminals.close(terminal);
  }
});
