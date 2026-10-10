import { hostIdentity } from "./hostIdentity";
import { validateHost } from "./remoteClient";
import { z } from "zod";

export interface SavedMobileHost { name: string; url: string }


const hostSchema = z.object({ name: z.string().trim().min(1), url: z.string(), position: z.number().int().nonnegative().optional() });

let savedHostCache: SavedMobileHost[] = [];

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


  try {
    const result = await hostTransaction(database, change, forgotten);

    if (result.connection) rememberConnection(result.connection);


    savedHostCache = result.hosts;

    return result.hosts;
  } finally { database.close(); }
}

function hostTransaction(database: IDBDatabase, change?: (hosts: SavedMobileHost[]) => SavedMobileHost[], forgotten?: string): Promise<{ hosts: SavedMobileHost[]; connection?: MobileConnection }> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["hosts", "state"], "readwrite", { durability: "strict" });
    const hosts = transaction.objectStore("hosts");
    const state = transaction.objectStore("state");
    let result: SavedMobileHost[] = [];
    let connection: MobileConnection | undefined;

    if (forgotten !== undefined) {
      const request = state.get("connection");
      request.onsuccess = () => {
        try {
          connection = withoutHost(request.result === undefined ? { lastHost: "", autoReconnect: false } : connectionSchema.parse(request.result), forgotten);
          state.put(connection, "connection");
        } catch (error) { transaction.abort(); reject(error); }
      };
    }

    {
      const request = hosts.getAll();
      request.onsuccess = () => {
        try {
          result = parseHosts(hostListSchema.parse(request.result));

          if (change) {
            result = change(result);
            hosts.clear();
            result.forEach((host, position) => hosts.put({ ...host, position }));
          }
        } catch (error) { transaction.abort(); reject(error); }
      };
    }

;

    transaction.oncomplete = () => resolve({ hosts: result, connection });
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save mobile hosts"));
  });
}

export function readMobileHosts(): Promise<SavedMobileHost[]> { return storedHosts(); }

export function mobileDraftHostId(address: string) {
  const host = savedHostCache.find(item => item.url === address);

  if (!host) throw new Error("Save a named host before opening drafts");

  return hostIdentity(host.name);
}

export function validateMobileHost(address: string, name: string, hosts: SavedMobileHost[]): SavedMobileHost {
  const url = validateHost({ url: address.trim() });
  const label = name.trim();

  if (!label) throw new Error("Enter a host name");

  if (hosts.some(host => host.url !== url && hostIdentity(host.name) === hostIdentity(label))) throw new Error("Choose a different host name. This name is already saved.");

  return { url, name: label };
}

export function saveMobileHost(address: string, name: string): Promise<SavedMobileHost[]> {
  return storedHosts(hosts => {
    const host = validateMobileHost(address, name, hosts);

    return [...hosts.filter(item => item.url !== host.url), host];
  });
}

export async function removeMobileHost(url: string): Promise<SavedMobileHost[]> {
  const host = (await readMobileHosts()).find(item => item.url === url);

  if (host) {
    const { removeHostSessionDrafts } = await import("./draftStorage");
    await removeHostSessionDrafts(hostIdentity(host.name));
  }

  return storedHosts(hosts => hosts.filter(host => host.url !== url), url);
}

function withoutHost(saved: MobileConnection, url: string): MobileConnection {
  return saved.lastHost && validateHost({ url: saved.lastHost }) === url ? { ...saved, lastHost: "" } : saved;
}

const connectionSchema = z.object({ lastHost: z.string(), autoReconnect: z.boolean() });

type MobileConnection = z.infer<typeof connectionSchema>;

let connectionCache: MobileConnection = { lastHost: "", autoReconnect: false };

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


}

function connectionTransaction(database: IDBDatabase, change?: (saved: MobileConnection) => MobileConnection): Promise<MobileConnection> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("state", "readwrite", { durability: "strict" });
    const state = transaction.objectStore("state");
    const request = state.get("connection");
    let result: MobileConnection;
    request.onsuccess = () => {
      try {
        const saved = request.result === undefined ? { lastHost: "", autoReconnect: false } : connectionSchema.parse(request.result);
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
