import { sessionGroupsSchema } from "./responseSchemas";
import { z } from "zod";
import { createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "./solid";

import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";
import { listen } from "./platform";
import { cacheSessionGroups, restoreSessionGroups } from "./sessionGroupsCache";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; }

export const DIRLESS_KEY = "__pi-desktop-dirless__";

/** Saved sidebar orders: `sidebar` is the top-level order, `sessions` and `children` have one list per group key. */
export interface SessionGroupOrders { sidebar: string[]; sessions: Record<string, string[]>; children: Record<string, string[]>; }

export interface SessionGroups { groups: SessionGroup[]; parents: Record<string, string>; assignments: Record<string, string | null>; removedProjects: string[]; orders: SessionGroupOrders; }

/** Moves `token` in front of `before` (to the end for null), after it adds the `visible` entries that the saved order does not have yet. A null token only adds them. */
export type OrderChange = { type: "order"; scope: keyof SessionGroupOrders; owner: string; visible: string[]; token: string | null; before: string | null };

export type GroupChange = OrderChange | { type: "move"; id: string; parent: string | null } | { type: "relocate"; project: SessionGroup; key: string } | { type: "create"; name: string } | { type: "project"; project: SessionGroup; key?: string } | { type: "rename"; id: string; name: string } | { type: "edit"; id: string; name: string; cwd: string } | { type: "remove"; id: string } | { type: "assign"; key: string; group: string | null };

export function isTemporaryChatCwd(cwd: string) {
  return /(?:^|[\\/])\.piop(?:-dev)?[\\/]tmp[\\/][0-9a-f]{4,32}[\\/]?$/i.test(cwd);
}

const listeners = new Set<(state: SessionGroups) => void>();

let eventRevision = 0;

function publish(state: SessionGroups) { cacheSessionGroups(state); listeners.forEach((listener) => listener(state));

return state; }

let pendingChanges: GroupChange[] | undefined;

let pendingResult: Promise<SessionGroups> | undefined;

/** Changes made in the same synchronous step go to the daemon as one atomic batch. */
export function updateSessionGroups(update: GroupChange) {
  if (pendingChanges && pendingResult) { pendingChanges.push(update);

  return pendingResult; }

  const changes = pendingChanges = [update];

  return pendingResult = Promise.resolve().then(() => {
    pendingChanges = undefined; pendingResult = undefined;

    return enqueue(async () => {
      await loadSessionGroups();
      const revision = eventRevision;
      const state = await changeSessionGroups(changes.length === 1 ? changes[0] : { type: "batch", changes });

      return revision === eventRevision ? publish(state) : state;
    });
  });
}

let queue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);

  return result;
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
