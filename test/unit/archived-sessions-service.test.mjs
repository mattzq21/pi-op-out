import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, renderComponent, act, enterText, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { chatPublisher } from '../chat-publisher-fixture.mjs';
import { ArchivedSessionPanel } from '../../clients/ui/components/ArchivedSessionPanel.tsx';

/** The archived chats panel against a real test daemon holding two archived chats, from the alpha and beta projects. */
async function archivePanel(t) {
  const dom = installDom();
  let view;
  t.after(async () => { await view?.unmount(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const archived = {};
  const publish = chatPublisher(t, { home });
  for (const project of ['alpha', 'beta']) {
    const cwd = join(home, 'work', project); mkdirSync(cwd, { recursive: true });
    const chat = await publish({ home, cwd, folder: project, content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Work on ' + project, timestamp: 1 } }) + '\n' });
    await daemon.invoke('archive_session', { sessionPath: chat.path, hostId: 'local', terminalIds: [], clientId: 'archive-test' });
    archived[project] = { ...chat, cwd };
  }
  mockWindows('main');
  mockIPC((command, args) => { assert.equal(command, 'daemon_invoke'); return daemon.invoke(args.command, args.args); }, { shouldMockEvents: true });
  view = await renderComponent(ArchivedSessionPanel);
  const rows = () => [...document.querySelectorAll('.session-item')].map(row => row.querySelector('.archived-session-detail').textContent);
  await untilDom(() => rows().length === 2 && document.querySelector('.session-scroll').getAttribute('aria-busy') === 'false', 10000);
  return { daemon, archived, rows };
}

test('archived chats can be searched by project and restored to the chat list', async t => {
  const { daemon, archived, rows } = await archivePanel(t);
  assert.deepEqual(rows().sort(), [archived.alpha.cwd, archived.beta.cwd]);

  await enterText(document.querySelector('[aria-label="Search archived sessions"]'), 'beta');
  assert.deepEqual(rows(), [archived.beta.cwd]);
  await enterText(document.querySelector('[aria-label="Search archived sessions"]'), 'gamma');
  assert.deepEqual(rows(), []);
  assert.match(document.querySelector('.session-scroll').textContent, /No matching archived sessions\./);
  await enterText(document.querySelector('[aria-label="Search archived sessions"]'), '');

  const row = [...document.querySelectorAll('.session-item')].find(item => item.textContent.includes(archived.beta.cwd));
  await act(async () => row.querySelector('button').click());
  await untilDom(() => rows().length === 1, 10000);
  assert.deepEqual(rows(), [archived.alpha.cwd]);
  const active = await daemon.invoke('list_sessions');
  assert.ok(active.some(session => session.id === archived.beta.id), 'the restored chat is in the chat list');
  assert.ok(!active.some(session => session.id === archived.alpha.id));
});

test('a restore that fails says why, and the panel then shows the archive as it is now', async t => {
  const { daemon, archived, rows } = await archivePanel(t);
  // Another client deletes the archived chat first, so this panel's list is out of date.
  const path = (await daemon.invoke('storage_report')).hosts[0].archives.find(archive => archive.cwd === archived.alpha.cwd).path;
  await daemon.invoke('delete_archived_session', { sessionPath: path, hostId: 'local', clientId: 'other-client' });
  const row = [...document.querySelectorAll('.session-item')].find(item => item.textContent.includes(archived.alpha.cwd));
  await act(async () => row.querySelector('button').click());
  await untilDom(() => document.querySelector('.session-scroll [role="alert"]'), 10000);
  assert.match(document.querySelector('.session-scroll [role="alert"]').textContent, /^Could not restore conversation. Could not locate archived conversation/);
  assert.deepEqual(rows(), [archived.beta.cwd]);
});
