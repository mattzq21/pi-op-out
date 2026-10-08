import { z } from "zod";

export type DraftStore = "drafts" | "submissions";

export interface DraftMutation { store: DraftStore; id: string; value?: z.JSONType }

const keyFor = (store: DraftStore, id: string) => JSON.stringify([store, id]);

export class DraftStorageConflict extends Error {
  constructor() { super("Saved input changed in another Piop window. This window's input is still here, and the other window's saved content has not been overwritten. Copy any input you want to keep before reloading the changed items."); }
}

export class DraftRevisions {
  private readonly observed = new Map<string, string>();
  private readonly changed = new Map<string, { store: DraftStore; id: string }>();

  count() { return this.changed.size; }

  reset() { this.observed.clear(); this.changed.clear(); }

  observe(store: DraftStore, id: string, value: z.JSONType | undefined) {
    const key = keyFor(store, id);
    const token = JSON.stringify(value);

    if (token === undefined) this.observed.delete(key);
    else this.observed.set(key, token);
  }

  accept(changes: DraftMutation[]) {
    for (const change of changes) {
      this.observe(change.store, change.id, change.value);
      this.changed.delete(keyFor(change.store, change.id));
    }
  }

  check(transaction: IDBTransaction, changes: DraftMutation[], done: (failure?: DraftStorageConflict) => void) {
    let pending = changes.length;
    let conflict = false;

    if (!pending) { done();

      return; }

    for (const change of changes) {
      const request = transaction.objectStore(change.store).get(change.id);
      request.onsuccess = () => {
        const key = keyFor(change.store, change.id);

        if (this.changed.has(key) || JSON.stringify(request.result) !== this.observed.get(key)) {
          conflict = true;
          this.changed.set(key, { store: change.store, id: change.id });
        }

        pending -= 1;

        if (!pending) {
          if (conflict) for (const item of changes) this.changed.set(keyFor(item.store, item.id), { store: item.store, id: item.id });
          done(conflict ? new DraftStorageConflict() : undefined);
        }
      };
    }
  }

  readChanged(transaction: IDBTransaction) {
    const records: DraftMutation[] = [];

    for (const change of this.changed.values()) {
      const request = transaction.objectStore(change.store).get(change.id);
      request.onsuccess = () => { records.push({ ...change, value: request.result }); };
    }

    return records;
  }
}
