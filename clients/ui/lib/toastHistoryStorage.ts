import { z } from "zod";

const toastEntriesSchema = z.array(z.object({
  id: z.string(), timestamp: z.number().min(0).max(8.64e15), source: z.string(), title: z.string(), message: z.string(),
}));

export type ToastHistoryEntry = z.infer<typeof toastEntriesSchema>[number];

export function mergeToastHistory(saved: ToastHistoryEntry[], additions: ToastHistoryEntry[]) {
  const entries = new Map([...saved, ...additions].map(entry => [entry.id, entry]));

  return [...entries.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-10);
}

function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-notification-history", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("history");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open notification history"));
  });
}

export async function syncToastHistory(additions: ToastHistoryEntry[]) {
  const database = await openHistory();

  try { return await updateHistory(database, additions); }
  finally { database.close(); }
}

function updateHistory(database: IDBDatabase, additions: ToastHistoryEntry[]): Promise<ToastHistoryEntry[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("history", "readwrite", { durability: "strict" });
    const store = transaction.objectStore("history");
    const request = store.get("recent");
    let result: ToastHistoryEntry[] = [];
    request.onsuccess = () => {
      try {
        const saved = request.result === undefined ? [] : toastEntriesSchema.parse(request.result);
        result = mergeToastHistory(saved, additions);
        store.put(result, "recent");
      } catch (error) { transaction.abort(); reject(error); }
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save notification history"));
  });
}
