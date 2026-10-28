import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent } from 'solid-js';
import { installDom, renderComponent, enterText, act, untilDom, channelsClosed } from '../dom.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { createConversationDrafts } from '../../clients/ui/appDrafts.ts';

async function retryConversation(t, extra = {}) {
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  let view, transport, daemon, target;
  const requests = new Set();
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => {
    await settle(); await view?.unmount(); await transport?.dispose();
    if (target) await daemon.invoke('remove_temporary_chat', { path: target.cwd, hostId: 'local' });
    await channelsClosed('piop-drafts'); await settle();
    storage.restore(); clearMocks(); dom.restore();
  });
  const native = await nativeFileCommand(t, { desktop: true });
  daemon = await daemonClient(t);
  mockIPC(async (command, args) => {
    const request = command === 'stop_pi' ? daemon.invoke(command, args) : native.invoke(command, args);
    requests.add(request);
    try { return await request; } finally { requests.delete(request); }
  }, { background: false, shouldMockEvents: true });
  target = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  transport = new NativeTransport({ cwd: target.cwd, sessionId: target.sessionId });
  // Retry asks Pi to run the failed response again. The test answers that request for Pi; other commands reach the daemon.
  const retries = [];
  let answerRetry = async () => null;
  const command = transport.command.bind(transport);
  transport.connect = async () => {};
  transport.command = (value, ...rest) => value?.type === 'retry_response' ? (retries.push(value.entryId), answerRetry(value)) : command(value, ...rest);
  const key = `local:${target.sessionId}`;
  const errors = [];
  function DraftConversation(props) {
    const drafts = createConversationDrafts(error => errors.push(error));
    drafts.bindTransport(transport, key);
    return createComponent(ChatView, {
      get messages() { return props.messages; },
      get onSend() { return props.onSend; },
      get onBranch() { return props.onBranch; },
      readOnly: false, transport,
      get state() { return { model: null, thinkingLevel: 'off', isStreaming: false, messageCount: 2, ...props.state }; },
      models: [], commands: [], thinkingLevels: [], widgets: [],
      get statuses() { return props.statuses ?? {}; },
      get draft() { return drafts.composerDrafts()[key] ?? ''; },
      onDraftChange: value => drafts.setComposerDraft(key, value),
    });
  }
  let props = { messages: [
    { id: 'question', role: 'user', content: 'Question' },
    { id: 'answer', entryId: 'answer-entry', role: 'assistant', content: 'Partial answer', stopReason: 'aborted' },
  ], ...extra };
  view = await renderComponent(DraftConversation, props);
  const editor = () => view.container.querySelector('[aria-label="Message piop"]');
  const retry = () => [...view.container.querySelectorAll('article button')].find(button => ['Retry', 'Retrying…'].includes(button.textContent));
  return { view, editor, retry, settle, errors, retries,
    answer(handler) { answerRetry = handler; },
    async update(changes) { props = { ...props, ...changes }; await view.rerender(props); },
  };
}

test('a submitted message waits for MCP loading and then shows its send status', async t => {
  const sent = Promise.withResolvers(), pending = Promise.withResolvers();
  const calls = [];
  const fixture = await retryConversation(t, {
    messages: [], state: { messageCount: 0 }, statuses: { 'pi-desktop-mcp-loading': 'Loading server' },
    onSend: (text, behavior, images) => { calls.push([text, behavior, images]); sent.resolve(); return pending.promise; },
  });
  await enterText(fixture.editor(), 'Question');
  const send = () => fixture.view.container.querySelector('[aria-label="Send message"]');
  await act(() => send().click());
  await sent.promise;
  assert.deepEqual(calls, [['Question', undefined, []]]);
  assert.equal(fixture.editor().value, '');
  assert.ok(fixture.view.container.querySelector('[aria-label="Message waiting for MCP"]'));
  assert.equal(fixture.view.container.querySelector('[aria-label="Preparing message"]'), null);
  assert.equal(send().disabled, true);
  await fixture.update({ statuses: {} });
  assert.equal(fixture.view.container.querySelector('[aria-label="Preparing message"] [role="status"]').textContent, 'Sending message…');
  await act(() => pending.resolve(true));
  await untilDom(() => !fixture.view.container.querySelector('[aria-label="Preparing message"]'));
  assert.equal(fixture.editor().value, '');
  assert.deepEqual(fixture.errors, []);
});

test('retry asks Pi to run the failed response again once, waits for it, and leaves the draft alone', async t => {
  const asked = Promise.withResolvers(), pending = Promise.withResolvers();
  const fixture = await retryConversation(t);
  fixture.answer(() => { asked.resolve(); return pending.promise; });
  await enterText(fixture.editor(), 'Draft');
  await act(() => { fixture.retry().click(); fixture.retry().click(); });
  await asked.promise;
  assert.deepEqual(fixture.retries, ['answer-entry']);
  assert.equal(fixture.retry().textContent, 'Retrying…');
  assert.equal(fixture.retry().disabled, true);
  assert.equal(fixture.editor().value, 'Draft');
  await act(() => pending.resolve(null));
  await untilDom(() => fixture.retry().textContent === 'Retry' && !fixture.retry().disabled);
  assert.deepEqual(fixture.retries, ['answer-entry']);
  assert.deepEqual(fixture.errors, []);
});

test('a failed retry shows why, and the next retry can run and clears the error', async t => {
  const fixture = await retryConversation(t);
  fixture.answer(async () => { throw new Error('offline'); });
  await act(() => fixture.retry().click());
  await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: offline'));
  assert.equal(fixture.retry().disabled, false);
  fixture.answer(async () => null);
  await act(() => fixture.retry().click());
  await untilDom(() => !fixture.view.container.textContent.includes('Retry failed: offline'));
  assert.deepEqual(fixture.retries, ['answer-entry', 'answer-entry']);
  assert.deepEqual(fixture.errors, []);
});

test('a stopped response after tool output is retried from its saved entry', async t => {
  const fixture = await retryConversation(t, { messages: [
    { id: 'question', role: 'user', content: '  retry me  ' },
    { id: 'tool', role: 'tool', content: 'Tool output' },
    { id: 'answer', entryId: 'stopped-entry', role: 'assistant', content: '', stopReason: 'aborted' },
  ] });
  await act(() => fixture.retry().click());
  await untilDom(() => fixture.retries.length === 1);
  assert.deepEqual(fixture.retries, ['stopped-entry']);
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});
