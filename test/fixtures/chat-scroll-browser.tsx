import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { ChatView } from '../../clients/ui/components/ChatView';
import '../../clients/ui/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 25 }, (_, index) => ({ id: crypto.randomUUID(), role: 'user', content: `Earlier message ${index}` })));
window.appendScrollMessage = () => setMessages(items => [...items, { id: crypto.randomUUID(), role: 'assistant', content: 'More output\n\n'.repeat(15) }]);
render(() => <div style={{ height: '500px', display: 'flex' }}>
  <ChatView readOnly messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: false, messageCount: messages().length }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}} />
</div>, document.getElementById('root'));
