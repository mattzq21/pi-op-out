import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { MobileTerminalView } from '../../clients/ui/components/MobileTerminalView';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

const [sent, setSent] = createSignal<string[]>([]);
const pending: Array<(accepted: boolean) => void> = [];

render(() => <>
  <button onClick={() => pending.shift()?.(true)}>Accept oldest input</button>
  <output aria-label="Sent input">{JSON.stringify(sent())}</output>
  <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <MobileTerminalView cwd="/tmp" activeId="shell" terminals={[{ id: 'shell', label: 'Shell' }]}
      output="demo$ " outputEnd={6} started={true} onStart={() => {}}
      onData={value => new Promise<boolean>(resolve => { setSent(values => [...values, value]); pending.push(resolve); })}
      onSnapshot={() => {}} onDraft={() => {}} onAdd={() => {}} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />
  </div>
</>, document.getElementById('root')!);
