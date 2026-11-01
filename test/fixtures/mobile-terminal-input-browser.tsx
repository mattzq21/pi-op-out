import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { MobileTerminalView } from '../../clients/ui/components/MobileTerminalView';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

const [sent, setSent] = createSignal<string[]>([]);
const [activeId, setActiveId] = createSignal('shell');
const [drafts, setDrafts] = createSignal<Record<string, string>>({ second: 'draft two' });
const [output, setOutput] = createSignal('demo$ ');
const pending: Array<(accepted: boolean) => void> = [];
(window as unknown as { emitShell: (data: string) => void }).emitShell = data => setOutput(text => text + data);

render(() => <>
  <button onClick={() => pending.shift()?.(true)}>Accept oldest input</button>
  <button onClick={() => pending.shift()?.(false)}>Reject oldest input</button>
  <output aria-label="Sent input">{JSON.stringify(sent())}</output>
  <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <MobileTerminalView cwd="/tmp" activeId={activeId()} terminals={[{ id: 'shell', label: 'Shell' }, { id: 'second', label: 'Second' }]}
      output={output()} outputEnd={output().length} started={true} onStart={() => {}}
      inputDraft={drafts()[activeId()]}
      onData={(value, clearDraft) => { setSent(values => [...values, value]); return clearDraft ? new Promise<boolean>(resolve => pending.push(resolve)) : Promise.resolve(true); }}
      onSnapshot={() => {}} onDraft={value => setDrafts(saved => ({ ...saved, [activeId()]: value }))}
      onAdd={() => {}} onSelect={setActiveId} onDelete={() => {}} onClose={() => {}} />
  </div>
</>, document.getElementById('root')!);
