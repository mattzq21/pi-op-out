import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

async function recorder(t) {
  const page = await appBrowser(t, { keybindings: { newConversation: 'Ctrl+N', openSettings: 'Alt+J' } });
  await page.keyboard.press('Alt+j');
  const input = page.getByRole('textbox', { name: 'New conversation shortcut', exact: true });
  await input.waitFor();
  await input.focus();
  return { page, input, async saveAndReload() {
    await page.getByRole('button', { name: 'Save changes', exact: true }).first().click();
    await page.getByRole('button', { name: 'Saved', exact: true }).first().waitFor();
    await page.reload();
    await page.getByRole('textbox', { name: 'Message piop', exact: true }).waitFor();
    await page.keyboard.press('Alt+j');
    await input.waitFor();
  } };
}

test('shortcut recording saves key combinations across reloads', async t => {
  const { page, input, saveAndReload } = await recorder(t);
  for (const [name, key, expected] of [
    ['saves Control Space with a readable key name', 'Control+Space', 'Ctrl+Space'],
    ['saves every modifier on a key combination', 'Control+Meta+Alt+Shift+n', 'Ctrl+Meta+Alt+Shift+N'],
    ['saves modified Tab as a shortcut', 'Alt+Tab', 'Alt+Tab'],
  ]) await t.test(`shortcut recording ${name}`, async () => {
    await input.focus();
    await page.keyboard.press(key);
    assert.equal(await input.inputValue(), expected);
    await saveAndReload();
    assert.equal(await input.inputValue(), expected);
  });
});

test('shortcut recording captures a function key and asks for a modifier before saving', async t => {
  const { page, input } = await recorder(t);
  await page.keyboard.press('F2');
  assert.equal(await input.inputValue(), 'F2');
  const error = page.getByRole('alert').filter({ hasText: 'needs Ctrl, Alt, or Meta' });
  await error.waitFor();
  assert.match(await error.textContent(), /needs Ctrl, Alt, or Meta/);
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).first().isDisabled(), true);
});

test('shortcut recording leaves unsupported input unchanged', async t => {
  const { page, input } = await recorder(t);
  for (const [name, key, text] of [
    ['ignores Meta alone', 'Meta'],
    ['ignores Control alone', 'Control'],
    ['ignores Alt alone', 'Alt'],
    ['ignores Shift alone', 'Shift'],
    ['leaves ordinary typing unchanged', 'a'],
    ['ignores Tab alone', 'Tab'],
    ['ignores Escape', 'Escape'],
    ['ignores emoji typing', null, '🦆'],
    ['ignores shifted typing', 'Shift+a'],
  ]) await t.test(`shortcut recording ${name}`, async () => {
    await input.focus();
    if (text) await page.keyboard.insertText(text);
    else await page.keyboard.press(key);
    assert.equal(await input.inputValue(), 'Ctrl+N');
    assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).first().isDisabled(), true);
  });
});

test('shortcut recording detects collisions, allows clearing, and restores defaults', async t => {
  const { page, input, saveAndReload } = await recorder(t);
  await page.keyboard.press('Tab');
  assert.equal(await input.evaluate(node => node === document.activeElement), false);
  await input.focus();
  await page.keyboard.press('Control+b');
  const error = page.getByRole('alert').filter({ hasText: 'assigned more than once' });
  await error.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).first().isDisabled(), true);
  await page.keyboard.press('Backspace');
  assert.equal(await input.inputValue(), '');
  assert.equal(await error.count(), 0);
  await page.keyboard.press('Control+Shift+k');
  await saveAndReload();
  assert.equal(await input.inputValue(), 'Ctrl+Shift+K');
  await page.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Saved', exact: true }).first().waitFor();
  await page.reload();
  await page.getByRole('textbox', { name: 'Message piop', exact: true }).waitFor();
  await page.keyboard.press('Control+,');
  await input.waitFor();
  for (const [label, shortcut] of [
    ['New conversation', 'Ctrl+N'], ['Toggle conversations', 'Ctrl+B'],
    ['Toggle terminal', 'Ctrl+J'], ['Toggle debug mode', 'Ctrl+D'],
    ['Focus composer', 'Ctrl+E'], ['Open settings', 'Ctrl+,'],
  ]) assert.equal(await page.getByRole('textbox', { name: `${label} shortcut`, exact: true }).inputValue(), shortcut);
});
