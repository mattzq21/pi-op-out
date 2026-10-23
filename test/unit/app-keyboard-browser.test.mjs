import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('configured settings shortcuts open settings while editing', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Alt+J' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  const goBack = page.getByRole('button', { name: 'Go back', exact: true });
  for (const [name, binding, key] of [
    ['configured Alt shortcut opens settings while editing a message', 'Alt+J', 'Alt+j'],
    ['a shortcut accepts spaces and lower-case key names in saved preferences', ' Ctrl + k ', 'Control+k'],
    ['Alt+Space opens settings while editing when configured', 'Alt+Space', 'Alt+Space'],
  ]) await t.test(name, async () => {
    if (binding !== 'Alt+J') {
      await page.evaluate(async binding => {
        const { settings } = await window.nativeCommand('load_client_settings');
        await window.nativeCommand('save_client_settings', {
          settings: { ...settings, keybindings: { ...settings.keybindings, openSettings: binding } },
          baseline: settings,
        });
      }, binding);
      await page.reload();
      await editor.waitFor();
    }
    await editor.fill('Keep this draft');
    assert.equal(await goBack.count(), 0);
    await page.keyboard.press(key);
    const field = page.getByRole('textbox', { name: 'Open settings shortcut', exact: true });
    await field.waitFor();
    if (binding === 'Alt+J') assert.equal(await field.inputValue(), binding);
    await goBack.click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), 'Keep this draft');
  });
});

test('a Mod shortcut accepts either primary modifier and requires one', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Mod+K' } });
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  const goBack = page.getByRole('button', { name: 'Go back', exact: true });
  await t.test('a Mod binding requires a primary modifier', async () => {
    await editor.fill('Keep this draft');
    await page.keyboard.press('k');
    assert.equal(await goBack.count(), 0);
    assert.equal(await editor.isVisible(), true);
    assert.equal(await editor.inputValue(), 'Keep this draftk');
  });
  for (const [name, key] of [['Ctrl', 'Control+k'], ['Meta', 'Meta+k']]) {
    await t.test(`a Mod shortcut opens settings with ${name} while editing`, async () => {
      await editor.fill('Keep this draft');
      assert.equal(await goBack.count(), 0);
      await page.keyboard.press(key);
      await page.getByRole('textbox', { name: 'Open settings shortcut', exact: true }).waitFor();
      await goBack.click();
      await editor.waitFor();
      assert.equal(await editor.inputValue(), 'Keep this draft');
    });
  }
});

test('unmatched settings shortcuts leave the composer unchanged', async t => {
  const page = await appBrowser(t);
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  for (const [name, binding, key] of [
    ['an unassigned settings shortcut does not react to Ctrl K', '', 'Control+k'],
    ['an extra Alt modifier prevents a Ctrl shortcut', 'Ctrl+K', 'Control+Alt+k'],
    ['an Alt binding does not react to Ctrl K', 'Alt+K', 'Control+k'],
    ['a Meta binding does not react to Ctrl K', 'Meta+K', 'Control+k'],
    ['a shifted binding requires Shift', 'Ctrl+Shift+K', 'Control+k'],
    ['a configured shortcut requires its assigned key', 'Ctrl+U', 'Control+k'],
  ]) await t.test(name, async () => {
    await page.evaluate(async binding => {
      const { settings } = await window.nativeCommand('load_client_settings');
      await window.nativeCommand('save_client_settings', {
        settings: { ...settings, keybindings: { ...settings.keybindings, openSettings: binding } },
        baseline: settings,
      });
    }, binding);
    await page.reload();
    await editor.waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Open settings shortcut', exact: true });
    if (!await field.isVisible()) await page.getByRole('button', { name: 'Keybinds' }).click();
    assert.equal(await field.inputValue(), binding);
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await editor.fill('Keep this draft');
    await page.keyboard.press(key);
    assert.equal(await page.getByRole('button', { name: 'Go back', exact: true }).count(), 0);
    assert.equal(await editor.isVisible(), true);
    assert.equal(await editor.inputValue(), 'Keep this draft');
  });
});

test('shared app shortcut actions', { timeout: 90000 }, async t => {
  const page = await appBrowser(t, { keybindings: { toggleConversations: 'Ctrl+B', newConversation: 'Alt+N' } });
  await t.test('holding the conversations shortcut toggles the conversation panel once', { timeout: 30000 }, async () => {
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
    await page.keyboard.press('Control+b');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await search.isVisible(), wasOpen);
  });

  await t.test('a shortcut field captures an assigned app shortcut without running it', { timeout: 30000 }, async () => {
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

  await t.test('Ctrl G asks before discarding unsaved settings and focuses conversation search only after discard', { timeout: 30000 }, async () => {
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
});

test('an open project dialog blocks the settings shortcut until the dialog is closed', async t => {
  const page = await appBrowser(t, { keybindings: { openSettings: 'Alt+J' } });
  await page.getByRole('region', { name: 'Conversation workspace ready', exact: true }).waitFor({ timeout: 30000 });
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
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.waitFor();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  await editor.fill('Start the conversation');
  await page.keyboard.press('Enter');
  await page.getByText('Reply to Start the conversation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  const terminal = page.getByRole('region', { name: 'Session terminal', exact: true });
  await terminal.locator('.xterm-rows').getByText('$').waitFor();
  return { editor, terminal };
}

test('Ctrl U in a focused terminal clears the shell line instead of opening settings', async t => {
  const page = await appBrowser(t, { model: 'echo', keybindings: { openSettings: 'Ctrl+U' } });
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
