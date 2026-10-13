import { join } from 'node:path';
import { DEVELOPMENT, STORAGE_DIRECTORY } from './config';
import { directory as daemonDirectory } from './daemon_endpoint';
import { homeDir } from './environment';
import { enabledToolNames } from './pi_launch';
import { atomicWritePrivate, ensurePrivateDir } from './private_fs';
import * as R from './resources';
import { publish } from './settings_records';
import type { AppSettings } from './settings_types';

export function generatedExtensionRoot(): string {
  return DEVELOPMENT ? join(daemonDirectory(), 'extensions') : join(homeDir(), STORAGE_DIRECTORY);
}

export function prepareMcpBridge(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-mcp-bridge.ts');
  atomicWritePrivate(path, R.mcpBridgeBundle);
  return path;
}

/** Enabled skills, split by who may invoke them. The skills store extension owns these lists in Pi. */
export function skillLists(settings: AppSettings): { userInvokedSkills: string[]; agentInvokedSkills: string[] } {
  const enabled = settings.skills.filter(skill => skill?.enabled === true && typeof skill.path === 'string');
  return {
    userInvokedSkills: enabled.filter(skill => skill.userInvokedOnly === true).map(skill => skill.path),
    agentInvokedSkills: enabled.filter(skill => skill.userInvokedOnly !== true).map(skill => skill.path),
  };
}

/** Tool names from the settings. The tool store extension owns these lists in Pi. */
export function toolLists(settings: AppSettings): { enabledTools: string[]; registeredTools: string[] } {
  return {
    enabledTools: enabledToolNames(settings),
    registeredTools: settings.tools.map(tool => tool?.name).filter((name): name is string => typeof name === 'string'),
  };
}

export function contextCapSettings(settings: AppSettings) {
  return {
    contextWindowCap: settings.contextWindowCap,
    contextWindowCapEnabled: settings.contextWindowCapEnabled,
    modelContextWindowCaps: settings.modelContextWindowCaps,
  };
}

export function saveContextCapSettings(settings: AppSettings): void {
  publish(join(generatedExtensionRoot(), 'context-cap-settings.json'), JSON.stringify(contextCapSettings(settings)));
}

export function runtimeSettings(settings: AppSettings): any {
  return { skills: skillLists(settings), tools: toolLists(settings) };
}

export function prepareRuntimeSettings(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'runtime-settings.ts');
  atomicWritePrivate(join(dir, 'runtime-bridge.cjs'), R.runtimeBridge);
  atomicWritePrivate(join(dir, 'runtime-configuration.cjs'), R.runtimeConfiguration);
  prepareSdkStorage(dir);
  atomicWritePrivate(path, R.runtimeSettingsExtension);
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  return path;
}

export function prepareSkillsStoreExtension(settings: AppSettings): string {
  const root = generatedExtensionRoot();
  const dir = join(root, 'piop-skills-store');
  ensurePrivateDir(dir);
  atomicWritePrivate(join(root, 'app-settings.cjs'), R.appSettingsCjs);
  atomicWritePrivate(join(dir, 'interface.ts'), R.skillsStoreInterface);
  atomicWritePrivate(join(dir, 'index.ts'), R.skillsStoreExtension);
  publish(join(root, 'skills-store.json'), JSON.stringify(skillLists(settings)));
  return join(dir, 'index.ts');
}

export function prepareToolStoreExtension(settings: AppSettings): string {
  const root = generatedExtensionRoot();
  const dir = join(root, 'piop-tool-store');
  ensurePrivateDir(dir);
  atomicWritePrivate(join(root, 'app-settings.cjs'), R.appSettingsCjs);
  atomicWritePrivate(join(dir, 'interface.ts'), R.toolStoreInterface);
  atomicWritePrivate(join(dir, 'index.ts'), R.toolStoreExtension);
  publish(join(root, 'tool-store.json'), JSON.stringify(toolLists(settings)));
  return join(dir, 'index.ts');
}

export const SESSION_BROKER_MODULES = R.SESSION_BROKER_MODULES;
export const EXCALIDRAW_ASSETS = R.EXCALIDRAW_ASSETS;

export function prepareSessionBroker(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  prepareBrokerStorage(dir);
  const modules = join(dir, 'session-broker');
  ensurePrivateDir(modules);
  for (const [name, content] of SESSION_BROKER_MODULES) atomicWritePrivate(join(modules, name), content);
  const path = join(dir, 'session-broker.ts');
  atomicWritePrivate(path, R.sessionBroker);
  return path;
}

