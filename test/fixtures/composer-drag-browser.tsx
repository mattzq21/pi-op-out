import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { PendingMessage } from '../../clients/ui/types';
import '../../clients/ui/styles.css';

mockWindows('main');
mockIPC((command, args) => window.nativeCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
const { Composer } = await import('../../clients/ui/components/Composer');
const [moves, setMoves] = createSignal<unknown[]>([]);
const [disabled, setDisabled] = createSignal(false);
const [holdMoves, setHoldMoves] = createSignal(false);
let rejectMove: ((reason: Error) => void) | undefined;
const [messages, setMessages] = createSignal<PendingMessage[]>([
  { id: 'a', message: 'First', behavior: 'steer' },
  { id: 'b', message: 'Second', behavior: 'steer' },
  { id: 'c', message: 'Third', behavior: 'steer' },
  ...(new URLSearchParams(location.search).has('long') ? Array.from({ length: 20 }, (_, index) => ({ id: `extra-${index}`, message: `Extra ${index}`, behavior: 'steer' as const })) : []),
  { id: 'other', message: 'Later', behavior: 'followUp' },
  { id: 'retry', message: 'Retry', behavior: 'steer', retry: true },
]);

render(() => <>
  <label><input type="checkbox" checked={disabled()} onChange={event => setDisabled(event.currentTarget.checked)} />Disable controls</label>
  <button onClick={() => setMessages(values => values.filter(message => message.id !== 'a'))}>Remove first message</button>
  <button onClick={() => setMessages([{ id: "multiline", message: "First line\nSecond line", behavior: "followUp" }])}>Use multiline message</button>
  <label><input type="checkbox" checked={holdMoves()} onChange={event => setHoldMoves(event.currentTarget.checked)} />Hold moves</label>
  <button onClick={() => rejectMove?.(new Error("queue changed"))}>Fail pending move</button>
  <output aria-label="Requested moves">{JSON.stringify(moves())}</output>
  <div style={{ width: '700px', margin: '80px 150px' }}>
    <Composer controlsDisabled={disabled()} streaming={true} queued={messages().length} commands={[]} agents={[]} models={[]} model={null}
      thinkingLevel="off" thinkingLevels={['off']} pendingMessages={messages()}
      onChangePending={async (...args) => { setMoves(values => [...values, args]); if (holdMoves()) await new Promise<void>((_resolve, reject) => { rejectMove = reject; }); }}
      onSend={async () => {}} onPause={async () => {}} onResume={async () => {}} onAbort={async () => {}}
      onAgent={() => {}} onModel={() => {}} onThinking={() => {}} onToggleFastMode={async () => {}} />
  </div>
</>, document.getElementById('root')!);
