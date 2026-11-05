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
  const retries = [];
  let connected = false;
  transport.connect = async () => { connected = true; };
  const command = transport.command.bind(transport);
  transport.command = (request, ...rest) => {
    if (request?.type !== 'retry_response') return command(request, ...rest);
    retries.push({ connected, command: request });
    return extra.onRetry(request);
  };
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
    async update(changes) { props = { ...props, ...changes }; await view.rerender(props); },
  };
}

test('Retry starts the chat, asks Pi once to run the stopped response again, and leaves the draft alone', async t => {
  const pending = Promise.withResolvers();
  const fixture = await retryConversation(t, { onRetry: () => pending.promise });
  await enterText(fixture.editor(), 'Draft');
  await act(() => { fixture.retry().click(); fixture.retry().click(); });
  await untilDom(() => fixture.retries.length === 1);
  assert.deepEqual(fixture.retries, [{ connected: true, command: { type: 'retry_response', entryId: 'answer-entry' } }]);
  assert.equal(fixture.retry().textContent, 'Retrying…');
  assert.equal(fixture.retry().disabled, true);
  await act(() => pending.resolve(null));
  await untilDom(() => fixture.retry().textContent === 'Retry');
  assert.equal(fixture.editor().value, 'Draft');
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});

test('a failed retry shows the error, and Retry works again afterwards', async t => {
  let fail = true;
  const fixture = await retryConversation(t, { onRetry: async () => { if (fail) throw new Error('offline'); return null; } });
  await act(() => fixture.retry().click());
  await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: offline'));
  assert.equal(fixture.retry().disabled, false);
  fail = false;
  await act(() => fixture.retry().click());
  await untilDom(() => fixture.retries.length === 2 && !fixture.view.container.textContent.includes('Retry failed: offline'));
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});

test('Retry targets the stopped response after tool output', async t => {
  const fixture = await retryConversation(t, {
    messages: [{ id: 'question', role: 'user', content: 'Question' }, { id: 'tool', role: 'tool', content: 'Tool output' }, { id: 'answer', entryId: 'late-answer', role: 'assistant', content: '', stopReason: 'error' }],
    onRetry: async () => null,
  });
  await act(() => fixture.retry().click());
  await untilDom(() => fixture.retries.length === 1);
  assert.equal(fixture.retries[0].command.entryId, 'late-answer');
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});

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
  assert.ok(fixture.view.container.querySelector('[aria-label="Stop piop"]'));
  await fixture.update({ statuses: {} });
  await untilDom(() => fixture.view.container.querySelector('[aria-label="Preparing message"] [role="status"]')?.textContent === 'Sending message…');
  await act(() => pending.resolve(true));
  await untilDom(() => !fixture.view.container.querySelector('[aria-label="Preparing message"]'));
  assert.equal(fixture.editor().value, '');
  assert.deepEqual(fixture.errors, []);
});
