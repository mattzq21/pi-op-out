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

async function storedHosts(change?: (hosts: SavedMobileHost[]) => SavedMobileHost[], forgotten?: string): Promise<SavedMobileHost[]> {
  const database = await openDatabase();
  let legacy: string | null = null;

  try { legacy = localStorage.getItem(key); } catch { }

  try {
    const result = await hostTransaction(database, legacy, change, forgotten);

    if (result.connection) rememberConnection(result.connection);

    try { if (localStorage.getItem(key) === legacy) localStorage.removeItem(key); } catch { }

    return result.hosts;
  } finally { database.close(); }
}

function hostTransaction(database: IDBDatabase, legacy: string | null, change?: (hosts: SavedMobileHost[]) => SavedMobileHost[], forgotten?: string): Promise<{ hosts: SavedMobileHost[]; connection?: MobileConnection }> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["hosts", "state"], "readwrite");
    const hosts = transaction.objectStore("hosts");
    const state = transaction.objectStore("state");
    let result: SavedMobileHost[] = [];
    let connection: MobileConnection | undefined;

    if (forgotten !== undefined) {
      const request = state.get("connection");
      request.onsuccess = () => {
        try {
          connection = withoutHost(request.result === undefined ? legacyConnection() : connectionSchema.parse(request.result), forgotten);
          state.put(connection, "connection");
        } catch (error) { transaction.abort(); reject(error); }
      };
    }

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

    transaction.oncomplete = () => resolve({ hosts: result, connection });
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

export function removeMobileHost(url: string): Promise<SavedMobileHost[]> {
  return storedHosts(hosts => hosts.filter(host => host.url !== url), url);
}

function withoutHost(saved: MobileConnection, url: string): MobileConnection {
  return saved.lastHost && validateHost({ url: saved.lastHost }) === url ? { ...saved, lastHost: "" } : saved;
}

const connectionSchema = z.object({ lastHost: z.string(), autoReconnect: z.boolean() });

type MobileConnection = z.infer<typeof connectionSchema>;

function legacyConnection(): MobileConnection {
  try { return { lastHost: localStorage.getItem("piop-mobile-host") ?? "", autoReconnect: localStorage.getItem("piop-mobile-auto-reconnect") === "true" }; }
  catch { return { lastHost: "", autoReconnect: false }; }
}

let connectionCache = legacyConnection();

export function cachedMobileHost() { return connectionCache.lastHost; }

async function connectionSettings(change?: (saved: MobileConnection) => MobileConnection): Promise<MobileConnection> {
  const database = await openDatabase();

  try {
    const saved = await connectionTransaction(database, change);
    rememberConnection(saved);

    return saved;
  } finally { database.close(); }
}

function rememberConnection(saved: MobileConnection) {
  connectionCache = saved;

  try {
    localStorage.removeItem("piop-mobile-host");
    localStorage.removeItem("piop-mobile-auto-reconnect");
  } catch { }
}

function connectionTransaction(database: IDBDatabase, change?: (saved: MobileConnection) => MobileConnection): Promise<MobileConnection> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("state", "readwrite");
    const state = transaction.objectStore("state");
    const request = state.get("connection");
    let result: MobileConnection;
    request.onsuccess = () => {
      try {
        const saved = request.result === undefined ? legacyConnection() : connectionSchema.parse(request.result);
        result = change ? change(saved) : saved;
        state.put(result, "connection");
      } catch (error) { transaction.abort(); reject(error); }
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save mobile connection settings"));
  });
}

export function readMobileConnection() { return connectionSettings(); }

export function saveMobileConnection(change: Partial<MobileConnection>) {
  return connectionSettings(saved => ({ ...saved, ...change }));
}
