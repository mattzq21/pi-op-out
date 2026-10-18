import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const open = t => startupPage(t, 'development', { entryPoint: 'test/fixtures/toast-history-browser.tsx', ready: 'main', holdStorage: false });
const shown = async page => page.locator('.toast-history-entry p').allTextContents();
async function notify(page, text) {
  await page.getByLabel('Notice text').fill(text);
  await page.getByRole('button', { name: 'Notify' }).click();
}

test('toast history keeps the newest 10 notices, newest first, after a reload and in every open window', async t => {
  const first = await open(t);
  assert.deepEqual(await shown(first), []);
  await first.getByText('No toasts recorded yet.').waitFor();
  const second = await first.context().newPage();
  await second.goto(first.url());
  await second.locator('main').waitFor();

  for (let index = 1; index <= 12; index++) await notify(first, 'Notice ' + index);
  const newest = Array.from({ length: 10 }, (_, index) => 'Notice ' + (12 - index));
  await first.waitForFunction(() => document.querySelectorAll('.toast-history-entry').length === 10);
  assert.deepEqual(await shown(first), newest);
  // The other window hears about the saved notices without a reload.
  await second.waitForFunction(() => document.querySelector('.toast-history-entry p')?.textContent === 'Notice 12');
  assert.deepEqual(await shown(second), newest);

  await first.reload();
  await first.waitForFunction(() => document.querySelectorAll('.toast-history-entry').length === 10);
  assert.deepEqual(await shown(first), newest);
  assert.match(await first.locator('.toast-history-entry small').first().textContent(), /test window$/);
});
