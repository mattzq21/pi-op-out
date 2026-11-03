import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, enterText, act, untilDom } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { ChatAgentPane } from '../../clients/ui/components/ChatAgentPane.tsx';
import { defaultKeybindings } from '../../clients/ui/lib/keybindings.ts';
import { DEFINED_AGENTS_STATUS_KEY } from '../../clients/ui/lib/agentProtocol.ts';

async function openPane() {
  const dom = installDom();
  mockIPC(() => ({ ready: true, providers: {} }), { shouldMockEvents: true });
  const settings = { hiddenModels: [], defaultThinking: 'off', defaultFastMode: false, modelContextWindowCaps: {}, hiddenUsageIndicators: [], keybindings: { ...defaultKeybindings }, tools: [], skills: [], hosts: [] };
  const chat = (description, model = 'p/a', effort = 'high', extra = {}) => ({ agent: { name: 'general', description, model, effort, tools: [], skills: [], mcpServers: {}, allowed_subagents: 'all', allowed_peers: 'all', ...extra }, systemPrompt: 'You help.', agentPrompt: '' });
  const listeners = new Set();
  const loads = [Promise.resolve(chat('first'))];
  const applied = [];
  const transport = {
    connect: async () => {}, loadHostSettings: async () => settings,
    command: async request => {
      if (request.type === 'chat_agent') return loads.shift();
      if (request.type === 'set_chat_agent') { applied.push(request); return {}; }
      return { models: [{ provider: 'p', id: 'a', name: 'A', reasoning: true }, { provider: 'p', id: 'b', name: 'B', reasoning: true }] };
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const statusUpdate = () => act(async () => { for (const listener of listeners) listener({ type: 'extension_ui_request', method: 'setStatus', statusKey: DEFINED_AGENTS_STATUS_KEY }); });
  const runtimePool = { forSession: () => transport, hold: () => () => {}, detachIdle: () => {} };
  const view = await renderComponent(ChatAgentPane, { session: { id: 's', path: '/s.jsonl', hostId: 'local' }, runtimePool, settings, agentNames: [], onActivate: () => {} });
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  return { dom, view, control, button, loads, applied, statusUpdate, chat };
}

test('agent updates reach an open pane: unedited fields take the new values, edited fields keep the user\'s values', async () => {
  const { dom, view, control, button, loads, applied, statusUpdate, chat } = await openPane();
  let finish;
  try {
    await untilDom(() => control('Agent description')?.value === 'first');

    loads.push(new Promise(resolve => { finish = () => resolve(chat('first', 'p/b', 'low')); }));
    await statusUpdate();
    await enterText(control('Agent description'), 'my edit');
    await enterText(control('Agent context cap'), '500k');
    await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(control('Agent description').value, 'my edit');
    assert.equal(control('Agent default model').dataset.value, 'p/b');
    assert.equal(control('Agent default effort').value, 'low');
    assert.equal(control('Agent context cap').value, '500k');

    loads.push(Promise.resolve(chat('my edit', 'p/b', 'low')));
    await act(async () => button('Apply').click());
    await untilDom(() => applied.length === 1);
    assert.deepEqual([applied[0].agent.description, applied[0].agent.model, applied[0].agent.effort, applied[0].agent.contextWindowCap], ['my edit', 'p/b', 'low', 500_000]);
    await untilDom(() => button('Applied'));
    assert.equal(document.querySelector('[role="alert"]'), null);

    loads.push(Promise.resolve(chat('switched', 'p/a', 'high')));
    await enterText(control('Agent description'), 'another edit');
    await statusUpdate();
    await untilDom(() => control('Agent default model').dataset.value === 'p/a');
    assert.equal(control('Agent description').value, 'another edit');
    await act(async () => button('Discard').click());
    assert.equal(control('Agent description').value, 'switched');

    loads.push(Promise.resolve(chat('described', 'p/a', 'high', { contextWindowCap: 300_000 })));
    await statusUpdate();
    await untilDom(() => control('Agent context cap').value === '300k' && control('Agent description').value === 'described');
    await enterText(control('Agent context cap'), '');
    await enterText(control('Agent description'), '');
    loads.push(Promise.resolve(chat('described', 'p/b', 'high', { contextWindowCap: 300_000 })));
    await statusUpdate();
    await untilDom(() => control('Agent default model').dataset.value === 'p/b');
    assert.equal(control('Agent context cap').value, '');
    assert.equal(control('Agent description').value, '');
    loads.push(Promise.resolve(chat('', 'p/b', 'high')));
    await act(async () => button('Apply').click());
    await untilDom(() => applied.length === 2);
    assert.equal(applied[1].agent.contextWindowCap, undefined);
    assert.ok(!applied[1].agent.description);
    assert.equal(applied[1].agent.model, 'p/b');
  } finally { await view.unmount(); dom.restore(); }
});

test('Apply waits for a pending refresh, and stays blocked when that refresh fails', async () => {
  const { dom, view, control, button, loads, applied, statusUpdate, chat } = await openPane();
  try {
    await untilDom(() => control('Agent description')?.value === 'first');
    await enterText(control('Agent description'), 'my edit');
    assert.equal(button('Apply').disabled, false);
    let fail;
    loads.push(new Promise((_resolve, reject) => { fail = () => reject(new Error('offline')); }));
    await statusUpdate();
    assert.equal(button('Apply').disabled, true);
    await act(async () => button('Apply').click());
    await act(async () => { fail(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.match(document.querySelector('[role="alert"]').textContent, /offline/);
    assert.equal(button('Apply').disabled, true);
    assert.equal(applied.length, 0);

    let finish;
    loads.push(new Promise(resolve => { finish = () => resolve(chat('first', 'p/b', 'low')); }));
    await statusUpdate();
    await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(button('Apply').disabled, false);
    assert.equal(control('Agent description').value, 'my edit');
    assert.equal(control('Agent default model').dataset.value, 'p/b');
  } finally { await view.unmount(); dom.restore(); }
});

test('a refresh that takes new MCP settings shows them in the MCP editor', async () => {
  const { dom, view, control, button, loads, applied, statusUpdate, chat } = await openPane();
  try {
    await untilDom(() => control('Agent description')?.value === 'first');
    await act(async () => control('Edit MCP servers as JSON').click());
    await enterText(control('MCP server configuration'), '{"old": {"command": "a"}}');
    await enterText(control('MCP server configuration'), '{}');
    await enterText(control('Agent description'), 'my edit');
    loads.push(Promise.resolve(chat('first', 'p/a', 'high', { mcpServers: { fresh: { command: 'b' } } })));
    await statusUpdate();
    await untilDom(() => JSON.parse(control('MCP server configuration')?.value ?? '{}').fresh?.command === 'b');
    loads.push(Promise.resolve(chat('my edit', 'p/a', 'high', { mcpServers: { fresh: { command: 'b' } } })));
    await act(async () => button('Apply').click());
    await untilDom(() => applied.length === 1);
    assert.deepEqual(applied[0].agent.mcpServers, { fresh: { command: 'b' } });
    assert.equal(applied[0].agent.description, 'my edit');
  } finally { await view.unmount(); dom.restore(); }
});
