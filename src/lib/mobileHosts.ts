import { validateHost } from "./remoteClient";
import { clearMobileSessionCache } from "./mobileSessionCache";

export interface SavedMobileHost { name: string; url: string }
const key = "piop-mobile-hosts";

export function readMobileHosts(): SavedMobileHost[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item): SavedMobileHost[] => {
      if (!item || typeof item.url !== "string" || typeof item.name !== "string") return [];
      try { return [{ name: item.name, url: validateHost({ url: item.url }) }]; } catch { return []; }
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
  clearMobileSessionCache(url);
  const next = readMobileHosts().filter((host) => host.url !== url);
  localStorage.setItem(key, JSON.stringify(next));
  const last = localStorage.getItem("piop-mobile-host");
  if (last && validateHost({ url: last }) === url) localStorage.removeItem("piop-mobile-host");
  return next;
}
