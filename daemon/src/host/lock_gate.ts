import { Mutex } from '../util/sync';

// One lock for each key. A key's lock exists only while someone holds or waits for it.
export class KeyedLocks {
  private locks = new Map<string, Mutex>();

  async lock(key: string): Promise<() => void> {
    let found = this.locks.get(key);
    if (!found) { found = new Mutex(); this.locks.set(key, found); }
    const mutex = found;
    return this.releaser(key, mutex, await mutex.lock());
  }

  private releaser(key: string, mutex: Mutex, release: () => void): () => void {
    return () => {
      release();
      if (!mutex.isLocked && this.locks.get(key) === mutex) this.locks.delete(key);
    };
  }
}
