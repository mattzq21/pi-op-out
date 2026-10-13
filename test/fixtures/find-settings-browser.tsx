import './find-in-page-browser';
import { render } from 'solid-js/web';
import { SettingsView } from '../../clients/ui/components/SettingsView';

render(() => <SettingsView scope="client" settings={{
  defaultAgent: 'general', defaultModel: '', hiddenModels: [], defaultThinking: 'off', defaultFastMode: false,
  contextWindowCap: 10000, contextWindowCapEnabled: false, autoCompaction: true, autoRetry: true,
  debugMode: false, tools: [], skills: [], hosts: [],
  keybindings: { newConversation: 'Ctrl+N', toggleConversations: 'Ctrl+B', toggleTerminal: 'Ctrl+J', toggleDebugMode: 'Ctrl+D', focusComposer: 'Ctrl+E', openSettings: 'Ctrl+,' },
}} onSave={async () => {}} />, document.getElementById('sample')!);
