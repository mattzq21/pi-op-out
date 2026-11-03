import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEVELOPMENT, STORAGE_DIRECTORY } from './config';
import { directory as daemonDirectory } from './daemon_endpoint';
import { homeDir } from './environment';
import { ensurePrivateDir } from './private_fs';
import * as R from './resources';
import * as Contributions from './plugin_contributions';
import { publish } from './settings_records';
import type { AppSettings } from './settings_types';
import { errorText } from './util/sync';

export function extensionBase(): string {
  return DEVELOPMENT ? join(daemonDirectory(), 'extensions') : join(homeDir(), STORAGE_DIRECTORY);
}

export function contextCapSettingsPath(): string { return join(extensionBase(), 'context-cap-settings.json'); }

export function skillLists(settings: AppSettings): { userInvokedSkills: string[]; agentInvokedSkills: string[] } {
  const enabled = settings.skills.filter(skill => skill?.enabled === true && typeof skill.path === 'string');
  return {
    userInvokedSkills: enabled.filter(skill => skill.userInvokedOnly === true).map(skill => skill.path),
    agentInvokedSkills: enabled.filter(skill => skill.userInvokedOnly !== true).map(skill => skill.path),
  };
}

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
  publish(contextCapSettingsPath(), JSON.stringify(contextCapSettings(settings)));
}

export function agentResources(settings: AppSettings): any {
  return { skills: skillLists(settings), tools: toolLists(settings) };
}

const BRIDGE = 'runtime-bridge.cjs';

const CORE = {
  ocx: 'piop-ocx-provider/index.ts',
  providersRefresh: 'piop-providers-refresh.ts',
  mcp: 'piop-mcp-bridge.ts',
  storage: 'piop-storage/index.ts',
  hooks: 'hooks-extended/index.ts',
  controls: 'piop-controls/index.ts',
  broker: 'session-broker.ts',
  compactionTiming: 'piop-compaction-timing.ts',
  contextWindowCap: 'piop-context-window-cap/index.ts',
  contextBar: 'piop-context-bar.ts',
  fastMode: 'piop-openai-fast-mode/index.ts',
  openaiCacheFork: 'piop-openai-cache-fork.ts',
  definedAgents: 'piop-define-agents/index.ts',
  skills: 'piop-controls/skills.ts',
} as const;

export interface GeneratedExtensions {
  root: string;
  bridge: string;
  core: Record<keyof typeof CORE, string>;
  plugins: Array<{ after: Contributions.CoreExtension; path: string }>;
}

interface Sources { files: Map<string, string>; plugins: Array<{ after: Contributions.CoreExtension; path: string }> }

