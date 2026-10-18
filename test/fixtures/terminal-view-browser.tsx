import { render } from 'solid-js/web';
import { batch, createSignal, Show } from 'solid-js';
import { TerminalView } from '../../clients/ui/components/TerminalView';
import '../../clients/ui/styles.css';

const [current, setCurrent] = createSignal(false);
const [previousInput, setPreviousInput] = createSignal('');
const [currentInput, setCurrentInput] = createSignal('');
const [size, setSize] = createSignal('');
const [output, setOutput] = createSignal('');
const [outputEnd, setOutputEnd] = createSignal<number>();
const [open, setOpen] = createSignal(true);
const [exited, setExited] = createSignal(false);
const [snapshot, setSnapshot] = createSignal('');
const [started, setStarted] = createSignal(!new URLSearchParams(location.search).has('new'));
const [starts, setStarts] = createSignal<Array<{ id: string; cols: number; rows: number }>>([]);
const previous = (value: string) => setPreviousInput(text => text + value);
const next = (value: string) => setCurrentInput(text => text + value);

render(() => <>
  <button onClick={() => setCurrent(true)}>Change input handler</button>
  <button onClick={() => setOutput('\u001b[8;25;90thello\u001b[6n')}>Show greeting</button>
  <button onClick={() => setOutput(text => text + '\u001b[8;0;10t\u001b[6n')}>Send invalid size</button>
  <button onClick={() => setOutput(text => text + '\u001b[8;20;70t\u001b[6n')}>Send smaller size</button>
  <button onClick={() => setOutput(text => text + ' world\u001b[6n')}>Append output</button>
  <button onClick={() => setOutput(text => text + '\u001b[999;999H\u001b[6n')}>Report screen bounds</button>
  <button onClick={() => setOutput(text => text + '\u001b[?2004h\u001b[6n')}>Enable bracketed paste</button>
  <button onClick={() => batch(() => { setOutputEnd(40); setOutput('xyz\u001b[6n'); })}>Show output after gap</button>
  <button onClick={() => setOpen(false)}>Close view</button>
  <button onClick={() => setExited(true)}>Report shell exited</button>
  <output aria-label="Previous input">{JSON.stringify(previousInput())}</output>
  <output aria-label="Current input">{JSON.stringify(currentInput())}</output>
  <output aria-label="Requested terminal size">{size()}</output>
  <output aria-label="Saved screen">{snapshot()}</output>
  <output aria-label="Shell starts">{JSON.stringify(starts())}</output>
  <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <Show when={open()}>
    <TerminalView cwd="/tmp" terminals={[{ id: 'shell', label: 'Shell' }]} activeId="shell"
      output={output()} outputEnd={outputEnd() ?? output().length} started={started()} exited={exited()} onData={current() ? next : previous}
      onStart={(id, cols, rows) => { setStarts(values => [...values, { id, cols, rows }]); setStarted(true); setExited(false); }}
      onResize={async (cols, rows) => { setSize(JSON.stringify({ cols, rows })); }}
      onSnapshot={(text, end) => setSnapshot(JSON.stringify({ text, end }))} onDraft={() => {}}
      onAdd={() => {}} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />
    </Show>
  </div>
</>, document.getElementById('root')!);
