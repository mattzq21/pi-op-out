import './find-in-page-browser';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { SettingsView } from '../../clients/ui/components/SettingsView';

mockWindows('main');
mockIPC((command, args) => {
  if (command === 'daemon_invoke' && args.command === 'provider_auth') return { ready: true, providers: {} };
  throw new Error('Unexpected command: ' + command);
}, { shouldMockEvents: true });

render(() => <SettingsView scope="client" settings={{
  hiddenModels: [], defaultThinking: 'off', defaultFastMode: false,
  contextWindowCap: 100_000, modelContextWindowCaps: {}, contextWindowCapEnabled: false, autoCompaction: true, autoRetry: true,
  debugMode: false, tools: [], skills: [], hosts: [],
  keybindings: { newConversation: 'Ctrl+N', toggleConversations: 'Ctrl+B', toggleTerminal: 'Ctrl+J', toggleDebugMode: 'Ctrl+D', focusComposer: 'Ctrl+E', openSettings: 'Ctrl+,' },
}} onSave={async () => {}} />, document.getElementById('sample')!);
