import { render } from 'solid-js/web';
import { DeferredTurn } from '../../clients/ui/components/DeferredTurn';
import { createRef } from '../../clients/ui/lib/solid';
import '../../clients/ui/styles.css';

/** A chat of 30 turns, laid out as the chat view does: only the last 3 render at once. */
const scrollRoot = createRef<HTMLDivElement | null>(null);
render(() => <div class="chat-shell">
  <div ref={element => { scrollRoot.current = element; }} data-testid="messages" style={{ height: '600px', overflow: 'auto' }}>
    {Array.from({ length: 30 }, (_, index) => <DeferredTurn navigationId={'turn-' + index} scrollRoot={scrollRoot} eager={index >= 27}>
      <p class="turn-text" style={{ height: '400px', margin: 0 }}>Answer number {index}</p>
    </DeferredTurn>)}
  </div>
</div>, document.getElementById('root')!);
requestAnimationFrame(() => { scrollRoot.current!.scrollTop = scrollRoot.current!.scrollHeight; });
