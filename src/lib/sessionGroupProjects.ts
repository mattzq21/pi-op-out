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
  const inferredWorktreeGroup = createMemo(() => ((storedGroups.state?.groups ?? []).find((group) => group.cwd && group.projectKind !== "worktree" && sessions().some((session) => (session.hostId ?? "local") === (group.hostId ?? "local") && session.cwd === group.cwd && session.projectKind === "worktree"))));
  createDependencyEffect(() => { const capturedInferredWorktreeGroup = inferredWorktreeGroup();
    if (!capturedInferredWorktreeGroup) return;
    void storedGroups.change({ type: "inspectProject", id: capturedInferredWorktreeGroup.id, projectKind: "worktree" }).catch(() => undefined);
  }, () => [storedGroups.change, inferredWorktreeGroup()?.id]);
}
