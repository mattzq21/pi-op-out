import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { FindInPage } from '../../clients/ui/components/FindInPage';
import '../../clients/ui/styles.css';

const [enabled, setEnabled] = createSignal(true);
const [active, setActive] = createSignal(true);

render(() => <>
  <label><input type="checkbox" checked={enabled()} onChange={event => setEnabled(event.currentTarget.checked)} />Enable search</label>
  <label><input type="checkbox" checked={active()} onChange={event => setActive(event.currentTarget.checked)} />Active conversation</label>
  <section id="chat" class="chat-shell" style={{ height: '400px', width: '600px', position: 'relative' }}>
    <div class="messages">
      <p>Alpha <em>beta</em> alpha</p>
      <p>literal [a+b]</p>
      <p hidden>alpha</p>
      <p aria-hidden="true">alpha</p>
      <p style={{ visibility: 'hidden' }}>alpha</p>
      <textarea aria-label="Example editor">alpha</textarea>
      <script type="text/plain">alpha</script>
      <p>separate</p><p>blocks</p>
    </div>
    <button>Conversation focus</button>
  </section>
  <FindInPage selector="#chat" scopeKey="one" enabled={enabled()} active={active()} />
</>, document.getElementById('root')!);
