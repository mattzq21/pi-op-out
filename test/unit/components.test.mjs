import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { ExtensionDialog } from '../../clients/ui/components/ExtensionDialog.tsx';
import { Toggle } from '../../clients/ui/components/Toggle.tsx';

describe('rendered controls and dialogs', () => {
  let dom, views;
  beforeEach(() => { dom = installDom(); views = []; });
  afterEach(async () => { for (const view of views) await view.unmount(); await dom.flushFrames(); dom.restore(); });

  async function render(Component, props) { const view = await renderComponent(Component, props); views.push(view);

  return view; }

  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async element => act(async () => element.click());

  test('switches expose current state, invert on click and respect disabled state', async () => {
    const changes = []; const props = { label: 'Enable feature', checked: false, onChange: value => changes.push(value) };
    const view = await render(Toggle, props); const control = document.querySelector('[role=switch]');
    assert.equal(control.getAttribute('aria-checked'), 'false'); assert.equal(control.getAttribute('aria-label'), 'Enable feature');
    await click(control); assert.deepEqual(changes, [true]);
    await view.rerender({ ...props, checked: true }); await click(control); assert.deepEqual(changes, [true, false]);
    await view.rerender({ ...props, disabled: true }); await click(control); assert.equal(changes.length, 2);
  });

  test("extension selection returns the chosen option", async () => {
    const responses = [];
    await render(ExtensionDialog, { request: { id: 'select', method: 'select', options: ['One', 'Two'] }, onRespond: value => responses.push(value) });
    await click(button('Two'));
    assert.deepEqual(responses, [{ value: 'Two' }]);
  });

  test("extension confirmation returns false", async () => {
    const responses = [];
    await render(ExtensionDialog, { request: { id: 'confirm', method: 'confirm' }, onRespond: value => responses.push(value) });
    await click(button('No'));
    assert.deepEqual(responses, [{ confirmed: false }]);
  });

  test("extension confirmation returns true", async () => {
    const responses = [];
    await render(ExtensionDialog, { request: { id: 'confirm', method: 'confirm' }, onRespond: value => responses.push(value) });
    await click(button('Confirm'));
    assert.deepEqual(responses, [{ confirmed: true }]);
  });

  test("extension request errors are visible", async () => {
    await render(ExtensionDialog, { request: { id: 'confirm', method: 'confirm', error: 'request error' }, onRespond: () => assert.fail('No response was requested') });
    assert.equal(document.querySelector('[role=alert]').textContent, 'request error');
  });

  test("extension editor submits edited multiline content", async () => {
    const responses = [];
    await render(ExtensionDialog, { request: { id: 'editor', method: 'editor', prefill: 'draft', placeholder: 'Instructions' }, onRespond: value => responses.push(value) });
    const editor = document.querySelector('textarea');
    assert.equal(editor.value, 'draft');
    await enterText(editor, 'multiline\ncontent'); await click(button('Continue'));
    assert.deepEqual(responses, [{ value: 'multiline\ncontent' }]);
  });

  test("extension editor accepts Cancel button", async () => {
    const responses = [];
    await render(ExtensionDialog, { request: { id: 'editor', method: 'editor', prefill: 'draft' }, onRespond: value => responses.push(value) });
    await click(button('Cancel'));
    assert.deepEqual(responses, [{ cancelled: true }]);
  });

});
