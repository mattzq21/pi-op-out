import { z } from "zod";
import type { DraftRecord, DraftSubmission } from "./draftState";
import { captureDaemonTransport } from "./platform";

export interface DraftSnapshot { records: DraftRecord[]; submissions: DraftSubmission[]; }

const destinationSchema = z.object({ key: z.string(), hostId: z.string(), cwd: z.string().optional(), sessionPath: z.string().optional(), temporary: z.boolean() });
const uploadsSchema = z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["image", "text"]), byteSize: z.number(), text: z.string().optional(), image: z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() }).optional() }));
const snapshotSchema = z.object({
  records: z.array(z.object({ key: z.string(), destination: destinationSchema.optional(), text: z.string(), uploads: uploadsSchema, updatedAt: z.number(), retrySubmission: z.object({ id: z.string(), fingerprint: z.string() }).optional() })),
  submissions: z.array(z.object({ id: z.string(), destination: destinationSchema, rawText: z.string(), uploads: uploadsSchema, status: z.enum(["preparing", "uncertain"]), createdAt: z.number(), error: z.string().optional() })),
});

export function createDraftPersistence() {
  const endpoint = captureDaemonTransport().identity;
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-drafts", 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => { if (failed) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    request.onerror = () => reject(request.error ?? new Error("Could not open draft storage"));
    request.onblocked = () => { failed = true; reject(new Error("Another window is blocking draft storage")); };
  });
  let previous: DraftSnapshot = { records: [], submissions: [] };
  const transact = async (next?: DraftSnapshot) => {
    const db = await database;

    if (!endpoint) throw new Error("Connect to a host before saving drafts");

    return new Promise<DraftSnapshot>((resolve, reject) => {
      const transaction = db.transaction("drafts", next ? "readwrite" : "readonly", { durability: "strict" });
      const store = transaction.objectStore("drafts");
      const request = store.get(endpoint);
      let result: DraftSnapshot;
      request.onsuccess = () => {
        try {
          result = request.result === undefined ? { records: [], submissions: [] } : snapshotSchema.parse(request.result);

          if (next) {
            const merge = <T>(saved: T[], before: T[], after: T[], key: (item: T) => string) => {
              const values = new Map(saved.map(item => [key(item), item]));
              const old = new Map(before.map(item => [key(item), item]));
              for (const item of before) if (!after.some(value => key(value) === key(item))) values.delete(key(item));
              for (const item of after) if (old.get(key(item)) !== item) values.set(key(item), item);

              return [...values.values()];
            };
            result = { records: merge(result.records, previous.records, next.records, item => item.key), submissions: merge(result.submissions, previous.submissions, next.submissions, item => item.id) };
            store.put(result, endpoint);
          }
        } catch (reason) { transaction.abort(); reject(reason); }
      };
      transaction.oncomplete = () => { previous = next ?? result; resolve(result); };
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save drafts"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not access draft storage"));
    });
  };

  return { read: () => transact(), write: (value: DraftSnapshot) => transact(value), close: async () => (await database).close() };
}
