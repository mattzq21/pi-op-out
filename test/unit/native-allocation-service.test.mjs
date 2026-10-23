import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('disconnect during temporary-chat allocation removes the late directory and rejects sending', async t => {
  const dom = installDom();
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  let client;
  t.after(async () => { release.resolve(); await client?.dispose(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t);
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    if (args.command === 'create_temporary_chat') {
      received.resolve(result);
      await release.promise;
    }
    return result;
  }, { shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  client = new NativeTransport({});
  await client.connect();
  const starting = client.startDraft();
  const rejected = assert.rejects(starting, /closed before sending/);
  const chat = await received.promise;
  assert.equal(existsSync(chat.cwd), true);
  await client.disconnect();
  release.resolve();
  await rejected;
  assert.equal(existsSync(chat.cwd), false);
  assert.equal(client.currentSessionPath(), undefined);
});
