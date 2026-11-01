import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('the composer caret returns to its place after switching chats', { timeout: 90000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('First chat');
  await editor.press('Enter');
  await page.getByText('Reply to First chat').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await editor.fill('Hello world');
  await editor.press('Home');
  for (let index = 0; index < 5; index++) await editor.press('ArrowRight');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByText('Reply to First chat').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^First chat,/ }).click();
  await page.getByText('Reply to First chat').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message piop');
  await page.keyboard.type('!');
  assert.equal(await editor.inputValue(), 'Hello! world');
});
