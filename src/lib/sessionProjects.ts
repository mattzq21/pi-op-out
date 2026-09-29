import type { Accessor } from "solid-js";
import type { SessionSummary } from "../types";
import { useSessionGroups } from "./sessionGroups";
import { reconcileSessionGroupProjects } from "./sessionGroupProjects";

export type SessionProjects = ReturnType<typeof useSessionProjects>;

export function useSessionProjects(sessions: Accessor<SessionSummary[]>) {
  const groups = useSessionGroups(sessions);
  reconcileSessionGroupProjects(groups, sessions);
  return groups;
}
