import sessionRegistry from "../resources/session-registry.cjs?raw";
import storageRecovery from "../resources/piop-storage/recovery.cjs?raw";
import storageIdentities from "../resources/piop-storage/identities.mjs?raw";
import storageBootstrap from "../resources/piop-storage/bootstrap.mjs?raw";
import storageIndex from "../resources/piop-storage/index.ts?raw";
import storageInterface from "../resources/piop-storage/interface.ts?raw";
import sessionStorageRaw from "../resources/piop-storage/session-storage.mjs?raw";
import storageFile from "../resources/storage-file.mjs?raw";
import agentResources from "../../extensions/piop-define-agents/resources.ts?raw";
import fileLockSource from '../resources/file-lock.cjs?raw';
import sessionDatabase from '../resources/session-database.cjs?raw';
import appSettingsCjs from '../resources/session-broker/app-settings.cjs?raw';
import transcriptReferences from '../resources/transcript-references.cjs?raw';
import sdkStorageRaw from '../resources/sdk-storage.mjs?raw';
import agentCommands from '../resources/agent-commands.json?raw';
import sdkStorageBundleRaw from '../resources/sdk-storage.bundle.mjs?raw';
import providerSdk from '../resources/provider-sdk.mjs?raw';
import fastModelDiscovery from '../resources/fast-model-discovery.mjs?raw';
import sessionBroker from '../resources/session-broker.ts?raw';
import hooksExtendedIndex from '../resources/hooks-extended/index.ts?raw';
import hooksExtendedInterface from '../resources/hooks-extended/interface.ts?raw';
import sdkSessionList from '../resources/sdk-session-list.mjs?raw';
import runtimeConfiguration from '../resources/runtime-configuration.cjs?raw';
import runtimeBridge from '../resources/runtime-bridge.cjs?raw';
import runtimeAvailability from '../resources/runtime-availability.cjs?raw';
import hooksAvailability from '../resources/hooks-extended/availability.ts?raw';
import mcpSchemaBundle from '../resources/mcp-schema.bundle.mjs?raw';
import mcpBridgeBundle from '../resources/mcp-bridge.bundle.mjs?raw';
import fastModeBundle from '../resources/fast-mode.bundle.mjs?raw';
import providersRefreshExtension from '../../extensions/piop-providers-refresh/index.ts?raw';
import openaiCacheForkExtension from '../../extensions/piop-openai-cache-fork/index.ts?raw';
import agentState from '../../extensions/piop-define-agents/state.ts?raw';
import agentPromptsRaw from '../../extensions/piop-define-agents/prompts.ts?raw';
import agentProfiles from '../../extensions/piop-define-agents/profiles.ts?raw';
import agentMcpConfig from '../../extensions/piop-define-agents/mcp-config.ts?raw';
import definedAgentsExtension from '../../extensions/piop-define-agents/index.ts?raw';
import agentExtensionLoader from '../../extensions/piop-define-agents/extension-loader.ts?raw';
import agentFastModels from '../../extensions/piop-define-agents/fast-models.ts?raw';
import contextWindowCapExtension from '../../extensions/piop-context-window-cap/index.ts?raw';
import contextWindowCapDefaults from '../../extensions/piop-context-window-cap/defaults.ts?raw';
import contextWindowCapInterface from '../../extensions/piop-context-window-cap/interface.ts?raw';
import contextBarExtension from '../../extensions/piop-context-bar/index.ts?raw';
import codexWebSearchExtension from '../../extensions/piop-codex-web-search/index.ts?raw';
import storageGoalRecovery from '../resources/piop-storage/goal-directory-recovery.cjs?raw';
import brokerModule2 from '../resources/session-broker/app-settings.cjs?raw';
import brokerModule4 from '../resources/session-broker/client.ts?raw';
import brokerModule5 from '../resources/session-broker/conversation-location.ts?raw';
import brokerModule7 from '../resources/session-broker/fast-mode.ts?raw';
import storagePublication from '../resources/piop-storage/session-file.ts?raw';
import brokerModule9 from '../resources/session-broker/session-child-index.cjs?raw';
import brokerModule10 from '../resources/session-broker/session-child-index.d.cts?raw';
import storagePublicationJournal from '../resources/piop-storage/session-publication.cjs?raw';
import storagePublicationIoRaw from '../resources/piop-storage/session-publication-io.cjs?raw';
import storagePublicationDependencies from '../resources/piop-storage/session-publication-dependencies.cjs?raw';
import storageReviews from '../resources/piop-storage/review-publication.cjs?raw';
import storagePublicationTypes from '../resources/piop-storage/session-publication.d.cts?raw';
import brokerModule17 from '../resources/session-broker/subagents.ts?raw';
import brokerModule18 from '../resources/session-broker/subagent-state.ts?raw';
import brokerModule19 from '../resources/session-broker/subagent-reconciliation.ts?raw';
import brokerModule21 from '../resources/session-broker/orchestration.ts?raw';
import brokerInputHold from '../resources/session-broker/input-hold.ts?raw';
import brokerToolInventory from '../resources/session-broker/tool-inventory.ts?raw';
import storageMailbox from '../resources/piop-storage/durable-mailbox.ts?raw';
import brokerModule23 from '../resources/session-broker/agent-profiles.ts?raw';
import storageRuns from '../resources/piop-storage/subagent-results.ts?raw';
import brokerModule29 from '../resources/session-broker/subagent-identity.ts?raw';
import sessionStateRecords from '../resources/piop-storage/session-records.cjs?raw';
import goalsRecords from '../resources/piop-storage/goals.cjs?raw';
import storageReferencesRaw from '../resources/piop-storage/reference-publication-lock.cjs?raw';
import storageGoalDependencies from '../resources/piop-storage/goal-dependencies.cjs?raw';
import storageGoalPreparedFiles from '../resources/piop-storage/goal-prepared-files.cjs?raw';
import storageGoalPreparations from '../resources/piop-storage/goal-preparations.cjs?raw';
import storageGoalOwnership from '../resources/piop-storage/goal-ownership.cjs?raw';
import storageGoalAssetsRaw from '../resources/piop-storage/goal-assets.cjs?raw';
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
import storageGoalFilesRaw from '../resources/piop-storage/goal-files.ts?raw';
import goalsPrompts from '../resources/piop-goals/prompts.ts?raw';
import goalsCoordination from '../resources/piop-goals/coordination.ts?raw';
import goalsTools from '../resources/piop-goals/tools.ts?raw';
import goalsCommands from '../resources/piop-goals/commands.ts?raw';


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
const agentPrompts = embedFileLock(agentPromptsRaw);
const storagePublicationIo = embedFileLock(storagePublicationIoRaw);
const storageReferences = embedFileLock(storageReferencesRaw);
const storageGoalAssets = embedFileLock(storageGoalAssetsRaw);
const storageGoalFiles = embedFileLock(storageGoalFilesRaw);

