import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { DesktopTerminalView } from '../../clients/ui/components/DesktopTerminalView';
import '../../clients/ui/styles.css';

const [output, setOutput] = createSignal('');

const existing = new URLSearchParams(location.search).has('existing');

const [started, setStarted] = createSignal(existing);

if (existing) window.launchSize = { cols: 135, rows: 24 };

window.feed = value => setOutput(current => current + value);

window.sent = [];

render(() => <div style={{ height: '650px', display: 'flex', 'flex-direction': 'column' }}>
  <div style={{ flex: 1 }} />
  <DesktopTerminalView cwd="/tmp" activeId="repro" terminals={[{id:'repro',label:'Terminal'}]}
    output={output()} outputEnd={output().length} started={started()} onStart={(_id, cols, rows) => {
      window.launchSize = { cols, rows }; setStarted(true);
    }} onData={data => window.sent.push(data)} onSnapshot={() => {}} onDraft={() => {}}
    onAdd={() => {}} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />
</div>, document.getElementById('app'));
