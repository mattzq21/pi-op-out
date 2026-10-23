import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeClientPreferences } from '../../clients/ui/lib/clientPreferenceMerge.ts';

const start = { keybindings: { openSettings: 'Ctrl+,', toggleTerminal: 'Ctrl+J' }, debugMode: false, debugFeaturesOff: [] };
const edit = changes => ({ ...structuredClone(start), ...changes, keybindings: { ...start.keybindings, ...changes.keybindings } });

test('changes made in two windows to different settings are both kept', () => {
  const otherWindow = edit({ keybindings: { toggleTerminal: 'Alt+T' } });
  const thisWindow = edit({ keybindings: { openSettings: 'Alt+S' }, debugMode: true });
  assert.deepEqual(mergeClientPreferences(otherWindow, start, thisWindow), {
    conflicts: [],
    preferences: { keybindings: { openSettings: 'Alt+S', toggleTerminal: 'Alt+T' }, debugMode: true, debugFeaturesOff: [] },
  });
});

test('two windows changing one shortcut differently is a conflict, the same change is not', () => {
  const conflicts = (other, mine) => mergeClientPreferences(edit(other), start, edit(mine)).conflicts;
  assert.deepEqual(conflicts({ keybindings: { openSettings: 'Alt+S' } }, { keybindings: { openSettings: 'Alt+P' } }), ['keybindings.openSettings']);
  assert.deepEqual(conflicts({ keybindings: { openSettings: 'Alt+S' } }, { keybindings: { openSettings: 'Alt+S' } }), []);
  const removed = { ...structuredClone(start), keybindings: { toggleTerminal: 'Ctrl+J' } };
  const merged = mergeClientPreferences(edit({ keybindings: { toggleTerminal: 'Alt+T' } }), start, removed);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.preferences.keybindings, { toggleTerminal: 'Alt+T' });
});
