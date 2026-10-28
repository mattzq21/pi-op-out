import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { installDom, renderComponent, act } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { skillMcpSession } from '../skill-mcp-session-fixture.mjs';

test('chat Retry and Remove buttons control a real failed MCP and removal survives agent SIGKILL', { timeout: 30000 }, async t => {
  const f = await skillMcpSession(t); let worker = await f.start();
  let state = await worker.command({ op: 'prompt', mode: 'read' }); const name = state.servers[0];
  process.kill(Number(readFileSync(f.pid, 'utf8')), 'SIGKILL');
  await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('failed'));
  state = await worker.command({ op: 'snapshot' });
  const dom = installDom(), actions = []; let actionDone;
  const base = { subscribe: () => () => {}, ownsConversation: () => true, hasConfirmedOwnership: () => true, isConnected: () => true, currentHostId: () => 'local', command(command) {
    assert.equal(command.type, 'skill_mcp'); actions.push(command);
    actionDone = worker.command({ op: 'action', name: command.name, action: command.action }); return actionDone;
  } };
  const transport = new Proxy(base, { get: (target, key) => key in target || key === 'then' || typeof key === 'symbol' ? target[key] : () => undefined });
  const noop = () => {};
  const props = () => ({ transport, onSend: noop, onAbort: noop, onOpenProject: noop, onBranch: noop, onModel: noop, onToggleFastMode: noop, onThinking: noop,
    state: { sessionId: 'session', isStreaming: false, messageCount: 0, pendingMessages: [], thinkingLevel: 'off', model: null }, messages: [], models: [], commands: [], thinkingLevels: ['off'], widgets: [], statuses: state.statuses });
  const view = await renderComponent(ChatView, props());
  t.after(async () => { await view.unmount(); dom.restore(); });
  const panel = () => view.container.querySelector('[aria-label="Skill MCP servers"]');
  const button = label => [...panel().querySelectorAll('button')].find(button => button.textContent === label);
  assert.match(panel().textContent, /skill: fixture/);
  writeFileSync(f.blocked, 'blocked');
  await act(() => button('Retry').click()); await assert.rejects(actionDone, /fixture cannot start/); await act(() => {});
  assert.match(panel().textContent, /fixture cannot start/);
  rmSync(f.blocked); await act(() => button('Retry').click()); await actionDone;
  state = await worker.command({ op: 'snapshot' }); await view.rerender(props());
  assert.equal(panel(), null);
  const before = worker.eventCount; process.kill(Number(readFileSync(f.pid, 'utf8')), 'SIGKILL');
  await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('failed'), before);
  state = await worker.command({ op: 'snapshot' }); await view.rerender(props());
  await act(() => button('Remove').click()); await actionDone;
  state = await worker.command({ op: 'snapshot' }); await view.rerender(props()); assert.equal(panel(), null);
  assert.deepEqual(actions.map(action => [action.name, action.action]), [[name, 'retry'], [name, 'retry'], [name, 'remove']]);
  await worker.kill(); worker = await f.start();
  state = await worker.command({ op: 'prompt' }); await view.rerender(props()); assert.equal(panel(), null); assert.deepEqual(state.servers, []);
});
