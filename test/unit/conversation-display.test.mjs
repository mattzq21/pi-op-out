import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { debugView } from '../../clients/ui/lib/debugFeatures.ts';

const allDebug = debugView({ debugMode: true });

async function conversation(t, extra = {}) {
  const dom = installDom();
  let view, storage;
  const requests = new Set();
  const settle = async () => { do { await storage?.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => { await settle(); await view?.unmount(); await settle(); storage?.restore(); if (storage) clearMocks(); dom.restore(); });
  if (extra.readOnly === false) {
    const native = await nativeFileCommand(t, { desktop: true });
    storage = trackStorage(indexedDB);
    mockIPC(async (command, args) => {
      const request = native.invoke(command, args); requests.add(request);
      try { return await request; } finally { requests.delete(request); }
    }, { background: false, shouldMockEvents: true });
  }
  let props = {
    readOnly: true, state: { model: null, thinkingLevel: 'off', isStreaming: false, messageCount: 0 },
    messages: [], models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {}, ...extra,
  };
  view = await renderComponent(ChatView, props);
  view.update = async changes => { props = { ...props, ...changes }; await view.rerender(props); };
  view.dom = dom;
  return view;
}

const summary = (view, text) => [...view.container.querySelectorAll('summary')].find(element => element.textContent === text);
test('system messages appear as conversation status messages', async t => {
  const view = await conversation(t, { messages: [{ id: 'saved', role: 'system', content: 'Saved' }] });
  assert.deepEqual([...view.container.querySelectorAll('[role="status"]')].map(element => element.textContent), ['Saved']);
});

test('an empty read-only conversation shows its empty state without a message editor', async t => {
  const view = await conversation(t);
  assert.equal(view.container.textContent, 'πop');
  assert.equal(view.container.querySelector('[aria-label="Message piop"]'), null);
});

test('loading MCP servers replaces the empty conversation message', async t => {
  const view = await conversation(t);
  assert.equal(view.container.textContent, 'πop');
  await view.update({ statuses: { 'pi-desktop-mcp-loading': 'Loading database' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Loading MCPs');
  assert.ok(!view.container.textContent.includes('πop'));
  assert.ok(!view.container.textContent.includes('database'));
});

test('debug view names the MCP server that is loading', async t => {
  const view = await conversation(t, { statuses: { 'pi-desktop-mcp-loading': 'Loading database' } });
  await view.update({ debug: allDebug });
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Loading database');
});

test('debug loading status displays valid server names from a mixed server list', async t => {
  const view = await conversation(t, { debug: allDebug, statuses: { 'pi-desktop-mcp-loading': 'json:[{"id":"a","name":"search"},null,{"id":2,"name":"invalid"}]' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Loading search');
});

test('debug loading status does not display malformed JSON as a server name', async t => {
  const view = await conversation(t, { debug: allDebug, statuses: { 'pi-desktop-mcp-loading': 'json:{broken' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, '');
});

test('debug loading status does not display a JSON object as a server list', async t => {
  const view = await conversation(t, { debug: allDebug, statuses: { 'pi-desktop-mcp-loading': 'json:{}' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, '');
});

const twoTurns = () => [
  { id: 'first-question', role: 'user', content: 'Earlier question', timestamp: 0 },
  { id: 'first-answer', role: 'assistant', content: [{ type: 'thinking', thinking: 'Earlier reasoning' }, { type: 'text', text: 'Earlier answer' }], completedAt: 1000 },
  { id: 'next-question', role: 'user', content: 'Next question', timestamp: 2000 },
  { id: 'next-answer', role: 'assistant', content: 'Partial answer', stopReason: 'aborted' },
];

test('streaming leaves the earlier answer settled and shows work on the latest prompt', async t => {
  const messages = twoTurns();
  delete messages[3].stopReason;
  const view = await conversation(t, { readOnly: false, messages, state: { model: null, thinkingLevel: 'off', isStreaming: true, messageCount: 4 } });
  assert.ok(view.container.textContent.includes('Earlier question'));
  assert.ok(view.container.textContent.includes('Earlier answer'));
  assert.ok(view.container.textContent.includes('Next question'));
  assert.ok(view.container.textContent.includes('Partial answer'));
  const reasoning = summary(view, 'Reasoning');
  assert.ok(reasoning);
  assert.equal(reasoning.parentElement.open, false);
  assert.ok(!view.container.textContent.includes('Earlier reasoning'));
  assert.deepEqual([...view.container.querySelectorAll('[role="status"]')].map(element => element.getAttribute('aria-label')), ['piop is working']);
});

test('pausing shows a paused status on the latest response without offering retry', async t => {
  const view = await conversation(t, { readOnly: false, messages: twoTurns(), state: { model: null, thinkingLevel: 'off', isStreaming: false, isPaused: true, messageCount: 4 } });
  const responses = [...view.container.querySelectorAll('article[aria-label]')];
  const latest = responses.find(element => element.textContent.includes('Partial answer'));
  const earlier = responses.find(element => element.textContent.includes('Earlier answer'));
  assert.ok(latest && earlier);
  assert.equal(latest.querySelector('[role="status"]').textContent, 'Response paused');
  assert.ok(!earlier.textContent.includes('Response paused'));
  assert.ok(![...view.container.querySelectorAll('button')].some(button => button.textContent === 'Retry'));
});

test('ending the pause offers retry only for the latest aborted response', async t => {
  const messages = twoTurns();
  messages[1].stopReason = 'aborted';
  const state = { model: null, thinkingLevel: 'off', isStreaming: false, isPaused: true, messageCount: 4 };
  const view = await conversation(t, { readOnly: false, messages, state });
  assert.ok(![...view.container.querySelectorAll('button')].some(button => button.textContent === 'Retry'));
  await view.update({ state: { ...state, isPaused: false } });
  const retries = [...view.container.querySelectorAll('button')].filter(button => button.textContent === 'Retry');
  assert.equal(retries.length, 1, retries.map(button => button.outerHTML + button.parentElement.textContent).join('\n'));
  assert.equal(retries[0].disabled, false);
  assert.ok(retries[0].closest('article').textContent.includes('Partial answer'));
});

const repositoryState = { model: null, thinkingLevel: 'off', isStreaming: false, messageCount: 2, repository: { root: '/repo', gitDir: '/repo/.git' } };
const forkControl = view => view.container.querySelector('[aria-label="Branch off"]');

test('regular Fork is available with and without a repository and is separate from worktree Fork', async t => {
  const answer = { id: 'answer', role: 'assistant', content: 'Answer', stopReason: 'stop' };
  const forks = [], worktrees = [];
  const view = await conversation(t, { state: repositoryState, messages: [answer], onFork: value => forks.push(value.id), onBranch: value => worktrees.push(value.id) });
  await act(() => view.container.querySelector('[aria-label="Fork"]').click());
  await act(() => forkControl(view).click());
  assert.deepEqual(forks, ['answer']);
  assert.deepEqual(worktrees, ['answer']);
  await view.update({ state: { ...repositoryState, repository: null } });
  assert.equal(forkControl(view), null);
  await act(() => view.container.querySelector('[aria-label="Fork"]').click());
  assert.deepEqual(forks, ['answer', 'answer']);
  assert.deepEqual(worktrees, ['answer']);
});

test('Worktree fork appears only under finished final responses in a Git repository', async t => {
  const question = { id: 'question', role: 'user', content: 'Question' };
  const answer = { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop' };
  const view = await conversation(t, { state: repositoryState, messages: [question, answer], onBranch: () => {} });
  assert.ok(forkControl(view));
  for (const changed of [{ stopReason: 'aborted' }, { stopReason: 'error' }, { stopReason: 'length' }, { streaming: true }, { content: [{ type: 'text', text: 'Answer' }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} }] }]) {
    await view.update({ messages: [question, { ...answer, ...changed }] });
    assert.equal(forkControl(view), null, JSON.stringify(changed));
  }
  await view.update({ messages: [question, answer], state: { ...repositoryState, repository: null } });
  assert.equal(forkControl(view), null);
  await view.update({ state: { ...repositoryState, repository: undefined } });
  assert.equal(forkControl(view), null);
});

test('a branched conversation links to its original conversation and message', async t => {
  const opened = [];
  const forkSource = { sessionId: '019a6e31-8c42-7b05-a281-3d96e04fc812', sessionPath: '/sessions/original.jsonl', entryId: 'answer' };
  const view = await conversation(t, { state: { ...repositoryState, forkSource }, forkSourceName: 'Login fix', onOpenForkSource: source => opened.push(source), messages: [
    { id: 'question', role: 'user', content: 'Question' },
    { id: 'display-answer', entryId: 'answer', role: 'assistant', content: 'Original answer', stopReason: 'stop' },
    { id: 'follow-up', role: 'user', content: 'Follow-up' },
    { id: 'later-answer', role: 'assistant', content: 'Later answer', stopReason: 'stop' },
  ] });
  const link = view.container.querySelector('.fork-source-link');
  assert.equal(link.textContent, 'Branched from “Login fix”');
  const turns = view.container.querySelectorAll('.conversation-turn');
  const following = link.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(turns[0].compareDocumentPosition(link) & following);
  assert.ok(link.compareDocumentPosition(turns[1]) & following);
  assert.equal(view.container.querySelectorAll('.fork-source').length, 1);
  await act(() => link.click());
  assert.deepEqual(opened, [forkSource]);
  await view.update({ forkSourceName: undefined });
  assert.equal(view.container.querySelector('.fork-source-link').textContent, 'Branched from 019a6e31');
});

test('opening the original conversation scrolls to the selected response once', async t => {
  const scrolled = [], revealed = [];
  const view = await conversation(t, { messages: [
    { id: 'question', role: 'user', content: 'Question' },
    { id: 'answer', role: 'assistant', content: 'Answer', stopReason: 'stop' },
  ], revealEntryId: 'answer', onEntryRevealed: () => revealed.push('answer') });
  const prototype = view.container.ownerDocument.defaultView.Element.prototype;
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function () { scrolled.push(this.getAttribute('data-response-id')); };
  t.after(() => { prototype.scrollIntoView = original; });
  await view.dom.flushFrames();
  assert.deepEqual(scrolled, ['answer']);
  assert.deepEqual(revealed, ['answer']);
});

test('Fork uses the current callback for an already displayed response', async t => {
  const previous = [], current = [];
  const view = await conversation(t, { state: repositoryState, messages: [
    { id: 'question', role: 'user', content: 'Question' },
    { id: 'answer', role: 'assistant', content: 'Answer', stopReason: 'stop' },
  ], onBranch: message => previous.push(message.id) });
  await view.update({ onBranch: message => current.push(message.id) });
  const fork = view.container.querySelector('[aria-label="Branch off"]');
  assert.ok(fork);
  await act(() => fork.click());
  assert.deepEqual(current, ['answer']);
  assert.deepEqual(previous, []);
});

test('the selected project control requests the project chooser', async t => {
  let opened = 0;
  const view = await conversation(t, { readOnly: false, projectCwd: '/repo/project', onOpenProject: () => opened++ });
  await act(() => view.container.querySelector('[aria-label="Selected project: project"]').click());
  assert.equal(opened, 1);
});

test('Clear project requests removal of the conversation project', async t => {
  let cleared = 0;
  const view = await conversation(t, { readOnly: false, projectCwd: '/repo/project', onClearProject: () => cleared++ });
  await act(() => view.container.querySelector('[aria-label="Clear project"]').click());
  assert.equal(cleared, 1);
});

test('extension widget text is displayed beside the message editor', async t => {
  const view = await conversation(t, { readOnly: false, widgets: ['Extension progress: indexing files'] });
  assert.ok(view.container.textContent.includes('Extension progress: indexing files'));
  assert.ok(view.container.querySelector('[aria-label="Message piop"]'));
});

test('MCP loading replaces the conversation activity status', async t => {
  const view = await conversation(t, { readOnly: false, state: { model: null, thinkingLevel: 'off', messageCount: 0, activity: 'Preparing' } });
  assert.ok([...view.container.querySelectorAll('[role="status"]')].some(element => element.textContent === 'Preparing'));
  await view.update({ statuses: { 'pi-desktop-mcp-loading': 'Loading server' } });
  const statuses = [...view.container.querySelectorAll('[role="status"]')].map(element => element.textContent);
  assert.ok(statuses.includes('Loading MCPs'));
  assert.ok(!statuses.includes('Preparing'));
});

test("Retry is unavailable for an empty conversation", async t => {
  const view = await conversation(t, { readOnly: false, messages: [] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for an unanswered prompt", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "Question"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for an aborted response without a prompt", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "aborted"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for a completed response", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "Question"}, {"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "stop"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for a response marked as paused", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "Question"}, {"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "aborted", "errorMessage": "Response paused"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for a context checkpoint", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "Question", "contextCheckpoint": true}, {"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "aborted"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for a blank prompt", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "   "}, {"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "aborted"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test("Retry is unavailable for an abort after a pause marker", async t => {
  const view = await conversation(t, { readOnly: false, messages: [{"id": "question", "role": "user", "content": "Question"}, {"id": "paused", "role": "assistant", "content": "Partial answer", "stopReason": "aborted", "errorMessage": "Response paused"}, {"id": "answer", "role": "assistant", "content": "Partial answer", "stopReason": "aborted"}] });
  assert.ok(![...view.container.querySelectorAll('article button')].some(button => button.textContent === 'Retry'));
  assert.equal(view.container.querySelector('[aria-label="Message piop"]').value, '');
});

test('auxiliary chats have no fork actions, including when their folder is a repository', async t => {
  const view = await conversation(t, { state: { ...repositoryState, canFork: false }, messages: [{ id: 'answer', role: 'assistant', content: 'Answer', stopReason: 'stop' }], onFork: () => {}, onBranch: () => {}, onForkAndForget: () => {} });
  assert.equal(view.container.querySelector('.branch-button'), null);
  await view.update({ state: { ...repositoryState, canFork: false, repository: null } });
  assert.equal(view.container.querySelector('.branch-button'), null);
  await view.update({ state: { ...repositoryState, canFork: true } });
  assert.ok(view.container.querySelector('[aria-label="Fork"]'));
  assert.ok(forkControl(view));
});

test('a turn started by another agent session shows the message once and its context bar in debug mode', async t => {
  const delivery = { id: 'delivery', role: 'custom', customType: 'piop-agent-message', timestamp: 1, details: { notificationId: 'n1' },
    content: JSON.stringify({ notificationId: 'n1', sourceSessionId: 'chat-7', sourceHostId: 'local', message: 'Draw a smile' }),
    promptContext: { systemPrompt: '', instructions: [], tools: [], skills: [], tokens: { system: 10, instructions: 0, tools: 0, skills: 0 }, agentNotificationId: 'n1', inputTokens: 100 } };
  const reply = { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop', timestamp: 2 };
  const view = await conversation(t, { debug: allDebug, messages: [delivery, reply] });
  assert.equal(view.container.querySelectorAll('[aria-label="Message from another agent"]').length, 1);
  assert.match(view.container.textContent, /System prompt/);
});

test('a turn started by a subagent result shows the result once and its context bar in debug mode', async t => {
  const result = { id: 'result', role: 'custom', customType: 'piop-subagent-result', timestamp: 1, content: 'Subagent finished',
    details: { notificationId: 'r1', runs: [{ name: 'painter', task: 'Draw', status: 'completed', sessionId: 's1', sessionPath: '/s1.jsonl', hostId: 'local' }] },
    promptContext: { systemPrompt: '', instructions: [], tools: [], skills: [], tokens: { system: 10, instructions: 0, tools: 0, skills: 0 }, agentNotificationId: 'r1', inputTokens: 100 } };
  const reply = { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop', timestamp: 2 };
  const view = await conversation(t, { debug: allDebug, messages: [result, reply] });
  assert.equal(view.container.querySelectorAll('[aria-label="Delegated work"]').length, 1);
  assert.match(view.container.textContent, /System prompt/);
});
