import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../types";
import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; }
export interface SessionGroups { groups: SessionGroup[]; assignments: Record<string, string | null>; removedProjects: string[]; }
export interface SessionGroupSeed { sessionKey: string; project: SessionGroup; }
export type GroupChange = { type: "create"; name: string } | { type: "rename"; id: string; name: string } | { type: "remove"; id: string } | { type: "assign"; key: string; group: string | null };

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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const seedsJson = JSON.stringify(sessions.map((session): SessionGroupSeed => ({
    sessionKey: `${session.hostId ?? "local"}:${session.id}`,
    project: { id: `${session.hostId ?? "local"}:${session.projectRoot ?? session.cwd}`, name: session.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? session.project, cwd: session.projectRoot ?? session.cwd, hostId: session.hostId ?? "local", hostName: session.hostName ?? session.hostId ?? "Local" },
  })).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)));
  useEffect(() => {
    const seeds: SessionGroupSeed[] = JSON.parse(seedsJson);
    void enqueue(() => loadSessionGroups(seeds, legacyGroups(seeds))).then((value) => { if (mounted.current) { setState(value); setError(undefined); } }).catch((reason) => { if (mounted.current) setError(String(reason)); });
  }, [seedsJson]);
  const change = useCallback(async (update: GroupChange) => {
    try {
      const value = await enqueue(() => changeSessionGroups(update));
      if (mounted.current) { setState(value); setError(undefined); }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      throw reason;
    }
  }, []);
  return { state, error, change };
}
