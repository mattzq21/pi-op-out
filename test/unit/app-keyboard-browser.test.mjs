import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

test('a shortcut field captures an assigned app shortcut without running it', async t => {
  const page = await appBrowser(t, { keybindings: { newConversation: 'Alt+N' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.fill('Keep this draft');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const binding = page.getByRole('textbox', { name: 'Toggle conversations shortcut', exact: true });
  if (!await binding.isVisible()) await page.getByRole('button', { name: 'Keybinds' }).click();
  await binding.focus();
  await page.keyboard.press('Alt+n');
  assert.equal(await binding.inputValue(), 'Alt+N');
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).isVisible(), true);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'Keep this draft');
});

test('Ctrl G asks before discarding unsaved settings and focuses conversation search only after discard', async t => {
  const page = await appBrowser(t);
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  const goBack = page.getByRole('button', { name: 'Go back', exact: true });
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await editor.fill('Keep this draft');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const retry = page.getByRole('switch', { name: 'Automatic retry', exact: true });
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Local', exact: true }).click();
  const edited = String(await retry.getAttribute('aria-checked') !== 'true');
  await retry.click();
  assert.equal(await retry.getAttribute('aria-checked'), edited);
  const messages = [];
  page.once('dialog', dialog => { messages.push(dialog.message()); return dialog.dismiss(); });
  await page.keyboard.press('Control+g');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(messages, ['Discard unsaved settings changes?']);
  assert.equal(await goBack.isVisible(), true);
  assert.equal(await retry.getAttribute('aria-checked'), edited);
  page.once('dialog', dialog => { messages.push(dialog.message()); return dialog.accept(); });
  await page.keyboard.press('Control+g');
  await search.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search conversations');
  assert.deepEqual(messages, ['Discard unsaved settings changes?', 'Discard unsaved settings changes?']);
  assert.equal(await goBack.count(), 0);
  assert.equal(await editor.inputValue(), 'Keep this draft');
});

test('an open project dialog blocks the settings shortcut until the dialog is closed', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Alt+J' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  const goBack = page.getByRole('button', { name: 'Go back', exact: true });
  await editor.fill('Keep this draft');
  await page.getByRole('button', { name: 'Choose project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Jump to a folder', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Alt+j');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await goBack.count(), 0);
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole('button', { name: 'esc', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), 'Keep this draft');
  await page.keyboard.press('Alt+j');
  await page.getByRole('textbox', { name: 'Open settings shortcut', exact: true }).waitFor();
  await goBack.click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'Keep this draft');
});

async function openShell(page) {
  const home = await page.evaluate(() => window.nativeCommand('daemon_invoke', { command: 'home_directory', args: { hostId: 'local' } }));
  await mkdir(join(home, '.piop'), { recursive: true });
  await writeFile(join(home, '.piop', 'models.json'), JSON.stringify({ providers: { 'offline-test': {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'unused-test-key', models: [{ id: 'offline', name: 'Offline' }],
  } } }));
  await page.reload();
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.waitFor();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /Offline/ }).click();
  await editor.fill('Start the conversation');
  await page.keyboard.press('Enter');
  await page.getByText('Response failed: Connection error.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  const terminal = page.getByRole('region', { name: 'Session terminal', exact: true });
  await terminal.locator('.xterm-rows').getByText('$').waitFor();
  return { editor, terminal };
}

test('Ctrl U in a focused terminal clears the shell line instead of opening settings', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Ctrl+U' } });
  const { editor, terminal } = await openShell(page);
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.type('echo discarded');
  await page.keyboard.press('Control+u');
  await page.keyboard.type('echo shell-$((6*7))');
  await page.keyboard.press('Enter');
  await terminal.getByText('shell-42', { exact: true }).waitFor();
  assert.equal(await terminal.getByText('discarded').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).count(), 0);
  await editor.focus();
  await page.keyboard.press('Control+u');
  await page.getByRole('textbox', { name: 'Open settings shortcut', exact: true }).waitFor();
});
