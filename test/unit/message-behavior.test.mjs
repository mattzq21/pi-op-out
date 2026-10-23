import { installDom, renderComponent, act, untilDom } from '../dom.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Message } from '../../clients/ui/components/Message.tsx';
import { debugView } from '../../clients/ui/lib/debugFeatures.ts';

const allDebug = debugView({ debugMode: true });

async function renderMessage(t, message, extra = {}) {
  const dom = installDom();
  let view;
  t.after(async () => { await view?.unmount(); dom.restore(); });
  view = await renderComponent(Message, { message: { id: 'message-id', ...message }, ...extra });
  return view;
}
const control = label => document.querySelector(`[aria-label="${label}"]`);
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
const click = element => act(() => element.click());
test('system messages display their status text', async t => {
  await renderMessage(t, { role: 'system', content: 'status message' });
  assert.equal(document.querySelector('[role=status]').textContent, 'status message');
});

test('compact tool results show their count and status without raw input or output', async t => {
  await renderMessage(t, { role: 'tool', toolName: 'read', content: 'private output', toolInput: { path: '/repo/a' } }, { toolCount: 3 });
  assert.match(document.body.textContent, /read x3Completed/);
  assert.doesNotMatch(document.body.textContent, /private output|\/repo\/a/);
});

test('running tools keep their input and output closed until requested', async t => {
  await renderMessage(t, { role: 'tool', toolName: 'read', toolStatus: 'running', content: 'private output' }, { debug: allDebug });
  assert.match(document.body.textContent, /Running/);
  assert.equal(document.querySelector('details').open, false);
  assert.equal(control('Tool output'), null);
});

test('paused responses show a pause notice without a failure or retry action', async t => {
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'aborted' }, { paused: true, onRetry: () => {} });
  assert.match(document.body.textContent, /Response paused/);
  assert.doesNotMatch(document.body.textContent, /Operation aborted|Response failed/);
  assert.equal(button('Retry'), undefined);
});

test('aborted responses without a reason show a clear failure notice', async t => {
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'aborted' });
  assert.match(document.querySelector('[role=status]').textContent, /Operation aborted/);
});

test('provider failures display the reported reason', async t => {
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'error', errorMessage: 'provider offline' });
  assert.match(document.querySelector('[role=status]').textContent, /Response failed: provider offline/);
});

test('failures without a reason display an unknown error notice', async t => {
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'error' });
  assert.match(document.querySelector('[role=status]').textContent, /Response failed: Unknown error/);
});

test('custom abort reasons are shown to the user', async t => {
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'aborted', errorMessage: 'custom abort reason' });
  assert.match(document.querySelector('[role=status]').textContent, /custom abort reason/);
});

test('retry sends the request to the caller', async t => {
  const retries = [];
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'error' }, { onRetry: () => retries.push('retry') });
  await click(button('Retry'));
  assert.deepEqual(retries, ['retry']);
});

test('retrying prevents another retry request', async t => {
  const retries = [];
  await renderMessage(t, { role: 'assistant', content: '', stopReason: 'error' }, { retrying: true, onRetry: () => retries.push('retry') });
  assert.equal(button('Retrying…').disabled, true);
  await click(button('Retrying…'));
  assert.deepEqual(retries, []);
});

const forgetControl = () => document.querySelector('button[aria-label^="Fork and forget from"]');
const copyResponse = () => document.querySelector('button[aria-label^="Copy assistant response"]');

test('a pending fork prevents another action until it finishes', async t => {
  const pending = Promise.withResolvers(), branches = [], forgotten = [];
  const message = { id: 'assistant-id', role: 'assistant', content: 'answer' };
  await renderMessage(t, message, { onFork: value => { branches.push(value); return pending.promise; }, onForkAndForget: value => forgotten.push(value) });
  await click(control('Fork'));
  assert.equal(control('Fork').disabled, true);
  assert.equal(forgetControl().disabled, true);
  await click(control('Fork')); await click(forgetControl());
  assert.deepEqual(branches, [message]);
  assert.deepEqual(forgotten, []);
  await act(() => pending.resolve());
  assert.equal(control('Fork').disabled, false);
  assert.equal(forgetControl().disabled, false);
  await click(forgetControl());
  assert.deepEqual(forgotten, [message]);
});

