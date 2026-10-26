import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { ChatView } from '../../clients/ui/components/ChatView';
import '../../clients/ui/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 12 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content: 'Message ' + index + '\n\n' + 'Some longer text. '.repeat(30) })));
const noop = () => {};
const [streaming, setStreaming] = createSignal(false);
window.setStreaming = setStreaming;
window.appendMessage = () => setMessages(items => [...items, { id: String(items.length), role: 'assistant', content: 'More output\n\n'.repeat(10) }]);
render(() => <div class="app" style={{ height: '600px', display: 'flex' }}>
  <ChatView messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: streaming(), sessionId: 'jump', messageCount: messages().length, pendingMessageCount: 0 }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}}
    onSend={noop} onAbort={noop} onOpenProject={noop}
    onBranch={noop} onModel={noop} onToggleFastMode={noop} onThinking={noop} />
</div>, document.getElementById('root')!);
