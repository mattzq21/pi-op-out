import { reportBackgroundError } from "./backgroundErrors";
import { cachedMobileHost } from "./mobileHosts";
import type { Accessor } from "solid-js";
import type { NativeConnectionTarget } from "./nativeTransport";
import { isMobile } from "./platform";
import { createDependencyEffect } from "./solid";
import { z } from "zod";

export const nativeConnectionTargetSchema = z.object({
  cwd: z.string().optional(), sessionPath: z.string().optional(), sessionId: z.string().optional(),
  hostId: z.string().optional(), readOnly: z.boolean().optional(),
  draftKey: z.string().optional(),
});

const savedSessionTargetSchema = nativeConnectionTargetSchema.omit({ readOnly: true, draftKey: true }).required();

const targetCache = new Map<string, z.infer<typeof savedSessionTargetSchema> | null>();

const pendingTargets = new Map<string, z.infer<typeof savedSessionTargetSchema> | null>();

let saving = false;

const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("piop-session-resume") : undefined;

let cacheReady = false;

let ignored = false;

export function ignoreSessionResume() { ignored = true; targetCache.clear(); refreshAgain = false; cacheReady = true; }

let refreshing = false;

let refreshAgain = false;

function openTargets(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-session-resume", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("targets", { keyPath: "key" });
      request.result.createObjectStore("state");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open saved conversations"));
  });
}

const targetRecordsSchema = z.array(z.object({ key: z.string(), target: savedSessionTargetSchema.nullable() }));

function readTargets(database: IDBDatabase): Promise<z.infer<typeof targetRecordsSchema>> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("targets", "readonly");
    const request = transaction.objectStore("targets").getAll();
    let records: z.infer<typeof targetRecordsSchema> = [];
    request.onsuccess = () => {
      try { records = targetRecordsSchema.parse(request.result); }
      catch (error) { transaction.abort(); reject(error); }
    };

    transaction.oncomplete = () => resolve(records);
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not restore saved conversations"));
  });
}

export async function initializeSessionResume() {
  const database = await openTargets();

  try {

    await loadTargetCache(database);
    cacheReady = true;

    if (refreshAgain) refreshTargetCache();
  } finally { database.close(); }
}

async function loadTargetCache(database: IDBDatabase) {
  const before = new Map(targetCache);
  const unsaved = new Set(pendingTargets.keys());

  for (const { key, target } of await readTargets(database)) {
    if (!unsaved.has(key) && !pendingTargets.has(key) && targetCache.get(key) === before.get(key)) targetCache.set(key, target);
  }
}

async function readTargetCache() {
  const database = await openTargets();

  try { await loadTargetCache(database); }
  finally { database.close(); }
}

function refreshTargetCache() {
  if (ignored) return;
  refreshAgain = true;

  if (!cacheReady || refreshing) return;
  refreshing = true; refreshAgain = false;
  void readTargetCache().catch(error => { reportBackgroundError("Could not refresh saved conversations", error); }).finally(() => {
    refreshing = false;

    if (refreshAgain) refreshTargetCache();
  });
}

if (channel) channel.onmessage = refreshTargetCache;

async function writeTargets(entries: [string, z.infer<typeof savedSessionTargetSchema> | null][]) {
  const database = await openTargets();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("targets", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("targets");
      entries.forEach(([key, target]) => store.put({ key, target }));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save the last conversation"));
    });
  } finally { database.close(); }
}

function flushTargets() {
  if (saving || !pendingTargets.size) return;
  saving = true;
  const entries = [...pendingTargets];
  let succeeded = false;
  void writeTargets(entries).then(() => {
    for (const [key, target] of entries) if (pendingTargets.get(key) === target) pendingTargets.delete(key);
    succeeded = true;
    channel?.postMessage(null);
    refreshTargetCache();
  }).catch(error => { reportBackgroundError("Could not save the last conversation", error); }).finally(() => {
    saving = false;

    if (succeeded) flushTargets();
  });
}

window.addEventListener("focus", () => { flushTargets(); refreshTargetCache(); });

function saveTarget(key: string, target: z.infer<typeof savedSessionTargetSchema> | null) {
  targetCache.set(key, target); pendingTargets.set(key, target); flushTargets();
}

function storageKey() {
  const host = isMobile ? cachedMobileHost() : "desktop";
  const windowTarget = new URLSearchParams(window.location.search).get("target");

  if (windowTarget) {
    localStorage.removeItem(`piop-last-session:${host}:${windowTarget}`);

    return;
  }

  return `piop-last-session:${host}:main`;
}

export function restoredSessionTarget(fallback: NativeConnectionTarget = {}): NativeConnectionTarget {
  try {
    const key = storageKey();

    if (!key) return fallback;

    return targetCache.get(key) ?? fallback;
  } catch { return fallback; }
}

export function targetedWindowSession(target: string): NativeConnectionTarget {
  const initial = nativeConnectionTargetSchema.parse(JSON.parse(target));

  if (initial.readOnly) return initial;

  try {
    const key = `piop-target-initialized:${target}`;
    const initialized = sessionStorage.getItem(key) === "1";
    sessionStorage.setItem(key, "1");

    return initialized ? restoredSessionTarget(initial) : initial;
  } catch { return initial; }
}

export function useSessionResume(selection: Accessor<{ target: NativeConnectionTarget; ready: boolean; saved: boolean }>) {
  let key: string | undefined;

  try { key = storageKey(); } catch { }

  createDependencyEffect(() => {
    const current = selection();

    if (!key || !current.ready) return;

    try {
      if (current.saved && current.target.sessionId && current.target.sessionPath) saveTarget(key, savedSessionTargetSchema.parse(current.target));
      else saveTarget(key, null);
    } catch (error) { reportBackgroundError("Could not save the last conversation", error); }
  }, () => [selection()]);
}
