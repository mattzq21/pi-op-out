import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

const initial = { keybindings: { newConversation: 'Mod+N', openSettings: 'Mod+,' }, debugMode: false };

async function storedPreferences(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('save_client_settings', { settings: initial, baseline: initial });
  return native;
}

test('a save from an older window keeps the shortcut another window saved', async t => {
  const native = await storedPreferences(t);
  const stale = (await native.invoke('load_client_settings')).settings;
  await native.invoke('save_client_settings', { settings: { ...stale, keybindings: { ...stale.keybindings, newConversation: 'Mod+Shift+N' } }, baseline: stale });

  await native.invoke('save_client_settings', { settings: { ...stale, debugMode: true }, baseline: stale });
  const { settings } = await native.invoke('load_client_settings');
  assert.equal(settings.keybindings.newConversation, 'Mod+Shift+N');
  assert.equal(settings.debugMode, true);
});

test('a conflicting shortcut save from an older window is rejected and keeps the saved shortcut', async t => {
  const native = await storedPreferences(t);
  const stale = (await native.invoke('load_client_settings')).settings;
  await native.invoke('save_client_settings', { settings: { ...stale, keybindings: { ...stale.keybindings, newConversation: 'Mod+Shift+N' } }, baseline: stale });

  await assert.rejects(native.invoke('save_client_settings', { settings: { ...stale, debugMode: true, keybindings: { ...stale.keybindings, newConversation: 'Alt+N' } }, baseline: stale }),
    /^Error: Client preference conflict at keybindings\.newConversation: another window changed this shortcut\./);
  const { settings } = await native.invoke('load_client_settings');
  assert.equal(settings.keybindings.newConversation, 'Mod+Shift+N');
  assert.equal(settings.debugMode, false);
});

