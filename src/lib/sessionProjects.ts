import { createMemo, type Accessor } from "solid-js";
import type { SessionSummary } from "../types";
import { gitProjectKind } from "./nativeTransport";
import { useSessionGroups } from "./sessionGroups";
import { createDependencyEffect } from "./solid";

export type SessionProjects = ReturnType<typeof useSessionProjects>;

export function useSessionProjects(sessions: Accessor<SessionSummary[]>) {
  const storedGroups = useSessionGroups(sessions);
  const projectKindInspections = new Set<string>();
  createDependencyEffect(() => {
    for (const group of storedGroups.state?.groups ?? []) {
      if (!group.cwd || group.projectKind || projectKindInspections.has(group.id)) continue;
      projectKindInspections.add(group.id);
      void gitProjectKind(group.cwd, group.hostId ?? "local")
        .then((projectKind) => storedGroups.change({ type: "inspectProject", id: group.id, projectKind }))
        .catch(() => undefined);
    }
  }, () => [storedGroups.change, storedGroups.state?.groups]);
  const inferredWorktreeGroup = createMemo(() => storedGroups.state?.groups.find((group) =>
    group.cwd && group.projectKind !== "worktree" && sessions().some((session) =>
      (session.hostId ?? "local") === (group.hostId ?? "local") && session.cwd === group.cwd && session.projectKind === "worktree")));
  createDependencyEffect(() => {
    const group = inferredWorktreeGroup();
    if (!group) return;
    void storedGroups.change({ type: "inspectProject", id: group.id, projectKind: "worktree" }).catch(() => undefined);
  }, () => [storedGroups.change, inferredWorktreeGroup()?.id]);
  return storedGroups;
}
