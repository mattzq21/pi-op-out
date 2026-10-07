import { z } from "zod";
import { isMobile } from "./platform";
import { nativeConnectionTargetSchema } from "./sessionResume";
import type { NativeConnectionTarget } from "./nativeTransport";
import type { ComposerUpload } from "../types";

const imageSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() });

const uploadFields = { id: z.string(), name: z.string(), byteSize: z.number().nonnegative() };

const uploadSchema = z.discriminatedUnion("kind", [
  z.object({ ...uploadFields, kind: z.literal("image"), image: imageSchema }),
  z.object({ ...uploadFields, kind: z.literal("text"), text: z.string() }),
]);

const draftSchema = z.object({
  text: z.string(), uploads: z.array(uploadSchema), target: nativeConnectionTargetSchema.optional(), updatedAt: z.number(),
});

const storedDraftSchema = draftSchema.extend({ namespace: z.string(), key: z.string(), revision: z.string() });

export interface ConversationDraft { text: string; uploads: ComposerUpload[]; target?: NativeConnectionTarget; updatedAt: number; }

export type DraftChanges = Map<string, ConversationDraft | undefined>;

type Drafts = Record<string, ConversationDraft>;

function storageNamespace() {
  return isMobile ? localStorage.getItem("piop-mobile-host") ?? "mobile" : "desktop";
}

function legacyDrafts(namespace: string | undefined, onError: (message: string) => void) {
  const drafts: Drafts = {};

  if (!namespace) return drafts;

  try {
    const stored = z.record(z.string(), z.unknown()).parse(JSON.parse(localStorage.getItem(`piop-conversation-drafts:v1:${namespace}`) ?? "{}"));

    for (const [key, value] of Object.entries(stored)) {
      const text = z.string().safeParse(value);

      if (text.success && text.data) drafts[key] = { text: text.data, uploads: [], updatedAt: 0 };
      else if (!text.success) onError(`Could not restore draft ${key}: its saved text is invalid.`);
    }

    return drafts;
  } catch (reason) {
    onError(`Could not restore older drafts. ${String(reason)}`);

    return drafts;
  }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-conversation-drafts", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("drafts", { keyPath: ["namespace", "key"] });
      store.createIndex("namespace", "namespace");
    };

    request.onerror = () => reject(request.error ?? new Error("Draft storage could not be opened"));

    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other Piop windows and retry saving the draft"));
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();

      if (blocked) database.close();
      else resolve(database);
    };
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Draft storage transaction was interrupted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Draft storage transaction failed"));
  });
}

function readDrafts(database: IDBDatabase, namespace: string, revisions: Map<string, string>, onError: (message: string) => void) {
  return new Promise<Drafts>((resolve, reject) => {
    const transaction = database.transaction("drafts", "readonly");
    const request = transaction.objectStore("drafts").index("namespace").getAll(namespace);
    const result: Drafts = {};
    const loaded = new Map<string, string>();
    transaction.onabort = () => reject(transaction.error ?? new Error("Saved drafts could not be read"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Saved drafts could not be read"));
    transaction.oncomplete = () => {
      revisions.clear();

      for (const [key, revision] of loaded) revisions.set(key, revision);
      resolve(result);
    };

    request.onsuccess = () => {
      for (const value of z.array(z.unknown()).parse(request.result)) {
        const parsed = storedDraftSchema.safeParse(value);

        if (parsed.success) {
          result[parsed.data.key] = parsed.data;
          loaded.set(parsed.data.key, parsed.data.revision);
        }
        else onError("A saved draft is damaged and could not be restored. Other drafts remain available.");
      }
    };
  });
}

async function migrateDrafts(database: IDBDatabase, namespace: string, drafts: Drafts) {
  const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
  const done = transactionDone(transaction);
  const store = transaction.objectStore("drafts");

  for (const [key, draft] of Object.entries(drafts)) {
    const request = store.get([namespace, key]);
    request.onsuccess = () => {
      if (request.result === undefined) store.put({ ...draft, namespace, key, revision: crypto.randomUUID() });
    };
  }

  await done;
}

function revisionMatches(value: z.JSONType | undefined, expected: string | undefined) {
  if (value === undefined) return expected === undefined;
  const parsed = z.object({ revision: z.string() }).safeParse(value);

  return expected !== undefined && parsed.success && parsed.data.revision === expected;
}

async function writeDrafts(database: IDBDatabase, namespace: string, changes: DraftChanges, revisions: Map<string, string>) {
  const validated = [...changes].map(([key, draft]) => ({ key, draft: draft ? draftSchema.parse(draft) : undefined }));
  const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
  const done = transactionDone(transaction);
  const store = transaction.objectStore("drafts");
  const saved = new Map<string, string | undefined>();
  let failure: Error | undefined;

  for (const { key, draft } of validated) {
    const request = store.get([namespace, key]);
    request.onsuccess = () => {
      if (!revisionMatches(request.result, revisions.get(key))) {
        failure = new Error("This draft changed in another Piop window. Your current version remains here; copy it before reloading this window.");
        transaction.abort();

        return;
      }

      const revision = draft ? crypto.randomUUID() : undefined;

      try {
        if (draft) store.put({ ...draft, namespace, key, revision });
        else store.delete([namespace, key]);
        saved.set(key, revision);
      } catch (reason) {
        failure = new Error(String(reason));
        transaction.abort();
      }
    };
  }

  try { await done; }
  catch (reason) { throw failure ?? reason; }

  for (const [key, revision] of saved) {
    if (revision) revisions.set(key, revision);
    else revisions.delete(key);
  }
}

async function migrateLegacy(database: IDBDatabase, namespace: string, onError: (message: string) => void) {
  const key = `piop-conversation-drafts:v1:${namespace}`;
  let before: string | null;

  try { before = localStorage.getItem(key); }
  catch (reason) { onError(`Could not read older drafts. ${String(reason)}`);

    return; }

  const older = legacyDrafts(namespace, onError);

  if (!Object.keys(older).length) return;
  await migrateDrafts(database, namespace, older);

  try {
    if (localStorage.getItem(key) !== before) return;
    const remaining = z.record(z.string(), z.unknown()).parse(JSON.parse(before ?? "{}"));

    for (const draftKey of Object.keys(older)) delete remaining[draftKey];

    if (Object.keys(remaining).length) localStorage.setItem(key, JSON.stringify(remaining));
    else localStorage.removeItem(key);
  } catch (reason) { onError(`Drafts were migrated, but their older copy could not be removed. ${String(reason)}`); }
}

export function createDraftStorage(onError: (message: string) => void) {
  let namespace: string | undefined;
  const revisions = new Map<string, string>();

  try { namespace = storageNamespace(); }
  catch (reason) { onError(`Could not identify this host's draft storage. ${String(reason)}`); }

  const legacy = legacyDrafts(namespace, onError);

  const withDatabase = async <T>(operation: (database: IDBDatabase, scope: string) => Promise<T>) => {
    namespace ??= storageNamespace();

    if (!namespace) throw new Error("Draft storage is unavailable for this host");
    const database = await openDatabase();

    try { return await operation(database, namespace); }
    finally { database.close(); }
  };

  const load = () => withDatabase(async (database, scope) => {
    await migrateLegacy(database, scope, onError);

    return readDrafts(database, scope, revisions, onError);
  });

  const save = (changes: DraftChanges) => withDatabase((database, scope) => writeDrafts(database, scope, changes, revisions));

  return { legacy, load, save };
}