function sources(): Sources {
  const files = new Map<string, string>();
  const add = (path: string, content: string) => {
    if (path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('Invalid generated extension path: ' + path);
    const previous = files.get(path);
    if (previous !== undefined && previous !== content) throw new Error('Two generated extension files use the path ' + path);
    files.set(path, content);
  };
  add(BRIDGE, R.runtimeBridge);
  add('pi-runtime.cjs', R.piRuntime);
  add('queue-pull.cjs', R.queuePull);
  add('runtime-availability.cjs', R.runtimeAvailability);
  add('mcp-connections.cjs', R.mcpConnections);
  add('runtime-configuration.cjs', R.runtimeConfiguration);
  add('app-settings.cjs', R.appSettingsCjs);
  add('transcript-references.cjs', R.transcriptReferences);
  add('sdk-storage.mjs', R.sdkStorage);
  add('storage-file.mjs', R.storageFile);
  add('sdk-session-list.mjs', R.sdkSessionList);
  add('session-database.cjs', R.sessionDatabase);
  add('session-registry.cjs', R.sessionRegistry);
  add(CORE.broker, R.sessionBroker);
  for (const [name, content] of R.SESSION_BROKER_MODULES) add('session-broker/' + name, content);
  for (const [extension, entries] of R.SESSION_EXTENSIONS) for (const [name, content] of entries) add(extension + '/' + name, content);
  add(CORE.mcp, R.mcpBridgeBundle);
  add(CORE.providersRefresh, R.providersRefreshExtension);
  add('piop-ocx-provider/ocx-provider.mjs', R.ocxProviderModule);
  add(CORE.ocx, R.ocxProviderExtension);
  add(CORE.openaiCacheFork, R.openaiCacheForkExtension);
  add(CORE.fastMode, R.fastModeBundle);
  add(CORE.contextBar, R.contextBarExtension);
  add(CORE.compactionTiming, R.compactionTimingExtension);
  add('piop-context-window-cap/interface.ts', R.contextWindowCapInterface);
  add('piop-context-window-cap/app-settings.cjs', R.appSettingsCjs);
  add('piop-context-window-cap/defaults.ts', R.contextWindowCapDefaults.replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs'));
  add(CORE.contextWindowCap, R.contextWindowCapExtension.replace('../../daemon/resources/hooks-extended/interface.ts', '../hooks-extended/interface.ts'));
  for (const [name, content] of [
    ['mcp-schema.ts', R.mcpSchemaBundle],
    ['mcp-config.ts', R.agentMcpConfig],
    ['extension-loader.ts', R.agentExtensionLoader],
    ['state.ts', R.agentState],
    ['resources.ts', R.agentResources],
    ['prompts.ts', R.agentPrompts],
    ['profiles.ts', R.agentProfiles],
    ['fast-models.ts', R.agentFastModels],
    ['index.ts', R.definedAgentsExtension],
  ] as const) add('piop-define-agents/' + name, content);
  const plugins: Sources['plugins'] = [];
  for (const plugin of Contributions.enabled()) {
    if (!plugin.extension) continue;
    for (const [name, content] of plugin.extension.files) add('plugins/' + plugin.id + '/' + name, content.replaceAll('"../../resources/', '"../../'));
    plugins.push({ after: plugin.extension.after, path: 'plugins/' + plugin.id + '/index.ts' });
  }
  return { files, plugins };
}

function contentName(files: Map<string, string>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    const body = Buffer.from(files.get(path)!);
    hash.update(path).update('\0').update(String(body.length)).update('\0').update(body);
  }
  return hash.digest('hex');
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeFile(path: string, content: string): void {
  const body = Buffer.from(content);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < body.length) offset += writeSync(descriptor, body, offset);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function writeFolder(root: string, files: Map<string, string>): void {
  mkdirSync(root, { mode: 0o700 });
  const folders = new Set([root]);
  for (const [relative, content] of files) {
    const path = join(root, relative);
    for (let folder = dirname(path); !folders.has(folder); folder = dirname(folder)) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      folders.add(folder);
    }
    writeFile(path, content);
  }
  for (const folder of [...folders].sort((left, right) => right.length - left.length)) syncPath(folder);
}

let published: GeneratedExtensions | undefined;

export function generatedExtensions(): GeneratedExtensions {
  if (published) return published;
  const { files, plugins } = sources();
  const parent = join(extensionBase(), 'generated');
  ensurePrivateDir(parent);
  const root = join(parent, contentName(files));
  if (!existsSync(root)) {
    const temporary = join(parent, '.tmp-' + randomUUID());
    try {
      writeFolder(temporary, files);
      renameSync(temporary, root);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    syncPath(parent);
  }
  const path = (relative: string) => join(root, relative);
  published = {
    root,
    bridge: path(BRIDGE),
    core: Object.fromEntries(Object.entries(CORE).map(([name, relative]) => [name, path(relative)])) as GeneratedExtensions['core'],
    plugins: plugins.map(plugin => ({ after: plugin.after, path: path(plugin.path) })),
  };
  return published;
}

// Removes the folders of other builds and plugin setups. Call it only while this daemon holds
// the claim of its folder and no Pi process of an earlier daemon is left: then nothing else uses them.
export function removeUnusedGeneratedExtensions(): void {
  const { root } = generatedExtensions();
  const parent = dirname(root);
  const failures: string[] = [];
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    if (path === root) continue;
    try { rmSync(path, { recursive: true, force: true }); } catch (error) { failures.push(path + ': ' + errorText(error)); }
  }
  if (failures.length) throw new Error('Could not remove unused Pi extension folders: ' + failures.join('; '));
}
