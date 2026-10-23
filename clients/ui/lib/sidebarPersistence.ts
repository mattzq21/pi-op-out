import { createSignal, onCleanup } from "solid-js";
import { z } from "zod";
import { captureDaemonTransport } from "./platform";
import type { StateUpdate } from "./solid";

const layoutSchema = z.object({
  collapsed: z.array(z.string()),
  sessions: z.record(z.string(), z.array(z.string()).optional().catch(undefined)),
  sidebar: z.array(z.string()),
  children: z.record(z.string(), z.array(z.string())),
  removed: z.array(z.string()).default([]),
});

const recordSchema = z.object({ revision: z.number().int().nonnegative(), layout: layoutSchema });

type Layout = z.infer<typeof layoutSchema>;

type LayoutRecord = z.infer<typeof recordSchema>;

function openLayouts() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piop-sidebar-layouts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("layouts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open sidebar storage"));
    request.onblocked = () => reject(new Error("Another window is preventing sidebar storage from opening"));
  });
}

function transactLayout(database: IDBDatabase, key: string, fallback: Layout, change?: (layout: Layout) => Layout) {
  return new Promise<LayoutRecord>((resolve, reject) => {
    const transaction = database.transaction("layouts", change ? "readwrite" : "readonly", { durability: "strict" });
    const store = transaction.objectStore("layouts");
    const request = store.get(key);
    let result: LayoutRecord;
    let failure: Error | undefined;
    request.onsuccess = () => {
      try {
        const current = request.result === undefined ? { revision: 0, layout: fallback } : recordSchema.parse(request.result);
        result = change ? { revision: current.revision + 1, layout: layoutSchema.parse(change(current.layout)) } : current;

        if (change) store.put(result, key);
      } catch (reason) { failure = reason instanceof Error ? reason : new Error((reason instanceof Error ? reason.message : String(reason))); transaction.abort(); }
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Could not save sidebar preferences"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not read sidebar preferences"));
  });
}

export function createSidebarPersistence() {
  const endpoint = captureDaemonTransport().identity;
  const initial: Layout = { collapsed: [], sessions: {}, sidebar: [], children: {}, removed: [] };
  const [layout, setLayout] = createSignal(initial);
  const [error, setError] = createSignal<string>();
  const notificationKey = `piop-sidebar-revision:${endpoint}`;
  const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel(notificationKey) : undefined;
  let revision = -1;
  let disposed = false;
  let queue = Promise.resolve();
  const database = Promise.resolve().then(openLayouts);

  const failure = (reason: Error | string) => { if (!disposed) setError(`Sidebar preferences: ${(reason instanceof Error ? reason.message : String(reason))}`); };

  const publish = (record: LayoutRecord) => {
    if (disposed || record.revision < revision) return;

    revision = record.revision;
    setLayout(record.layout);
  };

  const read = async () => {
    if (!endpoint) throw new Error("Connect to a host before loading sidebar preferences");

    publish(await transactLayout(await database, endpoint, initial));
  };

  const refresh = () => { void read().catch(reason => failure((reason instanceof Error ? reason.message : String(reason)))); };

  const changed = (event: StorageEvent) => { if (event.key === notificationKey) refresh(); };

  if (channel) channel.onmessage = refresh;

  window.addEventListener("storage", changed);
  void read().catch(reason => failure((reason instanceof Error ? reason.message : String(reason))));
  onCleanup(() => { disposed = true; channel?.close(); window.removeEventListener("storage", changed); void queue.catch(() => undefined).then(() => database).then(value => value.close()).catch(() => undefined); });

  const mutate = (update: (current: Layout) => Layout) => {
    queue = queue.catch(() => undefined).then(async () => {
      if (!endpoint) throw new Error("Connect to a host before saving sidebar preferences");

      const record = await transactLayout(await database, endpoint, initial, current => pruneRemovedGroups(update(current)));
      publish(record);

      try { localStorage.setItem(notificationKey, String(record.revision)); } catch { }

      if (!disposed) channel?.postMessage(record.revision);

      if (!disposed) setError(undefined);
    });

    void queue.catch(reason => failure((reason instanceof Error ? reason.message : String(reason))));
  };

  const change = <K extends keyof Layout>(key: K, update: StateUpdate<Layout[K]>) => mutate(current => {
    const value = update instanceof Function ? update(current[key]) : update;

    return { ...current, [key]: value };
  });

  const removeGroup = (id: string, released: string[]) => mutate(current => {
    const token = `group:${id}`;
    const sidebar = current.sidebar.filter(entry => !released.includes(entry));
    const index = sidebar.indexOf(token);
    sidebar.splice(index < 0 ? sidebar.length : index, index < 0 ? 0 : 1, ...released);

    const pruned = pruneRemovedGroups({
      ...current, sidebar,
      removed: [...new Set([...current.removed, id])],
    });

    return { ...pruned, removed: pruned.removed.filter(key => key.startsWith("__pi-desktop-custom-group__:")) };
  });

  return { layout, change, removeGroup, error };
}

function pruneRemovedGroups(current: Layout): Layout {
  const removed = new Set(current.removed);
  const tokens = new Set(current.removed.map(id => `group:${id}`));
  const sessions = Object.fromEntries(Object.entries(current.sessions).filter(([id]) => !removed.has(id)));
  const children = Object.fromEntries(Object.entries(current.children).flatMap(([id, entries]) => removed.has(id) ? [] : [[id, entries.filter(token => !tokens.has(token))]]));

  return { ...current, sessions, children, collapsed: current.collapsed.filter(id => !removed.has(id)), sidebar: current.sidebar.filter(token => !tokens.has(token)) };
}

export function moveSidebarToken(current: string[], token: string, before: string | null, available: string[] = []) {
  const entries = [...current, ...available.filter(item => !current.includes(item))].filter(item => item !== token);
  const index = before === null ? -1 : entries.indexOf(before);
  entries.splice(index < 0 ? entries.length : index, 0, token);

  return entries;
}
