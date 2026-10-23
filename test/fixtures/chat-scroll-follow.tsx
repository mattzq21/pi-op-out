import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { ChatView } from '../../clients/ui/components/ChatView';
import '../../clients/ui/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: 'user', content: 'Hello' })));

const noop = () => {};

const [streaming, setStreaming] = createSignal(false);

const [activity, setActivity] = createSignal<string>();

window.startResponse = () => {
  setStreaming(true);
  setActivity('Working');
  setMessages(items => [...items, { id: 'stream-user', role: 'user', content: 'Write 40 lines' }, { id: 'stream-answer', role: 'assistant', streaming: true, content: Array.from({ length: 40 }, (_, i) => `${i + 1}. This is a scrolling test.`).join('\n') }]);
};

window.finishResponse = () => {
  setMessages(items => items.map(item => item.id === 'stream-answer' ? { ...item, streaming: false, stopReason: 'stop' } : item));
  setStreaming(false);
  setActivity(undefined);
};

window.appendMessage = () => setMessages(items => [...items, { id: String(items.length), role: 'user', content: 'Another prompt\n'.repeat(10) }]);

window.appendResponse = () => setMessages(items => [...items, { id: String(items.length), role: 'assistant', content: 'Response complete' }]);

render(() => <div style={{ height: '500px', display: 'flex' }}>
  <ChatView messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: streaming(), activity: activity(), sessionId: 'scroll', messageCount: messages().length, pendingMessageCount: 0 }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}}
    onSend={window.appendMessage} onAbort={noop} onPause={noop} onResume={noop} onOpenProject={noop}
    onBranch={noop} onModel={noop} onToggleFastMode={noop} onThinking={noop} />
</div>, document.getElementById('app'));
