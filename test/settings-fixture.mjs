export function appSettings(extra = {}) {
  return {
    defaultModel: '', hiddenModels: [], knownModels: [],
    defaultThinking: 'off', defaultFastMode: false, contextWindowCap: 0,
    contextWindowCapEnabled: false, autoRetry: true, debugMode: false,
    keybindings: { newConversation: '', toggleConversations: '', toggleTerminal: '', toggleDebugMode: '', focusComposer: '', openSettings: '' },
    tools: [], skills: [], hosts: [], ...extra,
  };
}
