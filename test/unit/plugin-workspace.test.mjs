import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, installDom, renderComponent, retryUntil } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { onCleanup } from 'solid-js';
import { plugins, refreshPlugins } from '../../clients/ui/plugins/index.ts';
import { createPluginWorkspace } from '../../clients/ui/plugins/workspace.tsx';
import { waitForClientPlugins } from '../../clients/ui/plugins/lifecycle.ts';

test('command plugins start without adding empty tabs, and unload when disabled', async () => {
  const dom = installDom();
  const loaders = plugins.map(plugin => plugin.load);
  const created = [], disposed = [];
  let status = { enabled: ['cost', 'review'], configured: ['cost', 'review'], revision: 'commands-1', error: null };
  let view;
  mockIPC(command => {
    if (command === 'plugin_status') return status;
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
  for (const plugin of plugins) plugin.load = async () => ({ createPlugin() {
    created.push(plugin.id);
    onCleanup(() => disposed.push(plugin.id));
    return {};
  } });
  try {
    await refreshPlugins('local');
    view = await renderComponent(() => {
      const workspace = createPluginWorkspace(() => ({ hostId: 'local', sessionId: '', messageCount: 0, title: 'New chat', messages: [] }), () => true, () => {});
      return [workspace.button(), workspace.panel()];
    });
    await retryUntil(() => assert.deepEqual(created, ['cost', 'review']));
    await waitForClientPlugins('local');
    assert.equal(document.querySelector('[aria-label="Open sidepane"]'), null);
    assert.equal(document.querySelector('[role="tab"]'), null);
    status = { enabled: [], configured: [], revision: 'commands-2', error: null };
    await act(() => refreshPlugins('local'));
    await waitForClientPlugins('local');
    assert.deepEqual(disposed, ['cost', 'review']);
    assert.equal(document.querySelector('[aria-label="Open sidepane"]'), null);
  } finally {
    await view?.unmount();
    plugins.forEach((plugin, index) => { plugin.load = loaders[index]; });
    dom.restore();
  }
});
