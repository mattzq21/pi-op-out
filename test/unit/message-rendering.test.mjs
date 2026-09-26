import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { Message } from '../../src/components/Message.tsx';
import { DiffViewer } from '../../src/components/DiffViewer.tsx';
import { parseDiff } from '../../src/lib/diff.ts';

describe('message rendering', () => {
  let dom, view, copied, opened, openError;
  beforeEach(() => {
    dom = installDom(); copied = []; opened = []; openError = undefined;
    navigator.clipboard = { writeText: async text => copied.push(text) };
    mockIPC(async (command, args) => { opened.push({ command, args }); if (openError) throw openError; });
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; clearMocks(); dom.restore(); });
  async function render(message, extra = {}) { view = await renderComponent(Message, { message: { id: 'message-id', ...message }, ...extra }); }
  const click = async element => act(async () => element.click());
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const contextMenu = async link => act(async () => link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));


  test('system messages and compact tool status hide raw payloads until debug mode is enabled', async () => {
    await render({ role: 'system', content: 'status message' }); assert.equal(document.querySelector('[role=status]').textContent, 'status message');
    const message = { id: 'tool', role: 'tool', toolName: 'read', content: 'private output', toolInput: { path: '/repo/a' } };
    await view.rerender({ message, toolCount: 3 }); assert.match(document.body.textContent, /read x3Completed/); assert.equal(document.querySelector('pre'), null);
    await view.rerender({ message, debug: true }); assert.equal(control('Tool arguments'), null); assert.equal(control('Tool output'), null);
    assert.equal(document.querySelector('details').open, false);
    await view.rerender({ message: { ...message, toolStatus: 'running' }, debug: true }); assert.equal(document.querySelector('details').open, false); assert.match(document.body.textContent, /Running/);
    await act(() => { const details = document.querySelector('details'); details.open = true; details.dispatchEvent(new Event('toggle')); });
    assert.match(control('Tool arguments').textContent, /"path": "\/repo\/a"/); assert.equal(control('Tool output').textContent, 'private output');
    await view.rerender({ message: { ...message, toolStatus: 'error', toolInput: null }, debug: true, expanded: true }); assert.equal(document.querySelector('details').open, true); assert.equal(control('Tool arguments').textContent, 'null');
    await view.rerender({ message: { ...message, toolName: undefined, content: '', toolInput: undefined }, debug: true }); assert.equal(control('Tool arguments'), null); assert.equal(control('Tool output'), null); assert.match(document.body.textContent, /tool/);
  });

  test('user skill invocations collapse to a skill badge while malformed wrappers stay literal', async () => {
    const content = '<skill name="research" location="/skills/research">\nReferences are relative to /skills/research.\n\nPrivate instructions\n</skill>\n\nUser request';
    await render({ role: 'user', content, deliveryBehavior: 'steer' });
    assert.equal(document.querySelector('.skill-reference').textContent, '$research'); assert.match(document.body.textContent, /User request/); assert.doesNotMatch(document.body.textContent, /Private instructions/);
    assert.ok(document.querySelector('.steering-message'));
    await view.rerender({ message: { id: 'user', role: 'user', content: '<skill>not a recognized invocation</skill>' } });
    assert.equal(document.querySelector('.literal-skill-content').textContent, '<skill>not a recognized invocation</skill>');
    await view.rerender({ message: { id: 'user', role: 'user', content: content.split('\n\nUser request')[0] } });
    assert.equal(document.querySelector('.message-body').textContent, '$research');
  });

  test('only supported inline attachments render and remote Markdown images remain inert', async () => {
    await render({ role: 'user', content: [{ type: 'text', text: '![external](https://example.com/image.png)' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'image', mimeType: 'image/svg+xml', data: 'unsafe' }, { type: 'image', mimeType: 'image/jpeg', data: '' }] });
    assert.equal(document.querySelectorAll('img').length, 1); assert.equal(document.querySelector('img').src, 'data:image/png;base64,aGVsbG8=');
    assert.equal(document.querySelector('.message-image-placeholder').getAttribute('aria-label'), 'external');
    await view.rerender({ message: { id: 'assistant', role: 'assistant', content: '![](https://example.com/image.png)' } });
    assert.equal(document.querySelector('img'), null); assert.equal(document.querySelector('.message-image-placeholder').getAttribute('aria-label'), 'Blocked remote image');
  });

  test('message copying preserves source text and reports unavailable clipboard access', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await render({ role: 'user', content: '**source**' });
    await click(control('Copy message')); assert.deepEqual(copied, ['**source**']); assert.ok(control('Message copied'));
    await act(async () => t.mock.timers.tick(1800)); assert.ok(control('Copy message'));
    delete navigator.clipboard; await click(control('Copy message')); assert.equal(document.querySelector('.copy-feedback').textContent, 'Could not copy message');
    await act(async () => t.mock.timers.tick(1800)); assert.equal(document.querySelector('.copy-feedback'), null);
  });

  test('fenced code copying omits the trailing newline and handles write failures', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await render({ role: 'assistant', content: '```js\nconst answer = 42;\n```' });
    await click(control('Copy code')); assert.deepEqual(copied, ['const answer = 42;']); assert.ok(control('Code copied'));
    await act(async () => t.mock.timers.tick(1800)); navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await click(control('Copy code')); assert.equal(document.querySelector('.code-block [role=status]').textContent, 'Could not copy');
  });

  test('web links use native launching while relative and non-web targets remain readable', async () => {
    await render({ role: 'assistant', content: '[web](https://example.com/a) [relative](/local/file) [mail](mailto:a@example.com)' });
    assert.equal(document.querySelectorAll('a').length, 1); assert.equal(document.querySelectorAll('span.message-link').length, 2);
    const link = document.querySelector('a'); await click(link); assert.deepEqual(opened, [{ command: 'open_external_url', args: { url: 'https://example.com/a' } }]);
    openError = new Error('browser unavailable'); await click(link); assert.match(document.querySelector('[role=alert]').textContent, /Could not open link: browser unavailable/);
    const auxiliary = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }); await act(async () => link.dispatchEvent(auxiliary)); assert.equal(auxiliary.defaultPrevented, true); assert.equal(opened.length, 2);
  });

  test('link context menus copy the URL, restore focus and report clipboard failures', async () => {
    await render({ role: 'assistant', content: '[link](https://example.com)' }); const link = document.querySelector('a'); link.focus();
    await contextMenu(link); assert.equal(document.activeElement.getAttribute('role'), 'menuitem');
    await click(document.querySelector('[role=menuitem]')); assert.deepEqual(copied, ['https://example.com/']); assert.equal(document.querySelector('[role=menu]'), null); assert.equal(document.activeElement, link);
    await contextMenu(link); delete navigator.clipboard; await click(document.querySelector('[role=menuitem]')); assert.match(document.querySelector('[role=alert]').textContent, /Could not copy link/);
  });

  test('context menus close on Escape, Tab, scrolling and outside clicks and keep focus inside while navigating', async () => {
    await render({ role: 'assistant', content: '[link](http://example.com)' }); const link = document.querySelector('a'); link.focus();
    for (const key of ['Escape', 'Tab']) {
      await contextMenu(link); const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); await act(async () => document.activeElement.dispatchEvent(event));
      assert.equal(document.querySelector('[role=menu]'), null); assert.equal(document.activeElement, link); assert.equal(event.defaultPrevented, key === 'Escape');
    }
    await contextMenu(link); const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); await act(async () => document.activeElement.dispatchEvent(arrow)); assert.equal(arrow.defaultPrevented, true);
    await act(async () => window.dispatchEvent(new Event('scroll'))); assert.equal(document.querySelector('[role=menu]'), null);
    await contextMenu(link); await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))); assert.equal(document.querySelector('[role=menu]'), null);
  });

  test('paused responses differ from failures and retry state disables repeat requests', async () => {
    let retries = 0; const message = { id: 'assistant', role: 'assistant', content: '', stopReason: 'aborted' };
    await render(message, { paused: true, onRetry: () => retries++ }); assert.match(document.body.textContent, /Response paused/); assert.equal(document.querySelector('.message-failure'), null);
    await view.rerender({ message, onRetry: () => retries++ }); assert.match(document.body.textContent, /Operation aborted/);
    await click(document.querySelector('.message-failure button')); assert.equal(retries, 1);
    await view.rerender({ message, retrying: true, onRetry: () => retries++ }); assert.equal(document.querySelector('.message-failure button').disabled, true);
    await view.rerender({ message: { ...message, stopReason: 'error', errorMessage: 'provider offline' } }); assert.match(document.body.textContent, /Response failed: provider offline/);
    await view.rerender({ message: { ...message, stopReason: 'error' } }); assert.match(document.body.textContent, /Unknown error/);
    await view.rerender({ message: { ...message, errorMessage: 'custom abort reason' } }); assert.match(document.body.textContent, /custom abort reason/);
  });

  test('assistant actions serialize branching and forgetting and receive the original message', async () => {
    const pending = Promise.withResolvers(); const branches = [], forgotten = [], worktrees = [];
    const message = { id: 'assistant-id', role: 'assistant', content: 'answer' };
    const extra = { onBranch: value => { branches.push(value); return pending.promise; }, onForkAndForget: async value => forgotten.push(value), onCreateWorktree: value => worktrees.push(value) };
    await render(message, extra); await click(document.querySelector('[title="Branch from here"]'));
    assert.equal(document.querySelector('[title="Fork and forget from here"]').disabled, true); assert.equal(branches.length, 1);
    await act(async () => pending.resolve()); await click(document.querySelector('[title="Fork and forget from here"]')); await click(control('Create Git worktree'));
    assert.deepEqual(forgotten, [message]); assert.deepEqual(worktrees, [message]);
    await view.rerender({ message: { ...message, streaming: true }, ...extra }); assert.equal(document.querySelector('.message-actions'), null); assert.ok(document.querySelector('.stream-caret'));
    await view.rerender({ message, showActions: false }); assert.equal(document.querySelector('.message-actions'), null);
  });

  test('reasoning and cache totals accompany completed assistant responses', async () => {
    await render({ role: 'assistant', timestamp: 1000, content: [{ type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Answer' }], usage: { input: 1000, cacheRead: 1000 } }, { debug: true, turnCacheUsage: { input: 1000, cacheRead: 3000 } });
    assert.equal(document.querySelector('.reasoning-text').textContent.trim(), 'Reasoning'); assert.match(document.querySelector('.cache-hit-rate').textContent, /^Cache 75%/);
    assert.equal(document.querySelector('.cache-hit-rate').getAttribute('aria-label'), 'Cache 75%, 3000/4000');
    await click(document.querySelector('.message-actions .icon-button')); assert.deepEqual(copied, ['Answer']);
  });

  test('diff previews follow keyboard focus and render changed tokens, line numbers and warnings', async () => {
    const files = parseDiff('diff --git a/a b/a\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n context\n\\ No newline at end of file');
    view = await renderComponent(DiffViewer, { files, warnings: ['Partial snapshot'] });
    assert.match(document.body.textContent, /1 file/); assert.match(document.body.textContent, /Partial snapshot/); assert.equal(document.querySelector('.diff-file'), null);
    await act(async () => document.querySelector('.diff-file-chip').focus());
    assert.ok(control('a diff')); assert.equal(document.querySelectorAll('.diff-token.changed').length, 2); assert.match(document.querySelector('.diff-code').textContent, /const a = 2/);
    const outside = document.createElement('button'); document.body.append(outside); await act(async () => outside.focus()); assert.equal(document.querySelector('.diff-file'), null);
    await view.rerender({ files: [], warnings: [] }); assert.equal(document.querySelector('.diff-viewer'), null);
  });

});
