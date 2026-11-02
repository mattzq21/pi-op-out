import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { appBrowser } from '../app-browser-fixture.mjs';

const screens = process.env.PIOP_SCREENSHOTS;
const shoot = async (page, name) => { if (screens) await page.screenshot({ path: join(screens, name + '.png') }); };

test('running side agents show in the header pill, grouped by kind, and a row opens their chat', { timeout: 150000 }, async t => {
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
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '5 working' }).click();
  await page.mouse.click(700, 300);
  await popover.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '5 working' }).click();
  await popover.getByRole('button', { name: /^Rocket Draw a rocket/ }).click();
  await popover.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Rocket', selected: true }).waitFor();
});
