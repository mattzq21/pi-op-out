import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { savePanelSize } from '../panel-size-save.mjs';

const open = async t => {
  const page = await startupPage(t, 'development', { entryPoint: 'test/fixtures/terminal-panel-browser.tsx', ready: '[aria-label="Terminal panel height"]', holdStorage: false });
  await page.setViewportSize({ width: 900, height: 800 });
  return page;
};
const height = page => page.getByRole('region', { name: 'Session terminal' }).evaluate(node => Math.round(node.getBoundingClientRect().height));
const handle = page => page.getByRole('separator', { name: 'Terminal panel height' });

test('the terminal panel resizes by dragging and by keys, within its limits, and keeps its height after a reload', async t => {
  const page = await open(t);
  const start = await height(page);
  const box = await handle(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  assert.equal(await height(page), start + 100, 'dragging up makes it taller');

  await handle(page).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await height(page), start + 90);
  await page.keyboard.press('Shift+ArrowUp');
  assert.equal(await height(page), start + 140);
  await page.keyboard.press('Home');
  assert.equal(await height(page), 140, 'Home goes to the smallest height');
  await page.keyboard.press('End');
  assert.equal(await height(page), 600, 'End goes to three quarters of the window');
  await page.keyboard.press('ArrowUp');
  assert.equal(await height(page), 600, 'it never grows past the limit');

  await page.keyboard.press('Home');
  await savePanelSize(page, 'pi-desktop-terminal-height', 190, () => page.keyboard.press('Shift+ArrowUp'));
  await page.reload();
  await handle(page).waitFor();
  await page.waitForFunction(() => Math.round(document.querySelector('[aria-label="Session terminal"]').getBoundingClientRect().height) === 190);
});

test('a double click on the handle sets the default height again', async t => {
  const page = await open(t);
  await handle(page).focus();
  await page.keyboard.press('Home');
  assert.equal(await height(page), 140);
  await handle(page).dblclick();
  // The default is a third of the window height, between 210 and 380 pixels.
  assert.equal(await height(page), Math.round(800 * 0.34));
});
