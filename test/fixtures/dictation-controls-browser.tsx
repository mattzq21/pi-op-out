import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { emit } from '@tauri-apps/api/event';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { DictationControls } from '../../clients/ui/plugins/dictation/DictationControls';

mockWindows('main');
mockIPC((command, args: any) => {
  if (command === 'daemon_invoke') ({ command, args } = args);
  return window.nativeCommand(command, args);
}, { shouldMockEvents: true });
/** Sends an event as the native side does. */
(window as any).nativeEvent = (name: string, payload: unknown) => emit(name, payload);

/** The dictation buttons next to a draft, as in the composer. */
function Draft() {
  const [draft, setDraft] = createSignal('');
  return <main><DictationControls disabled={false} onText={text => setDraft(value => value + text)} /><p aria-label="Draft">{draft()}</p></main>;
}

render(() => <Draft />, document.getElementById('root')!);
