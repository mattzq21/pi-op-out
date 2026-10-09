import { z } from "zod";

type ClientKind = "desktop" | "mobile";

const identities = new Map<ClientKind, Promise<string>>();

const identitySchema = z.string().min(1);

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-client-identities", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("identities");
    request.onsuccess = () => {
      if (blocked) { request.result.close();

 return; }

      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };

    request.onerror = () => reject(request.error ?? new Error("Could not open client identity storage"));
    request.onblocked = () => { blocked = true; reject(new Error("Another window is preventing client identity storage from opening")); };
  });
}

function freshIdentity(kind: ClientKind) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;

  return `${kind}:${id}`;
}

function readOrCreate(database: IDBDatabase, kind: ClientKind) {
  return new Promise<string>((resolve, reject) => {
    const transaction = database.transaction("identities", "readwrite", { durability: "strict" });
    const store = transaction.objectStore("identities");
    const request = store.get(kind);
    let result: string | undefined;
    let failure: Error | undefined;
    request.onsuccess = () => {
      try {
        result = request.result === undefined ? freshIdentity(kind) : identitySchema.parse(request.result);

        if (request.result === undefined) store.put(result, kind);
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
    };

    transaction.oncomplete = () => result ? resolve(result) : reject(new Error("Client identity is missing"));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Could not save client identity"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not read client identity"));
  });
}

async function loadIdentity(kind: ClientKind) {
  const database = await openDatabase();

  try {
    return await readOrCreate(database, kind);
  } finally { database.close(); }
}

export function clientIdentity(kind: ClientKind): Promise<string> {
  const saved = identities.get(kind);

  if (saved) return saved;
  const pending = loadIdentity(kind).catch(error => { identities.delete(kind); throw error; });
  identities.set(kind, pending);

  return pending;
}
