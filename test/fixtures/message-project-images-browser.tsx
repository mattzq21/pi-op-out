import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { Message } from '../../clients/ui/components/Message';
import { MessageFileContext } from '../../clients/ui/lib/messageFiles';
import { ConversationImageProject } from '../../clients/ui/components/markdownImages';
import '../../clients/ui/styles.css';

mockWindows('main');
mockIPC((command, args: any) => {
  if (command === 'daemon_invoke') ({ command, args } = args);
  return window.nativeCommand(command, args);
});
const content = await window.messageContent();
render(() => <main style={{ width: '700px', margin: '80px auto' }}>
  <ConversationImageProject.Provider value={() => ({ cwd: '/work/project', hostId: 'server' })}>
    <MessageFileContext.Provider value={{ hostId: () => "server", cwd: () => "/work/project" }}>
    <Message message={{ id: 'answer', role: 'assistant', content }} />
    </MessageFileContext.Provider>
  </ConversationImageProject.Provider>
</main>, document.getElementById('root')!);
