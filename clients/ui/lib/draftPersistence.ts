import { z } from "zod";
import type { DraftRecord, DraftSubmission } from "./draftState";
import { captureDaemonTransport } from "./platform";

export interface DraftSnapshot { records: DraftRecord[]; submissions: DraftSubmission[]; }

export function mergeDraftSnapshots(saved: DraftSnapshot, before: DraftSnapshot, after: DraftSnapshot): DraftSnapshot {
  const merge = <T>(saved: T[], before: T[], after: T[], key: (item: T) => string, stamp: (item: T) => number) => {
    const values = new Map(saved.map(item => [key(item), item]));
    const old = new Map(before.map(item => [key(item), item]));
    const next = new Map(after.map(item => [key(item), item]));
    const same = (left: T | undefined, right: T | undefined) => left === right || JSON.stringify(left) === JSON.stringify(right);
    for (const item of before) {
      const current = values.get(key(item));
      if (!next.has(key(item)) && same(current, item)) values.delete(key(item));
    }
    for (const item of after) {
      if (same(old.get(key(item)), item)) continue;
      const current = values.get(key(item));
      if (current === undefined || stamp(item) >= stamp(current)) values.set(key(item), item);
    }

    return [...values.values()];
  };

  return { records: merge(saved.records, before.records, after.records, item => item.key, item => item.updatedAt), submissions: merge(saved.submissions, before.submissions, after.submissions, item => item.id, item => item.createdAt) };
}

const destinationSchema = z.object({ key: z.string(), hostId: z.string(), cwd: z.string().optional(), sessionPath: z.string().optional(), temporary: z.boolean() });
const uploadsSchema = z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["image", "text"]), byteSize: z.number(), text: z.string().optional(), image: z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() }).optional() }));
const snapshotSchema = z.object({
  records: z.array(z.object({ key: z.string(), destination: destinationSchema.optional(), text: z.string(), uploads: uploadsSchema, updatedAt: z.number(), retrySubmission: z.object({ id: z.string(), fingerprint: z.string() }).optional() })),
  submissions: z.array(z.object({ id: z.string(), destination: destinationSchema, rawText: z.string(), uploads: uploadsSchema, status: z.enum(["preparing", "uncertain"]), createdAt: z.number(), error: z.string().optional() })),
});

export function createDraftPersistence() {
  const endpoint = captureDaemonTransport().identity;
  const channel = new BroadcastChannel("piop-drafts");
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-drafts", 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => { if (failed) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    request.onerror = () => reject(request.error ?? new Error("Could not open draft storage"));
    request.onblocked = () => { failed = true; reject(new Error("Another window is blocking draft storage")); };
  });
  let previous: DraftSnapshot = { records: [], submissions: [] };
  const transact = async (next?: DraftSnapshot) => {
    const db = await open();

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
            result = mergeDraftSnapshots(result, previous, next);
            store.put(result, endpoint);
          }
        } catch (reason) { transaction.abort(); reject(reason); }
      };
      transaction.oncomplete = () => { previous = result; resolve(result); };
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save drafts"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not access draft storage"));
    });
  };

  const access = async (next?: DraftSnapshot) => {
    try { return await transact(next); }
    catch (reason) {
      const failed = database;
      database = undefined;
      await failed?.then(db => db.close(), () => undefined);
      throw reason;
    }
  };

  return {
    read: async (value?: DraftSnapshot) => {
      const before = previous;
      const saved = await access();

      return value ? mergeDraftSnapshots(saved, before, value) : saved;
    },
    write: async (value: DraftSnapshot) => {
      const saved = await access(value);
      channel.postMessage(endpoint);

      return saved;
    },
    subscribe: (changed: () => void) => {
      const listener = (event: MessageEvent) => { if (event.data === endpoint) changed(); };
      channel.addEventListener("message", listener);

      return () => channel.removeEventListener("message", listener);
    },
    close: async () => { channel.close(); (await database)?.close(); },
  };
}
