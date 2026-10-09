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

const draftTargetSchema = nativeConnectionTargetSchema.pick({ cwd: true, hostId: true, draftKey: true }).required({ hostId: true, draftKey: true });

const restoredTargetSchema = z.union([savedSessionTargetSchema, draftTargetSchema]);

const targetCache = new Map<string, z.infer<typeof restoredTargetSchema> | null>();

const pendingTargets = new Map<string, z.infer<typeof restoredTargetSchema> | null>();

let saving = false;

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

function legacyTargets() {
  const entries = new Map<string, { body: string; target: z.infer<typeof restoredTargetSchema> }>();

  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);

    if (!key?.startsWith("piop-last-session:") || !key.endsWith(":main")) continue;
    const body = localStorage.getItem(key);

    if (body === null) continue;

    try { entries.set(key, { body, target: restoredTargetSchema.parse(JSON.parse(body)) }); } catch { }
  }

  return entries;
}

function importTargets(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["targets", "state"], "readwrite", { durability: "strict" });
    const state = transaction.objectStore("state");
    const targets = transaction.objectStore("targets");
    const request = state.get("imported");
    let legacy: ReturnType<typeof legacyTargets> = new Map();
    request.onsuccess = () => {
      if (request.result) return;

      try {
        legacy = legacyTargets();
        legacy.forEach(({ target }, key) => {
          const stored = targets.get(key);
          stored.onsuccess = () => { if (stored.result === undefined) targets.put({ key, target }); };
        });
        state.put(true, "imported");
      } catch (error) { transaction.abort(); reject(error); }
    };

    transaction.oncomplete = () => {
      try { legacy.forEach(({ body }, key) => { if (localStorage.getItem(key) === body) localStorage.removeItem(key); }); } catch { }

      resolve();
    };

    transaction.onabort = () => reject(transaction.error ?? new Error("Could not import saved conversations"));
  });
}

const targetRecordsSchema = z.array(z.object({ key: z.string(), target: restoredTargetSchema.nullable() }));

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
    await importTargets(database);

    for (const { key, target } of await readTargets(database)) if (!pendingTargets.has(key)) targetCache.set(key, target);
  } finally { database.close(); }
}

async function writeTargets(entries: [string, z.infer<typeof restoredTargetSchema> | null][]) {
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
  }).catch(error => { console.error("Could not save the last conversation", error); }).finally(() => {
    saving = false;

    if (succeeded) flushTargets();
  });
}

window.addEventListener("focus", flushTargets);

function saveTarget(key: string, target: z.infer<typeof restoredTargetSchema> | null) {
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

    if (!key) return {};

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

export function useSessionResume(selection: Accessor<{ target: NativeConnectionTarget; ready: boolean; saved: boolean; ephemeral: boolean }>) {
  let key: string | undefined;

  try { key = storageKey(); } catch { }

  createDependencyEffect(() => {
    const current = selection();

    if (!key || !current.ready || current.ephemeral) return;

    try {
      if (current.saved && current.target.sessionId && current.target.sessionPath) saveTarget(key, savedSessionTargetSchema.parse(current.target));
      else if (current.target.draftKey) saveTarget(key, draftTargetSchema.parse(current.target));
      else saveTarget(key, null);
    } catch { }
  }, () => [selection()]);
}
