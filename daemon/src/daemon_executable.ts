import { resolve } from 'node:path';

// The file of this daemon: the executable, or the script that Bun runs in development.
export function daemonScript(): string { return Bun.isStandaloneExecutable ? process.execPath : resolve(process.argv[1] ?? ''); }
