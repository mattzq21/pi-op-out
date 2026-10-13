import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { Message } from '../../clients/ui/components/Message';
import '../../clients/ui/styles.css';

mockWindows('main');
mockIPC((command, args) => window.nativeCommand(command, args));
const content = await window.messageContent();
render(() => <main style={{ width: '700px', margin: '80px auto' }}>
  <Message message={{ id: 'answer', role: 'assistant', content }} />
</main>, document.getElementById('root')!);
