import { isMobile } from "./platform";
import { createSignal } from "solid-js";
import { createDependencyEffect } from "./solid";
import type { SessionSummary } from "../types";

const PREFIX = "piop-mobile-sessions-v1:";
const MAX_CHARS = 1_500_000;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
type Entry = { key: string; savedAt: number; value: unknown };

function isSessionSummary(session: SessionSummary): boolean {
  return Boolean(session) && [session.id, session.path, session.name, session.project, session.cwd, session.preview].every(value => typeof value === "string") && [session.messageCount, session.lastMessageAt, session.apiCost].every(value => typeof value === "number");
}

export function useMobileCachedSessions() {
  const cache = mobileSessionCache();
  const stored = cache.read("index");
  const initial: SessionSummary[] = Array.isArray(stored) ? stored.filter(isSessionSummary).map(session => ({ ...session, isRunning: false })) : [];
  const [sessions, setSessions] = createSignal(initial);
  createDependencyEffect(() => { cache.write("index", sessions()); }, () => [sessions()]);
  return [sessions, setSessions] as const;
}

export function clearMobileSessionCache(host: string) {
  try { localStorage.removeItem(PREFIX + host); } catch { }
}

export function mobileSessionCache() {
  let storageKey: string | undefined;
  try {
    const host = isMobile && localStorage.getItem("piop-mobile-host");
    if (host) storageKey = PREFIX + host;
  } catch { }
  const entries = (): Entry[] => {
    if (!storageKey) return [];
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(value) ? value.filter((entry): entry is Entry => entry && typeof entry.key === "string" && typeof entry.savedAt === "number" && Date.now() - entry.savedAt < MAX_AGE) : [];
    } catch { return []; }
  };
  return {
    enabled: Boolean(storageKey),
    read(key: string): unknown { return entries().find(entry => entry.key === key)?.value; },
    write(key: string, value: unknown) {
      if (!storageKey) return;
      try {
        const entry = { key, savedAt: Date.now(), value };
        const previous = entries().filter(item => item.key !== key);
        const next = (JSON.stringify(entry).length > MAX_CHARS / 2 ? previous : [entry, ...previous]).slice(0, 12);
        let serialized = JSON.stringify(next);
        while (serialized.length > MAX_CHARS) { next.pop(); serialized = JSON.stringify(next); }
        localStorage.setItem(storageKey, serialized);
      } catch { }
    },
  };
}
