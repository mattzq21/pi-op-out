import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { ChatView } from '../../clients/ui/components/ChatView';
import '../../clients/ui/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 25 }, (_, index) => ({ id: crypto.randomUUID(), role: 'user', content: `Earlier message ${index}` })));
const [streaming, setStreaming] = createSignal(false);
window.appendScrollMessage = () => setMessages(items => [...items, { id: crypto.randomUUID(), role: 'assistant', content: 'More output\n\n'.repeat(15) }]);
window.streamAnswerLine = (line: string) => {
  setStreaming(true);
  setMessages(items => {
    const answer = items.at(-1)?.streaming ? items.at(-1) : undefined;
    const lines = answer ? `${answer.content}\n\n${line}` : line;

    return [...(answer ? items.slice(0, -1) : [...items, { id: crypto.randomUUID(), role: 'user', content: 'Explain it slowly' }]), { id: answer?.id ?? crypto.randomUUID(), role: 'assistant', streaming: true, content: lines }];
  });
};
render(() => <div style={{ height: '500px', display: 'flex' }}>
  <ChatView readOnly messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: streaming(), messageCount: messages().length }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}} />
</div>, document.getElementById('root'));
