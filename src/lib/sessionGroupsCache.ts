import type { SessionGroups } from "./sessionGroups";
import { isMobile } from "./platform";

const snapshots = new Map<string, SessionGroups>();

function cacheKey() {
  if (!isMobile) return "desktop";
  try {
    const host = localStorage.getItem("piop-mobile-host");
    return host ? `piop-session-groups:v1:${host}` : undefined;
  } catch { return undefined; }
}

function validGroups(value: unknown): value is SessionGroups {
  if (!value || typeof value !== "object") return false;
  const state = value as SessionGroups;
  return Array.isArray(state.groups) && state.groups.every(group => group && typeof group.id === "string" && typeof group.name === "string")
    && Array.isArray(state.removedProjects) && state.removedProjects.every(id => typeof id === "string")
    && !!state.assignments && typeof state.assignments === "object" && !Array.isArray(state.assignments)
    && Object.values(state.assignments).every(id => id === null || typeof id === "string");
}

export function restoreSessionGroups() {
  const key = cacheKey();
  if (!key) return undefined;
  const snapshot = snapshots.get(key);
  if (snapshot) return snapshot;
  if (!isMobile) return undefined;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (validGroups(saved)) { snapshots.set(key, saved); return saved; }
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
