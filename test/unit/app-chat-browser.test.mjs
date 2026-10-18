import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

/** The app on a real daemon whose only model echoes each message, with that model chosen. */
async function chatPage(t) {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  return page;
}

async function send(page, message) {
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill(message);
  await composer.press('Enter');
  await page.getByText('Reply to ' + message).waitFor({ timeout: 30000 });
  return composer;
}

test('a message typed in the composer is answered by the model, and the composer is cleared', async t => {
  const page = await chatPage(t);
  const composer = await send(page, 'Hello from the window');
  assert.equal(await composer.inputValue(), '');
});

test('archiving the open chat removes it from the chat list and opens a new empty chat', async t => {
  const page = await chatPage(t);
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

