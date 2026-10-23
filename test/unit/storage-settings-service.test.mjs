import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendFileSync, chmodSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { installDom, renderComponent, act, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { StorageSettings } from '../../clients/ui/components/StorageSettings.tsx';

async function storagePanel(t, offline = false, archiveNames = [], options = {}) {
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const requests = new Set();
  let view, daemon, releaseReply;
  let replyGate = Promise.resolve();
  if (options.pauseReplies) replyGate = new Promise(resolve => { releaseReply = resolve; });
  const heldReply = Promise.withResolvers();
  let holdReply = options.holdReply;
  const temporary = [];
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => { releaseReply?.(); heldReply.resolve(); await settle(); await view?.unmount(); await settle(); for (const path of temporary) await daemon.invoke('remove_temporary_chat', { path, hostId: 'local' }); storage.restore(); clearMocks(); dom.restore(); });
  daemon = await daemonClient(t, undefined, { remotes: options.remotes });
  for (const archive of archiveNames) {
    const { name, hostId } = typeof archive === 'string' ? { name: archive, hostId: 'local' } : archive;
    const home = await daemon.invoke('home_directory', { hostId });
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: name } }) + '\n' }),
    }));
    await daemon.invoke('archive_session', { hostId, sessionPath: chat.path, terminalIds: [], clientId: 'storage-ui-test' });
  }
  if (offline) await daemon.disconnect();
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const held = holdReply?.(args.command, args.args);
    if (held) holdReply = undefined;
    const request = daemon.invoke(args.command, args.args); requests.add(request);
    try { const result = await request; await replyGate; if (held) await heldReply.promise; return result; } finally { requests.delete(request); }
  });
  view = await renderComponent(StorageSettings, options.props);
  return { daemon, view, settle, temporary, releaseHeldReply: () => heldReply.resolve(), failHeldReply: error => heldReply.reject(error), releaseReplies: () => releaseReply?.(), pauseReplies() {
    const gate = Promise.withResolvers();
    replyGate = gate.promise;
    releaseReply = () => gate.resolve();
    return releaseReply;
  } };
}

test('storage refresh follows connection and directory changes', { timeout: 120000 }, async t => {
  const { daemon, view, settle, temporary } = await storagePanel(t, true);
  await t.test('storage settings shows a connection failure when the service is unavailable', { timeout: 30000 }, async () => {
    const alert = await untilDom(() => view.container.querySelector('[role="alert"]'));
    assert.match(alert.textContent, /connection is not open/);
    const refresh = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh');
    assert.ok(refresh);
    assert.equal(refresh.disabled, false);
  });
  await t.test('Refresh loads the storage report after the service reconnects', { timeout: 30000 }, async () => {
    await untilDom(() => view.container.querySelector('[role="alert"]'));
    await daemon.reconnect();
    const refresh = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh');
    await act(() => refresh.click());
    await settle();
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.ok(view.container.textContent.includes('Local'));
    assert.ok(view.container.textContent.includes('General and shared history'));
    assert.equal(refresh.disabled, false);
  });
  await t.test('Refresh shows a newly created no-project working directory', { timeout: 30000 }, async () => {
    await settle();
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    temporary.push(chat.cwd);
    await act(() => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
    await settle();
    assert.ok(view.container.textContent.includes('No-project workdirs'));
    assert.ok(view.container.textContent.includes('1 directory'));
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    await daemon.invoke('remove_temporary_chat', { path: chat.cwd, hostId: 'local' });
    temporary.splice(temporary.indexOf(chat.cwd), 1);
  });
  await t.test('Refresh removes a deleted no-project directory from the storage count', { timeout: 30000 }, async () => {
    await settle();
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    temporary.push(chat.cwd);
    const refresh = async () => {
      await act(() => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
      await settle();
    };
    await refresh();
    assert.ok(view.container.textContent.includes('1 directory'));
    await daemon.invoke('remove_temporary_chat', { path: chat.cwd, hostId: 'local' });
    temporary.splice(temporary.indexOf(chat.cwd), 1);
    await refresh();
    assert.ok(!view.container.textContent.includes('1 directory'));
    assert.ok(view.container.textContent.includes('No-project workdirs'));
    assert.equal(view.container.querySelector('[role="alert"]'), null);
  });
});

test('cancelling single archive deletion keeps the chat available', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['Old chat']);
  await settle();
  let confirmation;
  window.confirm = message => { confirmation = message; return false; };
  await act(() => view.container.querySelector('[aria-label="Permanently delete Old chat"]').click());
  await settle();
  assert.equal(confirmation, 'Permanently delete “Old chat” and its attached reviews and subagents? Forks will be kept.');
  assert.ok(view.container.querySelector('[aria-label="Permanently delete Old chat"]'));
  const report = await daemon.invoke('storage_report');
  assert.deepEqual(report.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name), ['Old chat']);
});

