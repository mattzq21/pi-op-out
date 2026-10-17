import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

// `archives` are chat names on this machine, or { name, hostId } for a configured remote. `initial` registers gates before mount, so it can hold the first refresh.
async function archivedPanel(t, archives, { remotes, initial } = {}) {
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
  daemon = await daemonClient(t, undefined, { remotes });
  const chats = {};
  for (const archive of archives) {
    const { name, hostId } = typeof archive === 'string' ? { name: archive, hostId: 'local' } : archive;
    const home = await daemon.invoke('home_directory', { hostId });
    chats[name] = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: name } }) + '\n' }),
    }));
    await daemon.invoke('archive_session', { hostId, sessionPath: chats[name].path, terminalIds: [], clientId: 'archived-panel-test' });
  }
  const held = initial?.(gate);
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
  const buttons = name => view.container.querySelectorAll(`[aria-label="Restore ${name} to active sessions"]`);
  return { daemon, view, chats, settle, gate, held, button, buttons, refreshButton };
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

test('the archive of this machine shows while the full archive report is loading, then the remote archive is added with each chat listed once', { timeout: 90000 }, async t => {
  const { view, settle, held: fullReport, button, buttons, refreshButton } = await archivedPanel(t, ['Local archive', { name: 'Remote archive', hostId: 'remote' }], {
    remotes: [{ id: 'remote', name: 'Remote machine', target: 'archive-remote' }],
    initial: gate => gate('storage_report'),
  });
  await fullReport.reached();

  await untilDom(() => button('Local archive'));
  assert.equal(button('Remote archive'), null);
  assert.equal(view.container.querySelector('.session-scroll').getAttribute('aria-busy'), 'true');

  fullReport.release();
  await settle();
  assert.equal(buttons('Local archive').length, 1);
  assert.equal(buttons('Remote archive').length, 1);
  assert.equal(view.container.querySelector('.session-scroll').getAttribute('aria-busy'), 'false');
  assert.equal(refreshButton().disabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
});

test('a restore blocked by an occupied destination shows the error and keeps the chat archived, then a retry after the destination is freed restores it once', { timeout: 60000 }, async t => {
  const panel = await archivedPanel(t, ['Restore after conflict']);
  const { view, chats, settle, button } = panel;
  await settle();
  writeFileSync(chats['Restore after conflict'].path, 'occupant');
  let occupied = true;
  t.after(() => { if (occupied) unlinkSync(chats['Restore after conflict'].path); });

  await act(() => button('Restore after conflict').click());
  await settle();
  assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? '', /Restoration destination already exists/);
  assert.equal(button('Restore after conflict')?.disabled, false);
  assert.equal(readFileSync(chats['Restore after conflict'].path, 'utf8'), 'occupant');

  unlinkSync(chats['Restore after conflict'].path);
  occupied = false;
  await act(() => button('Restore after conflict').click());
  await settle();
  await assertRestoredOnce(panel, 'Restore after conflict');
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
