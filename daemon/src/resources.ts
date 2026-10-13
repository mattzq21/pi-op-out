import fileLockSource from '../resources/file-lock.cjs?raw';
import sessionDatabase from '../resources/session-database.cjs?raw';
import appSettingsCjs from '../resources/session-broker/app-settings.cjs?raw';
import transcriptReferences from '../resources/transcript-references.cjs?raw';
import sdkStorageRaw from '../resources/sdk-storage.mjs?raw';
import agentCommands from '../resources/agent-commands.json?raw';
import sdkStorageBundleRaw from '../resources/sdk-storage.bundle.mjs?raw';
import providerSdk from '../resources/provider-sdk.mjs?raw';
import fastModelDiscovery from '../resources/fast-model-discovery.mjs?raw';
import chatgptStream from '../resources/chatgpt-stream.mjs?raw';
import chatgptStorageRaw from '../resources/chatgpt-storage.mjs?raw';
import chatgptService from '../resources/chatgpt-service.mjs?raw';
import reviewPrompt from '../resources/piop-reviews/review-prompt.txt?raw';
import sessionBroker from '../resources/session-broker.ts?raw';
import sdkSessionList from '../resources/sdk-session-list.mjs?raw';
import runtimeConfiguration from '../resources/runtime-configuration.cjs?raw';
import runtimeBridge from '../resources/runtime-bridge.cjs?raw';
import mcpSchemaBundle from '../resources/mcp-schema.bundle.mjs?raw';
import mcpBridgeBundle from '../resources/mcp-bridge.bundle.mjs?raw';
import fastModeBundle from '../resources/fast-mode.bundle.mjs?raw';
import userQuestionsExtension from '../../extensions/piop-user-questions/index.ts?raw';
import userQuestionsInterface from '../../extensions/piop-user-questions/interface.ts?raw';
import userQuestionsLogic from '../../extensions/piop-user-questions/questions.ts?raw';
import sessionCostLimitExtension from '../../extensions/piop-session-cost-limit/index.ts?raw';
import runtimeSettingsExtension from '../../extensions/piop-runtime-settings/index.ts?raw';
import rtkExtension from '../../extensions/piop-rtk/rtk.ts?raw';
import openaiCacheForkExtension from '../../extensions/piop-openai-cache-fork/index.ts?raw';
import agentState from '../../extensions/piop-define-agents/state.ts?raw';
import agentPromptsRaw from '../../extensions/piop-define-agents/prompts.ts?raw';
import agentProfiles from '../../extensions/piop-define-agents/profiles.ts?raw';
import agentMcpConfig from '../../extensions/piop-define-agents/mcp-config.ts?raw';
import definedAgentsExtension from '../../extensions/piop-define-agents/index.ts?raw';
import agentExtensionLoader from '../../extensions/piop-define-agents/extension-loader.ts?raw';
import agentExcalidraw from '../../extensions/piop-define-agents/excalidraw.ts?raw';
import agentDaemonDefinitions from '../../extensions/piop-define-agents/daemon-definitions.ts?raw';
import agentFastModels from '../../extensions/piop-define-agents/fast-models.ts?raw';
import contextWindowCapExtension from '../../extensions/piop-context-window-cap/index.ts?raw';
import contextWindowCapInterface from '../../extensions/piop-context-window-cap/interface.ts?raw';
import contextBarExtension from '../../extensions/piop-context-bar/index.ts?raw';
import codexWebSearchExtension from '../../extensions/piop-codex-web-search/index.ts?raw';
import excalidrawSkill from '../../extensions/piop-excalidraw/SKILL.md?raw';
import excalidrawCheatsheet from '../../extensions/piop-excalidraw/references/cheatsheet.md?raw';
import brokerModule0 from '../resources/session-broker/goal-directory-recovery.cjs?raw';
import brokerModule1 from '../resources/session-broker/subagent-usage-storage.cjs?raw';
import brokerModule2 from '../resources/session-broker/app-settings.cjs?raw';
import brokerModule4 from '../resources/session-broker/client.ts?raw';
import brokerModule5 from '../resources/session-broker/conversation-location.ts?raw';
import brokerModule7 from '../resources/session-broker/fast-mode.ts?raw';
import brokerModuleContextCap from '../resources/session-broker/context-cap.ts?raw';
import brokerModule8 from '../resources/session-broker/session-file.ts?raw';
import brokerModule9 from '../resources/session-broker/session-child-index.cjs?raw';
import brokerModule10 from '../resources/session-broker/session-child-index.d.cts?raw';
import brokerModule11 from '../resources/session-broker/session-publication.cjs?raw';
import brokerModule12Raw from '../resources/session-broker/session-publication-io.cjs?raw';
import brokerModule13 from '../resources/session-broker/session-publication-dependencies.cjs?raw';
import brokerModule14 from '../resources/session-broker/review-publication.cjs?raw';
import brokerModule15 from '../resources/session-broker/session-publication.d.cts?raw';
import brokerModule17 from '../resources/session-broker/subagents.ts?raw';
import brokerModule18 from '../resources/session-broker/subagent-state.ts?raw';
import brokerModule19 from '../resources/session-broker/subagent-reconciliation.ts?raw';
import brokerModule20 from '../resources/session-broker/subagent-transcript.ts?raw';
import brokerModule21 from '../resources/session-broker/orchestration.ts?raw';
import brokerModule22 from '../resources/session-broker/durable-mailbox.ts?raw';
import brokerModule23 from '../resources/session-broker/agent-profiles.ts?raw';
import brokerModule24 from '../resources/session-broker/subagent-usage.ts?raw';
import brokerModule25Raw from '../resources/session-broker/subagent-usage-channel.ts?raw';
import brokerModule26 from '../resources/session-broker/subagent-mailbox.ts?raw';
import brokerModule27 from '../resources/session-broker/subagent-results.ts?raw';
import brokerModule28 from '../resources/session-broker/subagent-recovery.ts?raw';
import brokerModule29 from '../resources/session-broker/subagent-identity.ts?raw';
import brokerModule32 from '../resources/session-broker/html-preview.ts?raw';
import brokerModule36 from '../resources/session-broker/goal-storage.cjs?raw';
import brokerModule39Raw from '../resources/session-broker/reference-publication-lock.cjs?raw';
import brokerModule41 from '../resources/session-broker/goal-dependencies.cjs?raw';
import brokerModule42 from '../resources/session-broker/goal-prepared-files.cjs?raw';
import brokerModule43 from '../resources/session-broker/goal-preparations.cjs?raw';
import brokerModule44 from '../resources/session-broker/goal-ownership.cjs?raw';
import brokerModule45Raw from '../resources/session-broker/goal-assets.cjs?raw';
import controlsIndex from '../resources/piop-controls/index.ts?raw';
import controlsInterface from '../resources/piop-controls/interface.ts?raw';
import controlsPause from '../resources/piop-controls/pause.ts?raw';
import controlsFork from '../resources/piop-controls/fork.ts?raw';
import controlsCommands from '../resources/piop-controls/commands.ts?raw';
import controlsFastMode from '../resources/piop-controls/fast-mode.ts?raw';
import goalsIndex from '../resources/piop-goals/index.ts?raw';
import goalsInterface from '../resources/piop-goals/interface.ts?raw';
import goalsGoals from '../resources/piop-goals/goals.ts?raw';
import goalsState from '../resources/piop-goals/state.ts?raw';
import goalsPreparation from '../resources/piop-goals/preparation.ts?raw';
import goalsFilesRaw from '../resources/piop-goals/files.ts?raw';
import goalsPrompts from '../resources/piop-goals/prompts.ts?raw';
import goalsCoordination from '../resources/piop-goals/coordination.ts?raw';
import goalsTools from '../resources/piop-goals/tools.ts?raw';
import goalsCommands from '../resources/piop-goals/commands.ts?raw';
import reviewsIndex from '../resources/piop-reviews/index.ts?raw';
import reviewsInterface from '../resources/piop-reviews/interface.ts?raw';
import reviewsReviews from '../resources/piop-reviews/reviews.ts?raw';
import reviewsCommands from '../resources/piop-reviews/commands.ts?raw';


