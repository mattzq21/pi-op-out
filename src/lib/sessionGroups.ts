import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionSummary } from "../types";
import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; projectKind?: "no-repo" | "main" | "worktree" | null; }
export interface SessionGroups { groups: SessionGroup[]; assignments: Record<string, string | null>; removedProjects: string[]; }
export interface SessionGroupSeed { sessionKey: string; project: SessionGroup; }
export type GroupChange = { type: "create"; name: string } | { type: "project"; project: SessionGroup; key?: string } | { type: "rename"; id: string; name: string } | { type: "remove"; id: string } | { type: "assign"; key: string; group: string | null };

export function isTemporaryChatCwd(cwd: string) {
  return /(?:^|[\\/])\.piop[\\/]tmp[\\/][0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[\\/]?$/i.test(cwd);
}

const listeners = new Set<(state: SessionGroups) => void>();
function publish(state: SessionGroups) { listeners.forEach((listener) => listener(state)); return state; }

export function updateSessionGroups(update: GroupChange) {
  return enqueue(async () => {
    await loadSessionGroups([], legacyGroups([]));
    return publish(await changeSessionGroups(update));
  });
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}

function legacyGroups(seeds: SessionGroupSeed[]): SessionGroups {
  const read = (key: string): unknown => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
  const removed = read("pi-desktop-removed-project-groups");
  const removedProjects = Array.isArray(removed) ? removed.filter((id): id is string => typeof id === "string") : [];
  const groups = new Map(seeds.filter((seed) => !removedProjects.includes(seed.project.id)).map((seed) => [seed.project.id, seed.project]));
  const custom = read("pi-desktop-custom-session-groups");
  if (Array.isArray(custom)) for (const group of custom) {
    if (group && typeof group.id === "string" && typeof group.name === "string" && group.name.trim()) {
      const id = `__pi-desktop-custom-group__:${group.id}`;
      groups.set(id, { id, name: group.name });
    }
  }
  const assignments: Record<string, string | null> = {};
  const locations = read("pi-desktop-session-locations");
  if (locations && typeof locations === "object" && !Array.isArray(locations)) for (const [key, location] of Object.entries(locations)) {
    if (typeof location !== "string") continue;
    if (!groups.has(location) && !removedProjects.includes(location) && !location.startsWith("__pi-desktop-")) {
      const separator = location.indexOf(":");
      if (separator > 0) {
        const hostId = location.slice(0, separator); const cwd = location.slice(separator + 1);
        if (cwd) groups.set(location, { id: location, name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, cwd, hostId });
      }
    }
    assignments[key] = groups.has(location) ? location : null;
  }
  return { groups: [...groups.values()], assignments, removedProjects };
}

export function useSessionGroups(sessions: SessionSummary[]) {
  const [state, setState] = useState<SessionGroups>();
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const listener = (value: SessionGroups) => { setState(value); setError(undefined); };
    listeners.add(listener);
    const stop = listen<SessionGroups>("pi://groups-changed", ({ payload }) => listener(payload));
    return () => { mounted.current = false; listeners.delete(listener); void stop.then((unlisten) => unlisten()); };
  }, []);
  const seedsJson = JSON.stringify(sessions.filter((session) => !isTemporaryChatCwd(session.cwd)).map((session): SessionGroupSeed => ({
    sessionKey: `${session.hostId ?? "local"}:${session.id}`,
    project: { id: `${session.hostId ?? "local"}:${session.projectRoot ?? session.cwd}`, name: session.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? session.project, cwd: session.projectRoot ?? session.cwd, hostId: session.hostId ?? "local", hostName: session.hostName ?? session.hostId ?? "Local", projectKind: session.projectKind },
  })).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)));
  useEffect(() => {
    const seeds: SessionGroupSeed[] = JSON.parse(seedsJson);
    void enqueue(async () => publish(await loadSessionGroups(seeds, legacyGroups(seeds)))).catch((reason) => { if (mounted.current) setError(String(reason)); });
  }, [seedsJson]);
  const change = useCallback(async (update: GroupChange) => {
    try {
      await updateSessionGroups(update);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      throw reason;
    }
  }, []);
  return { state, error, change };
}
