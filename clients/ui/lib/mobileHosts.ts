import { validateHost } from "./remoteClient";
import { z } from "zod";

export interface SavedMobileHost { name: string; url: string }

const key = "piop-mobile-hosts";

const hostSchema = z.object({ name: z.string(), url: z.string(), position: z.number().int().nonnegative().optional() });

const hostListSchema = z.array(z.unknown()).catch([]);

function parseHosts(stored: z.infer<typeof hostListSchema>): SavedMobileHost[] {
  return stored.flatMap(item => {
    const host = hostSchema.safeParse(item);

    if (!host.success) return [];

    try { return [{ name: host.data.name, url: validateHost({ url: host.data.url }), position: host.data.position }]; } catch { return []; }
  }).sort((left, right) => (left.position ?? 0) - (right.position ?? 0)).map(({ name, url }) => ({ name, url }));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-mobile-hosts", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("hosts", { keyPath: "url" });
      request.result.createObjectStore("state");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedHosts(change?: (hosts: SavedMobileHost[]) => SavedMobileHost[]): Promise<SavedMobileHost[]> {
  const database = await openDatabase();
  let legacy: string | null = null;

  try { legacy = localStorage.getItem(key); } catch { }

  try {
    const result = await hostTransaction(database, legacy, change);

    try { if (localStorage.getItem(key) === legacy) localStorage.removeItem(key); } catch { }

    return result;
  } finally { database.close(); }
}

function hostTransaction(database: IDBDatabase, legacy: string | null, change?: (hosts: SavedMobileHost[]) => SavedMobileHost[]): Promise<SavedMobileHost[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["hosts", "state"], "readwrite");
    const hosts = transaction.objectStore("hosts");
    const state = transaction.objectStore("state");
    let result: SavedMobileHost[] = [];
    const imported = state.get("imported");
    imported.onsuccess = () => {
      if (!imported.result) {
        legacyHosts(legacy).forEach((host, position) => hosts.put({ ...host, position }));
        state.put(true, "imported");
      }

      const request = hosts.getAll();
      request.onsuccess = () => {
        result = parseHosts(hostListSchema.parse(request.result));

        if (change) {
          result = change(result);
          hosts.clear();
          result.forEach((host, position) => hosts.put({ ...host, position }));
        }
      };
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save mobile hosts"));
  });
}

function legacyHosts(value: string | null) {
  try { return parseHosts(hostListSchema.parse(JSON.parse(value ?? "[]"))); } catch { return []; }
}

export function readMobileHosts(): Promise<SavedMobileHost[]> { return storedHosts(); }

export function saveMobileHost(address: string, name: string): Promise<SavedMobileHost[]> {
  const url = validateHost({ url: address.trim() });

  return storedHosts(hosts => {
    const previous = hosts.find(host => host.url === url);
    const host = { url, name: name.trim() || previous?.name || new URL(url).hostname };

    return [...hosts.filter(item => item.url !== url), host];
  });
}

export async function removeMobileHost(url: string): Promise<SavedMobileHost[]> {
  const next = await storedHosts(hosts => hosts.filter(host => host.url !== url));
  const last = localStorage.getItem("piop-mobile-host");

  if (last && validateHost({ url: last }) === url) localStorage.removeItem("piop-mobile-host");

  return next;
}
