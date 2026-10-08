import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { TerminalView } from '../../clients/ui/components/TerminalView.tsx';
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

  test('starts once, forwards input through current callbacks, resizes and saves parsed output on disposal', async () => {
    const input = []; await render({ output: 'hello', outputEnd: 5 }); const terminal = terminals[0];
    assert.deepEqual(starts, [['one', 100, 30]]); assert.deepEqual(terminal.writes, ['hello']); await act(() => terminal.flush());
    await render({ started: true, onData: value => input.push(value) }); terminal.data('pwd\r');
    terminal.addons[0].proposeDimensions = () => ({ cols: 90, rows: 25 });
    await act(() => new Promise(resolve => setTimeout(resolve, 180)));
    assert.deepEqual(input, ['pwd\r']); assert.deepEqual(resizes.at(-1), [90, 25]);
    assert.equal(terminal.csiHandler([8, 25, 90]), true);
    assert.equal(terminal.csiHandler([8, 0, 90]), false);
    await view.unmount(); view = undefined; assert.deepEqual(snapshots, [['\u001b[8;25;90tserialized:hello', 5]]); assert.ok(terminal.disposed && terminal.dataDisposed && terminal.csiDisposed && terminal.cursorDisposed && terminal.renderDisposed && terminal.scrollDisposed);
  });

  test('appends only unseen output and resets when a truncated buffer creates a gap', async () => {
    await render({ output: 'abc', outputEnd: 3 }); const terminal = terminals[0];
    await act(() => terminal.flush());
    await render({ output: 'abcdef', outputEnd: 6 }); assert.deepEqual(terminal.writes, ['abc', 'def']);
    await act(() => terminal.flush());
    await render({ output: 'xyz', outputEnd: 20 }); assert.equal(terminal.resets, 1); assert.equal(terminal.writes.at(-1), 'xyz');
    await act(() => terminal.flush()); await view.unmount(); view = undefined; assert.equal(snapshots[0][1], 20);
  });

  test('restores snapshots before replaying new output and preserves unparsed snapshots when switching tabs', async () => {
    await render({ started: true, snapshot: 'screen', snapshotEnd: 10, output: '0123456789new', outputEnd: 13 }); const old = terminals[0];
    assert.deepEqual(starts, []); assert.deepEqual(old.writes, ['screen']);
    await act(() => new Promise(resolve => setTimeout(resolve, 180))); assert.deepEqual(resizes, [[100, 30]]);
    await render({ activeId: 'two', snapshot: 'second', snapshotEnd: 20, output: 'next', outputEnd: 24 });
    assert.deepEqual(snapshots[0], ['screen', 10]);
    await act(() => { old.flush(); terminals[1].flush(); });
    assert.deepEqual(terminals[1].writes, ['second', 'next']);
    await act(() => terminals[1].flush());
    await view.unmount(); view = undefined; assert.deepEqual(snapshots[1], ['\u001b[8;30;100tserialized:secondnext', 24]);
  });

  test('copy shortcut copies selection and reports clipboard failures without intercepting ordinary keys', async () => {
    const copied = []; navigator.clipboard = { writeText: async value => copied.push(value) }; await render(); const terminal = terminals[0]; terminal.selection = 'selected';

    const key = async extra => { const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, cancelable: true, ...extra }); let result; await act(async () => { result = terminal.key(event); });

    return { event, result }; };

    assert.equal((await key({ shiftKey: false })).result, true); assert.deepEqual(copied, []);
    const copiedEvent = await key({}); assert.equal(copiedEvent.result, false); assert.equal(copiedEvent.event.defaultPrevented, true); assert.deepEqual(copied, ['selected']);
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };

    await key({}); assert.match(document.querySelector('[role=status]').textContent, /Could not copy terminal selection/);
    terminal.selection = ''; await key({}); assert.equal(document.querySelector('[role=status]'), null);
  });

  test('unavailable directories and tab limits expose the appropriate controls', async () => {
    const actions = []; await render({ cwd: undefined, exited: true, onAdd: () => actions.push('add'), onSelect: id => actions.push(id), onDelete: () => actions.push('delete'), onClose: () => actions.push('close') });
    assert.equal(terminals.length, 0); assert.match(document.querySelector('.terminal-unavailable').textContent, /get a CWD/);
    await click(control('Restart terminal')); assert.deepEqual(starts, [['one', 80, 24]]);
    await click(control('Add terminal')); await click(document.querySelector('.terminal-tab')); await click(control('Delete terminal')); await click(control('Close terminal panel')); assert.deepEqual(actions, ['add', 'one', 'delete', 'close']);
    await render({ terminals: Array.from({ length: 8 }, (_, index) => ({ id: String(index), label: String(index) })) }); assert.equal(control('Terminal limit reached').disabled, true);
  });
});