const bunEnvironment = 'process.env.PIOP_BUN = ' + JSON.stringify(process.execPath) + ';\n';
const sdkStorageBundle = bunEnvironment + sdkStorageBundleRaw;
const fileLockModule = fileLockSource
  .replace("const { spawn, spawnSync } = require('node:child_process');", "import { spawn, spawnSync } from 'node:child_process';")
  .replace('module.exports = { lockSync, lock, bunExecutable, shellLock };', 'export { lockSync, lock, bunExecutable, shellLock };');
const fileLockUrl = 'data:text/javascript;base64,' + Buffer.from(fileLockModule).toString('base64');
function embedFileLock(source: string): string {
  return source
    .replace(/from ["'][^"']*file-lock\.cjs["']/g, 'from ' + JSON.stringify(fileLockUrl))
    .replace(/require\(['"][^'"]*file-lock\.cjs['"]\)/g, () => '(function () { const module = { exports: {} }; ' + fileLockSource + '; return module.exports; })()');
}
const sdkStorage = embedFileLock(sdkStorageRaw);
const chatgptStorage = bunEnvironment + embedFileLock(chatgptStorageRaw);
const agentPrompts = embedFileLock(agentPromptsRaw);
const brokerModule12 = embedFileLock(brokerModule12Raw);
const brokerModule25 = embedFileLock(brokerModule25Raw);
const brokerModule39 = embedFileLock(brokerModule39Raw);
const brokerModule45 = embedFileLock(brokerModule45Raw);
const goalsFiles = embedFileLock(goalsFilesRaw);

