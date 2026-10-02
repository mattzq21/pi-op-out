import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { ChatView } from '../../src/components/ChatView';
import '../../src/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: 'user', content: 'Hello' })));
const noop = () => {};
window.appendMessage = () => setMessages(items => [...items, { id: String(items.length), role: 'user', content: 'Another prompt\n'.repeat(10) }]);
render(() => <div style={{ height: '500px', display: 'flex' }}>
  <ChatView messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'scroll', messageCount: messages().length, pendingMessageCount: 0 }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}}
    onSend={window.appendMessage} onAbort={noop} onPause={noop} onResume={noop} onOpenProject={noop}
    onBranch={noop} onModel={noop} onToggleFastMode={noop} onThinking={noop} />
</div>, document.getElementById('app'));
