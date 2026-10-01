import { type Accessor, createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import type { SessionSummary } from "../types";
import { changeSessionGroups, loadSessionGroups } from "./nativeTransport";
import { listen } from "./platform";
import { cacheSessionGroups, restoreSessionGroups } from "./sessionGroupsCache";
import { z } from "zod";
import { stringsSchema, validItems } from "./messageSchemas";
import { readStoredJson } from "./storedJson";

export interface SessionGroup { id: string; name: string; cwd?: string | null; hostId?: string | null; hostName?: string | null; projectKind?: "no-repo" | "main" | "worktree" | null; branch?: string; branchAppearance?: SessionSummary["branchAppearance"]; }

export const DIRLESS_KEY = "__pi-desktop-dirless__";

export interface SessionGroups { groups: SessionGroup[]; assignments: Record<string, string | null>; removedProjects: string[]; }

export interface SessionGroupSeed { sessionKey: string; project: SessionGroup; }

const legacyCustomGroupsSchema = validItems(z.object({ id: z.string(), name: z.string() }));

const legacyLocationsSchema = z.record(z.string(), z.string().optional().catch(undefined));

export type GroupChange = { type: "relocate"; project: SessionGroup; key: string } | { type: "create"; name: string } | { type: "project"; project: SessionGroup; key?: string } | { type: "inspectProject"; id: string; projectKind: "no-repo" | "main" | "worktree" } | { type: "rename"; id: string; name: string } | { type: "remove"; id: string } | { type: "assign"; key: string; group: string | null };

export function isTemporaryChatCwd(cwd: string) {
  return /(?:^|[\\/])\.piop(?:-dev)?[\\/]tmp[\\/][0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[\\/]?$/i.test(cwd);
}

const listeners = new Set<(state: SessionGroups) => void>();

let eventRevision = 0;

function publish(state: SessionGroups) { cacheSessionGroups(state); listeners.forEach((listener) => listener(state));

return state; }

export function updateSessionGroups(update: GroupChange) {
  return enqueue(async () => {
    await loadSessionGroups([], legacyGroups([]));
    const revision = eventRevision;
    const state = await changeSessionGroups(update);

    return revision === eventRevision ? publish(state) : state;
  });
}

let queue: Promise<void> = Promise.resolve();

export function inheritSessionGroup(parentKey: string, childKey: string, parent?: SessionSummary) {
  return enqueue(async () => {
    const seeds = parent && !isTemporaryChatCwd(parent.cwd) ? [sessionGroupSeed(parent)] : [];
    const state = await loadSessionGroups(seeds, legacyGroups(seeds));
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

function legacyGroups(seeds: SessionGroupSeed[]): SessionGroups {
  const removedProjects = readStoredJson("pi-desktop-removed-project-groups", stringsSchema, []);
  const groups = new Map<string, SessionGroup>();

  for (const seed of seeds) {
    if (!removedProjects.includes(seed.project.id)) groups.set(seed.project.id, seed.project);
  }

  const custom = readStoredJson("pi-desktop-custom-session-groups", legacyCustomGroupsSchema, []);
  addLegacyCustomGroups(groups, custom);
  const assignments = legacyAssignments(groups, readStoredJson("pi-desktop-session-locations", legacyLocationsSchema, {}), removedProjects);

  return { groups: [...groups.values()], assignments, removedProjects };
}

function addLegacyCustomGroups(groups: Map<string, SessionGroup>, custom: Array<Pick<SessionGroup, "id" | "name">>) {
  for (const group of custom) {
    if (group.name.trim()) {
      const id = `__pi-desktop-custom-group__:${group.id}`;
      groups.set(id, { id, name: group.name });
    }
  }
}

function addLegacyLocation(groups: Map<string, SessionGroup>, location: string, removedProjects: string[]) {
  if (groups.has(location) || removedProjects.includes(location) || location.startsWith("__pi-desktop-")) return;
  const separator = location.indexOf(":");

  if (separator <= 0) return;
  const hostId = location.slice(0, separator); const cwd = location.slice(separator + 1);

  if (cwd) groups.set(location, { id: location, name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, cwd, hostId });
}

function legacyAssignments(groups: Map<string, SessionGroup>, locations: z.infer<typeof legacyLocationsSchema>, removedProjects: string[]) {
  const assignments: Record<string, string | null> = {};

  for (const [key, location] of Object.entries(locations)) {
    if (location === undefined) continue;
    addLegacyLocation(groups, location, removedProjects);
    assignments[key] = groups.has(location) ? location : null;
  }

  return assignments;
}

export function firstOrderBranch(session: SessionSummary) {
  const branch = session.branch;

  if (!branch || branch.startsWith("Detached at ")) return undefined;
  const separator = branch.indexOf("|");

  return separator === -1 ? branch : branch.slice(0, separator);
}

export function branchGroupId(session: SessionSummary) {
  const project = `${session.hostId ?? "local"}:${session.projectRoot ?? session.cwd}`;
  const branch = firstOrderBranch(session);

  return branch ? `${project}#branch=${encodeURIComponent(branch)}` : project;
}

function sessionGroupSeed(session: SessionSummary): SessionGroupSeed {
  const hostId = session.hostId ?? "local";
  const cwd = session.projectRoot ?? session.cwd;
  const projectKind = session.projectRoot && session.projectRoot !== session.cwd && session.projectKind === "worktree" ? "main" : session.projectKind;

  return {
    sessionKey: `${hostId}:${session.id}`,
    project: { id: branchGroupId(session), name: session.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? session.project, cwd, hostId, hostName: session.hostName ?? session.hostId ?? "Local", projectKind, branch: firstOrderBranch(session), branchAppearance: session.branchAppearance },
  };
}

function sessionGroupSeedInputs(session: SessionSummary) {
  return [session.id, session.hostId, session.cwd, session.projectRoot, session.project, session.hostName, session.projectKind, session.branch, JSON.stringify(session.branchAppearance)];
}

function sessionGroupSeeds(sessions: Accessor<SessionSummary[]>) {
  return createMemo((previous: { inputs: ReturnType<typeof sessionGroupSeedInputs>[]; json: string } | undefined) => {
    const eligible = sessions().filter(session => !session.isDraft && session.messageCount > 0 && session.projectKind != null && !isTemporaryChatCwd(session.cwd));
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
    const stop = listen<SessionGroups>("pi://groups-changed", ({ payload }) => { eventRevision++; publish(payload); });

    return () => { mounted.current = false; listeners.delete(listener); void stop.then((unlisten) => unlisten()); };
  }, () => []);
  const seeds = sessionGroupSeeds(sessions);
  const seedsJson = createMemo(() => seeds().json);
  createDependencyEffect(() => { const capturedSeedsJson = seedsJson();
    const seeds: SessionGroupSeed[] = JSON.parse(capturedSeedsJson);
    void enqueue(async () => { const revision = eventRevision; const state = await loadSessionGroups(seeds, legacyGroups(seeds));

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
