import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, Show } from 'solid-js';
import { installDom, renderComponent, act } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { terminals } from '../terminal-runtime.mjs';
import { createTerminalController } from '../../src/appTerminals.ts';
import { TerminalView } from '../../src/components/TerminalView.tsx';
import { nativeTerminals } from '../../src/lib/nativeTerminals.ts';

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
