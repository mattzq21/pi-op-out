import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { skillInventory } from './settings_records';
import type { AppSettings } from './settings_types';

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

function walkSkillFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(path);
    }
  };
  visit(root);
  return found;
}

function depth(path: string): number { return path.split(sep).filter(Boolean).length; }

function discoverInventory(root: string): any[] {
  try { statSync(root); } catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  const skillFiles = walkSkillFiles(root).sort((left, right) => depth(left) - depth(right));
  const skillRoots: string[] = [];
  const discovered: any[] = [];
  for (const skillFile of skillFiles) {
    const directory = dirname(skillFile);
    if (skillRoots.some(known => directory !== known && pathStartsWith(directory, known))) continue;
    skillRoots.push(directory);
    const content = readFileSync(skillFile, 'utf8');
    const fallback = basename(directory) || 'skill';
    const claudeUserOnly = frontmatterValue(content, 'disable-model-invocation')?.toLowerCase() === 'true';
    const codexUserOnly = codexDisablesImplicitInvocation(directory);
    discovered.push({
      name: frontmatterValue(content, 'name') ?? fallback,
      path: directory,
      description: frontmatterValue(content, 'description') ?? 'Pi skill',
      enabled: true,
      userInvokedOnly: claudeUserOnly || codexUserOnly,
    });
  }
  return discovered;
}

export function refreshSkills(): void {
  const home = homeDir();
  const previous = JSON.stringify(savedSkills(home, false));
  const current = JSON.stringify(savedSkills(home, true));
  if (previous !== current) for (const listener of skillListeners) listener();
}

const skillListeners = new Set<() => void>();

export function onSkillsChanged(listener: () => void): void { skillListeners.add(listener); }

function savedSkills(home: string, refresh: boolean): any[] {
  const root = join(home, '.agents/skills');
  const path = join(home, STORAGE_DIRECTORY, 'settings.json');
  return skillInventory(path, root, refresh, () => discoverInventory(root));
}

export function mergeDiscoveredSkills(settings: AppSettings): void {
  const home = homeDir();
  mergeSkills(settings, home, savedSkills(home, false));
}

/** Replaces the settings skills with the discovered skills. A user-invoked skill is always enabled; other skills keep their saved state. */
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
