import { join } from 'node:path';
import { DEVELOPMENT, STORAGE_DIRECTORY } from './config';
import { directory as daemonDirectory } from './daemon_endpoint';
import { homeDir } from './environment';
import { atomicWritePrivate, ensurePrivateDir } from './private_fs';
import * as R from './resources';
import * as Contributions from './plugin_contributions';
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

/** Tool names supplied when a Pi agent starts: the tools that Pi last reported on this host. */
export function toolLists(settings: AppSettings): { enabledTools: string[]; registeredTools: string[] } {
  const names = settings.tools.map(tool => tool.name);
  return { enabledTools: names, registeredTools: [...names] };
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
  atomicWritePrivate(join(dir, 'runtime-availability.cjs'), R.runtimeAvailability);
  atomicWritePrivate(join(dir, 'runtime-configuration.cjs'), R.runtimeConfiguration);
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  prepareSdkStorage(dir);
}

export const SESSION_BROKER_MODULES = R.SESSION_BROKER_MODULES;

/** Installs session-broker and the session extensions that share its modules. Returns the entries in load order. */
export function prepareSessionExtensions(): { hooks: string; storage: string; controls: string; broker: string; goals: string } {
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
  return { hooks: join(dir, 'hooks-extended/index.ts'), storage: join(dir, 'piop-storage/index.ts'), controls: join(dir, 'piop-controls/index.ts'), broker, goals: join(dir, 'piop-goals/index.ts') };
}

/**
 * Installs the Pi extensions of enabled plugins in plugins/<plugin id>/ and returns their entries with the core extension each follows.
 * Plugin sources import core modules through ../../resources/, which is the generated extension root here.
 */
export function preparePluginExtensions(): Array<{ after: Contributions.CoreExtension; path: string }> {
  const root = generatedExtensionRoot();
  const entries: Array<{ after: Contributions.CoreExtension; path: string }> = [];
  ensurePrivateDir(join(root, 'plugins'));
  for (const plugin of Contributions.enabled()) {
    if (!plugin.extension) continue;
    const dir = join(root, 'plugins', plugin.id);
    ensurePrivateDir(dir);
    for (const [name, source] of plugin.extension.files) atomicWritePrivate(join(dir, name), source.replaceAll('"../../resources/', '"../../'));
    entries.push({ after: plugin.extension.after, path: join(dir, 'index.ts') });
  }
  return entries;
}

function prepareSdkStorage(dir: string): void {
  atomicWritePrivate(join(dir, 'transcript-references.cjs'), R.transcriptReferences);
  atomicWritePrivate(join(dir, 'sdk-storage.mjs'), R.sdkStorage);
  atomicWritePrivate(join(dir, 'storage-file.mjs'), R.storageFile);
  atomicWritePrivate(join(dir, 'sdk-session-list.mjs'), R.sdkSessionList);
  atomicWritePrivate(join(dir, 'session-database.cjs'), R.sessionDatabase);
  atomicWritePrivate(join(dir, 'session-registry.cjs'), R.sessionRegistry);
}

function prepareBrokerStorage(dir: string): void {
  atomicWritePrivate(join(dir, 'transcript-references.cjs'), R.transcriptReferences);
  atomicWritePrivate(join(dir, 'session-database.cjs'), R.sessionDatabase);
  atomicWritePrivate(join(dir, 'session-registry.cjs'), R.sessionRegistry);
  atomicWritePrivate(join(dir, 'sdk-storage.mjs'), R.sdkStorage);
  atomicWritePrivate(join(dir, 'storage-file.mjs'), R.storageFile);
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
  atomicWritePrivate(join(dir, 'app-settings.cjs'), R.appSettingsCjs);
  atomicWritePrivate(join(dir, 'defaults.ts'), R.contextWindowCapDefaults.replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs'));
  atomicWritePrivate(extensionPath, R.contextWindowCapExtension.replace('../../daemon/resources/hooks-extended/interface.ts', '../hooks-extended/interface.ts'));
  return extensionPath;
}

function prepareAgentDirectories(dir: string): void {
  ensurePrivateDir(dir);
  atomicWritePrivate(join(dir, '../app-settings.cjs'), R.appSettingsCjs);
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
    ['fast-models.ts', R.agentFastModels],
    ['../piop-context-window-cap/interface.ts', R.contextWindowCapInterface],
    ['index.ts', R.definedAgentsExtension],
  ] as const) atomicWritePrivate(join(dir, name), source);
  return path;
}
