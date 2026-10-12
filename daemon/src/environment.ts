import { realpathSync, statSync } from 'node:fs';
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

export function piExecutable(): string {
  let home: string | undefined;
  try { home = homeDir(); } catch {}
  return piExecutableIn(home);
}

export function piExecutableIn(home: string | undefined): string {
  if (home) {
    for (const candidate of [join(home, '.local/bin/pi'), join(home, '.npm-global/bin/pi'), join(home, '.bun/bin/pi')]) if (isFile(candidate)) return candidate;
  }
  return piOnPath() ?? 'pi';
}

function piOnPath(): string | undefined {
  const paths = process.env.PATH;
  if (!paths) return undefined;
  return paths.split(delimiter).map(directory => join(directory, 'pi')).find(isFile);
}

/**
 * The Node.js executable that runs Pi. It prefers the Node.js that installed Pi (for example an nvm
 * install next to Pi), so a daemon started without the user's shell PATH still finds it.
 */
export function nodeExecutable(): string {
  const pi = piExecutable();
  if (isAbsolute(pi)) {
    const candidates = [join(dirname(pi), 'node')];
    try {
      for (let directory = dirname(realpathSync(pi)); directory !== dirname(directory); directory = dirname(directory)) {
        candidates.push(join(directory, 'bin', 'node'));
      }
    } catch {}
    const found = candidates.find(isFile);
    if (found) return found;
  }
  const paths = process.env.PATH;
  const found = paths?.split(delimiter).filter(Boolean).map(directory => join(directory, 'node')).find(isFile);
  if (found) return found;
  return ['/usr/local/bin/node', '/usr/bin/node'].find(isFile) ?? 'node';
}

/** PATH with the directory of the given Node.js first, so Pi and its child processes use the same Node.js. */
export function pathWithNode(node: string): string | undefined {
  const paths = process.env.PATH;
  if (!isAbsolute(node)) return paths;
  const directory = dirname(node);
  const entries = (paths ?? '').split(delimiter).filter(entry => entry && entry !== directory);
  return [directory, ...entries].join(delimiter);
}

export function codexExecutable(): string {
  try {
    const home = homeDir();
    for (const candidate of [join(home, '.local/bin/codex'), join(home, '.npm-global/bin/codex'), join(home, '.bun/bin/codex')]) if (isFile(candidate)) return candidate;
  } catch {}
  return 'codex';
}
