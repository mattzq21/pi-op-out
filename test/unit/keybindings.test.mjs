import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultKeybindings, keybindingsError } from '../../clients/ui/lib/keybindings.ts';

const withSettings = shortcut => ({ ...defaultKeybindings, openSettings: shortcut });

test('two actions cannot share a key press, counting Mod as both Ctrl and Meta', () => {
  assert.equal(keybindingsError(defaultKeybindings), undefined);
  assert.equal(keybindingsError(withSettings('Mod+N')), 'Shortcut “Mod+N” is assigned more than once');
  assert.equal(keybindingsError(withSettings('ctrl + n')), 'Shortcut “ctrl + n” is assigned more than once');
  assert.equal(keybindingsError(withSettings('Meta+N')), undefined);
  assert.equal(keybindingsError(withSettings('Ctrl+Alt+N')), undefined);
  assert.equal(keybindingsError(withSettings('Ctrl+Shift+N')), undefined);
  assert.equal(keybindingsError(withSettings('')), undefined, 'an unassigned action clashes with nothing');
});

test('find shortcuts stay reserved for search, but their Shift and Alt forms can be bound', () => {
  for (const shortcut of ['Ctrl+F', 'Mod+G', 'Meta+f']) assert.equal(keybindingsError(withSettings(shortcut)), `Shortcut “${shortcut}” is reserved for search`);
  for (const shortcut of ['Ctrl+Shift+F', 'Alt+F', 'Ctrl+Alt+G']) assert.equal(keybindingsError(withSettings(shortcut)), undefined);
});

test('the plus key can be bound with a modifier', () => {
  assert.equal(keybindingsError(withSettings('Ctrl++')), undefined);
  assert.equal(keybindingsError({ ...withSettings('Ctrl++'), focusComposer: 'Mod++' }), 'Shortcut “Ctrl++” is assigned more than once');
});
