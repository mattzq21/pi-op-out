import sessionDatabase from '../resources/session-database.cjs?raw';
import appSettingsCjs from '../resources/session-broker/app-settings.cjs?raw';
import relocateSessionBundle from '../resources/relocate-session.bundle.mjs?raw';
import transcriptReferences from '../resources/transcript-references.cjs?raw';
import sdkStorage from '../resources/sdk-storage.mjs?raw';
import sessionRegistryBundle from '../resources/session-registry.bundle.mjs?raw';
import agentCommands from '../resources/agent-commands.json?raw';
import goalDependencies from '../resources/session-broker/goal-dependencies.cjs?raw';
import sdkStorageBundle from '../resources/sdk-storage.bundle.mjs?raw';
import providerSdk from '../resources/provider-sdk.mjs?raw';
import fastCapabilities from '../resources/fast-capabilities.mjs?raw';
import chatgptStream from '../resources/chatgpt-stream.mjs?raw';
import chatgptStorage from '../resources/chatgpt-storage.mjs?raw';
import chatgptService from '../resources/chatgpt-service.mjs?raw';
import agentDefinitionsBundle from '../resources/agent-definitions.bundle.mjs?raw';
import reviewPrompt from '../resources/session-broker/review-prompt.txt?raw';
import temporaryChat from '../resources/temporary-chat.cjs?raw';
import indexSessionsBundle from '../resources/index-sessions.bundle.mjs?raw';
import traceReader from '../resources/trace-reader.ts?raw';
import sessionBroker from '../resources/session-broker.ts?raw';
import sdkSessionList from '../resources/sdk-session-list.mjs?raw';
import runtimeConfiguration from '../resources/runtime-configuration.cjs?raw';
import runtimeBridge from '../resources/runtime-bridge.cjs?raw';
import mcpSchemaBundle from '../resources/mcp-schema.bundle.mjs?raw';
import mcpBridgeBundle from '../resources/mcp-bridge.bundle.mjs?raw';
import fastModeBundle from '../resources/fast-mode.bundle.mjs?raw';
import askUser from '../resources/ask-user.ts?raw';
import storageInventoryBundle from '../resources/storage-inventory.bundle.mjs?raw';
import sessionDescendantsBundle from '../resources/session-descendants.bundle.mjs?raw';
import recoverMissingSessionBundle from '../resources/recover-missing-session.bundle.mjs?raw';
import sessionCostLimitExtension from '../../extensions/piop-session-cost-limit/index.ts?raw';
import runtimeSettingsExtension from '../../extensions/piop-runtime-settings/index.ts?raw';
import rtkExtension from '../../extensions/piop-rtk/rtk.ts?raw';
import openaiCacheForkExtension from '../../extensions/piop-openai-cache-fork/index.ts?raw';
import diagramsExtension from '../../extensions/piop-diagrams/index.ts?raw';
import agentState from '../../extensions/piop-define-agents/state.ts?raw';
import agentPrompts from '../../extensions/piop-define-agents/prompts.ts?raw';
import agentProfiles from '../../extensions/piop-define-agents/profiles.ts?raw';
import agentMcpConfig from '../../extensions/piop-define-agents/mcp-config.ts?raw';
import definedAgentsExtension from '../../extensions/piop-define-agents/index.ts?raw';
import agentExtensionLoader from '../../extensions/piop-define-agents/extension-loader.ts?raw';
import agentExcalidraw from '../../extensions/piop-define-agents/excalidraw.ts?raw';
import agentDaemonDefinitions from '../../extensions/piop-define-agents/daemon-definitions.ts?raw';
import contextWindowCapExtension from '../../extensions/piop-context-window-cap/index.ts?raw';
import contextBarExtension from '../../extensions/piop-context-bar/index.ts?raw';
import codexWebSearchExtension from '../../extensions/piop-codex-web-search/index.ts?raw';
import loopDetectionIndex from '../../extensions/piop-loop-detection/index.ts?raw';
import loopDetectionDetector from '../../extensions/piop-loop-detection/detector.ts?raw';
import loopDetectionObservations from '../../extensions/piop-loop-detection/observations.ts?raw';
import loopDetectionPersistence from '../../extensions/piop-loop-detection/persistence.ts?raw';
import loopDetectionStorage from '../../extensions/piop-loop-detection/storage.cjs?raw';
import excalidrawSkill from '../../extensions/piop-excalidraw/SKILL.md?raw';
import excalidrawCheatsheet from '../../extensions/piop-excalidraw/references/cheatsheet.md?raw';
import brokerModule0 from '../resources/session-broker/goal-directory-recovery.cjs?raw';
import brokerModule1 from '../resources/session-broker/subagent-usage-storage.cjs?raw';
import brokerModule2 from '../resources/session-broker/app-settings.cjs?raw';
import brokerModule3 from '../resources/session-broker/review-prompt.txt?raw';
import brokerModule4 from '../resources/session-broker/client.ts?raw';
import brokerModule5 from '../resources/session-broker/conversation-location.ts?raw';
import brokerModule6 from '../resources/session-broker/pause.ts?raw';
import brokerModule7 from '../resources/session-broker/fast-mode.ts?raw';
import brokerModule8 from '../resources/session-broker/session-file.ts?raw';
import brokerModule9 from '../resources/session-broker/session-child-index.cjs?raw';
import brokerModule10 from '../resources/session-broker/session-child-index.d.cts?raw';
import brokerModule11 from '../resources/session-broker/session-publication.cjs?raw';
import brokerModule12 from '../resources/session-broker/session-publication-io.cjs?raw';
import brokerModule13 from '../resources/session-broker/session-publication-dependencies.cjs?raw';
import brokerModule14 from '../resources/session-broker/review-publication.cjs?raw';
import brokerModule15 from '../resources/session-broker/session-publication.d.cts?raw';
import brokerModule16 from '../resources/session-broker/fork.ts?raw';
import brokerModule17 from '../resources/session-broker/subagents.ts?raw';
import brokerModule18 from '../resources/session-broker/subagent-state.ts?raw';
import brokerModule19 from '../resources/session-broker/subagent-reconciliation.ts?raw';
import brokerModule20 from '../resources/session-broker/subagent-transcript.ts?raw';
import brokerModule21 from '../resources/session-broker/orchestration.ts?raw';
import brokerModule22 from '../resources/session-broker/durable-mailbox.ts?raw';
import brokerModule23 from '../resources/session-broker/agent-profiles.ts?raw';
import brokerModule24 from '../resources/session-broker/subagent-usage.ts?raw';
import brokerModule25 from '../resources/session-broker/subagent-usage-channel.ts?raw';
import brokerModule26 from '../resources/session-broker/subagent-mailbox.ts?raw';
import brokerModule27 from '../resources/session-broker/subagent-results.ts?raw';
import brokerModule28 from '../resources/session-broker/subagent-recovery.ts?raw';
import brokerModule29 from '../resources/session-broker/subagent-identity.ts?raw';
import brokerModule30 from '../resources/session-broker/operations.ts?raw';
import brokerModule31 from '../resources/session-broker/tools.ts?raw';
import brokerModule32 from '../resources/session-broker/html-preview.ts?raw';
import brokerModule33 from '../resources/session-broker/goals.ts?raw';
import brokerModule34 from '../resources/session-broker/review.ts?raw';
import brokerModule35 from '../resources/session-broker/goal-state.ts?raw';
import brokerModule36 from '../resources/session-broker/goal-storage.cjs?raw';
import brokerModule37 from '../resources/session-broker/goal-controls.ts?raw';
import brokerModule38 from '../resources/session-broker/goal-coordination.ts?raw';
import brokerModule39 from '../resources/session-broker/reference-publication-lock.cjs?raw';
import brokerModule40 from '../resources/session-broker/goal-files.ts?raw';
import brokerModule41 from '../resources/session-broker/goal-dependencies.cjs?raw';
import brokerModule42 from '../resources/session-broker/goal-prepared-files.cjs?raw';
import brokerModule43 from '../resources/session-broker/goal-preparations.cjs?raw';
import brokerModule44 from '../resources/session-broker/goal-ownership.cjs?raw';
import brokerModule45 from '../resources/session-broker/goal-assets.cjs?raw';
import brokerModule46 from '../resources/session-broker/goal-prompts.ts?raw';

