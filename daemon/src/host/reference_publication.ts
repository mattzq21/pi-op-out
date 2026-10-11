import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { STORAGE_DIRECTORY } from '../config';
import { goalDependencies } from '../resources';
import * as Registry from '../session_registry';
import { lockPath, type FileLock } from '../util/flock';

export async function lock(root: string): Promise<FileLock> {
  const path = join(root, 'reference-publication.lock');
  const result = await lockPath(path, { blocking: true, shared: true, nofollow: true, regularFile: 'Invalid reference publication lock' });
  if (!result) throw new Error('Could not lock ' + path);
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

async function goalTextContents(root: string, directory: string): Promise<string[]> {
  const module = goalDependencies.replaceAll("require('../session-database.cjs')", "require('./session-database.cjs')");
  const script = Registry.withDatabase('const goalTextFiles = (() => { const module = {exports: {}}; ' + module + '\nreturn module.exports; })();\nprocess.stdout.write(JSON.stringify(goalTextFiles.textContents(process.argv[1], process.argv[2]).map(entry => entry.text)));');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, root, directory], { env: { ...process.env, BUN_BE_BUN: '1', PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputSize = 0, errorSize = 0;
    let failure: Error | undefined;
    const collect = (chunks: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (failure) return;
      if (stream === 'stdout') outputSize += chunk.length; else errorSize += chunk.length;
      if (outputSize > 1024 * 1024 * 1024 || errorSize > 1024 * 1024 * 1024) {
        failure = Object.assign(new Error('spawnSync ' + process.execPath + ' ENOBUFS'), { code: 'ENOBUFS' });
        child.kill();
      } else chunks.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(stderr, chunk, 'stderr'));
    child.on('error', reject);
    child.stdout.on('error', error => { failure = error; child.kill(); });
    child.stderr.on('error', error => { failure = error; child.kill(); });
    child.on('close', status => {
      if (failure) { reject(failure); return; }
      if (status !== 0) { reject(new Error(Buffer.concat(stderr).toString().trim())); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString())); } catch (error) { reject(error); }
    });
  });
}
