import { cachedMobileHost } from "./mobileHosts";
import type { SessionGroups } from "./sessionGroups";
import { isMobile } from "./platform";
import { z } from "zod";

const sessionGroupsSchema = z.object({
  groups: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  parents: z.record(z.string(), z.string()),
  removedProjects: z.array(z.string()),
  assignments: z.record(z.string(), z.string().nullable()),
});

const snapshots = new Map<string, SessionGroups>();

function cacheKey() {
  if (!isMobile) return "desktop";

  const host = cachedMobileHost();

  return host ? `piop-session-groups:v1:${host}` : undefined;
}

export function restoreSessionGroups() {
  const key = cacheKey();

  if (!key) return undefined;
  const snapshot = snapshots.get(key);

  if (snapshot) return snapshot;

  if (!isMobile) return undefined;

  try {
    const saved = sessionGroupsSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));

    if (saved.success) {
      snapshots.set(key, saved.data);

      return saved.data;
    }
  } catch { }

  return undefined;
}

export function cacheSessionGroups(state: SessionGroups) {
  const key = cacheKey();

  if (!key) return;
  snapshots.set(key, state);

  if (isMobile) {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { }
  }
}
