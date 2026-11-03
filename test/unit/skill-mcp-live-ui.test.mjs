import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { installDom, renderComponent } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { branchMessages } from '../../clients/ui/lib/messages.ts';
import { skillMcpConnecting } from '../../clients/ui/lib/skillMcpStatus.ts';
import { skillMcpSession } from '../skill-mcp-session-fixture.mjs';

const props = (messages, statuses = {}) => {
  const transport = new Proxy({ subscribe: () => () => {}, ownsConversation: () => true, hasConfirmedOwnership: () => true, isConnected: () => true, currentHostId: () => 'local' }, { get: (target, key) => key in target || key === 'then' || typeof key === 'symbol' ? target[key] : () => undefined });
  const noop = () => {};
  return { transport, onSend: noop, onAbort: noop, onOpenProject: noop, onBranch: noop, onModel: noop, onToggleFastMode: noop, onThinking: noop,
    state: { sessionId: 'session', isStreaming: false, messageCount: messages.length, pendingMessages: [], thinkingLevel: 'off', model: null }, messages, models: [], commands: [], thinkingLevels: ['off'], widgets: [], statuses };
};

test('a skill MCP that fails to load for the agent shows one centered notice in the chat history', { timeout: 30000 }, async t => {
  const f = await skillMcpSession(t), worker = await f.start(); writeFileSync(f.blocked, 'blocked');
  const state = await worker.command({ op: 'prompt', mode: 'read' });
  const dom = installDom();
  const view = await renderComponent(ChatView, props(branchMessages(state.entries, state.leaf)));
  t.after(async () => { await view.unmount(); dom.restore(); });
  const notices = [...view.container.querySelectorAll('.conversation .command-result')].map(notice => notice.textContent);
  assert.deepEqual(notices, ['The embedded MCP of skill "skill" failed to load.']);
  assert.equal(view.container.querySelector('[aria-label="Skill MCP servers"]'), null);
});

test('only a connecting skill MCP holds the message', () => {
  assert.equal(skillMcpConnecting(JSON.stringify([{ name: 'skill_a', label: 'app: a', state: 'connecting' }])), true);
  assert.equal(skillMcpConnecting(JSON.stringify([{ name: 'skill_a', label: 'app: a', state: 'connected' }])), false);
  assert.equal(skillMcpConnecting(undefined), false);
});
