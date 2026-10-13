import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appService } from '../app-service-fixture.mjs';

test("a bare function key cannot be saved as a shortcut", async t => {
  await assert.rejects(appService(t, { keybindings: { openSettings: "F2" } }), /Invalid shortcut for openSettings:/);
});

test("a bare plus cannot be saved as a shortcut", async t => {
  await assert.rejects(appService(t, { keybindings: { openSettings: "+" } }), /Invalid shortcut for openSettings:/);
});

test("a modifier without a key cannot be saved as a shortcut", async t => {
  await assert.rejects(appService(t, { keybindings: { openSettings: "Ctrl" } }), /Invalid shortcut for openSettings:/);
});

test("a bare letter cannot be saved as a shortcut", async t => {
  await assert.rejects(appService(t, { keybindings: { openSettings: "K" } }), /Invalid shortcut for openSettings:/);
});

test("Shift alone cannot qualify a saved shortcut", async t => {
  await assert.rejects(appService(t, { keybindings: { openSettings: "Shift+K" } }), /Invalid shortcut for openSettings:/);
});
