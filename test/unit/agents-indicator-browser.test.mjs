import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { appBrowser } from '../app-browser-fixture.mjs';

const screens = process.env.PIOP_SCREENSHOTS;
const shoot = async (page, name) => { if (screens) await page.screenshot({ path: join(screens, name + '.png') }); };

test('running side agents show in the header pill and in the dock, grouped by kind, and open their chat', { timeout: 150000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Draw with helpers: six SVGs that make me smile');
  await composer.press('Enter');

  const pill = page.getByRole('button', { name: '4 working' });
  await pill.waitFor({ timeout: 60000 });
  await composer.fill('/btw Which colours fit best?');
  await composer.press('Enter');
  await page.getByRole('button', { name: '5 working' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /^Open side pane/ }).click();
  await page.locator('#sidepane-panel').waitFor({ state: 'hidden' });
  await page.mouse.move(700, 500);
  await shoot(page, 'pill-closed');

  await page.getByRole('button', { name: '5 working' }).click();
  const popover = page.getByRole('dialog', { name: 'Side agents' });
  await popover.waitFor();
  assert.deepEqual(await popover.locator('.agents-group header span:first-child').allTextContents(), ['Subagents', 'Btw']);
  const names = await popover.locator('.agents-row-name').allTextContents();
  assert.deepEqual(names.slice(0, 6), ['Bloom', 'Rocket', 'Pixel', 'Toast', 'Kitty', 'Octo']);
  assert.equal(names.length, 7);
  await popover.getByRole('button', { name: /^Rocket Draw a rocket/ }).hover();
  await shoot(page, 'pill-open');
  await popover.getByRole('button', { name: /^Rocket Draw a rocket/ }).click();
  await page.getByRole('tab', { name: 'Rocket', selected: true }).waitFor();
  await page.getByRole('button', { name: /^Open side pane/ }).click();

  await page.evaluate(() => localStorage.setItem('piop-agents-indicator', 'dock'));
  await page.reload();
  const dock = page.getByRole('navigation', { name: 'Side agents' });
  await dock.waitFor({ timeout: 30000 });
  assert.deepEqual(await dock.locator('.agents-dock-kind').allTextContents(), ['Sub', 'Btw']);
  await page.mouse.move(700, 500);
  await shoot(page, 'dock');
  await dock.getByRole('button', { name: 'Rocket, working' }).hover();
  const card = page.getByRole('tooltip');
  await card.waitFor();
  assert.match(await card.textContent(), /^Rocket.*Subagents.*Working.*rocket lift-off/);
  await shoot(page, 'dock-hover');
  await dock.getByRole('button', { name: 'Kitty, idle' }).click();
  await page.getByRole('tab', { name: 'Kitty', selected: true }).waitFor();
});
