import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { ExtensionDialog } from '../../src/components/ExtensionDialog.tsx';
import { WorktreeDialog } from '../../src/components/WorktreeDialog.tsx';
import { RemoveWorktreeDialog } from '../../src/components/RemoveWorktreeDialog.tsx';
import { RemoveGroupDialog } from '../../src/components/RemoveGroupDialog.tsx';
import { ResizableSidebar } from '../../src/components/ResizableSidebar.tsx';
import { Toggle } from '../../src/components/Toggle.tsx';

describe('rendered controls and dialogs', () => {
  let dom, views;
  beforeEach(() => { dom = installDom(); views = []; });
  afterEach(async () => { for (const view of views) await view.unmount(); await dom.flushFrames(); dom.restore(); });
  async function render(Component, props) { const view = await renderComponent(Component, props); views.push(view); return view; }
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async element => act(async () => element.click());
  const key = async (element, key, extra = {}) => act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })));

  test('switches expose current state, invert on click and respect disabled state', async () => {
    const changes = []; const props = { label: 'Enable feature', checked: false, onChange: value => changes.push(value) };
    const view = await render(Toggle, props); const control = document.querySelector('[role=switch]');
    assert.equal(control.getAttribute('aria-checked'), 'false'); assert.equal(control.getAttribute('aria-label'), 'Enable feature');
    await click(control); assert.deepEqual(changes, [true]);
    await view.rerender({ ...props, checked: true }); await click(control); assert.deepEqual(changes, [true, false]);
    await view.rerender({ ...props, disabled: true }); await click(control); assert.equal(changes.length, 2);
  });

  test('extension input submits edited content, blocks duplicate responses and displays failures', async () => {
    const pending = Promise.withResolvers(); const responses = [];
    const props = { request: { id: 'one', method: 'input', prefill: 'initial', title: 'Name', message: 'Choose a name' }, owner: 'Agent', onRespond: value => { responses.push(value); return pending.promise; } };
    await render(ExtensionDialog, props); const input = document.querySelector('input'); assert.equal(input.value, 'initial');
    await enterText(input, 'edited'); await key(input, 'Enter', { isComposing: true }); assert.deepEqual(responses, []);
    await key(input, 'Enter'); await key(input, 'Enter');
    assert.deepEqual(responses, [{ value: 'edited' }]); assert.equal(input.disabled, true);
    await act(async () => { pending.reject(new Error('offline')); });
    assert.equal(document.querySelector('[role=alert]').textContent, 'offline'); assert.equal(input.disabled, false);
  });

  test('extension selection, confirmation, editor and cancellation send distinct responses', async () => {
    const responses = []; const onRespond = value => responses.push(value);
    const view = await render(ExtensionDialog, { request: { id: 'select', method: 'select', options: ['One', 'Two'] }, onRespond });
    await click(button('Two')); assert.deepEqual(responses.pop(), { value: 'Two' });
    await view.rerender({ request: { id: 'confirm', method: 'confirm', error: 'request error' }, onRespond });
    assert.equal(document.querySelector('[role=alert]').textContent, 'request error');
    await click(button('No')); await click(button('Confirm')); assert.deepEqual(responses.splice(0), [{ confirmed: false }, { confirmed: true }]);
    await view.rerender({ request: { id: 'editor', method: 'editor', prefill: 'draft', placeholder: 'Instructions' }, onRespond });
    await enterText(document.querySelector('textarea'), 'multiline\ncontent'); await click(button('Continue'));
    assert.deepEqual(responses.pop(), { value: 'multiline\ncontent' });
    await act(async () => document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })));
    assert.deepEqual(responses.pop(), { cancelled: true });
    await click(button('Cancel')); assert.deepEqual(responses.pop(), { cancelled: true });
  });

  test('worktree creation validates names and recovers from a failed request', async () => {
    const names = []; const view = await render(WorktreeDialog, { projectPath: '/repo', fromProject: true, onCancel() {}, onCreate: async name => { names.push(name); throw new Error('creation failed'); } });
    await click(button('Create worktree')); assert.equal(document.querySelector('[role=alert]').textContent, "Branch name can't be empty");
    const input = document.querySelector('input'); await enterText(input, ' feature ');
    assert.equal(document.querySelector('[role=alert]'), null); assert.equal(document.querySelector('.worktree-preview code').textContent, 'parent|feature');
    await key(input, 'Enter'); assert.deepEqual(names, ['feature']); assert.equal(document.querySelector('[role=alert]').textContent, 'creation failed'); assert.equal(input.disabled, false);
    await view.rerender({ projectPath: '/repo', beforePrompt: true, onCancel() {}, onCreate: async () => {} });
    assert.match(document.body.textContent, /before this response’s prompt/);
  });

  test('worktree setup cancellation can fail and retry without closing or creating twice', async () => {
    const creation = Promise.withResolvers(); const cancellation = Promise.withResolvers(); let created = 0, cancelled = 0, closed = 0;
    await render(WorktreeDialog, { projectPath: '/repo', onCancel: () => closed++, onCreate: (_name, setup) => { created++; setup(() => { cancelled++; return cancellation.promise; }); return creation.promise; } });
    const input = document.querySelector('input'); await enterText(input, 'feature'); await key(input, 'Enter'); await key(input, 'Enter');
    assert.equal(created, 1); assert.equal(input.disabled, true); assert.match(document.querySelector('[role=status]').textContent, /Running environment setup/);
    await click(button('Cancel setup')); assert.equal(cancelled, 1); assert.match(document.querySelector('[role=status]').textContent, /Stopping/);
    await act(async () => { cancellation.reject(new Error('cancel failed')); });
    assert.equal(document.querySelector('[role=alert]').textContent, 'cancel failed'); assert.equal(button('Cancel setup').disabled, false); assert.equal(closed, 0);
    await act(async () => { creation.reject(new Error('setup stopped')); });
    assert.equal(input.disabled, false); await click(button('Cancel')); assert.equal(closed, 1);
  });

  test('worktree removal reports backend usage checks and passes the selected branch policy', async () => {
    const values = []; const props = { name: 'feature', path: '/repo/feature', conversationCount: 1, onCancel() {}, onRemove: async value => values.push(value) };
    const view = await render(RemoveWorktreeDialog, props);
    assert.match(document.body.textContent, /checks for conversations and terminals still using/);
    await click(button('Delete worktree')); assert.deepEqual(values, [false]);
    await view.rerender(props); await click(document.querySelector('input')); await click(button('Delete worktree'));
    assert.deepEqual(values, [false, true]);
  });

  test('group removal disables cancellation while pending and makes failed operations retryable', async () => {
    const pending = Promise.withResolvers(); let removed = 0, cancelled = 0;
    await render(RemoveGroupDialog, { name: 'Work', onRemove: () => { removed++; return pending.promise; }, onCancel: () => cancelled++ });
    await click(button('Remove group')); assert.equal(button('Cancel').disabled, true);
    await act(async () => document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })));
    assert.equal(cancelled, 0); assert.equal(removed, 1);
    await act(async () => { pending.reject(new Error('cannot save')); });
    assert.match(document.querySelector('[role=alert]').textContent, /cannot save/); assert.equal(button('Cancel').disabled, false);
    await click(button('Cancel')); assert.equal(cancelled, 1);
  });

  test('sidebar keyboard resizing enforces bounds, persists widths and resets to the viewport default', async () => {
    window.innerWidth = 1200; localStorage.setItem('pi-desktop-sidebar-width', '300');
    const view = await render(ResizableSidebar, { compact: false, children: 'Sessions' }); const separator = document.querySelector('[role=separator]');
    assert.equal(separator.getAttribute('aria-valuenow'), '300');
    await key(separator, 'ArrowRight'); assert.equal(separator.getAttribute('aria-valuenow'), '310');
    await key(separator, 'ArrowLeft', { shiftKey: true }); assert.equal(localStorage.getItem('pi-desktop-sidebar-width'), '260');
    await key(separator, 'End'); assert.equal(separator.getAttribute('aria-valuenow'), '600');
    await key(separator, 'Home'); await key(separator, 'ArrowLeft'); assert.equal(separator.getAttribute('aria-valuenow'), '200');
    await key(separator, 'other'); assert.equal(separator.getAttribute('aria-valuenow'), '200');
    await act(async () => separator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); assert.equal(separator.getAttribute('aria-valuenow'), '260');
    await act(async () => { window.innerWidth = 400; window.dispatchEvent(new Event('resize')); }); assert.equal(separator.getAttribute('aria-valuenow'), '200');
    await view.rerender({ compact: true, children: 'Sessions' }); assert.equal(document.querySelector('[role=separator]'), null);
  });

  test('sidebar dragging tracks the captured pointer and restores body styles on release', async () => {
    await render(ResizableSidebar, { compact: false }); const separator = document.querySelector('[role=separator]');
    let captured; separator.setPointerCapture = id => { captured = id; }; separator.releasePointerCapture = () => { captured = undefined; };
    const pointer = async (type, properties) => act(async () => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: 100, ...properties }); separator.dispatchEvent(event); });
    await pointer('pointerdown', { button: 2 }); assert.equal(captured, undefined);
    await pointer('pointerdown'); assert.equal(captured, 1); assert.equal(document.body.style.cursor, 'col-resize');
    await pointer('pointermove', { pointerId: 2, clientX: 150 }); assert.equal(separator.getAttribute('aria-valuenow'), '232');
    await pointer('pointermove', { clientX: 150 }); assert.equal(separator.getAttribute('aria-valuenow'), '282');
    await pointer('pointerup', { pointerId: 2 }); assert.equal(captured, 1);
    await pointer('pointerup'); assert.equal(captured, undefined); assert.equal(document.body.style.cursor, '');
    await pointer('pointerdown'); await pointer('pointercancel'); assert.equal(document.body.style.userSelect, '');
  });

  test('worktree removal preserves the dialog on error and blocks Escape until removal settles', async () => {
    let cancelled = 0; const pending = Promise.withResolvers(); const policies = [];
    await render(RemoveWorktreeDialog, { name: 'feature', path: '/repo', conversationCount: 0, onCancel: () => cancelled++, onRemove: policy => { policies.push(policy); return pending.promise; } });
    await click(button('Delete worktree')); assert.deepEqual(policies, [false]);
    const dialog = document.querySelector('dialog');
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true }))); assert.equal(cancelled, 0);
    await act(async () => pending.reject('worktree has changes'));
    assert.equal(document.querySelector('[role=alert]').textContent, 'worktree has changes');
    assert.equal(button('Delete worktree').disabled, false);
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true }))); assert.equal(cancelled, 1);
  });

  test('extension backdrop clicks cancel only outside the dialog and return focus on unmount', async () => {
    const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
    const responses = []; const view = await render(ExtensionDialog, { request: { id: 'confirm', method: 'confirm' }, onRespond: response => responses.push(response) });
    const dialog = document.querySelector('dialog'); dialog.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 });
    await act(async () => dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50 })));
    assert.deepEqual(responses, []);
    await act(async () => dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 50 })));
    assert.deepEqual(responses, [{ cancelled: true }]);
    await view.unmount(); views.splice(views.indexOf(view), 1); await dom.flushFrames(); assert.equal(document.activeElement, launcher);
  });

  test('sidebar remains usable when persistence is unavailable and supports lost pointer capture', async () => {
    window.innerWidth = 1200;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
    await render(ResizableSidebar, { compact: false }); const separator = document.querySelector('[role=separator]');
    assert.equal(separator.getAttribute('aria-valuenow'), '260');
    separator.setPointerCapture = () => {};
    await act(async () => { const event = new Event('pointerdown', { bubbles: true }); Object.assign(event, { pointerId: 1, isPrimary: true, button: 0, clientX: 100 }); separator.dispatchEvent(event); });
    assert.equal(document.body.style.cursor, 'col-resize');
    await act(async () => separator.dispatchEvent(new Event('lostpointercapture', { bubbles: true })));
    assert.equal(document.body.style.cursor, '');
    await act(async () => { window.innerWidth = 1000; separator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    assert.equal(separator.getAttribute('aria-valuenow'), '232');
  });
});