export {
  storageInventoryBundle,
  sessionDescendantsBundle,
  recoverMissingSessionBundle,
  sessionDatabase,
  appSettingsCjs,
  relocateSessionBundle,
  transcriptReferences,
  sdkStorage,
  sessionRegistryBundle,
  agentCommands,
  goalDependencies,
  sdkStorageBundle,
  providerSdk,
  fastCapabilities,
  chatgptStream,
  chatgptStorage,
  chatgptService,
  agentDefinitionsBundle,
  reviewPrompt,
  temporaryChat,
  indexSessionsBundle,
  traceReader,
  sessionBroker,
  sdkSessionList,
  runtimeConfiguration,
  runtimeBridge,
  mcpSchemaBundle,
  mcpBridgeBundle,
  fastModeBundle,
  askUser,
  sessionCostLimitExtension,
  runtimeSettingsExtension,
  rtkExtension,
  openaiCacheForkExtension,
  diagramsExtension,
  agentState,
  agentPrompts,
  agentProfiles,
  agentMcpConfig,
  definedAgentsExtension,
  agentExtensionLoader,
  agentExcalidraw,
  agentDaemonDefinitions,
  contextWindowCapExtension,
  contextBarExtension,
  codexWebSearchExtension,
  loopDetectionIndex,
  loopDetectionDetector,
  loopDetectionObservations,
  loopDetectionPersistence,
  loopDetectionStorage,
  excalidrawSkill,
  excalidrawCheatsheet,
};

