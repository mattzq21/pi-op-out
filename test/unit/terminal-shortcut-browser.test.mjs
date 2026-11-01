import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('the toggle terminal and focus composer keys work in a focused terminal and other Ctrl keys still reach the shell', async t => {
  const page = await startupPage(t, 'development', { entryPoint: 'test/fixtures/terminal-shortcut-browser.tsx', ready: '.xterm-screen', holdStorage: false });
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.querySelector('[aria-label="Shell input"]').textContent === JSON.stringify('\u000b'));
  await page.keyboard.press('Control+j');
  await page.waitForFunction(() => document.querySelector('[aria-label="Terminal toggles"]').textContent === '1');
  assert.equal(await page.getByLabel('Shell input').textContent(), JSON.stringify('\u000b'), 'Ctrl+J does not reach the shell');
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+e');
  await page.waitForFunction(() => document.querySelector('[aria-label="Composer focuses"]').textContent === '1');
  assert.equal(await page.getByLabel('Shell input').textContent(), JSON.stringify('\u000b'), 'Ctrl+E does not reach the shell');
});