test('streaming responses show work in progress and hide completed response actions', async t => {
  await renderMessage(t, { role: 'assistant', content: 'partial answer', streaming: true }, { onFork: () => {}, onBranch: () => {}, onForkAndForget: () => {} });
  assert.equal(control('Fork'), null);
  assert.equal(forgetControl(), null);
  assert.equal(copyResponse(), null);
});

test('the caller can hide completed response actions', async t => {
  await renderMessage(t, { role: 'assistant', content: 'answer' }, { showActions: false, onFork: () => {}, onBranch: () => {}, onForkAndForget: () => {} });
  assert.match(document.body.textContent, /answer/);
  assert.equal(control('Fork'), null);
  assert.equal(forgetControl(), null);
  assert.equal(copyResponse(), null);
});

test('completed responses show reasoning before the answer', async t => {
  await renderMessage(t, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Answer' }] });
  const text = document.body.textContent;
  assert.match(text, /Reasoning/);
  assert.match(text, /Answer/);
  assert.ok(text.indexOf('Reasoning') < text.indexOf('Answer'));
});

test('copying a response copies the answer without its reasoning', async t => {
  await renderMessage(t, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Answer' }] });
  const copied = [];
  navigator.clipboard = { writeText: async text => copied.push(text) };
  await click(copyResponse());
  assert.deepEqual(copied, ['Answer']);
});

test('skill instructions are replaced by the skill name while the user request stays visible', async t => {
  await renderMessage(t, { role: 'user', content: '<skill name="research" location="/skills/research">\nReferences are relative to /skills/research.\n\nPrivate instructions\n</skill>\n\nUser request' });
  assert.match(document.body.textContent, /\$research/);
  assert.match(document.body.textContent, /User request/);
  assert.doesNotMatch(document.body.textContent, /Private instructions|References are relative/);
});

test('malformed skill wrappers remain readable as literal text', async t => {
  await renderMessage(t, { role: 'user', content: '<skill>not a recognized invocation</skill>' });
  assert.match(document.body.textContent, /<skill>not a recognized invocation<\/skill>/);
});

test('a skill invocation without a user request shows only the skill name', async t => {
  await renderMessage(t, { role: 'user', content: '<skill name="research" location="/skills/research">\nReferences are relative to /skills/research.\n\nPrivate instructions\n</skill>' });
  assert.equal(document.querySelector('article').textContent.trim(), '$research');
});

test('steering messages use the smaller shaded message style', async t => {
  const message = { id: 'steering', role: 'user', content: 'Steering request', deliveryBehavior: 'steer' };
  const view = await renderMessage(t, message);
  const style = document.createElement('style');
  style.textContent = await readFile(new URL('../../clients/ui/styles.css', import.meta.url), 'utf8');
  document.head.append(style);
  const shadedText = () => {
    let element = document.querySelector('article p');
    while (element) {
      const color = getComputedStyle(element).backgroundColor;
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return element;
      element = element.parentElement;
    }
  };
  assert.equal(getComputedStyle(shadedText()).backgroundColor, 'rgb(25, 24, 21)');
  assert.equal(getComputedStyle(shadedText()).fontSize, '12px');
  await view.rerender({ message: { ...message, deliveryBehavior: undefined } });
  assert.notEqual(getComputedStyle(shadedText()).backgroundColor, 'rgb(25, 24, 21)');
});

const mixedContent = [
  { type: 'text', text: 'Hello' },
  { type: 'thinking', thinking: 'First' },
  { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  { type: 'text', text: ' world' },
  { type: 'thinking', thinking: 'Second' },
];

test('assistant content joins text fragments and displays reasoning separately', async t => {
  await renderMessage(t, { role: 'assistant', content: mixedContent });
  assert.deepEqual([...document.querySelectorAll('p')].map(element => element.textContent), ['First', 'Second', 'Hello world']);
  assert.doesNotMatch(document.body.textContent, /aGVsbG8=/);
});

test('copying mixed content excludes reasoning and image data', async t => {
  await renderMessage(t, { role: 'assistant', content: mixedContent });
  const copied = [];
  navigator.clipboard = { writeText: async text => copied.push(text) };
  await click(copyResponse());
  assert.deepEqual(copied, ['Hello world']);
});

test('plain string responses display and copy without extra content', async t => {
  await renderMessage(t, { role: 'assistant', content: 'plain' });
  assert.equal(document.body.textContent.trim(), 'plain');
  const copied = [];
  navigator.clipboard = { writeText: async text => copied.push(text) };
  await click(copyResponse());
  assert.deepEqual(copied, ['plain']);
});

test('empty response content adds no text or copy action', async t => {
  await renderMessage(t, { role: 'assistant', content: [] });
  assert.equal(document.body.textContent.trim(), '');
  assert.equal(copyResponse(), null);
});

test('a failed tool payload load shows its error and retry loads the input and output', async t => {
  const firstLoad = Promise.withResolvers(), secondLoad = Promise.withResolvers(), secondCall = Promise.withResolvers();
  const pendingLoads = [firstLoad, secondLoad];
  let calls = 0;
  const message = { id: 'tool-id', role: 'tool', toolName: 'read', content: '', deferredToolPayload: 'payload-ref', toolPayloadVersion: 1,
    loadToolPayload: () => { calls++; if (calls === 2) secondCall.resolve(); return pendingLoads.shift().promise; } };
  const view = await renderMessage(t, message, { debug: allDebug });
  await click(document.querySelector('summary'));
  await untilDom(() => /Loading tool input and output/.test(document.querySelector('[role=status]')?.textContent));
  await act(() => firstLoad.reject(new Error('payload unavailable')));
  const alert = await untilDom(() => document.querySelector('[role=alert]'));
  assert.match(alert.textContent, /payload unavailable/);
  await click(button('Retry'));
  let timer;
  await Promise.race([secondCall.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Retry did not load the tool payload again')), 2000); })]).finally(() => clearTimeout(timer));
  await view.rerender({ debug: allDebug, message: { ...message, content: 'file contents', toolInput: { path: '/repo/a' }, toolPayloadLoaded: true, loadedToolPayloadVersion: 1 } });
  await act(() => secondLoad.resolve());
  assert.equal(calls, 2);
  assert.equal(document.querySelector('[role=alert]'), null);
  assert.equal(document.querySelector('[role=status]'), null);
  assert.match(control('Tool arguments').textContent, /\/repo\/a/);
  assert.equal(control('Tool output').textContent, 'file contents');
});

test('a stale tool payload failure does not replace the newer loaded input and output', async t => {
  const oldLoad = Promise.withResolvers();
  const message = { id: 'tool-id', role: 'tool', toolName: 'read', content: '', deferredToolPayload: 'payload-ref', toolPayloadVersion: 1, loadToolPayload: () => oldLoad.promise };
  const view = await renderMessage(t, message, { debug: allDebug });
  await click(document.querySelector('summary'));
  await untilDom(() => /Loading tool input and output/.test(document.querySelector('[role=status]')?.textContent));
  await view.rerender({ debug: allDebug, message: { ...message, content: 'new contents', toolInput: { path: '/repo/new' }, toolPayloadVersion: 2, toolPayloadLoaded: true, loadedToolPayloadVersion: 2 } });
  await act(() => oldLoad.reject(new Error('old payload unavailable')));
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(document.querySelector('[role=alert]'), null);
  assert.equal(button('Retry'), undefined);
  assert.equal(document.querySelector('[role=status]'), null);
  assert.match(control('Tool arguments').textContent, /\/repo\/new/);
  assert.equal(control('Tool output').textContent, 'new contents');
});
