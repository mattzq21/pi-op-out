import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// WebKitGTK sends no paste event when an image is pasted, so the editor reads the clipboard after Ctrl+V. Chromium sends a paste event with the image.
for (const way of ['a paste event', 'Ctrl+V without a paste event']) test('an image pasted into a queued message being edited is attached to it, through ' + way, { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('First');
  await composer.press('Enter');
  await page.getByText('Reply to First').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Hold queue', exact: true }).click();
  await composer.fill('Look at this');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Edit queued message: Look at this', exact: true }).click();
  const editor = page.locator('.composer .pending-edit');
  assert.equal(await page.locator('.pending-message textarea').count(), 0);
  const colors = await page.evaluate(() => ['.composer.editing-pending', '.pending-message.editing-pending'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
  assert.deepEqual(colors, ['rgb(73, 55, 40)', 'rgb(73, 55, 40)']);
  await editor.focus();
  await page.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, PNG);
  if (way === 'a paste event') await page.keyboard.press('Control+V');
  else await editor.dispatchEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true });
  await page.locator('.composer .attachment-image img').waitFor({ timeout: 5000 });
  await editor.press('Enter');
  await editor.waitFor({ state: 'detached' });
  await page.locator('.pending-message .pending-images img').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.pending-message .pending-images img').count(), 1);
});
