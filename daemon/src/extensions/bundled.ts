import agentCommands from '../../resources/agent-commands.json?raw';
import runtimeBridge from '../../resources/pi-runtime/bridge.ts?node-program' with { type: 'text' };
import providerSdk from '../../resources/pi-runtime/provider-sdk.ts?node-program' with { type: 'text' };
import ocx from '../../../pi-extensions/piop-ocx-provider/index.ts?pi-extension' with { type: 'text' };
import providersRefresh from '../../../pi-extensions/piop-providers-refresh/index.ts?pi-extension' with { type: 'text' };
import mcp from '../../resources/mcp/extension.ts?pi-extension' with { type: 'text' };
import storage from '../../resources/piop-storage/extension.ts?pi-extension' with { type: 'text' };
import hooks from '../../resources/hooks-extended/extension.ts?pi-extension' with { type: 'text' };
import controls from '../../resources/piop-controls/extension.ts?pi-extension' with { type: 'text' };
import broker from '../../resources/session-broker/extension.ts?pi-extension' with { type: 'text' };
import compactionTiming from '../../../pi-extensions/piop-compaction-timing/index.ts?pi-extension' with { type: 'text' };
import contextWindowCap from '../../../pi-extensions/piop-context-window-cap/index.ts?pi-extension' with { type: 'text' };
import contextBar from '../../../pi-extensions/piop-context-bar/index.ts?pi-extension' with { type: 'text' };
import fastMode from '../../../pi-extensions/piop-openai-fast-mode/src/index.ts?pi-extension' with { type: 'text' };
import openaiCacheFork from '../../../pi-extensions/piop-openai-cache-fork/index.ts?pi-extension' with { type: 'text' };
import definedAgents from '../../../pi-extensions/piop-define-agents/index.ts?pi-extension' with { type: 'text' };
import skills from '../../resources/skills/extension.ts?pi-extension' with { type: 'text' };

export { agentCommands, runtimeBridge, providerSdk };

export const CORE_EXTENSIONS = {
  ocx, providersRefresh, mcp, storage, hooks, controls, broker, compactionTiming,
  contextWindowCap, contextBar, fastMode, openaiCacheFork, definedAgents, skills,
};
