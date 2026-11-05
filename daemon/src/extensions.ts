import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir } from './private_fs';
import * as R from './resources';
import * as Contributions from './plugins';
import type { AppSettings } from './settings_types';
import { errorText } from './util/sync';

export function extensionBase(): string {
  return join(homeDir(), STORAGE_DIRECTORY);
}

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

export function agentResources(settings: AppSettings): any {
  return { skills: skillLists(settings), tools: toolLists(settings) };
}

const BRIDGE = 'runtime-bridge.mjs';
const PROVIDER_SDK = 'provider-sdk.mjs';

// Each core extension is one built file. Settings groups an extension's tools under its file name.
const CORE: Record<keyof typeof R.CORE_EXTENSIONS, string> = {
  ocx: 'piop-ocx-provider.mjs',
  providersRefresh: 'piop-providers-refresh.mjs',
  mcp: 'piop-mcp-bridge.mjs',
  storage: 'piop-storage.mjs',
  hooks: 'hooks-extended.mjs',
  controls: 'piop-controls.mjs',
  broker: 'session-broker.mjs',
  compactionTiming: 'piop-compaction-timing.mjs',
  contextWindowCap: 'piop-context-window-cap.mjs',
  contextBar: 'piop-context-bar.mjs',
  fastMode: 'piop-openai-fast-mode.mjs',
  openaiCacheFork: 'piop-openai-cache-fork.mjs',
  definedAgents: 'piop-define-agents.mjs',
  skills: 'skills.mjs',
};

export interface GeneratedExtensions {
  root: string;
  bridge: string;
  providerSdk: string;
  core: Record<keyof typeof CORE, string>;
  plugins: Array<{ after: Contributions.CoreExtension; path: string }>;
}

interface Sources { files: Map<string, string>; plugins: Array<{ after: Contributions.CoreExtension; path: string }> }

function sources(): Sources {
  const files = new Map<string, string>();
  const add = (path: string, content: string) => {
    if (files.has(path)) throw new Error('Two generated Pi files use the path ' + path);
    files.set(path, content);
  };
  add(BRIDGE, R.runtimeBridge);
  add(PROVIDER_SDK, R.providerSdk);
  for (const [name, path] of Object.entries(CORE) as Array<[keyof typeof CORE, string]>) add(path, R.CORE_EXTENSIONS[name]);
  const plugins: Sources['plugins'] = [];
  for (const plugin of Contributions.enabled()) {
    if (!plugin.manifest.extension || plugin.extension === undefined) continue;
    const path = 'plugins/' + plugin.manifest.id + '.mjs';
    add(path, plugin.extension);
    plugins.push({ after: plugin.manifest.extension.after, path });
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
    providerSdk: path(PROVIDER_SDK),
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
