import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'storage-ui-test' });
  const report = await daemon.invoke('storage_report');
  const archived = report.hosts.find(host => host.hostId === 'local').archives.find(chat => chat.name === 'Damaged chat');
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/storage-settings-browser.tsx', ready: '[aria-label="Permanently delete Damaged chat"]', holdStorage: false,
    prepare: page => page.exposeFunction('storageCommand', (command, args) => {
      assert.equal(command, 'daemon_invoke');
      return daemon.invoke(args.command, args.args);
    }),
  });
  await appendFile(archived.path, 'not JSON\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const summary = page.locator('summary').filter({ hasText: /^Storage coverage is incomplete/ });
  await summary.waitFor();
  assert.match(await summary.textContent(), /\d+ warnings?/);
  const warning = summary.locator('..').locator('p').filter({ hasText: archived.path });
  assert.equal(await warning.isVisible(), false);
  await summary.click();
  await warning.waitFor();
  assert.match(await warning.textContent(), /session provenance is incomplete/);
});

test('retrying a failed archive deletion removes the chat and clears the error', async t => {
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Stubborn chat' } }) + '\n' }),
  }));
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'storage-ui-test' });
  const report = await daemon.invoke('storage_report');
  const directory = dirname(report.hosts.find(host => host.hostId === 'local').archives.find(chat => chat.name === 'Stubborn chat').path);
  const mode = (await stat(directory)).mode & 0o777;
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/storage-settings-browser.tsx', ready: '[aria-label="Permanently delete Stubborn chat"]', holdStorage: false,
    prepare: page => page.exposeFunction('storageCommand', (command, args) => {
      assert.equal(command, 'daemon_invoke');
      return daemon.invoke(args.command, args.args);
    }),
  });
  page.on('dialog', dialog => dialog.accept());
  const remove = page.getByRole('button', { name: 'Permanently delete Stubborn chat' });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const alert = page.getByRole('alert');
  await chmod(directory, 0o500);
  try {
    await remove.click();
    await alert.waitFor();
    assert.match(await alert.textContent(), /^Could not delete conversation\..*(EACCES|Permission denied)/);
    await refresh.waitFor();
    assert.equal(await remove.isEnabled(), true);
    const kept = await daemon.invoke('storage_report');
    assert.deepEqual(kept.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name), ['Stubborn chat']);
  } finally { await chmod(directory, mode); }
  await remove.click();
  await remove.waitFor({ state: 'detached' });
  await refresh.waitFor();
  assert.equal(await alert.count(), 0);
  const after = await daemon.invoke('storage_report');
  assert.deepEqual(after.hosts.find(host => host.hostId === 'local').archives.map(chat => chat.name), []);
});
