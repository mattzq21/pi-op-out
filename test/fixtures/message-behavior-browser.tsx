import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { Message } from '../../clients/ui/components/Message';
import '../../clients/ui/styles.css';

const [props, setProps] = createSignal(await window.initialMessageProps());
window.updateMessageProps = value => setProps(value);
render(() => <main style={{ width: '700px', margin: '80px auto' }}><Message {...props()} /></main>, document.getElementById('root')!);
