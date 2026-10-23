import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

const initial = { keybindings: { newConversation: 'Mod+N', openSettings: 'Mod+,' }, debugMode: false, debugFeaturesOff: [] };

async function storedPreferences(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('save_client_settings', { settings: initial, baseline: initial });
  return native;
}

test('a window that initializes preferences from a stale empty read keeps the preferences another window saved, and can still save an edit after', async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  assert.equal((await native.invoke('load_client_settings')).settings, null);
  assert.equal((await native.invoke('load_client_settings')).settings, null);
  // Both windows read the same old local preference (debug mode on) on top of the defaults before either window saved.
  const local = { ...initial, debugMode: true };

  await native.invoke('save_client_settings', { settings: local, baseline: initial, initialize: true });
  await native.invoke('save_client_settings', { settings: { ...local, debugMode: false, keybindings: { ...local.keybindings, newConversation: 'Mod+Shift+N' } }, baseline: local });
  const latest = { keybindings: { newConversation: 'Mod+Shift+N', openSettings: 'Mod+,' }, debugMode: false, debugFeaturesOff: [] };

  const late = await native.invoke('save_client_settings', { settings: local, baseline: initial, initialize: true });
  assert.deepEqual(late.settings, latest);
  assert.deepEqual(await native.invoke('load_client_settings'), { settings: latest, revision: late.revision });

  await native.invoke('save_client_settings', { settings: { ...late.settings, keybindings: { ...late.settings.keybindings, openSettings: 'Mod+;' } }, baseline: late.settings });
  assert.deepEqual((await native.invoke('load_client_settings')).settings, { keybindings: { newConversation: 'Mod+Shift+N', openSettings: 'Mod+;' }, debugMode: false, debugFeaturesOff: [] });
});

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

test('older windows that each pick the same effective shortcut for different actions cannot save the combined clash', async t => {
  const native = await storedPreferences(t);
  const stale = (await native.invoke('load_client_settings')).settings;
  await native.invoke('save_client_settings', { settings: { ...stale, keybindings: { ...stale.keybindings, newConversation: 'Mod+Shift+K' } }, baseline: stale });

  await assert.rejects(native.invoke('save_client_settings', { settings: { ...stale, debugMode: true, keybindings: { ...stale.keybindings, openSettings: ' ctrl + SHIFT + k' } }, baseline: stale }),
    /^Error: Client preference conflict at keybindings\.(newConversation|openSettings): shortcut .+ is assigned more than once\./);
  assert.deepEqual((await native.invoke('load_client_settings')).settings, { keybindings: { newConversation: 'Mod+Shift+K', openSettings: 'Mod+,' }, debugMode: false, debugFeaturesOff: [] });

  await native.invoke('save_client_settings', { settings: { ...stale, debugMode: true, keybindings: { ...stale.keybindings, openSettings: 'Ctrl+Shift+L' } }, baseline: stale });
  assert.deepEqual((await native.invoke('load_client_settings')).settings, { keybindings: { newConversation: 'Mod+Shift+K', openSettings: 'Ctrl+Shift+L' }, debugMode: true, debugFeaturesOff: [] });
});