export {
  sessionDatabase,
  sessionRegistry,
  appSettingsCjs,
  transcriptReferences,
  sdkStorage,
  storageFile,
  agentCommands,
  sdkStorageBundle,
  providerSdk,
  fastModelDiscovery,
  sessionBroker,
  sdkSessionList,
  runtimeConfiguration,
  runtimeBridge,
  runtimeAvailability,
  mcpSchemaBundle,
  mcpBridgeBundle,
  fastModeBundle,
  providersRefreshExtension,
  openaiCacheForkExtension,
  agentState,
  agentResources,
  agentPrompts,
  agentProfiles,
  agentMcpConfig,
  definedAgentsExtension,
  agentExtensionLoader,
  agentFastModels,
  contextWindowCapExtension,
  contextWindowCapInterface,
  contextWindowCapDefaults,
  contextBarExtension,
  codexWebSearchExtension,
};

export const SESSION_BROKER_MODULES: Array<[string, string]> = [
  ['app-settings.cjs', brokerModule2],
  ['client.ts', brokerModule4],
  ['conversation-location.ts', brokerModule5],
  ['fast-mode.ts', brokerModule7],
  ['session-child-index.cjs', brokerModule9],
  ['session-child-index.d.cts', brokerModule10],
  ['subagents.ts', brokerModule17],
  ['subagent-state.ts', brokerModule18],
  ['subagent-reconciliation.ts', brokerModule19],
  ['orchestration.ts', brokerModule21],
  ['input-hold.ts', brokerInputHold],
  ['tool-inventory.ts', brokerToolInventory],
  ['agent-profiles.ts', brokerModule23],
  ['subagent-identity.ts', brokerModule29],
];

/** Session extensions installed next to session-broker. Each directory holds one extension with index.ts as its entry. */
export const SESSION_EXTENSIONS: Array<[string, Array<[string, string]>]> = [
  ['hooks-extended', [['index.ts', hooksExtendedIndex], ['interface.ts', hooksExtendedInterface], ['availability.ts', hooksAvailability]]],
  ['piop-storage', [
    ['index.ts', storageIndex],
    ['recovery.cjs', storageRecovery],
    ['identities.mjs', storageIdentities],
    ['bootstrap.mjs', storageBootstrap],
    ['interface.ts', storageInterface],
    ['goals.cjs', goalsRecords],
    ['session-records.cjs', sessionStateRecords],
    ['session-storage.mjs', embedFileLock(sessionStorageRaw)],
    ['goal-files.ts', storageGoalFiles],
    ['goal-directory-recovery.cjs', storageGoalRecovery],
    ['goal-assets.cjs', storageGoalAssets],
    ['goal-dependencies.cjs', storageGoalDependencies],
    ['goal-prepared-files.cjs', storageGoalPreparedFiles],
    ['goal-preparations.cjs', storageGoalPreparations],
    ['goal-ownership.cjs', storageGoalOwnership],
    ['reference-publication-lock.cjs', storageReferences],
    ['review-publication.cjs', storageReviews],
    ['durable-mailbox.ts', storageMailbox],
    ['subagent-results.ts', storageRuns],
    ['session-file.ts', storagePublication],
    ['session-publication.cjs', storagePublicationJournal],
    ['session-publication-io.cjs', storagePublicationIo],
    ['session-publication-dependencies.cjs', storagePublicationDependencies],
    ['session-publication.d.cts', storagePublicationTypes],
  ]],
  ['piop-controls', [
    ['interface.ts', controlsInterface], ['pause.ts', controlsPause], ['fork.ts', controlsFork],
    ['commands.ts', controlsCommands], ['fast-mode.ts', controlsFastMode], ['index.ts', controlsIndex],
  ]],
  ['piop-goals', [
    ['interface.ts', goalsInterface], ['state.ts', goalsState], ['prompts.ts', goalsPrompts], ['coordination.ts', goalsCoordination],
    ['preparation.ts', goalsPreparation], ['goals.ts', goalsGoals], ['tools.ts', goalsTools],
    ['commands.ts', goalsCommands], ['index.ts', goalsIndex],
  ]],
];
