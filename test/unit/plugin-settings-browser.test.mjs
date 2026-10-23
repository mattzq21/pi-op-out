import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act, installDom, renderComponent, untilDom } from '../dom.mjs';
import { clearMocks, mockIPC } from '../mock-ipc.mjs';
import { PluginSettings } from '../../clients/ui/components/PluginSettings.tsx';

let dom, view, restarts, status;

beforeEach(() => {
  dom = installDom(); restarts = [];
  status = { enabled: ['cost', 'review'], configured: ['cost', 'review'], revision: 'first', error: null };
  // The daemon side of a restart has its own test; this daemon answers as one with one open terminal.
  mockIPC((command, args) => {
    if (command === 'plugin_status') return status;
    if (command === 'restart_daemon') {
      restarts.push(args);
      if (!args.closeTerminals) return { confirmationRequired: 'terminals', terminalCount: 1 };
      status = { enabled: args.enabled, configured: args.enabled, revision: 'second', error: null };
      return { restartId: 'restart-1' };
    }
    if (command === 'daemon_restart_status') return { phase: 'complete', error: null };
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
});
afterEach(async () => { await view?.unmount(); view = undefined; clearMocks(); dom.restore(); });

const control = label => document.querySelector(`[aria-label="${label}"]`);
const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
const click = element => act(async () => element.click());

test('restarting with an open terminal asks first; cancel keeps the terminal, confirm restarts with the chosen plugins', async () => {
  view = await renderComponent(PluginSettings, { hostId: 'local' });
  await untilDom(() => button('Restart daemon') && !button('Restart daemon').disabled);
  await click(control('Enable Cost limit plugin'));
  await click(button('Restart daemon'));
  const dialog = await untilDom(() => control('Close terminals and restart?'));
  assert.match(dialog.textContent, /close 1 running terminal,/);

  await click(button('Cancel'));
  assert.equal(control('Close terminals and restart?'), null);
  assert.deepEqual(restarts.map(request => request.closeTerminals), [false]);

  await click(button('Restart daemon'));
  await untilDom(() => control('Close terminals and restart?'));
  await click(button('Close terminals and restart'));
  await untilDom(() => control('Daemon restarted'), 5000);
  assert.deepEqual(restarts.at(-1), { hostId: 'local', enabled: ['review'], revision: 'first', closeTerminals: true });
  assert.equal(control('Enable Cost limit plugin').getAttribute('aria-checked'), 'false');
  assert.equal(control('Enable Review plugin').getAttribute('aria-checked'), 'true');
});

test('a plugin setup that cannot load shows the daemon message, and Reload tries again', async () => {
  let fail = true;
  clearMocks();
  mockIPC(command => {
    if (command === 'plugin_status') { if (fail) throw new Error('Plugins are unavailable'); return status; }
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
  view = await renderComponent(PluginSettings, { hostId: 'local' });
  const alert = await untilDom(() => document.querySelector('[role="alert"]'));
  assert.equal(alert.textContent, 'Plugins are unavailable');
  fail = false;
  await click(button('Reload plugin setup'));
  await untilDom(() => !document.querySelector('[role="alert"]') && control('Enable Review plugin'));
});

test('cost and review can be enabled independently in plugin settings', async () => {
  status = { enabled: [], configured: [], revision: 'first', error: null };
  view = await renderComponent(PluginSettings, { hostId: 'local' });
  const cost = await untilDom(() => control('Enable Cost limit plugin'));
  const review = control('Enable Review plugin');
  assert.equal(cost.getAttribute('aria-checked'), 'false');
  assert.equal(review.getAttribute('aria-checked'), 'false');
  await click(cost);
  await click(review);
  await click(button('Restart daemon'));
  await untilDom(() => control('Close terminals and restart?'));
  await click(button('Close terminals and restart'));
  await untilDom(() => control('Daemon restarted'), 5000);
  assert.deepEqual(restarts.at(-1).enabled, ['cost', 'review']);
  assert.equal(control('Enable Cost limit plugin').getAttribute('aria-checked'), 'true');
  assert.equal(control('Enable Review plugin').getAttribute('aria-checked'), 'true');
});
