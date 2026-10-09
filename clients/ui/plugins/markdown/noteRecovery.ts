import { z } from "zod";

const recoverySchema = z.object({
  scope: z.string(), id: z.string(), revision: z.string(), content: z.string(), baseVersion: z.string(), updatedAt: z.number(),
});


export type NoteRecovery = z.infer<typeof recoverySchema>;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-note-recovery", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("edits", { keyPath: ["scope", "id"] }).createIndex("scope", "scope");
    request.onerror = () => reject(request.error ?? new Error("Note recovery storage could not be opened"));
    request.onblocked = () => { blocked = true; reject(new Error("Close other Piop windows and retry note recovery")); };

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
    transaction.onabort = () => reject(transaction.error ?? new Error("Note recovery storage was interrupted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Note recovery storage failed"));
  });
}

async function readRecoveries(database: IDBDatabase, scope: string, warnings: string[]) {
  const transaction = database.transaction("edits", "readonly");
  const done = transactionDone(transaction);
  const request = transaction.objectStore("edits").index("scope").getAll(scope);
  await done;

  const values: NoteRecovery[] = [];

  for (const item of z.array(z.unknown()).parse(request.result)) {
    const parsed = recoverySchema.safeParse(item);

    if (parsed.success) values.push(parsed.data);
    else warnings.push("A saved note edit is damaged and could not be restored. Its stored copy was retained.");
  }

  return values.sort((left, right) => right.updatedAt - left.updatedAt);
}

async function writeRecovery(database: IDBDatabase, recovery: NoteRecovery) {
  const transaction = database.transaction("edits", "readwrite", { durability: "strict" });
  const done = transactionDone(transaction);
  transaction.objectStore("edits").put(recovery);
  await done;
}

async function removeRecovery(database: IDBDatabase, recovery: NoteRecovery) {
  const transaction = database.transaction("edits", "readwrite", { durability: "strict" });
  const done = transactionDone(transaction);
  const store = transaction.objectStore("edits");
  const key = [recovery.scope, recovery.id];
  const request = store.get(key);
  request.onsuccess = () => {
    const saved = recoverySchema.safeParse(request.result);

    if (saved.success && saved.data.revision === recovery.revision) store.delete(key);
  };

  await done;
}

export function createNoteRecovery(identity: string | undefined, hostId: string, sessionId: string, id: string) {
  const scope = JSON.stringify([identity, hostId, sessionId]);

  const withDatabase = async <T>(operation: (database: IDBDatabase) => Promise<T>) => {
    if (!identity) throw new Error("Reconnect to this note's host to access its recovery copies");
    const database = await openDatabase();

    try { return await operation(database); }
    finally { database.close(); }
  };

  const load = () => withDatabase(async database => {
    const warnings: string[] = [];



    return { copies: await readRecoveries(database, scope, warnings), warnings };
  });

  const create = (content: string, baseVersion: string): NoteRecovery => ({ scope, id, revision: crypto.randomUUID(), content, baseVersion, updatedAt: Date.now() });
  const save = (recovery: NoteRecovery) => withDatabase(database => writeRecovery(database, recovery));
  const remove = (recovery: NoteRecovery) => withDatabase(database => removeRecovery(database, recovery));

  return { load, create, save, remove };
}
