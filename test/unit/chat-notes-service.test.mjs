import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDom, renderHook, renderComponent, act, whenReactive, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { daemonClient } from '../daemon-client.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { useChatNote } from '../../clients/ui/plugins/markdown/useNotes.ts';
import { useNoteSession } from '../../clients/ui/plugins/markdown/noteSessions.ts';
import { RetainedNoteDrafts } from '../../clients/ui/plugins/markdown/RetainedNoteDrafts.tsx';

/** A saved chat on a real test daemon, and a way to open its note the way the notes panel does. Without events, change notices never reach the app. */
async function noteHost(t, { events = true } = {}) {
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const requests = new Set();
  const views = [];
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => { for (const view of views) await view.unmount(); await settle(); storage.restore(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t, (event, payload) => { if (events) void emit(event, payload); });
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content: '' }) }));
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const request = daemon.invoke(args.command, args.args); requests.add(request);
    try { return await request; } finally { requests.delete(request); }
  }, { shouldMockEvents: true });
  const open = async ({ owned = true, hook = useChatNote } = {}) => {
    const view = await renderHook(() => hook({ sessionId: chat.id, hostId: 'local' }, () => true));
    views.push(view);
    await whenReactive(() => view.current.ready() && (!owned || view.current.owned()));
    return view.current;
  };
  /** What another client reads from the host. */
  const otherClient = (action, fields = {}) => daemon.invoke('plugin_call', { clientId: 'other-client', hostId: 'local', pluginId: 'markdown', request: { sessionId: chat.id, leaseId: otherLease, action, ...fields } });
  const otherLease = crypto.randomUUID();
  const hostCopy = async () => (await otherClient('read')).content;
  /** Another client takes the note over and saves its own text. */
  const otherClientWrites = async content => {
    const taken = await otherClient('takeover');
    await otherClient('save', { content, version: taken.version, leaseToken: taken.ownership.token });
    await otherClient('release', { leaseToken: taken.ownership.token });
  };
  const closeAll = async () => { for (const view of views.splice(0)) await view.unmount(); await settle(); };
  return { daemon, chat, open, closeAll, hostCopy, otherClientWrites, settle };
}

test('typing in a note saves it to the host', async t => {
  const host = await noteHost(t);
  const note = await host.open();
  await act(() => note.edit('# Plan\n- write tests'));
  await host.settle();
  assert.equal(await host.hostCopy(), '# Plan\n- write tests');
  assert.equal(note.dirty(), false);
  assert.equal(note.content(), '# Plan\n- write tests');
});

test('another client\'s change reaches an open note at once and makes it read-only', async t => {
  const host = await noteHost(t);
  const note = await host.open();
  await host.otherClientWrites('theirs');
  await whenReactive(() => note.content() === 'theirs');
  assert.deepEqual([note.owned(), note.editable()], [false, false]);
  await act(() => note.edit('ignored'));
  assert.deepEqual([note.dirty(), await host.hostCopy()], [false, 'theirs']);
});

test('an edit typed before another client\'s change arrives is kept until the user chooses', async t => {
  const host = await noteHost(t, { events: false });
  const note = await host.open();
  await host.otherClientWrites('theirs');
  await act(() => note.edit('mine'));
  await host.settle();
  assert.deepEqual([note.conflict(), note.content(), note.savedContent(), note.owned()], [true, 'mine', 'theirs', false]);
  assert.equal(await host.hostCopy(), 'theirs');
  await act(() => note.takeControl());
  await act(() => note.saveEdits());
  await host.settle();
  assert.deepEqual([note.conflict(), note.dirty(), await host.hostCopy()], [false, false, 'mine']);
});

test('choosing the saved note drops the conflicting edit', async t => {
  const host = await noteHost(t, { events: false });
  const note = await host.open();
  await host.otherClientWrites('theirs');
  await act(() => note.edit('mine'));
  await host.settle();
  await act(() => note.useSaved());
  await host.settle();
  assert.deepEqual([note.conflict(), note.dirty(), note.content(), await host.hostCopy()], [false, false, 'theirs', 'theirs']);
});

test('an edit made while the host is unreachable survives closing the window and is saved after taking control again', async t => {
  const host = await noteHost(t);
  const note = await host.open();
  await host.daemon.disconnect();
  await act(() => note.edit('written offline'));
  await host.settle();
  assert.deepEqual([note.dirty(), note.durable(), Boolean(note.error())], [true, true, true]);
  await host.closeAll();
  await host.daemon.reconnect();
  const reopened = await host.open({ owned: false });
  assert.deepEqual([reopened.owned(), reopened.content(), reopened.dirty(), reopened.conflict()], [false, 'written offline', true, false], 'the closed window could not hand back its lock while offline');
  await act(() => reopened.takeControl());
  await host.settle();
  assert.deepEqual([reopened.content(), reopened.dirty(), await host.hostCopy()], ['written offline', false, 'written offline']);
});

test('an unsaved note of a deleted chat stays available in plugin settings until the user discards it', async t => {
  const host = await noteHost(t);
  const note = await host.open({ hook: useNoteSession });
  await host.daemon.disconnect();
  await act(() => note.edit('draft worth keeping'));
  await host.settle();
  await host.daemon.reconnect();
  await host.daemon.invoke('delete_session', { sessionPath: host.chat.path, hostId: 'local', clientId: 'other-client' });
  await whenReactive(() => note.deleted());
  await host.closeAll();
  const settings = await renderComponent(RetainedNoteDrafts, { hostId: 'local', busy: false });
  const draft = await untilDom(() => settings.container.querySelector('[aria-label="Unsaved note draft"]'));
  assert.match(draft.textContent, /This conversation was deleted\..*draft worth keeping/s);
  await act(() => [...draft.querySelectorAll('button')].find(button => button.textContent === 'Discard unsaved edits').click());
  await host.settle();
  await untilDom(() => !settings.container.querySelector('[aria-label="Unsaved note draft"]'));
  await settings.unmount();
});
