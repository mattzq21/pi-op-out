import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

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
  await view.update({ debug: true });
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Loading database');
});

test('debug loading status displays valid server names from a mixed server list', async t => {
  const view = await conversation(t, { debug: true, statuses: { 'pi-desktop-mcp-loading': 'json:[{"id":"a","name":"search"},null,{"id":2,"name":"invalid"}]' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Loading search');
});

test('debug loading status does not display malformed JSON as a server name', async t => {
  const view = await conversation(t, { debug: true, statuses: { 'pi-desktop-mcp-loading': 'json:{broken' } });
  assert.equal(view.container.querySelector('[role="status"]').textContent, '');
});

test('debug loading status does not display a JSON object as a server list', async t => {
  const view = await conversation(t, { debug: true, statuses: { 'pi-desktop-mcp-loading': 'json:{}' } });
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
  const view = await conversation(t, { messages, state: { isStreaming: true, messageCount: 4 } });
  assert.ok(view.container.textContent.includes('Earlier question'));
  assert.ok(view.container.textContent.includes('Earlier answer'));
  assert.ok(view.container.textContent.includes('Next question'));
  assert.ok(view.container.textContent.includes('Partial answer'));
  const reasoning = summary(view, 'Reasoning');
  assert.ok(reasoning);
  assert.equal(reasoning.parentElement.open, false);
  assert.ok(!view.container.textContent.includes('Earlier reasoning'));
  assert.deepEqual([...view.container.querySelectorAll('[role="status"]')].map(element => element.textContent), ['piop is working']);
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

test('Fork uses the current callback for an already displayed response', async t => {
  const previous = [], current = [];
  const view = await conversation(t, { messages: [
    { id: 'question', role: 'user', content: 'Question' },
    { id: 'answer', role: 'assistant', content: 'Partial answer', stopReason: 'aborted' },
  ], onBranch: message => previous.push(message.id) });
  await view.update({ onBranch: message => current.push(message.id) });
  const fork = view.container.querySelector('[aria-label="Fork"]');
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
