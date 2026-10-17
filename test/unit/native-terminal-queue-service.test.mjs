import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeTerminals } from '../../clients/ui/lib/nativeTerminals.ts';

test('typing that waits behind a slow draft save is sent once and the next draft stays', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const held = Promise.withResolvers(), release = Promise.withResolvers(), response = Promise.withResolvers();
  let output = '', holding = true;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('queued-send')) response.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    if (holding && args.command === 'shared_terminal' && args.args.action === 'draft') {
      holding = false;
      held.resolve();
      await release.promise;
    }
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const typed = "printf '%s%s\\n' 'queued-' 'send'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  const work = [];
  try {
    work.push(nativeTerminals.write(terminal, 'p', 'draft'));
    await held.promise;
    work.push(nativeTerminals.write(terminal, 'printf', 'draft'));
    work.push(nativeTerminals.write(terminal, typed, 'draft'));
    work.push(nativeTerminals.writeAndClearDraft(terminal, typed + '\r', typed));
    work.push(nativeTerminals.write(terminal, 'next command', 'draft'));
    await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    const results = await Promise.allSettled(work);
    assert.deepEqual(results.map(result => result.status === 'rejected' ? String(result.reason) : result.status), Array(5).fill('fulfilled'));
    await response.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.inputDraft, 'next command');
    assert.equal(listed.output.split('queued-send').length - 1, 1);
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    await nativeTerminals.close(terminal);
  }
});
