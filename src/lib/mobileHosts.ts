import { validateHost } from "./remoteClient";
import { z } from "zod";

export interface SavedMobileHost { name: string; url: string }

const key = "piop-mobile-hosts";

const hostSchema = z.object({ name: z.string(), url: z.string() });

export function readMobileHosts(): SavedMobileHost[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");

    if (!Array.isArray(stored)) return [];

    return stored.flatMap((item): SavedMobileHost[] => {
      const host = hostSchema.safeParse(item);

      if (!host.success) return [];

      try { return [{ name: host.data.name, url: validateHost({ url: host.data.url }) }]; } catch { return []; }
    });
  } catch { return []; }
}

export function saveMobileHost(address: string, name: string): SavedMobileHost[] {
  const url = validateHost({ url: address.trim() });
  const hosts = readMobileHosts();
  const previous = hosts.find((host) => host.url === url);
  const host = { url, name: name.trim() || previous?.name || new URL(url).hostname };
  const next = [...hosts.filter((item) => item.url !== url), host];
  localStorage.setItem(key, JSON.stringify(next));

  return next;
}

export function removeMobileHost(url: string): SavedMobileHost[] {
  const next = readMobileHosts().filter((host) => host.url !== url);
  localStorage.setItem(key, JSON.stringify(next));
  const last = localStorage.getItem("piop-mobile-host");

  if (last && validateHost({ url: last }) === url) localStorage.removeItem("piop-mobile-host");

  return next;
}
