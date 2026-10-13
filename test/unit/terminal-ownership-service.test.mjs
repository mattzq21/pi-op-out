import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom, renderHook, act } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { createTerminalController } from '../../clients/ui/appTerminals.ts';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('terminal recovery dismisses its sync error without dismissing unrelated notices', async t => {
  const dom = installDom();
  const notices = new Set([{ title: 'Unrelated problem' }]);
  const reported = Promise.withResolvers();
  let offline = true, transport, view;
  t.after(async () => {
    try { await view?.unmount(); await transport?.dispose(); }
    finally { clearMocks(); dom.restore(); }
  });
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home, cwd: home, content: '' }),
  }));
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    if (offline && args.command === 'shared_terminal' && args.args.action === 'list') throw new Error('Backend is offline');
    return daemon.invoke(args.command, args.args);
  }, { shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command,
    command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  transport = new NativeTransport({ sessionId: chat.id, sessionPath: chat.path, cwd: home });
  await transport.connect();
  view = await renderHook(() => createTerminalController({
    transport: () => transport, sessionTransport: () => transport,
    conversationKey: () => 'local:' + chat.id, location: () => ({ cwd: home, hostId: 'local' }),
    addNotice: notice => {
      notices.add(notice);
      reported.resolve();
      return () => notices.delete(notice);
    },
  }));
  await reported.promise;
  assert.equal(view.current.ready(), false);
  assert.equal(notices.size, 2);
  assert.ok([...notices].some(notice => notice.title === 'Could not sync terminals'));
  offline = false;
  await act(view.current.takeOwnership);
  assert.equal(view.current.ready(), true);
  assert.deepEqual([...notices].map(notice => notice.title), ['Unrelated problem']);
  offline = true;
  await act(view.current.takeOwnership);
  assert.equal(notices.size, 2);
  assert.ok([...notices].some(notice => notice.title === 'Could not sync terminals'));
});
