import { statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export function homeDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is not set');
  return home;
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

// The Node.js that runs Pi: the user's own in ~/.local/bin, else the one on PATH, else a system one.
export function nodeExecutable(): string {
  const home = process.env.HOME;
  const own = home ? join(home, '.local/bin/node') : undefined;
  if (own && isFile(own)) return own;
  const found = process.env.PATH?.split(delimiter).filter(Boolean).map(directory => join(directory, 'node')).find(isFile);
  return found ?? ['/usr/local/bin/node', '/usr/bin/node'].find(isFile) ?? 'node';
}

export function pathWithNode(node: string): string | undefined {
  const paths = process.env.PATH;
  if (!isAbsolute(node)) return paths;
  const directory = dirname(node);
  const entries = (paths ?? '').split(delimiter).filter(entry => entry && entry !== directory);
  return [directory, ...entries].join(delimiter);
}

export function codexExecutable(): string {
  const home = process.env.HOME;
  if (home) for (const candidate of [join(home, '.local/bin/codex'), join(home, '.npm-global/bin/codex'), join(home, '.bun/bin/codex')]) if (isFile(candidate)) return candidate;
  return 'codex';
}
