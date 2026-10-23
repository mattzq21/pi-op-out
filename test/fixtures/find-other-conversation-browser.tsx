import './find-in-page-browser';
import { render } from 'solid-js/web';
import { ChatView } from '../../clients/ui/components/ChatView';

render(() => <ChatView readOnly={true} state={{ isStreaming: false, messageCount: 1 }}
  messages={[{ id: 'other-question', role: 'user', content: 'Another conversation' }]}
  models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}} />,
document.getElementById('sample')!);
