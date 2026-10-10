import { sessionGroupsSchema } from "./responseSchemas";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "./solid";

import type { SessionSummary } from "../types";
import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";
import { listen } from "./platform";
import { cacheSessionGroups, restoreSessionGroups } from "./sessionGroupsCache";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; }

export const DIRLESS_KEY = "__pi-desktop-dirless__";

export interface SessionGroups { groups: SessionGroup[]; parents: Record<string, string>; assignments: Record<string, string | null>; removedProjects: string[]; }

export interface SessionGroupSeed { sessionKey: string; project: SessionGroup; }

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
    await loadSessionGroups([]);
    const revision = eventRevision;
    const state = await changeSessionGroups(update);

    return revision === eventRevision ? publish(state) : state;
  });
}

let queue: Promise<void> = Promise.resolve();

export function inheritSessionGroup(parentKey: string, childKey: string, parent?: SessionSummary) {
  return enqueue(async () => {
    const seeds = parent && !isTemporaryChatCwd(parent.cwd) ? [sessionGroupSeed(parent)] : [];
    const state = await loadSessionGroups(seeds);
    const revision = eventRevision;
    const next = await changeSessionGroups({ type: "assign", key: childKey, group: state.assignments[parentKey] ?? null });

    return revision === eventRevision ? publish(next) : next;
  });
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);

  return result;
}

export function projectGroupId(session: SessionSummary) {
  return `${session.hostId ?? "local"}:${session.cwd}`;
}

function sessionGroupSeed(session: SessionSummary): SessionGroupSeed {
  const hostId = session.hostId ?? "local";
  const cwd = session.cwd;

  return {
    sessionKey: `${hostId}:${session.id}`,
    project: { id: projectGroupId(session), name: session.project, cwd, hostId, hostName: session.hostName ?? session.hostId ?? "Local" },
  };
}

function sessionGroupSeedInputs(session: SessionSummary) {
  return [session.id, session.hostId, session.cwd, session.project, session.hostName];
}

function sessionGroupSeeds(sessions: Accessor<SessionSummary[]>) {
  return createMemo((previous: { inputs: ReturnType<typeof sessionGroupSeedInputs>[]; json: string } | undefined) => {
    const eligible = sessions().filter(session => !session.isDraft && session.messageCount > 0 && !isTemporaryChatCwd(session.cwd));
    const inputs = eligible.map(sessionGroupSeedInputs);

    if (previous && inputs.length === previous.inputs.length && inputs.every((input, index) => input.every((value, field) => value === previous.inputs[index][field]))) return previous;

    return { inputs, json: JSON.stringify(eligible.map(sessionGroupSeed).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey))) };
  });
}

export function useSessionGroups(sessions: Accessor<SessionSummary[]>) {
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
  const seeds = sessionGroupSeeds(sessions);
  const seedsJson = createMemo(() => seeds().json);
  createDependencyEffect(() => { const capturedSeedsJson = seedsJson();
    const seeds: SessionGroupSeed[] = JSON.parse(capturedSeedsJson);
    void enqueue(async () => { const revision = eventRevision; const state = await loadSessionGroups(seeds);

    if (revision === eventRevision) publish(state); }).catch((reason) => { if (mounted.current) setError(String(reason)); });
  }, () => [seedsJson()]);

  const change = async (update: GroupChange) => {
    try {
      await updateSessionGroups(update);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      throw reason;
    }
  };

  return { get state() { return state(); }, get error() { return error(); }, get change() { return change; } };
}
