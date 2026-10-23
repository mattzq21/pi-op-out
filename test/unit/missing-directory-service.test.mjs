import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appService } from '../app-service-fixture.mjs';
import { act, untilDom } from '../dom.mjs';

/** The app with one saved chat whose project folder was deleted before the app opened. */
async function appWithMissingFolder(t) {
  let chat, cwd;
  const app = await appService(t, { beforeMount: async ({ daemon }) => {
    const home = await daemon.invoke('home_directory', { hostId: 'local' });
    cwd = join(home, 'work', 'deleted-project'); mkdirSync(cwd, { recursive: true });
    chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, cwd, folder: 'deleted', content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Work in this folder', timestamp: 1 } }) + '\n' }) }));
    rmSync(cwd, { recursive: true });
  } });
  const row = await untilDom(() => document.querySelector(`[data-session-key="local:${chat.id}"] .session-main`), 10000);
  const dialog = () => document.querySelector('dialog.missing-directory-dialog');
  const button = text => [...dialog().querySelectorAll('button')].find(item => item.textContent === text);
  return { ...app, chat, cwd, row, dialog, button };
}

test('missing project folder recovery', { timeout: 60000 }, async t => {
  const { row, dialog, button, cwd, daemon, chat, root, settle } = await appWithMissingFolder(t);
  await t.test('opening a chat whose folder is gone asks first, and cancelling leaves everything as it was', { timeout: 30000 }, async () => {
    await act(async () => row.click());
    await untilDom(() => dialog()?.open, 10000);
    assert.match(dialog().textContent, /Working directory is missing/);
    assert.equal(dialog().querySelector('.missing-directory-path').textContent, cwd);
    await act(async () => button('Cancel').click());
    await settle();
    assert.equal(dialog(), null);
    assert.equal(existsSync(cwd), false);
  });
  await t.test('creating an empty folder opens the same chat in a new empty folder', { timeout: 30000 }, async () => {
    await act(async () => row.click());
    await untilDom(() => dialog()?.open, 10000);
    await act(async () => button('Create empty folder').click());
    await untilDom(() => !dialog(), 15000);
    await settle();
    const recovered = (await daemon.invoke('list_sessions')).find(session => session.id === chat.id);
    assert.ok(existsSync(recovered.cwd), 'the chat has a folder again');
    assert.deepEqual(readdirSync(recovered.cwd), [], 'the new folder is empty');
    assert.notEqual(recovered.cwd, cwd);
    await untilDom(() => document.querySelector(`[data-session-key="local:${chat.id}"] .session-main`)?.getAttribute('aria-current') === 'page', 10000);
    const history = readFileSync(recovered.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual([history[0].id, history[0].cwd], [chat.id, recovered.cwd], 'the same chat file now names the new folder');
    void root;
  });
});
