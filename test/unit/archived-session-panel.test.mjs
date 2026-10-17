import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDom, renderComponent, act, attributeBecomes, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ArchivedSessionPanel } from '../../clients/ui/components/ArchivedSessionPanel.tsx';

const within = (promise, label, timeout = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); })]).finally(() => clearTimeout(timer));
};

async function archivedPanel(t, names) {
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const calls = new Set();
  const gates = [];
  let view, daemon;
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...calls])); } while (calls.size); };
  // Holds the next IPC call of `command`: before it reaches the daemon (`send`), or after the daemon answered (`reply`).
  const gate = (command, stage = 'reply') => {
    const entry = { command, stage, reached: Promise.withResolvers(), open: Promise.withResolvers(), replied: Promise.withResolvers() };
    gates.push(entry);
    return {
      reached: () => within(entry.reached.promise, `${command} ${stage} reached`),
      replied: () => within(entry.replied.promise, `${command} replied`),
      release: () => entry.open.resolve(),
    };
  };
  t.after(async () => { for (const entry of gates) entry.open.resolve(); await settle(); await view?.unmount(); await settle(); storage.restore(); clearMocks(); dom.restore(); });
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
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    const entry = gates.find(candidate => candidate.command === args.command && !candidate.taken);
    if (entry) entry.taken = true;
    const call = (async () => {
      if (entry?.stage === 'send') { entry.reached.resolve(); await entry.open.promise; }
      const result = await daemon.invoke(args.command, args.args);
      if (entry?.stage === 'reply') { entry.reached.resolve(result); await entry.open.promise; }
      return result;
    })();
    calls.add(call);
    call.then(() => entry?.replied.resolve(), () => entry?.replied.resolve()).finally(() => calls.delete(call));
    return call;
  });
  view = await renderComponent(ArchivedSessionPanel);
  const button = name => view.container.querySelector(`[aria-label="Restore ${name} to active sessions"]`);
  const refreshButton = () => view.container.querySelector('[aria-label="Refresh archived sessions"]');
  return { daemon, view, chats, settle, gate, button, refreshButton };
}

// Holds both archive report replies of one refresh after the daemon computed them, so they still list every archived chat.
function holdComputedReports(gate) {
  const reports = [gate('host_storage_report'), gate('storage_report')];
  return { reached: () => Promise.all(reports.map(report => report.reached())), release: () => reports.forEach(report => report.release()) };
}

async function assertRestoredOnce({ daemon, chats, button, view }, name) {
  const sessions = await daemon.invoke('list_sessions');
  assert.equal(sessions.filter(session => session.id === chats[name].id).length, 1, `${name} is active in the daemon`);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.equal(button(name), null, `${name} is still listed as archived after every reply settled`);
}

test('restoring an archived chat blocks other restores until the reply arrives, then shows the chat once in active sessions', { timeout: 60000 }, async t => {
  const { daemon, view, chats, settle, gate, button } = await archivedPanel(t, ['Restore me', 'Keep archived']);
  await settle();
  const restoreReply = gate('restore_archived_session');
  const restore = button('Restore me');
  const other = button('Keep archived');
  assert.ok(restore && other);

  await act(() => restore.click());
  await attributeBecomes(other, 'disabled', '');
  assert.equal(restore.disabled, true);
  assert.equal(other.disabled, true);
  await act(() => other.click());

  restoreReply.release();
  await settle();
  assert.equal(button('Restore me'), null);
  assert.equal(button('Keep archived')?.disabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  const sessions = await daemon.invoke('list_sessions');
  assert.equal(sessions.filter(session => session.id === chats['Restore me'].id).length, 1);
  assert.equal(sessions.some(session => session.id === chats['Keep archived'].id), false);
});

test('restoring a chat while a refresh is loading still removes it once the older archive report arrives', { timeout: 60000 }, async t => {
  const panel = await archivedPanel(t, ['Restore me', 'Keep archived']);
  const { settle, gate, button, refreshButton } = panel;
  await settle();
  const restore = button('Restore me');
  assert.ok(restore);

  const reports = holdComputedReports(gate);
  const restoreCall = gate('restore_archived_session');
  restoreCall.release();
  await act(() => refreshButton().click());
  await reports.reached();

  await act(() => restore.click());
  await restoreCall.replied();
  await untilDom(() => !button('Keep archived').disabled);

  reports.release();
  await settle();
  await assertRestoredOnce(panel, 'Restore me');
});

test('refreshing while a restore is pending still removes the chat once the archive report computed before the restore arrives', { timeout: 60000 }, async t => {
  const panel = await archivedPanel(t, ['Restore me', 'Keep archived']);
  const { settle, gate, button, refreshButton } = panel;
  await settle();
  const restore = button('Restore me');
  assert.ok(restore);

  const restoreCall = gate('restore_archived_session', 'send');
  await act(() => restore.click());
  await restoreCall.reached();

  const reports = holdComputedReports(gate);
  await act(() => refreshButton().click());
  await reports.reached();

  restoreCall.release();
  await restoreCall.replied();
  await untilDom(() => !button('Keep archived').disabled);

  reports.release();
  await settle();
  await assertRestoredOnce(panel, 'Restore me');
});
