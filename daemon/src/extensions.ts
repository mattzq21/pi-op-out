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

/** Enabled skill paths supplied when a Pi agent starts. */
export function skillLists(settings: AppSettings): { userInvokedSkills: string[]; agentInvokedSkills: string[] } {
  const enabled = settings.skills.filter(skill => skill?.enabled === true && typeof skill.path === 'string');
  return {
    userInvokedSkills: enabled.filter(skill => skill.userInvokedOnly === true).map(skill => skill.path),
    agentInvokedSkills: enabled.filter(skill => skill.userInvokedOnly !== true).map(skill => skill.path),
  };
}

/** Tool names supplied when a Pi agent starts. */
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

export function agentResources(settings: AppSettings): any {
  return { skills: skillLists(settings), tools: toolLists(settings) };
}

export function prepareRuntimeBridge(): void {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, 'runtime-bridge.cjs'), R.runtimeBridge);
  atomicWritePrivate(join(dir, 'runtime-configuration.cjs'), R.runtimeConfiguration);
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  prepareSdkStorage(dir);
}

export const SESSION_BROKER_MODULES = R.SESSION_BROKER_MODULES;
export const EXCALIDRAW_ASSETS = R.EXCALIDRAW_ASSETS;

/** Installs session-broker and the session extensions that share its modules. Returns the entries in load order. */
export function prepareSessionExtensions(): { controls: string; broker: string; goals: string; reviews: string } {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  prepareBrokerStorage(dir);
  const modules = join(dir, 'session-broker');
  ensurePrivateDir(modules);
  for (const [name, content] of SESSION_BROKER_MODULES) atomicWritePrivate(join(modules, name), content);
  for (const [extension, files] of R.SESSION_EXTENSIONS) {
    ensurePrivateDir(join(dir, extension));
    for (const [name, content] of files) atomicWritePrivate(join(dir, extension, name), content);
  }
  const broker = join(dir, 'session-broker.ts');
  atomicWritePrivate(broker, R.sessionBroker);
  return { controls: join(dir, 'piop-controls/index.ts'), broker, goals: join(dir, 'piop-goals/index.ts'), reviews: join(dir, 'piop-reviews/index.ts') };
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
}

export function prepareUserQuestionsExtension(): string {
  const dir = join(generatedExtensionRoot(), 'piop-user-questions');
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, 'interface.ts'), R.userQuestionsInterface);
  atomicWritePrivate(join(dir, 'questions.ts'), R.userQuestionsLogic);
  const path = join(dir, 'index.ts');
  atomicWritePrivate(path, R.userQuestionsExtension);
  return path;
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

export function prepareHtmlPreviewExtension(): string {
  const dir = join(generatedExtensionRoot(), 'piop-html-preview');
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, 'interface.ts'), R.htmlPreviewInterface);
  atomicWritePrivate(join(dir, 'preview.ts'), R.htmlPreviewFeature);
  const path = join(dir, 'index.ts');
  atomicWritePrivate(path, R.htmlPreviewExtension);
  return path;
}

export function prepareContextWindowCapExtension(settings: AppSettings): string {
  saveContextCapSettings(settings);
  const dir = join(generatedExtensionRoot(), 'piop-context-window-cap');
  ensurePrivateDir(dir);
  const extensionPath = join(dir, 'index.ts');
  atomicWritePrivate(join(dir, 'interface.ts'), R.contextWindowCapInterface);
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  atomicWritePrivate(join(dir, 'defaults.ts'), R.contextWindowCapDefaults.replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs'));
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
    ['resources.ts', R.agentResources],
    ['prompts.ts', R.agentPrompts],
    ['profiles.ts', R.agentProfiles],
    ['excalidraw.ts', R.agentExcalidraw],
    ['fast-models.ts', R.agentFastModels],
    ['../piop-context-window-cap/interface.ts', R.contextWindowCapInterface],
    ['index.ts', R.definedAgentsExtension],
  ] as const) atomicWritePrivate(join(dir, name), source);
  return path;
}
