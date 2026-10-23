import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appService } from '../app-service-fixture.mjs';
import { act, enterText, untilDom } from '../dom.mjs';

const navButton = (root, text) => [...root.querySelectorAll('.settings-host-nav button')].find(button => button.textContent.trim() === text);
const click = element => act(async () => element.click());

/** The app with the settings of the local daemon open. */
async function daemonSettings(t) {
  const app = await appService(t);
  await click(app.root.querySelector('[aria-label="Settings"]'));
  const daemonButton = await untilDom(() => [...app.root.querySelectorAll('.settings-host-nav .settings-nav-group:nth-of-type(2) button')][0], 10000);
  await click(daemonButton);
  const cap = await untilDom(() => app.root.querySelector('[aria-label="Context window cap"]'), 10000);
  return { ...app, daemonButton, cap };
}

test('unsaved daemon settings lock the other settings pages until they are saved or discarded', async t => {
  const { root, cap, daemon } = await daemonSettings(t);
  const saved = cap.value;
  const before = (await daemon.invoke('load_app_settings')).contextWindowCap;
  await enterText(cap, '250000');
  await untilDom(() => navButton(root, 'Keybinds').disabled, 10000);

  await click(root.querySelector('.settings-save > .discard-button'));
  const fresh = await untilDom(() => root.querySelector('[aria-label="Context window cap"]'));
  assert.equal(fresh.value, saved);
  assert.equal(navButton(root, 'Keybinds').disabled, false);
  assert.equal((await daemon.invoke('load_app_settings')).contextWindowCap, before, 'discarded edits never reach the daemon');
});

test('saved daemon settings reach the daemon and unlock the other pages', async t => {
  const { root, cap, daemon, settle } = await daemonSettings(t);
  await enterText(cap, '250000');
  await click(root.querySelector('.settings-save > .primary-button'));
  await untilDom(() => !navButton(root, 'Keybinds').disabled, 10000);
  await settle();
  assert.equal((await daemon.invoke('load_app_settings')).contextWindowCap, 250000);
  assert.equal(navButton(root, 'Keybinds').disabled, false);
});
