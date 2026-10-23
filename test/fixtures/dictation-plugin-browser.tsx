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
/** Sends an event as the native side or the daemon does. */
(window as any).nativeEvent = (name: string, payload: unknown) => emit(name, payload);
/** Resolves when the workspace has applied the plugin setup of the host. */
(window as any).pluginsSettled = (hostId: string) => waitForClientPlugins(hostId);

/** A draft with the composer plugin tools, as the app wires them: the plugin workspace runs the enabled plugins and gives their composer tools to the composer. */
function Draft() {
  const [hostId, setHostId] = createSignal('local');
  /** Opens a new chat on another agent host. */
  (window as any).chooseHost = setHostId;
  const workspace = createPluginWorkspace(() => ({ hostId: hostId(), sessionId: '', messageCount: 0, title: 'New chat', messages: [] }), () => true, () => {});
  const [draft, setDraft] = createSignal('Unsent words');
  return <ComposerPluginsContext.Provider value={workspace.composers}>
    <main><ComposerPlugins disabled={false} onText={text => setDraft(value => value + ' ' + text)} /><p aria-label="Draft">{draft()}</p></main>
  </ComposerPluginsContext.Provider>;
}

render(() => <Draft />, document.getElementById('root')!);
