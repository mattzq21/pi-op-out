import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { isDatabaseChange } from '../../resources/session-database.ts';

// Runs check now and after each change of the storage database in directory, until check gives a value or ms pass.
// The kernel tells of each change (inotify), so nothing is read again and again. When also settles, check runs again
// too: it is for a change that the database does not show, such as the end of a process. Gives undefined when the
// time is up.
export async function untilStorageChange<T>(directory: string, check: () => Promise<T | undefined> | T | undefined, ms: number, also?: Promise<unknown>): Promise<T | undefined> {
  let wake: (() => void) | undefined;
  let changed = true;
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    watcher = watch(directory, (_event, name) => {
      if (name !== null && !isDatabaseChange(String(name))) return;
      changed = true;
      wake?.();
    });
    timer = setTimeout(() => { timedOut = true; wake?.(); }, Math.max(ms, 0));
    void also?.finally(() => { changed = true; wake?.(); });
    for (;;) {
      if (changed) {
        changed = false;
        const value = await check();
        if (value !== undefined) return value;
      }
      if (timedOut) return undefined;
      if (!changed) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
  } finally {
    clearTimeout(timer);
    watcher?.close();
  }
}
