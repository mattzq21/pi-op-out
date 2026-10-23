import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { installDom, renderComponent, act, attributeBecomes, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { chatPublisher } from '../chat-publisher-fixture.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ArchivedSessionPanel } from '../../clients/ui/components/ArchivedSessionPanel.tsx';

const within = (promise, label, timeout = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); })]).finally(() => clearTimeout(timer));
};

// `archives` are chat names on this machine, or { name, hostId, key } for a configured remote. `chats` is keyed by `key`, else by name. `initial` registers gates before mount, so it can hold the first refresh.
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
  let sessionsChanged = Promise.withResolvers();
  daemon = await daemonClient(t, event => { if (event === 'pi://sessions-changed') { sessionsChanged.resolve(); sessionsChanged = Promise.withResolvers(); } }, { remotes });
  // Remote session lists are read again in the background, so list again after each change until `match` holds.
  const sessionsWhere = async (match, label) => {
    for (;;) {
      const changed = sessionsChanged.promise;
      const sessions = await daemon.invoke('list_sessions');
      if (match(sessions)) return sessions;
      await within(changed, label);
    }
  };
  const chats = {};
  const publishers = new Map();
  for (const archive of archives) {
    const { name, hostId, key = name, customType } = typeof archive === 'string' ? { name: archive, hostId: 'local' } : archive;
    assert.equal(Object.hasOwn(chats, key), false, `Archive fixture key ${key} is used twice`);
    const home = await daemon.invoke('home_directory', { hostId });
    if (!publishers.has(home)) publishers.set(home, chatPublisher(t, { home }));
    chats[key] = await publishers.get(home)({ content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: name } }) + '\n' + (customType ? JSON.stringify({ type: 'custom', id: 'parent-marker', parentId: 'question', customType, data: { parentSessionId: 'root' } }) + '\n' : '') });
    await daemon.invoke('archive_session', { hostId, sessionPath: chats[key].path, terminalIds: [], clientId: 'archived-panel-test' });
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
  return { daemon, view, chats, settle, gate, held, button, buttons, refreshButton, sessionsWhere };
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

test('restoring a remote archive that has the same name as a local archive restores only the remote chat, once, on the remote machine', { timeout: 90000 }, async t => {
  const name = 'Same name';
  const { daemon, view, chats, settle, sessionsWhere } = await archivedPanel(t, [{ name, hostId: 'local', key: 'local' }, { name, hostId: 'remote', key: 'remote' }], {
    remotes: [{ id: 'remote', name: 'Remote machine', target: 'archive-remote' }],
  });
  await settle();
  const hostNames = Object.fromEntries((await daemon.invoke('storage_report')).hosts.map(host => [host.hostId, host.hostName]));
  assert.notEqual(hostNames.local, hostNames.remote);
  const restoreIn = hostId => [...view.container.querySelectorAll('section')]
    .filter(section => section.querySelector('.project-label')?.textContent === hostNames[hostId])
    .flatMap(section => [...section.querySelectorAll(`[aria-label="Restore ${name} to active sessions"]`)]);
  assert.equal(restoreIn('local').length, 1);
  assert.equal(restoreIn('remote').length, 1);

  await act(() => restoreIn('remote')[0].click());
  await settle();

  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.equal(restoreIn('remote').length, 0, 'remote archive is still listed');
  assert.equal(restoreIn('local').length, 1, 'local archive is no longer listed once');
  const sessions = await sessionsWhere(rows => rows.some(row => row.id === chats.remote.id), 'remote chat listed in active sessions');
  assert.deepEqual(sessions.filter(session => session.id === chats.remote.id).map(session => session.hostId), ['remote']);
  assert.equal(sessions.some(session => session.id === chats.local.id), false, 'local archive was restored');
  const archived = Object.fromEntries((await daemon.invoke('storage_report')).hosts.map(host => [host.hostId, host.archives.map(archive => archive.id)]));
  assert.equal(archived.remote.includes(chats.remote.id), false, 'remote archive is still in remote storage');
  assert.deepEqual(archived.local.filter(id => id === chats.local.id), [chats.local.id]);
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


for (const customType of ['piop-subagent-parent', 'piop-review-parent']) test(`an archived ${customType} has no restore action and cannot be restored directly`, { timeout: 60000 }, async t => {
  const panel = await archivedPanel(t, [{ name: 'Auxiliary chat', hostId: 'local', customType }, 'Root chat']);
  await panel.settle();
  assert.ok(panel.view.container.textContent.includes('Auxiliary chat'));
  assert.equal(panel.button('Auxiliary chat'), null);
  assert.ok(panel.button('Root chat'));
  const report = await panel.daemon.invoke('storage_report');
  const auxiliary = report.hosts.flatMap(host => host.archives).find(archive => archive.id === panel.chats['Auxiliary chat'].id);
  assert.equal(auxiliary.restorable, false);
  await assert.rejects(panel.daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: auxiliary.path, clientId: 'archived-panel-test' }), /Auxiliary sessions can only be restored with their root session/);
});
