import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";

const sizeSchema = z.number().finite();

const cache = new Map<string, number>();

const revisions = new Map<string, number>();

const pending = new Map<string, number>();

let saving = false;

function openSizes(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-panel-sizes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sizes");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open panel settings"));
  });
}

async function loadSize(key: string, fallback: number) {
  const database = await openSizes();

  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction("sizes", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("sizes");
      const request = store.get(key);
      let value = fallback;
      request.onsuccess = () => {
        try {
          value = request.result === undefined ? fallback : sizeSchema.parse(request.result);

          if (request.result === undefined) store.put(value, key);
        } catch (error) { transaction.abort(); reject(error); }
      };

      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not load panel size"));
    });
  } finally { database.close(); }
}

async function saveSizes(entries: [string, number][]) {
  const database = await openSizes();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("sizes", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("sizes");
      entries.forEach(([key, value]) => store.put(value, key));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save panel size"));
    });
  } finally { database.close(); }
}

function flushSizes() {
  if (saving || !pending.size) return;
  saving = true;
  const entries = [...pending];
  let succeeded = false;
  void saveSizes(entries).then(() => {
    for (const [key, value] of entries) if (pending.get(key) === value) pending.delete(key);
    succeeded = true;
  }).catch(error => { console.error("Could not save panel sizes", error); }).finally(() => {
    saving = false;

    if (succeeded) flushSizes();
  });
}

window.addEventListener("focus", flushSizes);

function legacySize(keys: string[], fallback: number, minimum: number) {
  try {
    const stored = keys.map(key => localStorage.getItem(key));
    const value = Number(stored.find(value => value !== null));

    return { value: Number.isFinite(value) && value >= minimum ? value : fallback, stored };
  } catch { return { value: fallback, stored: [] }; }
}

function removeLegacy(keys: string[], stored: (string | null)[]) {
  try { keys.forEach((key, index) => { if (localStorage.getItem(key) === stored[index]) localStorage.removeItem(key); }); } catch { }
}

export function createPanelSize(key: string, fallback: number, minimum: number, olderKeys: string[] = []): readonly [Accessor<number>, (value: number) => void] {
  const keys = [key, ...olderKeys];
  const legacy = legacySize(keys, fallback, minimum);
  const [size, setSize] = createSignal(cache.get(key) ?? legacy.value);
  const revision = revisions.get(key);
  const pendingAtStart = pending.has(key);
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => {
    flushSizes();
    void loadSize(key, legacy.value).then(saved => {
      removeLegacy(keys, legacy.stored);

      if (pendingAtStart || revisions.get(key) !== revision) return;
      const value = saved >= minimum ? saved : fallback;
      cache.set(key, value);

      if (!disposed) setSize(value);
    }).catch(error => { console.error("Could not restore panel size", error); });
  });

  const update = (value: number) => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    cache.set(key, value); setSize(value); pending.set(key, value); flushSizes();
  };

  return [size, update];
}
