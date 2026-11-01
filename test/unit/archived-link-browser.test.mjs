import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

async function chooseModel(page) {
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
}

async function send(page, message, reply) {
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill(message);
  await composer.press('Enter');
  await page.getByText(reply).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
}

test('a link to an archived chat offers to restore it, and the restored chat opens', { timeout: 90000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await chooseModel(page);
  await send(page, 'Plan the release', 'Reply to Plan the release');
  const key = await page.locator('.session-item.active').getAttribute('data-session-key');
  const separator = key.indexOf(':');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /^Plan the release,/ }).hover();
  await page.getByRole('button', { name: 'Archive Plan the release' }).click();
  await page.getByText('Reply to Plan the release').waitFor({ state: 'detached' });
  await chooseModel(page);
  await send(page, `Continue [Plan the release](piop://session/${key.slice(0, separator)}/${key.slice(separator + 1)}).`, /^Reply to Continue/);

  const link = page.locator('.user-message button[data-session-reference]').first();
  const popup = page.getByRole('dialog', { name: 'Plan the release is archived' });
  await link.click();
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await popup.waitFor({ state: 'detached' });

  await link.click();
  await popup.getByRole('button', { name: 'Restore and open' }).click();
  await popup.waitFor({ state: 'detached' });
  await page.getByText('Reply to Plan the release').waitFor();
  await page.locator('.session-item.active[data-session-key="' + key + '"]').waitFor();
});
