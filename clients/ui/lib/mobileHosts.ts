import { validateHost } from "./remoteClient";
import { isMobile } from "./platform";
import { z } from "zod";

/** The one daemon that the phone connects to. Its added machines are reached through it. */
export interface MobileAnchor { name: string; url: string }

const anchorSchema = z.object({ name: z.string().trim().min(1), url: z.string() });
const storageTimeoutMs = 10000;

let anchorCache: MobileAnchor | undefined;

export function cachedMobileHost() { return anchorCache?.url ?? ""; }

export function localHostLabel() { return isMobile ? anchorCache?.name ?? "Anchor host" : "Local"; }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-mobile-anchor", 1);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Opening anchor host storage timed out")), storageTimeoutMs);
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }

      try { request.result.createObjectStore("state"); }
      catch (error) { fail(error); request.transaction?.abort(); }
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail(request.error ?? new Error("Could not open anchor host storage"));
    request.onblocked = () => fail(new Error("Another window is preventing anchor host storage from opening"));
  });
}

async function anchorTransaction(change?: () => MobileAnchor | undefined): Promise<MobileAnchor | undefined> {
  const database = await openDatabase();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const anchor = await new Promise<MobileAnchor | undefined>((resolve, reject) => {
      const transaction = database.transaction("state", "readwrite", { durability: "strict" });
      timer = setTimeout(() => {
        try { transaction.abort(); }
        catch (error) { reject(error); return; }
        reject(new Error("Accessing anchor host storage timed out"));
      }, storageTimeoutMs);
      const state = transaction.objectStore("state");
      let result: MobileAnchor | undefined;

      if (change) {
        result = change();

        if (result) state.put(result, "anchor"); else state.delete("anchor");
      } else {
        const request = state.get("anchor");
        request.onsuccess = () => {
          try { result = request.result === undefined ? undefined : anchorSchema.parse(request.result); }
          catch (error) { transaction.abort(); reject(error); }
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save the anchor host"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not access anchor host storage"));
    });
    anchorCache = anchor;

    return anchor;
  } finally { clearTimeout(timer); database.close(); }
}

export function readMobileAnchor() { return anchorTransaction(); }

export function validateMobileAnchor(address: string, name: string): MobileAnchor {
  const url = validateHost({ url: address.trim() });
  const label = name.trim();

  if (!label) throw new Error("Enter a host name");

  return { url, name: label };
}

export function saveMobileAnchor(address: string, name: string) {
  const anchor = validateMobileAnchor(address, name);

  return anchorTransaction(() => anchor);
}

/** Uses a development connection for this run only, so it never replaces the saved anchor. */
export function useDevelopmentAnchor(address: string) {
  anchorCache = { url: address, name: "Development" };

  return anchorCache;
}

export function forgetMobileAnchor() { return anchorTransaction(() => undefined); }
