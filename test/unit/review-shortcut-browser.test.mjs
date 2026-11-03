import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('Ctrl+Alt+R starts a review in a side pane', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.focus();
  await page.keyboard.press('Control+Alt+r');
  await page.getByRole('region', { name: /^Side chat: Review/ }).waitFor({ timeout: 30000 });
});
