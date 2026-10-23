import { render } from 'solid-js/web';
import { createSignal, Show } from 'solid-js';
import { TerminalView } from '../../clients/ui/components/TerminalView';
import '../../clients/ui/styles.css';

const tabs = {
  first: { snapshot: '\u001b[8;25;90tscreen', snapshotEnd: 10, output: '0123456789new\u001b[6n', outputEnd: 17 },
  second: { snapshot: '\u001b[8;25;90tsecond', snapshotEnd: 20, output: 'next\u001b[6n', outputEnd: 28 },
};
const [active, setActive] = createSignal<keyof typeof tabs>('first');
const [open, setOpen] = createSignal(true);
const [replies, setReplies] = createSignal('');
const [saved, setSaved] = createSignal<Record<string, { text: string; end: number }>>({});
const saveFor = (id: string) => (text: string, end: number) => setSaved(values => ({ ...values, [id]: { text, end } }));

render(() => <>
  <button onClick={() => { setActive('second'); setActive('first'); }}>Briefly open second tab</button>
  <button onClick={() => setActive('second')}>Open second tab</button>
  <button onClick={() => setOpen(false)}>Close view</button>
  <output aria-label="Previous input">{JSON.stringify(replies())}</output>
  <output aria-label="Saved screens">{JSON.stringify(saved())}</output>
  <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
    <Show when={open()}>
      <TerminalView cwd="/tmp" activeId={active()} terminals={[{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]}
        snapshot={tabs[active()].snapshot} snapshotEnd={tabs[active()].snapshotEnd}
        output={tabs[active()].output} outputEnd={tabs[active()].outputEnd} started={true}
        onData={async text => { setReplies(value => value + text); return true; }} onSnapshot={saveFor(active())}
        onStart={() => { throw new Error('Restoring a running terminal must not start a shell'); }}
        onResize={async () => {}} onDraft={() => {}} onAdd={() => {}} onSelect={id => setActive(id as keyof typeof tabs)}
        onDelete={() => {}} onClose={() => setOpen(false)} />
    </Show>
  </div>
</>, document.getElementById('root')!);