test('confirming single archive deletion removes the chat from the screen and storage', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['Delete this chat', 'Keep this chat']);
  await settle();
  window.confirm = () => true;
  await act(() => view.container.querySelector('[aria-label="Permanently delete Delete this chat"]').click());
  await settle();
  assert.equal(view.container.querySelector('[aria-label="Permanently delete Delete this chat"]'), null);
  assert.ok(view.container.querySelector('[aria-label="Permanently delete Keep this chat"]'));
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  const report = await daemon.invoke('storage_report');
  assert.deepEqual(report.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name), ['Keep this chat']);
  assert.equal([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').disabled, false);
});


test('archive deletion disables its controls until the service reply arrives', async t => {
  const { view, settle, pauseReplies } = await storagePanel(t, false, ['Old chat']);
  await settle();
  window.confirm = () => true;
  const remove = view.container.querySelector('[aria-label="Permanently delete Old chat"]');
  const refresh = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh');
  const release = pauseReplies();
  await act(() => remove.click());
  assert.equal(remove.disabled, true);
  assert.equal(refresh.disabled, true);
  release();
  await settle();
  assert.equal(view.container.querySelector('[aria-label="Permanently delete Old chat"]'), null);
  assert.equal(refresh.disabled, false);
});

test('cancelling bulk deletion preserves every archived chat', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['First chat', 'Second chat']);
  await settle();
  const button = text => [...view.container.querySelectorAll('button')].find(button => button.textContent === text);
  await act(() => button('Delete all').click());
  assert.match(view.container.querySelector('dialog').textContent, /2 archived conversations on Local/);
  await act(() => button('Cancel').click());
  await settle();
  assert.equal(view.container.querySelector('dialog'), null);
  assert.ok(view.container.querySelector('[aria-label="Permanently delete First chat"]'));
  assert.ok(view.container.querySelector('[aria-label="Permanently delete Second chat"]'));
  const report = await daemon.invoke('storage_report');
  assert.deepEqual(report.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name).sort(), ['First chat', 'Second chat']);
});


test('bulk deletion keeps an unreadable archive and removes only readable chats', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['First chat', 'Second chat', 'Unsafe chat']);
  await settle();
  const report = await daemon.invoke('storage_report');
  const unsafe = report.hosts.find(host => host.hostId === 'local').archives.find(chat => chat.name === 'Unsafe chat');
  appendFileSync(unsafe.path, 'not JSON\n');
  const button = text => [...view.container.querySelectorAll('button')].find(button => button.textContent === text);
  await act(() => button('Refresh').click());
  await settle();
  assert.equal(view.container.querySelector('[aria-label^="Cannot safely delete Unsafe chat"]').disabled, true);
  await act(() => button('Delete available').click());
  assert.match(view.container.querySelector('dialog').textContent, /2 archived conversations on Local/);
  await act(() => view.container.querySelector('dialog button.primary-button').click());
  await settle();
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.equal(view.container.querySelector('[aria-label="Permanently delete First chat"]'), null);
  assert.equal(view.container.querySelector('[aria-label="Permanently delete Second chat"]'), null);
  assert.ok(view.container.querySelector('[aria-label^="Cannot safely delete Unsafe chat"]'));
  const after = await daemon.invoke('storage_report');
  assert.deepEqual(after.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name), ['Unsafe chat']);
});

test('a failed bulk deletion reports the error and keeps the archived chats visible', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['First chat', 'Second chat']);
  await settle();
  const report = await daemon.invoke('storage_report');
  const archive = report.hosts.find(host => host.hostId === 'local').archives[0];
  const directory = dirname(archive.path);
  const mode = statSync(directory).mode & 0o777;
  const button = text => [...view.container.querySelectorAll('button')].find(button => button.textContent === text);
  await act(() => button('Delete all').click());
  chmodSync(directory, 0o500);
  try {
    await act(() => view.container.querySelector('dialog button.primary-button').click());
    await settle();
    assert.match(view.container.querySelector('[role="alert"]').textContent, /EACCES|Permission denied/);
    assert.ok(view.container.querySelector('[aria-label="Permanently delete First chat"]'));
    assert.ok(view.container.querySelector('[aria-label="Permanently delete Second chat"]'));
    const after = await daemon.invoke('storage_report');
    assert.deepEqual(after.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name).sort(), ['First chat', 'Second chat']);
  } finally { chmodSync(directory, mode); }
});


