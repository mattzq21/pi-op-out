import { dlopen, type FFIFunction } from 'bun:ffi';

// The C library of this Linux system: glibc, or musl on systems such as Alpine.
const MACHINE: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

let found: string | undefined;

// The name that dlopen loads the C library by. Found once.
export function libcName(): string {
  if (found) return found;
  const failures: string[] = [];
  for (const name of ['libc.so.6', 'libc.musl-' + (MACHINE[process.arch] ?? process.arch) + '.so.1']) {
    try {
      dlopen(name, { getpid: { args: [], returns: 'i32' } }).close();
      return found = name;
    } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); }
  }
  throw new Error('Cannot load the C library (' + failures.join('; ') + ')');
}

export function loadLibc<Symbols extends Record<string, FFIFunction>>(symbols: Symbols) {
  return dlopen(libcName(), symbols);
}
