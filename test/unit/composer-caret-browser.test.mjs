import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('the composer caret returns to its place after switching chats', { timeout: 90000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('First chat');
  await editor.press('Enter');
  await page.getByText('Reply to First chat').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await editor.fill('Hello world');
  await editor.press('Home');
  for (let index = 0; index < 5; index++) await editor.press('ArrowRight');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByText('Reply to First chat').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^First chat,/ }).click();
  await page.getByText('Reply to First chat').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message piop');
  await page.keyboard.type('!');
  assert.equal(await editor.inputValue(), 'Hello! world');
});

test('each saved chat keeps its own composer caret', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  for (const name of ['Alpha chat', 'Beta chat']) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await editor.fill(name);
    await editor.press('Enter');
    await page.getByText(`Reply to ${name}`).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  }
  const open = async name => {
    await page.getByRole('button', { name: new RegExp(`^${name},`) }).click();
    await page.getByText(`Reply to ${name}`).waitFor();
  };
  const place = async (text, offset) => {
    await editor.fill(text);
    await editor.press('Home');
    for (let index = 0; index < offset; index++) await editor.press('ArrowRight');
  };
  await open('Alpha chat');
  await place('Hello world', 5);
  await open('Beta chat');
  await place('Other text', 1);
  await open('Alpha chat');
  await editor.focus();
  await page.keyboard.type('!');
  assert.equal(await editor.inputValue(), 'Hello! world');
  await open('Beta chat');
  await editor.focus();
  await page.keyboard.type('!');
  assert.equal(await editor.inputValue(), 'O!ther text');
});
