import { sessionGroupsSchema } from "./responseSchemas";
import { z } from "zod";
import { createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "./solid";

import type { SessionSummary } from "../types";
import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";
import { listen } from "./platform";
import { cacheSessionGroups, restoreSessionGroups } from "./sessionGroupsCache";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; }

export const DIRLESS_KEY = "__pi-desktop-dirless__";

export interface SessionGroups { groups: SessionGroup[]; parents: Record<string, string>; assignments: Record<string, string | null>; removedProjects: string[]; }

export type GroupChange = { type: "move"; id: string; parent: string | null } | { type: "relocate"; project: SessionGroup; key: string } | { type: "create"; name: string } | { type: "project"; project: SessionGroup; key?: string } | { type: "rename"; id: string; name: string } | { type: "remove"; id: string } | { type: "assign"; key: string; group: string | null };

export function isTemporaryChatCwd(cwd: string) {
  return /(?:^|[\\/])\.piop(?:-dev)?[\\/]tmp[\\/][0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[\\/]?$/i.test(cwd);
}

const listeners = new Set<(state: SessionGroups) => void>();

let eventRevision = 0;

function publish(state: SessionGroups) { cacheSessionGroups(state); listeners.forEach((listener) => listener(state));

return state; }

export function updateSessionGroups(update: GroupChange) {
  return enqueue(async () => {
    await loadSessionGroups();
    const revision = eventRevision;
    const state = await changeSessionGroups(update);

    return revision === eventRevision ? publish(state) : state;
  });
}

let queue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);

  return result;
}

export function projectGroupId(session: SessionSummary) {
  return `${session.hostId ?? "local"}:${session.cwd}`;
}

export function useSessionGroups() {
  const [state, setState] = createSignal<SessionGroups | undefined>(restoreSessionGroups());
  const [error, setError] = createSignal<string>();
  const mounted = createRef(false);
  createDependencyEffect(() => {
    mounted.current = true;
    const listener = (value: SessionGroups) => { setState(value); setError(undefined); };

    listeners.add(listener);
    const stop = listen("pi://groups-changed", ({ payload }) => { eventRevision++; publish(payload); }, sessionGroupsSchema);

    return () => { mounted.current = false; listeners.delete(listener); void stop.then((unlisten) => unlisten()); };
  }, () => []);
  const reload = () => {
    void enqueue(async () => { const revision = eventRevision; const state = await loadSessionGroups();

    if (revision === eventRevision) publish(state); }).catch((reason) => { if (mounted.current) setError((reason instanceof Error ? reason.message : String(reason))); });
  };
  reload();
  // Group events sent while the phone was offline are lost, so a restored connection loads the groups again.
  createDependencyEffect(() => {
    const stop = listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") reload(); }, z.object({ type: z.string().optional() }).catch({}));

    return () => { void stop.then((unlisten) => unlisten()); };
  }, () => []);

  const change = async (update: GroupChange) => {
    try {
      await updateSessionGroups(update);
    } catch (reason) {
      if (mounted.current) setError((reason instanceof Error ? reason.message : String(reason)));
      throw reason;
    }
  };

  return { get state() { return state(); }, get error() { return error(); }, get change() { return change; } };
}
