import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { savePanelSize } from '../panel-size-save.mjs';

const open = async t => {
  const page = await startupPage(t, 'development', { entryPoint: 'test/fixtures/sidebar-width-browser.tsx', ready: '[aria-label="Sidebar width"]', holdStorage: false });
  await page.setViewportSize({ width: 1200, height: 800 });
  return page;
};
const handle = page => page.getByRole('separator', { name: 'Sidebar width' });
const width = async page => Number(await handle(page).getAttribute('aria-valuenow'));
const railWidth = page => page.locator('.icon-rail').evaluate(node => node.style.getPropertyValue('--rail-width'));

test('the sidebar resizes by dragging and by keys, within its limits, and keeps its width after a reload', async t => {
  const page = await open(t);
  const start = await width(page);
  const box = await handle(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 100, { steps: 5 });
  await page.mouse.up();
  assert.equal(await width(page), start + 80, 'dragging right makes it wider');
  assert.equal(await railWidth(page), `${start + 80}px`);

  await handle(page).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await width(page), start + 70);
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await width(page), start + 120);
  await page.keyboard.press('Home');
  assert.equal(await width(page), 200, 'Home goes to the narrowest width');
  await page.keyboard.press('End');
  assert.equal(await width(page), 600, 'End goes to half the window');
  await page.keyboard.press('ArrowRight');
  assert.equal(await width(page), 600, 'it never grows past half the window');

  await page.keyboard.press('Home');
  await savePanelSize(page, 'pi-desktop-sidebar-width', 250, () => page.keyboard.press('Shift+ArrowRight'));
  await page.reload();
  await handle(page).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Sidebar width"]').getAttribute('aria-valuenow') === '250');
});

test('a compact sidebar has no resize handle, and a double click sets the default width', async t => {
  const page = await open(t);
  await handle(page).focus();
  await page.keyboard.press('Home');
  await handle(page).dblclick();
  assert.equal(await width(page), 320, 'the default width on a wide window');
  await page.getByLabel('Compact').check();
  assert.equal(await handle(page).count(), 0);
});
