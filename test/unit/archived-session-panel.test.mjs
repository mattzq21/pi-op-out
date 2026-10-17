import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDom, renderComponent, act, attributeBecomes } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ArchivedSessionPanel } from '../../clients/ui/components/ArchivedSessionPanel.tsx';

async function archivedPanel(t, names, holdCommand) {
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const requests = new Set();
  const heldReply = Promise.withResolvers();
  let view, daemon, holding = true;
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => { heldReply.resolve(); await settle(); await view?.unmount(); await settle(); storage.restore(); clearMocks(); dom.restore(); });
  daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chats = {};
  for (const name of names) {
    chats[name] = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: name } }) + '\n' }),
    }));
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chats[name].path, terminalIds: [], clientId: 'archived-panel-test' });
  }
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const held = holding && args.command === holdCommand;
    if (held) holding = false;
    const request = daemon.invoke(args.command, args.args); requests.add(request);
    try { const result = await request; if (held) await heldReply.promise; return result; } finally { requests.delete(request); }
  });
  view = await renderComponent(ArchivedSessionPanel);
  return { daemon, view, chats, settle, releaseHeldReply: () => heldReply.resolve() };
}

test('restoring an archived chat blocks other restores until the reply arrives, then shows the chat once in active sessions', { timeout: 60000 }, async t => {
  const { daemon, view, chats, settle, releaseHeldReply } = await archivedPanel(t, ['Restore me', 'Keep archived'], 'restore_archived_session');
  await settle();
  const button = name => view.container.querySelector(`[aria-label="Restore ${name} to active sessions"]`);
  const restore = button('Restore me');
  const other = button('Keep archived');
  assert.ok(restore && other);

  await act(() => restore.click());
  await attributeBecomes(other, 'disabled', '');
  assert.equal(restore.disabled, true);
  assert.equal(other.disabled, true);
  await act(() => other.click());

  releaseHeldReply();
  await settle();
  assert.equal(button('Restore me'), null);
  assert.equal(button('Keep archived')?.disabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  const sessions = await daemon.invoke('list_sessions');
  assert.equal(sessions.filter(session => session.id === chats['Restore me'].id).length, 1);
  assert.equal(sessions.some(session => session.id === chats['Keep archived'].id), false);
});
