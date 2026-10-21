import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeClientPreferences } from '../../clients/ui/lib/clientPreferenceMerge.ts';

const start = { keybindings: { openSettings: 'Ctrl+,', toggleTerminal: 'Ctrl+J' }, debugMode: false, dictationEngine: 'transcribe.cpp', dictationArgs: '' };
const edit = changes => ({ ...structuredClone(start), ...changes, keybindings: { ...start.keybindings, ...changes.keybindings } });

test('changes made in two windows to different settings are both kept', () => {
  const otherWindow = edit({ keybindings: { toggleTerminal: 'Alt+T' }, dictationArgs: '--fast' });
  const thisWindow = edit({ keybindings: { openSettings: 'Alt+S' }, debugMode: true });
  assert.deepEqual(mergeClientPreferences(otherWindow, start, thisWindow), {
    conflicts: [],
    preferences: { keybindings: { openSettings: 'Alt+S', toggleTerminal: 'Alt+T' }, debugMode: true, dictationEngine: 'transcribe.cpp', dictationModelPath: undefined, dictationArgs: '--fast', dictationEngines: undefined },
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

test('dictation engines merge one engine at a time', () => {
  const transcribe = models => ({ engine: 'transcribe.cpp', models });
  const needle = models => ({ engine: 'needle', models });
  const base = edit({ dictationEngines: [transcribe([]), needle([])] });
  const other = edit({ dictationEngines: [transcribe([{ path: '/m/small.gguf' }]), needle([])] });
  const mine = edit({ dictationEngines: [transcribe([]), needle([{ path: '/m/en.cact' }])] });
  assert.deepEqual(mergeClientPreferences(other, base, mine), { conflicts: [], preferences: { ...mine, dictationModelPath: undefined, dictationEngines: [transcribe([{ path: '/m/small.gguf' }]), needle([{ path: '/m/en.cact' }])] } });
  const clash = edit({ dictationEngines: [transcribe([{ path: '/m/large.gguf' }]), needle([])] });
  assert.deepEqual(mergeClientPreferences(other, base, clash).conflicts, ['dictationEngines.transcribe.cpp']);
});
