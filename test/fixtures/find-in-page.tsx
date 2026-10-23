import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ChatView } from '../../clients/ui/components/ChatView';
import { FindInPage } from '../../clients/ui/components/FindInPage';

function SearchExample() {
  const [enabled, setEnabled] = createSignal(true);
  return <>
    <button onClick={() => setEnabled(value => !value)}>Toggle search</button>
    <main id="search-content" style={{ padding: '100px 30px' }}>
      <p>Alpha beta alpha</p>
      <button>Conversation focus</button>
    </main>
    <FindInPage selector="#search-content" scopeKey="example" enabled={enabled()} />
  </>;
}

function ConversationSearch() {
  const messages = [{ id: 'question', role: 'user', content: 'Find the historical marker' },
    { id: 'answer', role: 'assistant', content: 'Needle\n\n' + Array.from({ length: 80 }, (_, index) => `Paragraph ${index} in the conversation.`).join('\n\n') }];
  return <div id="conversation-example" style={{ height: '600px', display: 'flex' }}>
    <ChatView readOnly={location.search !== '?composer'} state={{ isStreaming: false, messageCount: 2, thinkingLevel: "off", model: null }} messages={messages}
      models={[]} commands={[]} thinkingLevels={[]} widgets={location.search === '?composer' ? ['Composer boundary'] : []} statuses={{}}
      onSend={() => {}} onAbort={() => {}} onPause={() => {}} onResume={() => {}}
      onOpenProject={() => {}} onBranch={() => {}} onModel={() => {}}
      onToggleFastMode={() => {}} onThinking={() => {}} />
    <FindInPage selector="#conversation-example > main" scopeKey="conversation" />
  </div>;
}

function HorizontalSearch() {
  return <>
    <main id="horizontal-search" tabindex="0" style={{ margin: '100px 40px', width: '300px', height: '100px', overflow: 'auto' }}>
      <pre>Needle{' '.repeat(200)}End</pre>
    </main>
    <FindInPage selector="#horizontal-search" scopeKey="horizontal" />
  </>;
}

if (location.search === '?composer') {
  mockWindows('main');
  mockIPC((command, args) => window.invokeNativeFromTest(command, args), { shouldMockEvents: true });
}

render(() => location.search === '?horizontal' ? <HorizontalSearch /> : location.search === '?conversation' || location.search === '?composer'  ? <ConversationSearch /> : <SearchExample />, document.getElementById('app')!);
