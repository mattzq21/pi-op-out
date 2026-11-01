import { Mutex } from '../util/sync';

export async function lockGate(map: Map<string, Mutex>, key: string): Promise<() => void> {
  let found = map.get(key);
  if (!found) { found = new Mutex(); map.set(key, found); }
  const mutex = found;
  const release = await mutex.lock();
  return () => {
    release();
    if (!mutex.isLocked && map.get(key) === mutex) map.delete(key);
  };
}
