import { lstatSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { DEFAULT_TIMEOUT, hostOperation, runHostOperation } from '../host_operations';
import { lockPath, type FileLock } from '../util/flock';

export async function lock(root: string): Promise<FileLock> {
  const path = join(root, 'reference-publication.lock');
  const result = await lockPath(path, { blocking: true, timeoutMs: 10_000, shared: true, nofollow: true, regularFile: 'Invalid reference publication lock' });
  if (!result) throw new Error('Reference publication is locked by another process; try again');
  return result;
}

export async function validateNewReferences(root: string, values: any[], previous: any[]): Promise<void> {
  const retained = valueReferences(root, previous);
  const pending = [...valueReferences(root, values)];
  while (pending.length) {
    const directory = pending.pop()!;
    if (retained.has(directory)) continue;
    retained.add(directory);
    let dependencies: Set<string>;
    try { dependencies = await goalDependenciesOf(root, directory); } catch (error: any) {
      throw new Error('Managed goal attachment is unavailable: ' + directory + '. Reattach it before saving. ' + (error?.message ?? String(error)));
    }
    pending.push(...dependencies);
  }
}

function valueReferences(root: string, values: any[]): Set<string> {
  const found = new Set<string>();
  const pending: any[] = [...values];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') textReferences(root, value, found);
    else if (Array.isArray(value)) pending.push(...value);
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { textReferences(root, key, found); pending.push(item); }
    }
  }
  return found;
}

function textReferences(root: string, text: string, found: Set<string>): void {
  const rootPrefix = root + '/';
  for (const area of ['sessions', 'archived']) {
    const prefix = root + '/' + area + '/';
    let start = text.indexOf(prefix);
    while (start >= 0) {
      const remainder = text.slice(start);
      const offset = remainder.slice(prefix.length).indexOf(rootPrefix);
      const next = offset < 0 ? remainder.length : prefix.length + offset;
      const segment = remainder.slice(0, next);
      const newline = segment.search(/[\r\n]/);
      const path = managedGoalPath(segment.slice(0, newline < 0 ? segment.length : newline));
      if (path) found.add(path);
      start = text.indexOf(prefix, start + prefix.length);
    }
  }
}

function managedGoalPath(text: string): string | undefined {
  const marker = '/attachments/goal-';
  let start = text.indexOf(marker);
  while (start >= 0) {
    const suffix = text.slice(start + marker.length);
    const length = goalIdentityLength(suffix);
    if (length !== undefined) {
      const path = text.slice(0, start + marker.length + length);
      const parts = path.split('/');
      if (!parts.includes('..') && normalize(path) === path && !path.endsWith('/')) return path;
    }
    start = text.indexOf(marker, start + 1);
  }
  return undefined;
}

function goalIdentityLength(suffix: string): number | undefined {
  let length = 0;
  while (length < suffix.length && /[A-Za-z0-9]/.test(suffix[length]!)) length++;
  const valid = length === 6 || (length === 64 && /^[0-9a-f]+$/.test(suffix.slice(0, length)));
  if (!valid || suffix[length] === '-' || suffix[length] === '_') return undefined;
  return length;
}

function validateGoalDirectory(directory: string): void {
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, 'goal-objective.md')).isFile()) throw new Error('Invalid goal attachment');
}

async function goalDependenciesOf(root: string, directory: string): Promise<Set<string>> {
  validateGoalDirectory(directory);
  const found = new Set<string>();
  for (const text of await goalTextContents(root, directory)) textReferences(root, text, found);
  return found;
}

const goalText = hostOperation<{ root: string; directory: string }, string[]>('goal-text', 'general', DEFAULT_TIMEOUT, value => {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('expected a list of texts');
  return value;
});

function goalTextContents(root: string, directory: string): Promise<string[]> {
  return runHostOperation(goalText, { root, directory });
}
