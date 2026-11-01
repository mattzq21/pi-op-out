import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { TerminalView } from '../../clients/ui/components/TerminalView';
import { useAppKeyboard } from '../../clients/ui/useAppKeyboard';
import { defaultKeybindings } from '../../clients/ui/lib/keybindings';
import type { AppSettings } from '../../clients/ui/types';
import '../../clients/ui/styles.css';

const [toggles, setToggles] = createSignal(0);
const [input, setInput] = createSignal('');
const [focuses, setFocuses] = createSignal(0);
const ignore = (() => undefined) as never;

function Harness() {
  useAppKeyboard({ settings: () => ({ keybindings: defaultKeybindings }) as AppSettings, activePane: () => 'main', splitPane: () => undefined, canLeaveSettings: () => true,
    setView: (() => undefined) as never, panelOpen: () => false, setPanelOpen: ignore, newSession: async () => {}, toggleTerminal: () => setToggles(count => count + 1), toggleDebugMode: () => {},
    setSplitComposerFocusRequest: ignore, setMainComposerFocusRequest: (() => setFocuses(count => count + 1)) as never, settingsDirty: () => false, view: () => 'chat', terminalOpen: () => true, setTerminalOpen: ignore });

  return <>
    <output aria-label="Terminal toggles">{toggles()}</output>
    <output aria-label="Composer focuses">{focuses()}</output>
    <output aria-label="Shell input">{JSON.stringify(input())}</output>
    <div style={{ height: '600px', display: 'flex', 'flex-direction': 'column' }}>
      <TerminalView cwd="/tmp" terminals={[{ id: 'shell', label: 'Shell' }]} activeId="shell" output="$ " outputEnd={2} started={true}
        onData={async value => { setInput(text => text + value); return true; }} onStart={() => {}} onSnapshot={() => {}} onDraft={() => {}}
        onAdd={() => {}} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />
    </div>
  </>;
}

render(() => <Harness />, document.getElementById('root')!);
