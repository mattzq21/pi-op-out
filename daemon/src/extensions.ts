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

export function runtimeSettings(settings: AppSettings): any {
  const enabledSkills = settings.skills.filter(skill => skill?.enabled === true);
  return {
    defaultModel: settings.defaultModel,
    tools: enabledToolNames(settings),
    registeredTools: settings.tools.map(tool => tool?.name).filter((name): name is string => typeof name === 'string'),
    skills: enabledSkills.map(skill => skill.path).filter((path): path is string => typeof path === 'string'),
    explicitOnlySkills: enabledSkills.filter(skill => skill.userInvokedOnly === true).map(skill => skill.path).filter((path): path is string => typeof path === 'string'),
    contextWindowCap: settings.contextWindowCap,
    contextWindowCapEnabled: settings.contextWindowCapEnabled,
  };
}

export function prepareRtkExtension(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'rtk.ts');
  atomicWritePrivate(path, R.rtkExtension);
  return path;
}

export function prepareRuntimeSettings(settings: AppSettings): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  const path = join(dir, 'runtime-settings.ts');
  atomicWritePrivate(join(dir, 'runtime-bridge.cjs'), R.runtimeBridge);
  atomicWritePrivate(join(dir, 'runtime-configuration.cjs'), R.runtimeConfiguration);
  prepareSdkStorage(dir);
  atomicWritePrivate(path, R.runtimeSettingsExtension);
  saveRuntimeSettings(dir, settings);
  return path;
}

function saveRuntimeSettings(dir: string, settings: AppSettings): void {
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  publish(join(dir, 'runtime-settings.json'), JSON.stringify(runtimeSettings(settings)));
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

export function prepareTraceReader(): string {
  const dir = generatedExtensionRoot();
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, 'session-database.cjs'), R.sessionDatabase);
  const path = join(dir, 'piop-trace-reader.ts');
  atomicWritePrivate(path, R.traceReader);
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
  const dir = join(generatedExtensionRoot(), 'piop-context-window-cap');
  ensurePrivateDir(dir);
  const extensionPath = join(dir, 'index.ts');
  atomicWritePrivate(extensionPath, R.contextWindowCapExtension);
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  publish(join(dir, 'config.json'), JSON.stringify({ contextWindowCap: settings.contextWindowCap, enabled: settings.contextWindowCapEnabled }));
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
    ['../piop-diagrams.ts', R.diagramsExtension],
    ['index.ts', R.definedAgentsExtension],
  ] as const) atomicWritePrivate(join(dir, name), source);
  return path;
}
