import { IDBDatabase } from 'fake-indexeddb';

export function trackStorage(factory) {
  const pending = new Set();
  const track = (target, event) => {
    const settled = new Promise(resolve => {
      for (const name of [event, 'error', 'abort']) target.addEventListener(name, resolve, { once: true });
    });
    pending.add(settled); settled.then(() => pending.delete(settled));
    return target;
  };
  const open = factory.open;
  factory.open = (...args) => track(open.apply(factory, args), 'success');
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) { return track(transaction.apply(this, args), 'complete'); };
  return {
    async settled() { while (pending.size) await Promise.all([...pending]); await new Promise(resolve => setImmediate(resolve)); },
    restore() { factory.open = open; IDBDatabase.prototype.transaction = transaction; },
  };
}
