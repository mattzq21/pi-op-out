import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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

export function codexExecutable(): string {
  try {
    const home = homeDir();
    for (const candidate of [join(home, '.local/bin/codex'), join(home, '.npm-global/bin/codex'), join(home, '.bun/bin/codex')]) if (isFile(candidate)) return candidate;
  } catch {}
  return 'codex';
}
