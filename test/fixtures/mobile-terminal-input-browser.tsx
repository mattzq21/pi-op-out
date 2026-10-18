import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { MobileTerminalView } from '../../clients/ui/components/MobileTerminalView';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

const [sent, setSent] = createSignal<string[]>([]);
const [activeId, setActiveId] = createSignal('shell');
const [drafts, setDrafts] = createSignal<Record<string, string>>({ second: 'draft two' });
const pending: Array<(accepted: boolean) => void> = [];

render(() => <>
  <button onClick={() => pending.shift()?.(true)}>Accept oldest input</button>
  <button onClick={() => pending.shift()?.(false)}>Reject oldest input</button>
  <output aria-label="Sent input">{JSON.stringify(sent())}</output>
  <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <MobileTerminalView cwd="/tmp" activeId={activeId()} terminals={[{ id: 'shell', label: 'Shell' }, { id: 'second', label: 'Second' }]}
      output="demo$ " outputEnd={6} started={true} onStart={() => {}}
      inputDraft={drafts()[activeId()]}
      onData={value => new Promise<boolean>(resolve => { setSent(values => [...values, value]); pending.push(resolve); })}
      onSnapshot={() => {}} onDraft={value => setDrafts(saved => ({ ...saved, [activeId()]: value }))}
      onAdd={() => {}} onSelect={setActiveId} onDelete={() => {}} onClose={() => {}} />
  </div>
</>, document.getElementById('root')!);
