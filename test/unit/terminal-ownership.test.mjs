import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, Show } from 'solid-js';
import { installDom, renderComponent, renderHook, act } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { terminals } from '../terminal-runtime.mjs';
import { createTerminalController } from '../../src/appTerminals.ts';
import { TerminalView } from '../../src/components/TerminalView.tsx';
import { nativeTerminals } from '../../src/lib/nativeTerminals.ts';
import { beginBranching } from '../../src/lib/branchActivity.ts';

test('opening an empty terminal then taking ownership starts the shell before input', async () => {
  const dom = installDom();
  HTMLElement.prototype.scrollIntoView = () => {};

  terminals.length = 0;
  const history = new Map(), notices = [], writes = [], calls = [];
  mockIPC((command, args) => {
    if (command !== 'shared_terminal') return;
    calls.push(args.action);
    const id = args.sharedTerminalId;

    if (args.action === 'list') return [...history.values()];

    if (args.action === 'start') history.set(id, { id, output: '$ ', outputEnd: 2, generation: '1', owned: true, started: true, exited: false });

    if (args.action === 'write_with_draft') {
      if (!history.has(id)) throw 'Terminal is unavailable';
      writes.push(args.data);
    }
  }, { shouldMockEvents: true });
  let owned = false, listener, controller, view;

  const transport = {
    markTerminalActivity: () => {},
    ownsConversation: () => owned,
    hasConfirmedOwnership: () => owned,
    subscribe: callback => { listener = callback;

    return () => {}; },
    takeOwnership: async () => { owned = true; listener({ type: 'ownership_acquired' }); },
    startTerminal: (...args) => nativeTerminals.start(...args),
    writeTerminal: (...args) => nativeTerminals.write(...args),
    resizeTerminal: (...args) => nativeTerminals.resize(...args),
  };

  try {
    view = await renderComponent(() => {
      controller = createTerminalController({ transport: () => transport, sessionTransport: () => transport, conversationKey: () => 'local:ownership-repro', location: () => ({ cwd: '/repo', hostId: 'local' }), addNotice: notice => notices.push(notice) });
      controller.setTerminalOpen(true);

      return createComponent(Show, {
        get when() { return controller.ready(); },
        get children() { return createComponent(TerminalView, {
          cwd: '/repo',
          get ownershipRequired() { return !controller.owned(); },
          get terminals() { return controller.state.sessionTerminals.tabs.map(tab => ({ id: tab.id, label: 'Terminal' })); },
          get activeId() { return controller.state.activeTerminal.id; },
          get output() { return controller.state.activeTerminal.output; },
          get outputEnd() { return controller.state.activeTerminal.outputEnd; },
          get started() { return controller.state.activeTerminal.started; },
          onStart: controller.startTerminal, onData: controller.write, onResize: controller.resize,
          onTakeOwnership: controller.takeOwnership, onSnapshot: () => {}, onAdd: controller.addTerminal,
          onSelect: controller.selectTerminal, onDelete: controller.deleteTerminal, onClose: controller.close,
        }); },
      });
    });
    assert.equal(history.size, 0);
    await act(() => document.querySelector('.terminal-host').dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
    await act(() => terminals.at(-1).data('pwd\r'));
    const firstNotices = [...notices], firstCalls = [...calls];
    const originalId = controller.state.activeTerminal.id;
    await act(controller.addTerminal);
    await act(() => controller.selectTerminal(originalId));
    await act(() => terminals.at(-1).data('pwd\r'));
    assert.ok(history.has(originalId), 'switching back after adding a terminal starts the first shell');
    assert.deepEqual(firstNotices, [], JSON.stringify({ notices: firstNotices, calls: firstCalls }));
    assert.deepEqual(writes, ['pwd\r', 'pwd\r']);
    assert.equal(history.size, 2);
  } finally { await view?.unmount(); dom.restore(); }
});

test('terminal recovery dismisses its sync error without dismissing unrelated notices', async () => {
  const dom = installDom();
  const notices = new Set([{ title: 'Unrelated problem' }]);
  let offline = true;
  let view;
  mockIPC((command, args) => {
    if (command !== 'shared_terminal' || args.action !== 'list') return;

    if (offline) throw new Error('Backend is offline');

    return [];
  }, { shouldMockEvents: true });
  const transport = { hasConfirmedOwnership: () => true, subscribe: () => () => {}, takeOwnership: async () => {} };

  try {
    view = await renderHook(() => createTerminalController({
      transport: () => transport, sessionTransport: () => transport,
      conversationKey: () => 'local:recovery', location: () => ({ cwd: '/repo', hostId: 'local' }),
      addNotice: notice => { notices.add(notice);

      return () => notices.delete(notice); },
    }));
    assert.equal(view.current.ready(), false);
    assert.equal(notices.size, 2);
    offline = false;
    await act(view.current.takeOwnership);
    assert.equal(view.current.ready(), true);
    assert.deepEqual([...notices].map(notice => notice.title), ['Unrelated problem']);
    offline = true;
    await act(view.current.takeOwnership);
    assert.equal(notices.size, 2);
  } finally { await view?.unmount(); dom.restore(); }
});

test('terminal input and resize wait for a fork and its terminal transfer', async () => {
  const dom = installDom();
  const transferred = Promise.withResolvers();
  const calls = [];
  const finishBranching = beginBranching();
  let move;
  mockIPC((command, args) => {
    if (command !== 'shared_terminal') return;
    calls.push(args.action);

    if (args.action === 'reassign') return transferred.promise;
  });
  const writing = nativeTerminals.write('fork-queued-input', 'pwd\r');
  const resizing = nativeTerminals.resize('fork-queued-input', 100, 30);

  try {
    await act(() => {});
    assert.deepEqual(calls, [], 'input must remain queued while the fork releases source ownership');
    move = nativeTerminals.reassign('fork-queued-input', 'local:fork-queued-child');
    await act(() => {});
    finishBranching();
    await act(() => {});
    assert.deepEqual(calls, ['reassign'], 'input must also wait for the terminal to reach the child');
    transferred.resolve();
    await Promise.all([move, writing, resizing]);
    assert.deepEqual(calls, ['reassign', 'write_with_draft', 'resize']);
  } finally {
    finishBranching(); transferred.resolve();
    await Promise.allSettled([move, writing, resizing]);
    dom.restore();
  }
});

test('one failed terminal transfer does not prevent transferring the other tabs', async () => {
  const dom = installDom();
  const calls = [];
  mockIPC((command, args) => {
    if (command !== 'shared_terminal' || args.action !== 'reassign') return;
    calls.push(args.sharedTerminalId);

    if (args.sharedTerminalId === 'fork-failed-tab') throw new Error('First terminal is unavailable');
  });

  try {
    const results = await Promise.allSettled([
      nativeTerminals.reassign('fork-failed-tab', 'local:fork-independent-tabs'),
      nativeTerminals.reassign('fork-healthy-tab', 'local:fork-independent-tabs'),
    ]);

    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(calls, ['fork-failed-tab', 'fork-healthy-tab']);
  } finally { dom.restore(); }
});
