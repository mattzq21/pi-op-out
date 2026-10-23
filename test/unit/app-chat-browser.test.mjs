import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser, trackBrowserStorage } from '../app-browser-fixture.mjs';

async function chooseModel(page) {
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
}

async function send(page, message) {
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill(message);
  await composer.press('Enter');
  await page.getByText('Reply to ' + message).waitFor({ timeout: 30000 });
  return composer;
}

test('chat messages, reopening, and archiving', { timeout: 90000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await t.test('a message typed in the composer is answered by the model, and the composer is cleared', { timeout: 30000 }, async () => {
    await chooseModel(page);
    const composer = await send(page, 'Hello from the window');
    assert.equal(await composer.inputValue(), '');
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  });

  await t.test('a chat without a project reopens after its first reply and a full reload', { timeout: 30000 }, async () => {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await chooseModel(page);
    await trackBrowserStorage(page);
    await send(page, 'Reopen this chat');
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
    await page.evaluate(() => window.savedDraft());
    await page.reload();
    await page.getByRole('textbox', { name: 'Message piop' }).waitFor();
    await page.getByText('Reply to Reopen this chat').waitFor();
  });

  await t.test('archiving the open chat removes it from the chat list and opens a new empty chat', { timeout: 30000 }, async () => {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await chooseModel(page);
    await send(page, 'Archive this chat');
    const archive = page.getByRole('button', { name: 'Archive Archive this chat' });
    await page.getByRole('button', { name: /^Archive this chat,/ }).hover();
    await archive.waitFor();
    page.once('dialog', dialog => dialog.accept());
    await archive.click();
    await archive.waitFor({ state: 'detached' });
    await page.getByText('Reply to Archive this chat').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).inputValue(), '');
  });
});
