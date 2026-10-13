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
    { id: 'answer', role: 'assistant', content: 'Partial answer', stopReason: 'aborted' },
  ], ...extra };
  view = await renderComponent(DraftConversation, props);
  const editor = () => view.container.querySelector('[aria-label="Message piop"]');
  const retry = () => [...view.container.querySelectorAll('article button')].find(button => ['Retry', 'Retrying…'].includes(button.textContent));
  return { view, editor, retry, settle, errors,
    async update(changes) { props = { ...props, ...changes }; await view.rerender(props); },
  };
}

test('retry sends the original attachments once while submission is pending', async t => {
  const sent = Promise.withResolvers(), pending = Promise.withResolvers();
  const calls = [];
  const image = { type: 'image', mimeType: 'image/png', data: 'aA==' };
  const fixture = await retryConversation(t, {
    messages: [{ id: 'question', role: 'user', content: [{ type: 'text', text: 'Question' }, image] }, { id: 'answer', role: 'assistant', content: '', stopReason: 'aborted' }],
    onSend: (text, behavior, images) => { calls.push([text, behavior, images]); sent.resolve(); return pending.promise; },
  });
  await enterText(fixture.editor(), 'Question');
  await act(() => { fixture.retry().click(); fixture.retry().click(); });
  await sent.promise;
  assert.deepEqual(calls, [['Question', undefined, [image]]]);
  assert.equal(fixture.retry().disabled, true);
  assert.equal(fixture.editor().value, '');
  await act(() => pending.resolve(true));
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});

test('a rejected retry restores the prompt in the editor and shows the error', async t => {
  const sent = Promise.withResolvers(), pending = Promise.withResolvers();
  const fixture = await retryConversation(t, { onSend: () => { sent.resolve(); return pending.promise; } });
  await enterText(fixture.editor(), 'Question');
  await act(() => fixture.retry().click());
  await sent.promise;
  assert.equal(fixture.editor().value, '');
  await act(() => pending.reject(new Error('offline')));
  const alert = await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: offline'));
  assert.ok(alert);
  assert.equal(fixture.editor().value, 'Question');
  assert.equal(fixture.retry().disabled, false);
  assert.deepEqual(fixture.errors, []);
});

test('a declined retry restores the prompt and explains that it was not submitted', async t => {
  const fixture = await retryConversation(t, { onSend: async () => false });
  await enterText(fixture.editor(), 'Question');
  await act(() => fixture.retry().click());
  await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: Message was not submitted'));
  assert.equal(fixture.editor().value, 'Question');
  assert.equal(fixture.retry().disabled, false);
  assert.deepEqual(fixture.errors, []);
});

test('retry can submit again after a previous attempt failed', async t => {
  const fixture = await retryConversation(t, { onSend: async () => { throw new Error('offline'); } });
  await enterText(fixture.editor(), 'Question');
  await act(() => fixture.retry().click());
  await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: offline'));
  const calls = [], sent = Promise.withResolvers();
  await fixture.update({ onSend: async (text, behavior, images) => { calls.push([text, behavior, images]); sent.resolve(); return true; } });
  await act(() => fixture.retry().click());
  await sent.promise;
  await fixture.settle();
  assert.deepEqual(calls, [['Question', undefined, []]]);
  assert.equal(fixture.editor().value, '');
  assert.ok(!fixture.view.container.textContent.includes('Retry failed: offline'));
  assert.deepEqual(fixture.errors, []);
});

test('a failed retry preserves text typed while the send was pending', async t => {
  const sent = Promise.withResolvers(), pending = Promise.withResolvers();
  const fixture = await retryConversation(t, { onSend: () => { sent.resolve(); return pending.promise; } });
  await enterText(fixture.editor(), 'Question');
  await act(() => fixture.retry().click());
  await sent.promise;
  assert.equal(fixture.editor().value, '');
  await enterText(fixture.editor(), 'New question');
  await act(() => pending.resolve(false));
  await untilDom(() => [...fixture.view.container.querySelectorAll('[role="alert"]')].find(element => element.textContent === 'Retry failed: Message was not submitted'));
  assert.equal(fixture.editor().value, 'Question\n\nNew question');
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
  assert.equal(send().disabled, true);
  await fixture.update({ statuses: {} });
  assert.equal(fixture.view.container.querySelector('[aria-label="Preparing message"] [role="status"]').textContent, 'Sending message…');
  await act(() => pending.resolve(true));
  await untilDom(() => !fixture.view.container.querySelector('[aria-label="Preparing message"]'));
  assert.equal(fixture.editor().value, '');
  assert.deepEqual(fixture.errors, []);
});

test('retry trims the original prompt and keeps intervening tool output out of the submission', async t => {
  const sent = Promise.withResolvers();
  const fixture = await retryConversation(t, {
    messages: [{ id: 'question', role: 'user', content: '  retry me  ' }, { id: 'tool', role: 'tool', content: 'Tool output' }, { id: 'answer', role: 'assistant', content: '', stopReason: 'aborted' }],
    onSend: async text => { sent.resolve(text); return true; },
  });
  await act(() => fixture.retry().click());
  assert.equal(await sent.promise, 'retry me');
  await fixture.settle();
  assert.deepEqual(fixture.errors, []);
});
