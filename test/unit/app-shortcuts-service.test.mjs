import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

for (const [name, shortcut] of [
  ["a bare function key cannot be saved as a shortcut", "F2"],
  ["a bare plus cannot be saved as a shortcut", "+"],
  ["a modifier without a key cannot be saved as a shortcut", "Ctrl"],
  ["a bare letter cannot be saved as a shortcut", "K"],
  ["Shift alone cannot qualify a saved shortcut", "Shift+K"],
]) test(name, async t => {
  const native = await nativeFileCommand(t, { desktop: true });
  const baseline = { keybindings: { openSettings: "Ctrl+," }, debugMode: false };
  await assert.rejects(native.invoke('save_client_settings', {
    baseline, settings: { ...baseline, keybindings: { openSettings: shortcut } },
  }), { message: `Invalid shortcut for openSettings: ${shortcut}` });
  assert.equal((await native.invoke('load_client_settings')).settings, null);
});
