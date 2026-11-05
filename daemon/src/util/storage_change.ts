import { mkdirSync, watch, type FSWatcher } from 'node:fs';

// Runs check now, after each change of the file signal in directory, and when a promise of also settles, until check
// gives a value or ms pass. Writers change the signal file after they commit, so check then sees the commit. Gives
// undefined when the time is up; throws when a promise of also or the watcher fails.
export async function untilSignal<T>(directory: string, signal: string, check: () => Promise<T | undefined> | T | undefined, ms: number, also: Promise<unknown>[] = []): Promise<T | undefined> {
  let wake: (() => void) | undefined;
  let changed = true;
  let failure: { error: unknown } | undefined;
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const fail = (error: unknown) => { failure ??= { error }; wake?.(); };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    watcher = watch(directory, (_event, name) => {
      if (name !== null && String(name) !== signal) return;
      changed = true;
      wake?.();
    });
    watcher.on('error', fail);
    timer = setTimeout(() => { timedOut = true; wake?.(); }, Math.max(ms, 0));
    for (const promise of also) promise.then(() => { changed = true; wake?.(); }, fail);
    for (;;) {
      if (failure) throw failure.error;
      if (changed) {
        changed = false;
        const value = await check();
        if (value !== undefined) return value;
      }
      if (timedOut) return undefined;
      if (!changed && !failure) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
  } finally {
    clearTimeout(timer);
    watcher?.close();
  }
}
