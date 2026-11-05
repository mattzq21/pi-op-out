import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { DeferredTurn } from '../../clients/ui/components/DeferredTurn';
import '../../clients/ui/styles.css';

const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement | null>(null);
render(() => <div class="chat-shell">
  <div ref={setScrollRoot} data-testid="messages" style={{ height: '600px', overflow: 'auto' }}>
    {Array.from({ length: 30 }, (_, index) => <DeferredTurn navigationId={'turn-' + index} scrollRoot={scrollRoot} eager={index >= 27}>
      <p class="turn-text" style={{ height: '400px', margin: 0 }}>Answer number {index}</p>
    </DeferredTurn>)}
  </div>
</div>, document.getElementById('root')!);
requestAnimationFrame(() => { const root = scrollRoot()!; root.scrollTop = root.scrollHeight; });
