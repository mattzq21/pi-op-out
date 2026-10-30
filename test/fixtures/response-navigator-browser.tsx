import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ResponseNavigator, type ResponseDestination } from '../../clients/ui/components/ResponseNavigator';
import { createRef } from '../../clients/ui/lib/solid';
import '../../clients/ui/styles.css';

/** A scrolling chat with tall answers, marked the way the chat view marks its turns and responses. */
const answers = ['Plan the parser', 'Write the lexer', 'Add the tests'];
const [count, setCount] = createSignal(Number(new URLSearchParams(location.search).get('answers') ?? answers.length));
const responses = (): ResponseDestination[] => answers.slice(0, count()).map((preview, index) => ({ turnId: 'turn-' + index, messageId: 'answer-' + index, preview }));
/** Answers in older history that the chat has not loaded. */
const [older, setOlder] = createSignal<string[]>([]);
const rail = (): ResponseDestination[] => [...older().map((preview, index) => ({ messageId: 'older-' + index, preview })), ...responses()];
const scrollRoot = createRef<HTMLDivElement | null>(null);
(window as any).navigated = 0;
(window as any).revealed = [];
(window as any).setAnswers = setCount;
(window as any).setOlder = setOlder;

render(() => <main style={{ position: 'relative' }}>
  <div ref={element => { scrollRoot.current = element; }} data-testid="messages" style={{ height: '400px', overflow: 'auto', position: 'relative' }}>
    <div class="conversation">{responses().map(response => <section data-response-turn={response.turnId} style={{ height: '900px' }}>
      <p>Question before {response.preview}</p>
      <article data-response-id={response.messageId}>{response.preview}</article>
    </section>)}</div>
  </div>
  <ResponseNavigator responses={rail()} forked={new Set(['answer-1'])} scrollRoot={scrollRoot} onNavigate={() => { (window as any).navigated++; }} onReveal={id => (window as any).revealed.push(id)} />
</main>, document.getElementById('root')!);