export const SESSION_BROKER_MODULES: Array<[string, string]> = [
  ['goal-directory-recovery.cjs', brokerModule0],
  ['subagent-usage-storage.cjs', brokerModule1],
  ['app-settings.cjs', brokerModule2],
  ['review-prompt.txt', brokerModule3],
  ['client.ts', brokerModule4],
  ['conversation-location.ts', brokerModule5],
  ['pause.ts', brokerModule6],
  ['fast-mode.ts', brokerModule7],
  ['session-file.ts', brokerModule8],
  ['session-child-index.cjs', brokerModule9],
  ['session-child-index.d.cts', brokerModule10],
  ['session-publication.cjs', brokerModule11],
  ['session-publication-io.cjs', brokerModule12],
  ['session-publication-dependencies.cjs', brokerModule13],
  ['review-publication.cjs', brokerModule14],
  ['session-publication.d.cts', brokerModule15],
  ['fork.ts', brokerModule16],
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
  ['operations.ts', brokerModule30],
  ['tools.ts', brokerModule31],
  ['html-preview.ts', brokerModule32],
  ['goals.ts', brokerModule33],
  ['review.ts', brokerModule34],
  ['goal-state.ts', brokerModule35],
  ['goal-storage.cjs', brokerModule36],
  ['goal-controls.ts', brokerModule37],
  ['goal-coordination.ts', brokerModule38],
  ['reference-publication-lock.cjs', brokerModule39],
  ['goal-files.ts', brokerModule40],
  ['goal-dependencies.cjs', brokerModule41],
  ['goal-prepared-files.cjs', brokerModule42],
  ['goal-preparations.cjs', brokerModule43],
  ['goal-ownership.cjs', brokerModule44],
  ['goal-assets.cjs', brokerModule45],
  ['goal-prompts.ts', brokerModule46],
];

export const LOOP_DETECTION_ASSETS: Array<[string, string]> = [
  ['index.ts', loopDetectionIndex],
  ['detector.ts', loopDetectionDetector],
  ['observations.ts', loopDetectionObservations],
  ['persistence.ts', loopDetectionPersistence],
  ['storage.cjs', loopDetectionStorage],
];

export const EXCALIDRAW_ASSETS: Array<[string, string]> = [
  ['SKILL.md', excalidrawSkill],
  ['references/cheatsheet.md', excalidrawCheatsheet],
];
