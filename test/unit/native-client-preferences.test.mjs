import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

const start = { keybindings: { openSettings: 'Ctrl+,', toggleTerminal: 'Ctrl+J' }, debugMode: false, debugFeaturesOff: [] };
const edited = keybindings => ({ ...start, keybindings: { ...start.keybindings, ...keybindings } });

async function preferences(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  await native.invoke('save_client_settings', { settings: start, baseline: start });
  return {
    save: (settings, baseline = start) => native.invoke('save_client_settings', { settings, baseline }),
    initialize: settings => native.invoke('save_client_settings', { settings, baseline: settings, initialize: true }),
    stored: async () => (await native.invoke('load_client_settings')).settings,
  };
}

test('two windows that change different shortcuts both keep their change', async t => {
  const store = await preferences(t);
  await store.save(edited({ toggleTerminal: 'Alt+T' }));
  await store.save({ ...edited({ openSettings: 'Alt+S' }), debugMode: true });
  assert.deepEqual(await store.stored(), { keybindings: { openSettings: 'Alt+S', toggleTerminal: 'Alt+T' }, debugMode: true, debugFeaturesOff: [] });
});

test('two windows that change one shortcut differently cannot overwrite each other', async t => {
  const store = await preferences(t);
  await store.save(edited({ openSettings: 'Alt+S' }));
  await assert.rejects(store.save(edited({ openSettings: 'Alt+P' })), /^Error: Client preference conflict at keybindings.openSettings: another window changed this shortcut\. Reload the latest preferences and choose the shortcut again\.$/);
  await store.save(edited({ openSettings: 'Alt+S' }));
  assert.deepEqual((await store.stored()).keybindings, { openSettings: 'Alt+S', toggleTerminal: 'Ctrl+J' });
});

test('shortcuts that clash or take over search are refused and nothing is stored', async t => {
  const store = await preferences(t);
  await assert.rejects(store.save(edited({ openSettings: 'Mod+J' })), /shortcut (Mod\+J|Ctrl\+J) is assigned more than once/);
  await assert.rejects(store.save(edited({ openSettings: 'Ctrl+F' })), /^Error: Shortcut Ctrl\+F is reserved for search$/);
  await assert.rejects(store.save(edited({ openSettings: 'Shift+K' })), /^Error: Invalid shortcut for openSettings: Shift\+K$/);
  assert.deepEqual(await store.stored(), start);
});

test('a newly opened window cannot replace stored preferences with its defaults', async t => {
  const store = await preferences(t);
  await store.save(edited({ openSettings: 'Alt+S' }));
  const result = await store.initialize(start);
  assert.deepEqual(result.settings.keybindings, { openSettings: 'Alt+S', toggleTerminal: 'Ctrl+J' });
  assert.deepEqual((await store.stored()).keybindings, { openSettings: 'Alt+S', toggleTerminal: 'Ctrl+J' });
});
