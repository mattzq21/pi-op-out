import { readdirSync, readFileSync, realpathSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import { saveSkillInventoryJson, skillInventoryJson, transaction } from '../../resources/session-database.cjs';
import type { AppSettings } from '../settings_types';

export function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith('---')) return undefined;
  const lines = content.split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (line.trim() === '---') return undefined;
    const index = line.indexOf(':');
    if (index < 0) continue;
    if (line.slice(0, index).trim() === key) return line.slice(index + 1).trim().replace(/^['"]+|['"]+$/g, '');
  }
  return undefined;
}

export function codexDisablesImplicitInvocation(skillDirectory: string): boolean {
  let content: string;
  try { content = readFileSync(join(skillDirectory, 'agents/openai.yaml'), 'utf8'); } catch { return false; }
  let policyIndent: number | undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed === 'policy:') { policyIndent = indent; continue; }
    if (policyIndent === undefined) continue;
    if (indent <= policyIndent) { policyIndent = undefined; continue; }
    const index = trimmed.indexOf(':');
    if (index < 0) continue;
    if (trimmed.slice(0, index).trim() === 'allow_implicit_invocation') {
      return (trimmed.slice(index + 1).split('#')[0] ?? '').trim().replace(/^['"]+|['"]+$/g, '').toLowerCase() === 'false';
    }
  }
  return false;
}

export function pathStartsWith(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, '');
  return path === normalizedRoot || path.startsWith(normalizedRoot + sep);
}

export function expandSkillPath(path: string, home: string): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

interface SkillTree { skillFiles: string[]; directories: string[] }

function scanSkillTree(root: string): SkillTree {
  const tree: SkillTree = { skillFiles: [], directories: [] };
  const visited = new Set<string>();
  const visit = (directory: string) => {
    const real = realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    tree.directories.push(directory);
    const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules');
    const kind = (entry: Dirent) => {
      if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined;
      try { const target = statSync(join(directory, entry.name)); return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined; }
      catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
    };
    const skillFile = entries.find(entry => entry.name === 'SKILL.md' && kind(entry) === 'file');
    if (skillFile) {
      tree.skillFiles.push(join(directory, skillFile.name));
      const agents = entries.find(entry => entry.name === 'agents' && kind(entry) === 'directory');
      if (agents) tree.directories.push(join(directory, agents.name));
      return;
    }
    for (const entry of entries) if (kind(entry) === 'directory') visit(join(directory, entry.name));
  };
  visit(root);
  return tree;
}

function rootExists(root: string): boolean {
  try { return statSync(root).isDirectory(); } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
}

function discoverInventory(root: string): any[] {
  if (!rootExists(root)) return [];
  return scanSkillTree(root).skillFiles.map(skillFile => {
    const directory = dirname(skillFile);
    const content = readFileSync(skillFile, 'utf8');
    const claudeUserOnly = frontmatterValue(content, 'disable-model-invocation')?.toLowerCase() === 'true';
    return {
      name: frontmatterValue(content, 'name') ?? (basename(directory) || 'skill'),
      path: directory,
      description: frontmatterValue(content, 'description') ?? 'Pi skill',
      enabled: true,
      userInvokedOnly: claudeUserOnly || codexDisablesImplicitInvocation(directory),
    };
  });
}

let skillWatchers: Map<string, FSWatcher> | undefined;

export function watchSkills(onError: (error: unknown) => void): void {
  if (skillWatchers) return;
  const watchers = skillWatchers = new Map<string, FSWatcher>();
  const root = join(homeDir(), '.agents/skills');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(sync, 50); timer.unref(); };
  function watched(): string[] {
    if (rootExists(root)) return scanSkillTree(root).directories;
    let ancestor = dirname(root);
    while (!rootExists(ancestor)) ancestor = dirname(ancestor);
    return [ancestor];
  }
  function sync() {
    try {
      refreshSkills();
      const directories = new Set(watched());
      for (const [directory, watcher] of watchers) if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
      for (const directory of directories) {
        if (watchers.has(directory)) continue;
        const watcher = watch(directory, schedule);
        watcher.on('error', schedule);
        watcher.unref();
        watchers.set(directory, watcher);
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') schedule();
      else onError(error);
    }
  }
  sync();
}

export function refreshSkills(): void {
  const home = homeDir();
  const previous = JSON.stringify(savedSkills(home, false));
  const current = JSON.stringify(savedSkills(home, true));
  if (previous !== current) for (const listener of skillListeners) listener();
}

const skillListeners = new Set<() => void>();

export function onSkillsChanged(listener: () => void): void { skillListeners.add(listener); }

// The skills found in the skills folder, saved in the storage root. refresh finds them again.
function savedSkills(home: string, refresh: boolean): any[] {
  const root = join(home, '.agents/skills');
  const storage = join(home, STORAGE_DIRECTORY);
  return transaction(storage, 'IMMEDIATE', () => {
    const saved = skillInventoryJson(storage, root);
    if (saved !== undefined && !refresh) return JSON.parse(saved);
    const skills = discoverInventory(root);
    saveSkillInventoryJson(storage, root, JSON.stringify(skills));
    return skills;
  });
}

export function mergeDiscoveredSkills(settings: AppSettings): void {
  const home = homeDir();
  mergeSkills(settings, home, savedSkills(home, false));
}

function mergeSkills(settings: AppSettings, home: string, skills: any[]): void {
  const enabledByPath = new Map<string, boolean>();
  for (const skill of settings.skills) {
    if (typeof skill?.path === 'string' && typeof skill.enabled === 'boolean') enabledByPath.set(expandSkillPath(skill.path, home), skill.enabled);
  }
  settings.skills = skills.map(skill => ({
    name: skill.name, path: skill.path, description: skill.description, userInvokedOnly: skill.userInvokedOnly === true,
    enabled: skill.userInvokedOnly === true || (enabledByPath.get(skill.path) ?? true),
  }));
  const name = (skill: any) => skill.name.toLowerCase();
  settings.skills.sort((left, right) => (name(left) < name(right) ? -1 : name(left) > name(right) ? 1 : 0));
}
