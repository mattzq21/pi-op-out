import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { DictationRecording } from '../../clients/ui/lib/dictation';

mockWindows('main');
mockIPC((command, args: any) => {
  if (command === 'daemon_invoke') ({ command, args } = args);
  return window.nativeCommand(command, args);
}, { shouldMockEvents: true });

/** Starts one dictation, shows when it ends by itself, then finishes it and shows the engine's text. */
function Dictation() {
  const [state, setState] = createSignal('idle');
  const [text, setText] = createSignal('');
  const recording = new DictationRecording(message => setState('error: ' + message));
  const start = () => {
    setState('recording');
    void recording.start(async () => {
      setState('ended by itself');
      try { setText((await recording.finish())?.text ?? ''); setState('finished'); }
      catch (error) { setState('error: ' + String(error)); }
    }, () => undefined).catch(error => setState('error: ' + String(error)));
  };
  return <main><button onClick={start}>Dictate</button><p role="status">{state()}</p><p aria-label="Dictated text">{text()}</p></main>;
}

render(() => <Dictation />, document.getElementById('root')!);
