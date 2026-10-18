import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, Show } from 'solid-js';
import { installDom, renderComponent, act } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { terminals } from '../terminal-runtime.mjs';
import { createTerminalController } from '../../clients/ui/appTerminals.ts';
import { TerminalView } from '../../clients/ui/components/TerminalView.tsx';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('opening an empty terminal then taking ownership starts the shell before input', async () => {
  const dom = installDom();
  HTMLElement.prototype.scrollIntoView = () => {};

  terminals.length = 0;
  const history = new Map(), notices = [], writes = [], calls = [], used = new Set();
  mockIPC((command, args) => {
    if (command === 'start_pi') return { attached: true, owned: false };

    if (command === 'stop_pi') return true;

    if (command !== 'shared_terminal') return;
    calls.push(args.action);
    const id = args.sharedTerminalId;

    if (args.action === 'list') return [...history.values()];

    if (args.action === 'start') history.set(id, { id, output: '$ ', outputEnd: 2, generation: '1', owned: true, started: true, exited: false });
    if (args.action === 'close_unused' && !used.has(id)) history.delete(id);

    if (args.action === 'write_with_draft') {
      if (!history.has(id)) throw 'Terminal is unavailable';
      writes.push(args.data);
      used.add(id);
    }
  }, { shouldMockEvents: true });
  let controller, view;
  const transport = new NativeTransport({ sessionId: 'ownership-repro', cwd: '/repo' });

  try {
    await transport.connect();
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
    await act(controller.close);
    assert.equal(controller.terminalOpen(), false);
    assert.deepEqual([...history.keys()], [originalId]);
    assert.equal(calls.filter(action => action === 'close_unused').length, 2);
    assert.deepEqual(notices, []);
  } finally { await view?.unmount(); await transport.dispose(); dom.restore(); }
});
