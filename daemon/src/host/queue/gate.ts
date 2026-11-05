import { Mutex } from '../../util/sync';

// The queue's lock. A stop holds it while Pi stops, but Pi can only stop after its queue
// requests are answered, so the stop lends the lock to those requests until it ends.
export class QueueGate {
  private gate = new Mutex();
  private lent: Mutex | null = null;
  private borrowers = new Set<(lock: Mutex) => void>();

  lock(): Promise<() => void> { return this.gate.lock(); }

  // For Pi's queue requests: the gate, or the lent lock while a stop holds the gate.
  runtimeLock(): Promise<() => void> {
    const lent = this.lent;
    if (lent) return lent.lock();
    return new Promise(resolve => {
      let settled = false;
      const borrow = (lock: Mutex) => {
        if (settled) return;
        settled = true;
        this.borrowers.delete(borrow);
        void lock.lock().then(resolve);
      };
      this.borrowers.add(borrow);
      void this.gate.lock().then(release => {
        if (settled) { release(); return; }
        settled = true;
        this.borrowers.delete(borrow);
        resolve(release);
      });
    });
  }

  // For a stop: holds the gate and lends it to Pi's queue requests until the returned release.
  async lockLending(): Promise<() => void> {
    const release = await this.gate.lock();
    const lent = new Mutex();
    this.lent = lent;
    for (const borrow of [...this.borrowers]) borrow(lent);
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.lent = null;
      void lent.lock().then(back => { back(); release(); });
    };
  }
}
