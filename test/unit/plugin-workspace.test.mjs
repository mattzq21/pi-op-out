import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, installDom, renderComponent, retryUntil, untilDom } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { createSignal, onCleanup } from 'solid-js';
import { plugins, refreshPlugins } from '../../clients/ui/plugins/index.ts';
import { createPluginWorkspace } from '../../clients/ui/plugins/workspace.tsx';
import { waitForClientPlugins } from '../../clients/ui/plugins/lifecycle.ts';

test('client plugins keep their draft across new chats, first messages and host changes', async () => {
  const dom = installDom();
  const loaders = plugins.map(plugin => plugin.load);
  const created = [], disposed = [];
  const statuses = {
    local: { enabled: ['chatgpt', 'markdown'], configured: ['chatgpt', 'markdown'], revision: 'local-1', error: null },
    remote: { enabled: ['markdown'], configured: ['markdown'], revision: 'remote-1', error: null },
  };
  let view, select;
  mockIPC((command, args) => {
    if (command === 'plugin_status') return statuses[args.hostId];
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
  for (const plugin of plugins) plugin.load = async () => ({ createPlugin() {
    const state = { id: plugin.id };
    created.push(state);
    onCleanup(() => disposed.push(state));
    return { panel: () => {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', plugin.name + ' draft');
      return input;
    } };
  } });

  try {
    view = await renderComponent(() => {
      const [source, setSource] = createSignal({ hostId: 'local', sessionId: 'saved', messageCount: 2, title: 'Saved', messages: [] });
      select = setSource;
      return createPluginWorkspace(source, () => true, () => {}).panel();
    });
    await retryUntil(() => assert.equal(created.length, 2));
    await waitForClientPlugins('local');
    const chatgpt = created.find(item => item.id === 'chatgpt');
    const option = await untilDom(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'ChatGPT'));
    await act(async () => option.click());
    const draft = await untilDom(() => document.querySelector('[aria-label="ChatGPT draft"]'));
    draft.value = 'Keep this unsent message';

    for (const target of [
      { hostId: 'local', sessionId: '', messageCount: 0 },
      { hostId: 'local', sessionId: 'new', messageCount: 1 },
      { hostId: 'remote', sessionId: 'remote-chat', messageCount: 1 },
    ]) {
      await act(async () => select({ ...target, title: 'Chat', messages: [] }));
      await waitForClientPlugins(target.hostId);
      assert.equal(disposed.includes(chatgpt), false);
      assert.equal(created.filter(item => item.id === 'chatgpt').length, 1);
      assert.equal(document.querySelector('[aria-label="ChatGPT draft"]'), draft);
      assert.equal(draft.value, 'Keep this unsent message');
    }

    statuses.remote.revision = 'remote-2';
    await act(() => refreshPlugins('remote'));
    await waitForClientPlugins('remote');
    assert.equal(disposed.includes(chatgpt), false, 'a remote restart must keep local plugins');

    statuses.local.revision = 'local-2';
    await act(() => refreshPlugins('local'));
    await waitForClientPlugins('local');
    assert.equal(disposed.includes(chatgpt), true, 'a local restart must reload local plugins');
    assert.equal(created.filter(item => item.id === 'chatgpt').length, 2);
  } finally {
    await view?.unmount();
    await act(async () => {});
    plugins.forEach((plugin, index) => { plugin.load = loaders[index]; });
    dom.restore();
  }
});

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