function prepareSdkStorage(dir: string): void {
  atomicWritePrivate(join(dir, 'transcript-references.cjs'), R.transcriptReferences);
  atomicWritePrivate(join(dir, 'sdk-storage.mjs'), R.sdkStorage);
  atomicWritePrivate(join(dir, 'sdk-session-list.mjs'), R.sdkSessionList);
  atomicWritePrivate(join(dir, 'session-database.cjs'), R.sessionDatabase);
}

function prepareBrokerStorage(dir: string): void {
  atomicWritePrivate(join(dir, 'transcript-references.cjs'), R.transcriptReferences);
  atomicWritePrivate(join(dir, 'session-database.cjs'), R.sessionDatabase);
  atomicWritePrivate(join(dir, 'sdk-storage.mjs'), R.sdkStorage);
  atomicWritePrivate(join(dir, 'ask-user.ts'), R.askUser);
}

export function prepareProvidersRefreshExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-providers-refresh.ts');
  atomicWritePrivate(path, R.providersRefreshExtension);
  return path;
}

export function prepareOpenaiCacheForkExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-openai-cache-fork.ts');
  atomicWritePrivate(path, R.openaiCacheForkExtension);
  return path;
}

export function prepareFastModeExtension(): string {
  const dir = join(generatedExtensionRoot(), 'piop-openai-fast-mode');
  ensurePrivateDir(dir);
  const path = join(dir, 'index.ts');
  atomicWritePrivate(path, R.fastModeBundle);
  return path;
}

export function prepareCodemodeToolsDescriptionExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-codemode-tools-description.ts');
  atomicWritePrivate(path, R.codemodeToolsDescriptionExtension);
  return path;
}

export function prepareCodexWebSearchExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-codex-web-search.ts');
  atomicWritePrivate(path, R.codexWebSearchExtension);
  return path;
}

export function prepareContextBarExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'piop-context-bar.ts');
  atomicWritePrivate(path, R.contextBarExtension);
  return path;
}

export function prepareContextWindowCapExtension(settings: AppSettings): string {
  saveContextCapSettings(settings);
  const dir = join(generatedExtensionRoot(), 'piop-context-window-cap');
  ensurePrivateDir(dir);
  const extensionPath = join(dir, 'index.ts');
  atomicWritePrivate(join(dir, 'interface.ts'), R.contextWindowCapInterface);
  atomicWritePrivate(extensionPath, R.contextWindowCapExtension);
  return extensionPath;
}

export function prepareSessionCostLimitExtension(_settings: AppSettings): string {
  const dir = join(generatedExtensionRoot(), 'piop-session-cost-limit');
  ensurePrivateDir(dir);
  const path = join(dir, 'index.ts');
  atomicWritePrivate(path, R.sessionCostLimitExtension);
  return path;
}

function prepareAgentDirectories(dir: string): void {
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, '../app-settings.cjs'), R.appSettingsCjs);
  const rtk = join(homeDir(), STORAGE_DIRECTORY, 'piop-rtk');
  ensurePrivateDir(rtk);
  atomicWritePrivate(join(rtk, 'rtk.ts'), R.rtkExtension);
  const excalidraw = join(homeDir(), STORAGE_DIRECTORY, 'piop-excalidraw');
  ensurePrivateDir(excalidraw);
  ensurePrivateDir(join(excalidraw, 'references'));
  for (const [name, source] of EXCALIDRAW_ASSETS) atomicWritePrivate(join(excalidraw, name), source);
}

export function prepareDefinedAgentsExtension(): string {
  const dir = join(generatedExtensionRoot(), 'piop-define-agents');
  prepareAgentDirectories(dir);
  const path = join(dir, 'index.ts');
  for (const [name, source] of [
    ['mcp-schema.ts', R.mcpSchemaBundle],
    ['mcp-config.ts', R.agentMcpConfig],
    ['extension-loader.ts', R.agentExtensionLoader],
    ['state.ts', R.agentState],
    ['daemon-definitions.ts', R.agentDaemonDefinitions],
    ['prompts.ts', R.agentPrompts],
    ['profiles.ts', R.agentProfiles],
    ['excalidraw.ts', R.agentExcalidraw],
    ['fast-models.ts', R.agentFastModels],
    ['../piop-context-window-cap/interface.ts', R.contextWindowCapInterface],
    ['index.ts', R.definedAgentsExtension],
  ] as const) atomicWritePrivate(join(dir, name), source);
  return path;
}