export {
  sessionDatabase,
  appSettingsCjs,
  transcriptReferences,
  sdkStorage,
  agentCommands,
  sdkStorageBundle,
  providerSdk,
  fastModelDiscovery,
  chatgptStream,
  chatgptStorage,
  chatgptService,
  reviewPrompt,
  sessionBroker,
  sdkSessionList,
  runtimeConfiguration,
  runtimeBridge,
  mcpSchemaBundle,
  mcpBridgeBundle,
  fastModeBundle,
  userQuestionsExtension,
  userQuestionsInterface,
  userQuestionsLogic,
  sessionCostLimitExtension,
  runtimeSettingsExtension,
  rtkExtension,
  openaiCacheForkExtension,
  agentState,
  agentPrompts,
  agentProfiles,
  agentMcpConfig,
  definedAgentsExtension,
  agentExtensionLoader,
  agentExcalidraw,
  agentDaemonDefinitions,
  agentFastModels,
  contextWindowCapExtension,
  contextWindowCapInterface,
  contextBarExtension,
  codexWebSearchExtension,
  excalidrawSkill,
  excalidrawCheatsheet,
};

export const SESSION_BROKER_MODULES: Array<[string, string]> = [
  ['goal-directory-recovery.cjs', brokerModule0],
  ['subagent-usage-storage.cjs', brokerModule1],
  ['app-settings.cjs', brokerModule2],
  ['client.ts', brokerModule4],
  ['conversation-location.ts', brokerModule5],
  ['fast-mode.ts', brokerModule7],
  ['context-cap.ts', brokerModuleContextCap],
  ['session-file.ts', brokerModule8],
  ['session-child-index.cjs', brokerModule9],
  ['session-child-index.d.cts', brokerModule10],
  ['session-publication.cjs', brokerModule11],
  ['session-publication-io.cjs', brokerModule12],
  ['session-publication-dependencies.cjs', brokerModule13],
  ['review-publication.cjs', brokerModule14],
  ['session-publication.d.cts', brokerModule15],
  ['subagents.ts', brokerModule17],
  ['subagent-state.ts', brokerModule18],
  ['subagent-reconciliation.ts', brokerModule19],
  ['subagent-transcript.ts', brokerModule20],
  ['orchestration.ts', brokerModule21],
  ['durable-mailbox.ts', brokerModule22],
  ['agent-profiles.ts', brokerModule23],
  ['subagent-usage.ts', brokerModule24],
  ['subagent-usage-channel.ts', brokerModule25],
  ['subagent-mailbox.ts', brokerModule26],
  ['subagent-results.ts', brokerModule27],
  ['subagent-recovery.ts', brokerModule28],
  ['subagent-identity.ts', brokerModule29],
  ['html-preview.ts', brokerModule32],
  ['goal-storage.cjs', brokerModule36],
  ['reference-publication-lock.cjs', brokerModule39],
  ['goal-dependencies.cjs', brokerModule41],
  ['goal-prepared-files.cjs', brokerModule42],
  ['goal-preparations.cjs', brokerModule43],
  ['goal-ownership.cjs', brokerModule44],
  ['goal-assets.cjs', brokerModule45],
];

export const EXCALIDRAW_ASSETS: Array<[string, string]> = [
  ['SKILL.md', excalidrawSkill],
  ['references/cheatsheet.md', excalidrawCheatsheet],
];

/** Session extensions installed next to session-broker. Each directory holds one extension with index.ts as its entry. */
export const SESSION_EXTENSIONS: Array<[string, Array<[string, string]>]> = [
  ['piop-controls', [
    ['interface.ts', controlsInterface], ['pause.ts', controlsPause], ['fork.ts', controlsFork],
    ['commands.ts', controlsCommands], ['fast-mode.ts', controlsFastMode], ['index.ts', controlsIndex],
  ]],
  ['piop-goals', [
    ['interface.ts', goalsInterface], ['state.ts', goalsState], ['prompts.ts', goalsPrompts], ['coordination.ts', goalsCoordination],
    ['files.ts', goalsFiles], ['preparation.ts', goalsPreparation], ['goals.ts', goalsGoals], ['tools.ts', goalsTools],
    ['commands.ts', goalsCommands], ['index.ts', goalsIndex],
  ]],
  ['piop-reviews', [
    ['interface.ts', reviewsInterface], ['review-prompt.txt', reviewPrompt], ['reviews.ts', reviewsReviews],
    ['commands.ts', reviewsCommands], ['index.ts', reviewsIndex],
  ]],
];
