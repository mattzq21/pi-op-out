import { validateHost } from "./remoteClient";
import { isMobile } from "./platform";
import { z } from "zod";

/** The one daemon that the phone connects to. Its added machines are reached through it. */
export interface MobileAnchor { name: string; url: string }

/** The current anchor and every anchor host that this device has saved. The current anchor is always in the saved list. */
export interface MobileHosts { anchor?: MobileAnchor; saved: MobileAnchor[] }

const anchorSchema = z.object({ name: z.string().trim().min(1), url: z.string() });
const savedSchema = z.array(anchorSchema);
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

function storedHosts(anchorValue: unknown, savedValue: unknown): MobileHosts {
  const anchor = anchorValue === undefined ? undefined : anchorSchema.parse(anchorValue);
  const saved = savedValue === undefined ? [] : savedSchema.parse(savedValue);

  return { anchor, saved: anchor && !saved.some(host => host.url === anchor.url) ? [anchor, ...saved] : saved };
}

/** Reads the hosts, and with `change` replaces them in the same transaction. `"reset"` removes them without reading, so unreadable data can be cleared. */
async function hostsTransaction(change?: ((current: MobileHosts) => MobileHosts) | "reset"): Promise<MobileHosts> {
  const database = await openDatabase();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const hosts = await new Promise<MobileHosts>((resolve, reject) => {
      const transaction = database.transaction("state", "readwrite", { durability: "strict" });
      timer = setTimeout(() => {
        try { transaction.abort(); }
        catch (error) { reject(error); return; }
        reject(new Error("Accessing anchor host storage timed out"));
      }, storageTimeoutMs);
      const state = transaction.objectStore("state");
      let result: MobileHosts = { saved: [] };

      if (change === "reset") { state.delete("anchor"); state.delete("saved"); }
      else {
        const anchorRequest = state.get("anchor");
        const savedRequest = state.get("saved");
        savedRequest.onsuccess = () => {
          try {
            const current = storedHosts(anchorRequest.result, savedRequest.result);
            result = change ? change(current) : current;

            if (!change) return;
            if (result.anchor) state.put(result.anchor, "anchor"); else state.delete("anchor");
            state.put(result.saved, "saved");
          } catch (error) { transaction.abort(); reject(error); }
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save the anchor host"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not access anchor host storage"));
    });
    anchorCache = hosts.anchor;

    return hosts;
  } finally { clearTimeout(timer); database.close(); }
}

export function readMobileHosts() { return hostsTransaction(); }

export function validateMobileAnchor(address: string, name: string): MobileAnchor {
  const url = validateHost({ url: address.trim() });
  const label = name.trim();

  if (!label) throw new Error("Enter a host name");

  return { url, name: label };
}

/** Makes the host the current anchor and saves it, replacing the saved name of the same address. */
export function saveMobileAnchor(address: string, name: string) {
  const anchor = validateMobileAnchor(address, name);

  return hostsTransaction(current => ({ anchor, saved: current.saved.some(host => host.url === anchor.url) ? current.saved.map(host => host.url === anchor.url ? anchor : host) : [...current.saved, anchor] }));
}

/** Uses a development connection for this run only, so it never replaces the saved anchor. */
export function useDevelopmentAnchor(address: string) {
  anchorCache = { url: address, name: "Development" };

  return anchorCache;
}

/** Removes one saved host, or every host when `url` is undefined. Removing the current anchor clears it. */
export function forgetMobileHost(url?: string) {
  return hostsTransaction(url === undefined ? "reset" : current => ({ anchor: current.anchor?.url === url ? undefined : current.anchor, saved: current.saved.filter(host => host.url !== url) }));
}
