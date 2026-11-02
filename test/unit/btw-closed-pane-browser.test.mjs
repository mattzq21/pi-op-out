import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { appBrowser } from '../app-browser-fixture.mjs';

test('a btw chat whose side pane closes at once still gets its question and keeps working', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await composer.fill('/btw Which colours fit best?');
  await composer.press('Enter');
  await page.locator('#sidepane-panel').waitFor();
  await page.getByRole('button', { name: /^Open side pane/ }).click();
  await page.locator('#sidepane-panel').waitFor({ state: 'hidden' });

  const btw = async () => (await page.daemon.invoke('list_sessions')).find(session => session.auxiliaryKind === 'btw');
  const asked = async () => { const session = await btw(); return Boolean(session) && (await readFile(session.path, 'utf8')).includes('Which colours fit best?'); };
  for (const deadline = Date.now() + 20000; !(await asked()) && Date.now() < deadline;) await page.waitForTimeout(100);
  assert.ok(await asked(), 'the btw question was never saved in its chat');
  await page.getByRole('button', { name: '1 working' }).waitFor();
  assert.equal((await btw()).isRunning, true);
});
