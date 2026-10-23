import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDom, renderComponent, act, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { SubagentPane } from '../../clients/ui/components/SubagentPane.tsx';

/** The subagent pane against a real test daemon, with one saved chat on it. */
async function pane(t) {
  const dom = installDom();
  HTMLElement.prototype.scrollIntoView = () => {};
  let view;
  const close = async () => { await view?.unmount(); view = undefined; };
  t.after(async () => { await close(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content: '' }) }));
  mockWindows('main');
  mockIPC((command, args) => { assert.equal(command, 'daemon_invoke'); return daemon.invoke(args.command, args.args); }, { shouldMockEvents: true });
  const closed = [], archives = [];
  const open = async target => { view = await renderComponent(SubagentPane, { target: { name: 'reader', hostId: 'local', ...target }, onClose: () => closed.push(1), onActivate: () => {}, onShowArchive: () => archives.push(1) }); };
  const region = () => document.querySelector('[aria-label="Subagent conversation: reader"]');
  return { daemon, chat, open, close, region, closed, archives };
}

test('active and archived subagent views', { timeout: 60000 }, async t => {
  const { daemon, chat, open, close, region, closed, archives } = await pane(t);
  await t.test('a subagent chat opens read-only, without a message box, and closes', { timeout: 30000 }, async () => {
    await open({ sessionId: chat.id, sessionPath: chat.path });
    await untilDom(() => !region().querySelector('.split-pane-status') && region().querySelector('.chat-shell, .conversation'), 15000);
    assert.equal(region().querySelector('[aria-label="Message piop"]'), null, 'there is no message box');
    assert.equal(region().querySelector('[role="alert"]'), null);
    await act(async () => region().querySelector('[aria-label="Close subagent conversation"]').click());
    assert.equal(closed.length, 1);
  });
  await t.test('an archived subagent chat says so and links to the archive', { timeout: 30000 }, async () => {
    await close();
    await daemon.invoke('archive_session', { sessionPath: chat.path, hostId: 'local', terminalIds: [], clientId: 'archive-test' });
    const archived = (await daemon.invoke('storage_report')).hosts[0].archives.find(item => item.id === chat.id);
    await open({ sessionId: chat.id, sessionPath: archived.path });
    const status = await untilDom(() => [...region().querySelectorAll('[role="status"]')].find(item => /archived and read-only/.test(item.textContent)), 15000);
    await act(async () => status.querySelector('button').click());
    assert.equal(archives.length, 1);
  });
});

test('a subagent chat that was deleted shows why it cannot load, with Retry', async t => {
  const { daemon, chat, open, region } = await pane(t);
  await daemon.invoke('delete_session', { sessionPath: chat.path, hostId: 'local', clientId: 'delete-test' });
  await open({ sessionId: chat.id, sessionPath: chat.path });
  const alert = await untilDom(() => region().querySelector('[role="alert"]'), 15000);
  assert.match(alert.textContent, /^Conversation was not found in active or archived storage/);
  assert.ok([...alert.querySelectorAll('button')].some(button => button.textContent === 'Retry'));
});