test('storage shows the scan status until the service report arrives', async t => {
  const { view, settle, releaseReplies } = await storagePanel(t, false, [], { pauseReplies: true });
  assert.match(view.container.querySelector('[role="status"]').textContent, /Scanning storage/);
  assert.equal([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Scanning…').disabled, true);
  releaseReplies();
  await settle();
  assert.equal(view.container.querySelector('[role="status"]'), null);
  assert.equal([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').disabled, false);
});


test('storage shows archive sizes in bytes and kibibytes', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['Small chat', 'Larger chat']);
  await settle();
  const report = await daemon.invoke('storage_report');
  const archives = report.hosts.find(host => host.hostId === 'local').archives;
  for (const [name, bytes] of [['Small chat', 1023], ['Larger chat', 2048]]) {
    const archive = archives.find(chat => chat.name === name);
    const header = JSON.parse(readFileSync(archive.path, 'utf8').split('\n')[0]);
    const content = Buffer.from(JSON.stringify({ type: 'session', version: header.version, id: header.id, cwd: header.cwd }) + '\n'
      + JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: name } }) + '\n');
    assert.ok(content.length < bytes, 'Fixture transcript must fit in its intended size');
    writeFileSync(archive.path, Buffer.concat([content, Buffer.alloc(bytes - content.length, ' ')]));
  }
  await act(() => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
  await settle();
  const archived = view.container.querySelector('[aria-label="Archived sessions"]');
  const small = archived.querySelector('[aria-label="Permanently delete Small chat"]').parentElement;
  const larger = archived.querySelector('[aria-label="Permanently delete Larger chat"]').parentElement;
  assert.ok(small.textContent.includes('1023 B'));
  assert.ok(larger.textContent.includes('2.00 KiB'));
});


test('storage counts archived chats in the archived section', async t => {
  const { view, settle } = await storagePanel(t, false, ['First chat', 'Second chat']);
  await settle();
  const archived = view.container.querySelector('[aria-label="Archived sessions"]');
  assert.ok(archived.textContent.includes('2 conversations'));
  assert.ok(archived.textContent.includes('2 stored on Local'));
});

test('storage keeps the local report visible when a remote machine is unavailable', async t => {
  const { daemon, view, settle } = await storagePanel(t);
  await settle();
  const settings = await daemon.invoke('load_app_settings');
  await daemon.invoke('save_app_settings', { settings: { ...settings, hosts: [{ id: crypto.randomUUID(), name: 'Unavailable machine', target: 'unavailable', piPath: 'piopd', enabled: true }] } });
  await act(() => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
  await settle();
  assert.ok(view.container.textContent.includes('Unavailable machine'));
  assert.ok(view.container.textContent.includes('Storage unavailable'));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /Could not attach to Unavailable machine/);
  assert.ok(view.container.textContent.includes('Local'));
  assert.ok(view.container.querySelector('[aria-label="Active sessions"]'));
});

test('storage shows a large archive size in mebibytes', async t => {
  const { daemon, view, settle } = await storagePanel(t, false, ['Large chat']);
  await settle();
  const report = await daemon.invoke('storage_report');
  const chat = report.hosts.find(host => host.hostId === 'local').archives[0];
  const content = readFileSync(chat.path);
  writeFileSync(chat.path, Buffer.concat([content, Buffer.alloc(2097152 - content.length, ' ')]));
  await act(() => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click());
  await settle();
  const row = view.container.querySelector('[aria-label="Permanently delete Large chat"]').parentElement;
  assert.ok(row.textContent.includes('2.00 MiB'));
});

test('a storage report for the previous machine does not replace the report for the selected machine', { timeout: 60000 }, async t => {
  const { view, settle, releaseHeldReply } = await storagePanel(t, false, ['Local chat', { name: 'Remote chat', hostId: 'remote' }], {
    remotes: [{ id: 'remote', name: 'Remote machine', target: 'storage-remote' }],
    props: { hostId: 'local' },
    holdReply: (command, args) => command === 'host_storage_report' && args.hostId === 'local',
  });
  await view.rerender({ hostId: 'remote' });
  await untilDom(() => view.container.querySelector('[aria-label="Permanently delete Remote chat"]'), 30000);
  releaseHeldReply();
  await settle();
  assert.ok(view.container.querySelector('[aria-label="Permanently delete Remote chat"]'));
  assert.equal(view.container.querySelector('[aria-label="Permanently delete Local chat"]'), null);
});

test('a failed storage report for the previous machine does not replace the report for the selected machine', { timeout: 60000 }, async t => {
  const { view, settle, failHeldReply } = await storagePanel(t, false, ['Local chat', { name: 'Remote chat', hostId: 'remote' }], {
    remotes: [{ id: 'remote', name: 'Remote machine', target: 'storage-remote' }],
    props: { hostId: 'local' },
    holdReply: (command, args) => command === 'host_storage_report' && args.hostId === 'local',
  });
  await view.rerender({ hostId: 'remote' });
  await untilDom(() => view.container.querySelector('[aria-label="Permanently delete Remote chat"]'), 30000);
  failHeldReply(new Error('Local storage scan failed'));
  await settle();
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.ok(view.container.querySelector('[aria-label="Permanently delete Remote chat"]'));
  assert.equal(view.container.querySelector('[aria-label="Permanently delete Local chat"]'), null);
  assert.equal(view.container.querySelector('[role="status"]'), null);
  assert.equal([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh').disabled, false);
});
