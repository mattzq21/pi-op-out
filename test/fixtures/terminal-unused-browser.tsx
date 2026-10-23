import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import '../../clients/ui/styles.css';

mockWindows('main');
mockIPC((command, args) => window.terminalCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
window.deliverTerminalEvent = (event, payload) => emit(event, payload);
const { createTerminalController } = await import('../../clients/ui/appTerminals');
const { NativeTransport } = await import('../../clients/ui/lib/nativeTransport');
const { TerminalView } = await import('../../clients/ui/components/TerminalView');
const chat = await window.terminalChat();
const transport = new NativeTransport({ sessionId: chat.sessionId, cwd: chat.cwd });
await transport.connect();
const [closed, setClosed] = createSignal(false);
const [notices, setNotices] = createSignal<string[]>([]);
function TestTerminal() {
  const controller = createTerminalController({ transport: () => transport, sessionTransport: () => transport,
    conversationKey: () => 'local:' + chat.sessionId, location: () => ({ cwd: chat.cwd, hostId: 'local' }),
    addNotice: notice => { setNotices(values => [...values, notice.message]); } });
  controller.setTerminalOpen(true);
  return <><button onClick={async () => { await controller.close(); setClosed(true); }}>Close panel</button>
    <output aria-label="Closed">{String(closed())}</output><output aria-label="Errors">{JSON.stringify(notices())}</output>
    <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <Show when={controller.ready()}>
      <TerminalView visible={controller.terminalOpen()} cwd={chat.cwd} ownershipRequired={!controller.owned()}
        terminals={controller.state.sessionTerminals.tabs.map(tab => ({ id: tab.id, label: 'Terminal' }))}
        activeId={controller.state.activeTerminal.id} output={controller.state.activeTerminal.output} outputEnd={controller.state.activeTerminal.outputEnd}
        started={controller.state.activeTerminal.started} exited={controller.state.activeTerminal.exited}
        onStart={controller.startTerminal} onData={controller.write} onDraft={controller.updateDraft} onResize={controller.resize}
        onSnapshot={() => {}} onAdd={controller.addTerminal} onSelect={controller.selectTerminal} onDelete={controller.deleteTerminal} onClose={controller.close} />
    </Show></div></>;
}
render(() => <TestTerminal />, document.getElementById('root')!);
