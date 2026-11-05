import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, installDom, renderComponent, retryUntil } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { refreshPlugins } from '../../clients/ui/plugins/index.ts';
import { createPluginWorkspace } from '../../clients/ui/plugins/workspace.tsx';
import { waitForClientPlugins } from '../../clients/ui/plugins/lifecycle.ts';

// A client part as a plugin builds it: it gets Solid from the app.
const client = id => `const { onCleanup } = globalThis[Symbol.for("piop.plugin-modules")]["solid-js"];
export function createPlugin() { globalThis.pluginEvents.push("start ${id}"); onCleanup(() => globalThis.pluginEvents.push("stop ${id}")); return {}; }
`;

const CATALOG = [{ id: 'notes', name: 'Notes', client: { scope: 'host' } }, { id: 'clock', name: 'Clock', client: { scope: 'host' } }, { id: 'cost', name: 'Cost limit' }];

test('the client parts of the enabled plugins of a host start, and stop when the plugins are disabled', async () => {
  const dom = installDom();
  globalThis.pluginEvents = [];
  let status = { enabled: ['notes', 'clock', 'cost'], configured: ['notes', 'clock', 'cost'], revision: 'commands-1', error: null, plugins: CATALOG, queuedCommands: ['compact'], queuedWithPrompt: [] };
  const loaded = [];
  let view;
  mockIPC((command, args) => {
    if (command === 'plugin_status') return status;
    if (command === 'plugin_client') { loaded.push(args.id); return { source: client(args.id) }; }
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
  try {
    await refreshPlugins('local');
    view = await renderComponent(() => {
      createPluginWorkspace(() => ({ hostId: 'local', sessionId: '', messageCount: 0, title: 'New chat', messages: [] }));
      return [];
    });
    await retryUntil(() => assert.deepEqual(globalThis.pluginEvents.toSorted(), ['start clock', 'start notes']));
    assert.deepEqual(loaded.toSorted(), ['clock', 'notes']);
    await waitForClientPlugins('local');
    status = { enabled: [], configured: [], revision: 'commands-2', error: null, plugins: CATALOG, queuedCommands: ['compact'], queuedWithPrompt: [] };
    await act(() => refreshPlugins('local'));
    await waitForClientPlugins('local');
    assert.deepEqual(globalThis.pluginEvents.slice(2).toSorted(), ['stop clock', 'stop notes']);
  } finally {
    await view?.unmount();
    dom.restore();
  }
});

test('a client part that cannot load is reported for its host', async () => {
  const dom = installDom();
  const status = { enabled: ['notes'], configured: ['notes'], revision: 'broken-1', error: null, plugins: [{ id: 'notes', name: 'Notes', client: { scope: 'host' } }], queuedCommands: ['compact'], queuedWithPrompt: [] };
  mockIPC(command => {
    if (command === 'plugin_status') return status;
    if (command === 'plugin_client') return { source: 'export const settings = { label: "Notes" };' };
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
  try {
    await refreshPlugins('broken');
    await assert.rejects(waitForClientPlugins('broken'), /Notes: Invalid client\.mjs/);
  } finally { dom.restore(); }
});
