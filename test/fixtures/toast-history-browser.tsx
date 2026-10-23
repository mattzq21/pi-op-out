import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ToastHistory } from '../../clients/ui/components/ToastHistory';
import { trackToastMessage } from '../../clients/ui/lib/toastHistory';
import '../../clients/ui/styles.css';

/** A window that shows its toast history and raises a notice for each submitted text, as app toasts do. */
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
