import { render } from 'solid-js/web';
import { createSignal, Show } from 'solid-js';
import { ChatView } from '../../clients/ui/components/ChatView';
import '../../clients/ui/styles.css';

const [messages, setMessages] = createSignal(Array.from({ length: 30 }, (_, index) => ({ id: String(index), role: 'user', content: `Prompt ${index}\n`.repeat(8) })));
const [shown, setShown] = createSignal(true);
const noop = () => {};
const transport = { subscribe: () => noop, hasSentMessage: () => true, currentHostId: () => 'local', currentCwd: () => undefined, ownsConversation: () => true, isConnected: () => true, newChatWorktreeOptions: () => undefined, onDispose: () => noop };

window.setShown = setShown;
window.appendMessage = () => setMessages(items => [...items, { id: String(items.length), role: 'user', content: 'Another prompt\n'.repeat(10) }]);

render(() => <div style={{ height: '500px', display: 'flex' }}><Show when={shown()}>
  <ChatView transport={transport as never} messages={messages()} state={{ model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'scroll', messageCount: messages().length, pendingMessageCount: 0 }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}}
    onSend={noop} onAbort={noop} onOpenProject={noop} onBranch={noop} onModel={noop} onToggleFastMode={noop} onThinking={noop} />
</Show></div>, document.getElementById('app'));
