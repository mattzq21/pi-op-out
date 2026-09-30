import { createMemo, type Accessor } from "solid-js";
import { createDependencyEffect } from "./solid";
import { gitProjectKind } from "./nativeTransport";
import type { SessionGroups, GroupChange } from "./sessionGroups";
import type { SessionSummary } from "../types";

export function reconcileSessionGroupProjects(storedGroups: { readonly state: SessionGroups | undefined; change: (update: GroupChange) => Promise<void> }, sessions: Accessor<SessionSummary[]>) {
  const inspected = new Set<string>();
  createDependencyEffect(() => {
    for (const group of storedGroups.state?.groups ?? []) {
      if (!group.cwd || group.projectKind || inspected.has(group.id)) continue;
      inspected.add(group.id);
      void gitProjectKind(group.cwd, group.hostId ?? "local")
        .then((projectKind) => storedGroups.change({ type: "inspectProject", id: group.id, projectKind }))
        .catch(() => undefined);
    }
  }, () => [storedGroups.change, storedGroups.state?.groups]);
  const worktrees = createMemo(() => {
    const locations = new Map<string, Set<string>>();
    for (const session of sessions()) {
      if (session.projectKind !== "worktree") continue;
      const host = session.hostId ?? "local";
      const paths = locations.get(host) ?? new Set<string>();
      paths.add(session.cwd);
      locations.set(host, paths);
    }
    return locations;
  });
  const inferredWorktreeGroup = createMemo(() => ((storedGroups.state?.groups ?? []).find((group) => group.cwd && group.projectKind !== "worktree" && worktrees().get(group.hostId ?? "local")?.has(group.cwd))));
  createDependencyEffect(() => { const capturedInferredWorktreeGroup = inferredWorktreeGroup();
    if (!capturedInferredWorktreeGroup) return;
    void storedGroups.change({ type: "inspectProject", id: capturedInferredWorktreeGroup.id, projectKind: "worktree" }).catch(() => undefined);
  }, () => [storedGroups.change, inferredWorktreeGroup()?.id]);
}
