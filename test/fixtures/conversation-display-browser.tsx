import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ChatView } from '../../clients/ui/components/ChatView';
import { debugView } from '../../clients/ui/lib/debugFeatures';
import '../../clients/ui/styles.css';

const [debug, setDebug] = createSignal(false);
const messages = await window.conversationMessages();
render(() => <main style={{ height: '650px', width: '800px', display: 'flex', 'flex-direction': 'column' }}>
  <label><input type="checkbox" checked={debug()} onChange={event => setDebug(event.currentTarget.checked)} />Debug view</label>
  <ChatView readOnly messages={messages} debug={debugView({ debugMode: debug() })}
    state={{ model: null, thinkingLevel: 'off', isStreaming: false, messageCount: messages.length }}
    models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}} />
</main>, document.getElementById('root')!);
