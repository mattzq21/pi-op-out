import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { emit } from '@tauri-apps/api/event';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createPluginWorkspace } from '../../clients/ui/plugins/workspace';
import { ComposerPlugins, ComposerPluginsContext } from '../../clients/ui/plugins/composer';
import { waitForClientPlugins } from '../../clients/ui/plugins/lifecycle';

mockWindows('main');
mockIPC((command, args: any) => {
  if (command === 'daemon_invoke') ({ command, args } = args);
  return window.nativeCommand(command, args);
}, { shouldMockEvents: true });
(window as any).nativeEvent = (name: string, payload: unknown) => emit(name, payload);
(window as any).pluginsSettled = (hostId: string) => waitForClientPlugins(hostId);

function Draft() {
  const [hostId, setHostId] = createSignal('local');
  (window as any).chooseHost = setHostId;
  const workspace = createPluginWorkspace(() => ({ hostId: hostId(), sessionId: '', messageCount: 0, title: 'New chat', messages: [] }));
  const [draft, setDraft] = createSignal('Unsent words');
  return <ComposerPluginsContext.Provider value={workspace.composers}>
    <main><ComposerPlugins disabled={false} onText={text => setDraft(value => value + ' ' + text)} /><p aria-label="Draft">{draft()}</p></main>
  </ComposerPluginsContext.Provider>;
}

render(() => <Draft />, document.getElementById('root')!);
