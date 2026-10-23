import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { MobileTerminalView } from '../../clients/ui/components/MobileTerminalView';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

const [output, setOutput] = createSignal(Array.from({ length: 80 }, (_, i) => `history ${i}\r\n`).join('') + 'demo$ ');

const [unowned, setUnowned] = createSignal(false);

window.feed = value => setOutput(current => current + value);

window.setUnowned = setUnowned;

window.claims = 0;

render(() => <div style={{ height: '700px', display: 'flex', 'flex-direction': 'column' }}>
  <div style={{ flex: 1 }} />
  <MobileTerminalView cwd="/tmp" activeId="scroll" terminals={[{ id: 'scroll', label: 'Terminal' }]}
    ownershipRequired={unowned()} onTakeOwnership={async () => { window.claims++; setUnowned(false); }}
    output={output()} outputEnd={output().length} started={true} onStart={() => {}}
    onData={async value => { window.lastData = value; return true; }} onSnapshot={() => {}} onDraft={value => { window.lastDraft = value; }} onAdd={() => {}} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />
</div>, document.getElementById('app'));
