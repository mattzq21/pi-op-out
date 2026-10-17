import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('configured Alt shortcut opens settings while editing a message', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Alt+J' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.fill('Keep this draft');
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).count(), 0);
  await page.keyboard.press('Alt+j');
  const binding = page.getByRole('textbox', { name: 'Open settings shortcut', exact: true });
  await binding.waitFor();
  assert.equal(await binding.inputValue(), 'Alt+J');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'Keep this draft');
});

async function openSettingsWithShortcut(t, binding, key) {
  const page = await appBrowser(t, { keybindings: { openSettings: binding } });
  await page.getByRole('textbox', { name: 'Message piop', exact: true }).fill('Keep this draft');
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).count(), 0);
  await page.keyboard.press(key);
  await page.getByRole('textbox', { name: 'Open settings shortcut', exact: true }).waitFor();
  return page;
}

test('a Mod shortcut opens settings with Ctrl while editing', async t => {
  await openSettingsWithShortcut(t, 'Mod+K', 'Control+k');
});

test('a Mod shortcut opens settings with Meta while editing', async t => {
  await openSettingsWithShortcut(t, 'Mod+K', 'Meta+k');
});

test('a shortcut accepts spaces and lower-case key names in saved preferences', async t => {
  await openSettingsWithShortcut(t, ' Ctrl + k ', 'Control+k');
});

test('Alt+Space opens settings while editing when configured', async t => {
  await openSettingsWithShortcut(t, 'Alt+Space', 'Alt+Space');
});

async function ignoreSettingsShortcut(t, binding, key, expectedDraft = 'Keep this draft') {
  const page = await appBrowser(t, { keybindings: { openSettings: binding } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.fill('Keep this draft');
  await page.keyboard.press(key);
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).count(), 0);
  assert.equal(await editor.isVisible(), true);
  assert.equal(await editor.inputValue(), expectedDraft);
}

test('an unassigned settings shortcut does not react to Ctrl K', async t => {
  await ignoreSettingsShortcut(t, '', 'Control+k');
});

test('a Mod binding requires a primary modifier', async t => {
  await ignoreSettingsShortcut(t, 'Mod+K', 'k', 'Keep this draftk');
});

test('an extra Alt modifier prevents a Ctrl shortcut', async t => {
  await ignoreSettingsShortcut(t, 'Ctrl+K', 'Control+Alt+k');
});

test('an Alt binding does not react to Ctrl K', async t => {
  await ignoreSettingsShortcut(t, 'Alt+K', 'Control+k');
});

test('a Meta binding does not react to Ctrl K', async t => {
  await ignoreSettingsShortcut(t, 'Meta+K', 'Control+k');
});

test('a shifted binding requires Shift', async t => {
  await ignoreSettingsShortcut(t, 'Ctrl+Shift+K', 'Control+k');
});

test('a configured shortcut requires its assigned key', async t => {
  await ignoreSettingsShortcut(t, 'Ctrl+U', 'Control+k');
});

test('holding the conversations shortcut toggles the conversation panel once', async t => {
  const page = await appBrowser(t, { keybindings: { toggleConversations: 'Ctrl+B' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await editor.fill('Keep this draft');
  const wasOpen = await search.isVisible();
  await page.keyboard.down('Control');
  for (let press = 0; press < 4; press++) await page.keyboard.down('b');
  await page.keyboard.up('b');
  await page.keyboard.up('Control');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await search.isVisible(), !wasOpen);
  assert.equal(await editor.inputValue(), 'Keep this draft');
});
