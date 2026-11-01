import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ToastHistory } from '../../clients/ui/components/ToastHistory';
import { trackToastMessage } from '../../clients/ui/lib/toastHistory';
import '../../clients/ui/styles.css';

function Window() {
  const [notice, setNotice] = createSignal<string>();
  let input!: HTMLInputElement;
  trackToastMessage('test window', 'Notice', notice);
  return <main>
    <form onSubmit={event => { event.preventDefault(); setNotice(input.value); }}><input ref={input} aria-label="Notice text" /><button>Notify</button></form>
    <ToastHistory />
  </main>;
}

render(() => <Window />, document.getElementById('root')!);
