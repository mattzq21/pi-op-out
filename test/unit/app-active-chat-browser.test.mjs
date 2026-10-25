import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function chooseModel(page) {
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
}

async function activeChat(page) {
  return page.evaluate(() => [...document.querySelectorAll('.session-item.active')].map(item => item.querySelector('.session-main')?.getAttribute('aria-label')?.split(',')[0]));
}

for (const withImage of [false, true]) test('the chat list marks a new chat as active after its first message' + (withImage ? ' with an image' : ''), { timeout: 60000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await chooseModel(page);
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  if (withImage) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async image => {
      const bytes = Uint8Array.from(atob(image), char => char.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    }, PIXEL);
    await composer.focus();
    await page.keyboard.press('Control+v');
    await page.locator('.attachments button').first().waitFor();
  }
  await composer.fill('Look here');
  await composer.press('Enter');
  await page.getByText('Reply to Look here').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^Look here,/ }).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await activeChat(page), ['Look here']);
});
