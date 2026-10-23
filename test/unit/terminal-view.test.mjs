import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { TerminalView } from '../../clients/ui/components/TerminalView.tsx';
import { MobileTerminalView } from '../../clients/ui/components/MobileTerminalView.tsx';
import { terminals } from '../terminal-runtime.mjs';

describe('terminal view', () => {
  let dom, view, props, starts, resizes, snapshots;
  beforeEach(() => {
    dom = installDom(); HTMLElement.prototype.scrollIntoView = () => {};

    terminals.length = 0; starts = []; resizes = []; snapshots = [];
    props = { cwd: '/repo', terminals: [{ id: 'one', label: 'Shell' }], activeId: 'one', output: '', outputEnd: 0, started: false, onDraft: () => {}, onAdd: () => {}, onSelect: () => {}, onStart: (...args) => starts.push(args), onData: () => {}, onResize: async (...args) => resizes.push(args), onSnapshot: (...args) => snapshots.push(args), onDelete: () => {}, onClose: () => {} };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });

  async function render(extra = {}) { props = { ...props, ...extra };

  if (view) await view.rerender(props); else view = await renderComponent(TerminalView, props); }

  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const click = async element => act(async () => element.click());

  for (const [name, component] of [['desktop', TerminalView], ['mobile', MobileTerminalView]]) {
    test(`${name} starts a shell only after its hidden panel is opened`, async () => {
      props = { ...props, visible: false };
      view = await renderComponent(component, props);
      assert.deepEqual(starts, []);
      props = { ...props, visible: true };
      await view.rerender(props);
      assert.equal(starts.length, 1);
      props = { ...props, started: true, visible: false };
      await view.rerender(props);
      await view.rerender({ ...props, visible: true });
      assert.equal(starts.length, 1);
    });
  }

  test('closing the view releases the terminal and its event subscriptions', async () => {
    await render();
    const terminal = terminals[0];
    await view.unmount(); view = undefined;
    assert.equal(terminal.disposed, true);
    assert.equal(terminal.dataDisposed, true);
    assert.equal(terminal.csiDisposed, true);
    assert.equal(terminal.cursorDisposed, true);
    assert.equal(terminal.renderDisposed, true);
    assert.equal(terminal.scrollDisposed, true);
  });

  test('a conversation without a directory explains why its terminal is unavailable', async () => {
    await render({ cwd: undefined });
    assert.match(view.container.textContent, /get a CWD/);
    assert.deepEqual(starts, []);
    assert.equal(terminals.length, 0);
  });

  test('Add terminal requests another tab', async () => {
    let added = 0;
    await render({ onAdd: () => added++ });
    await click(control('Add terminal'));
    assert.equal(added, 1);
  });

  test('choosing a terminal tab requests that tab by its ID', async () => {
    const selected = [];
    await render({ terminals: [{ id: 'one', label: 'Shell' }, { id: 'two', label: 'Build' }], onSelect: id => selected.push(id) });
    const build = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Build');
    assert.ok(build);
    await click(build);
    assert.deepEqual(selected, ['two']);
  });

  test('Delete terminal requests removal of the selected tab', async () => {
    let deleted = 0;
    await render({ onDelete: () => deleted++ });
    await click(control('Delete terminal'));
    assert.equal(deleted, 1);
  });

  test('Close terminal panel requests that the panel close', async () => {
    let closed = 0;
    await render({ onClose: () => closed++ });
    await click(control('Close terminal panel'));
    assert.equal(closed, 1);
  });

  test('eight terminal tabs prevent adding another tab', async () => {
    let added = 0;
    await render({ terminals: [
      { id: 'one', label: 'Shell' }, { id: 'two', label: 'Build' },
      { id: 'three', label: 'Logs' }, { id: 'four', label: 'Server' },
      { id: 'five', label: 'Worker' }, { id: 'six', label: 'Monitor' },
      { id: 'seven', label: 'Tools' }, { id: 'eight', label: 'Scratch' },
    ], onAdd: () => added++ });
    const add = control('Terminal limit reached');
    assert.equal(add.disabled, true);
    await click(add);
    assert.equal(added, 0);
  });
});
