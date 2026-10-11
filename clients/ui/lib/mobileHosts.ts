import { validateHost } from "./remoteClient";
import { isMobile } from "./platform";
import { z } from "zod";

/** The one daemon that the phone connects to. Its added machines are reached through it. */
export interface MobileAnchor { name: string; url: string }

const anchorSchema = z.object({ name: z.string().trim().min(1), url: z.string() });

let anchorCache: MobileAnchor | undefined;

export function cachedMobileHost() { return anchorCache?.url ?? ""; }

export function localHostLabel() { return isMobile ? anchorCache?.name ?? "Anchor host" : "Local"; }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("piop-mobile-anchor", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("state"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function anchorTransaction(change?: () => MobileAnchor | undefined): Promise<MobileAnchor | undefined> {
  const database = await openDatabase();

  try {
    const anchor = await new Promise<MobileAnchor | undefined>((resolve, reject) => {
      const transaction = database.transaction("state", "readwrite", { durability: "strict" });
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
    });
    anchorCache = anchor;

    return anchor;
  } finally { database.close(); }
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
