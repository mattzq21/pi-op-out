import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { daemonClient } from '../daemon-client.mjs';
import { startupPage } from '../startup-browser-fixture.mjs';

test('storage warns when an archived transcript has damaged content', async t => {
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Damaged chat' } }) + '\n' }),
  }));
  await daemon.invoke('archive_session', { hostId: 'local', sessionId: chat.id, terminalIds: [], clientId: 'storage-ui-test' });
  const report = await daemon.invoke('storage_report');
  const archived = report.hosts.find(host => host.hostId === 'local').archives.find(chat => chat.name === 'Damaged chat');
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/storage-settings-browser.tsx', ready: '[aria-label="Permanently delete Damaged chat"]', holdStorage: false,
    prepare: page => page.exposeFunction('storageCommand', (command, args) => {
      assert.equal(command, 'daemon_invoke');
      return daemon.invoke(args.command, args.args);
    }),
  });
  await writeFile(archived.path, 'not JSON\n' + await readFile(archived.path, 'utf8'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const blocked = page.locator('[aria-label^="Cannot safely delete Unreadable conversation"]');
  await blocked.waitFor();
  assert.equal(await blocked.isDisabled(), true);
  const row = page.locator('.archive-row.cleanup-unavailable').filter({ has: blocked });
  assert.match(await row.textContent(), /Cleanup unavailable · This archive has invalid chat data\./);
  assert.equal(await page.locator('[aria-label="Permanently delete Damaged chat"]').count(), 0);
});
