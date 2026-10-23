import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const open = t => startupPage(t, 'development', { entryPoint: 'test/fixtures/zoomable-image-browser.tsx', ready: 'main', holdStorage: false });
const shownWidth = page => page.getByRole('dialog', { name: 'Chart' }).locator('img').evaluate(image => image.getBoundingClientRect().width);

test('an image opens in a viewer that fits it to the window, shows it at full size, zooms, and closes back to the image', async t => {
  const page = await open(t);
  await page.setViewportSize({ width: 1000, height: 700 });
  const preview = page.getByRole('button', { name: 'Enlarge image: Chart' });
  await preview.click();
  const viewer = page.getByRole('dialog', { name: 'Chart' });
  await viewer.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close image');
  assert.ok(await shownWidth(page) <= 1000, 'the image fits the window');

  await viewer.getByRole('button', { name: 'View image at full size' }).locator('img').click();
  await viewer.getByRole('button', { name: 'Fit image to screen' }).waitFor();
  assert.equal(Math.round(await shownWidth(page)), 2000);
  await viewer.getByRole('button', { name: 'Fit image to screen' }).locator('img').click();
  await viewer.getByRole('button', { name: 'View image at full size' }).waitFor();

  const fitted = await shownWidth(page);
  await page.mouse.move(500, 350);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(width => document.querySelector('dialog img').getBoundingClientRect().width > width, fitted);
  await viewer.getByRole('button', { name: 'Fit image to screen' }).waitFor();

  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Enlarge image: Chart');
  await preview.click();
  await page.getByRole('button', { name: 'Close image' }).click();
  await viewer.waitFor({ state: 'detached' });
});

test('an image that cannot load says so and cannot be opened', async t => {
  const page = await open(t);
  const preview = page.getByRole('button', { name: 'Image unavailable: Missing chart' });
  await preview.waitFor();
  assert.equal(await preview.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.imageErrors), 1);
});
