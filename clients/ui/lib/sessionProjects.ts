import type { Accessor } from "solid-js";
import type { SessionSummary } from "../types";
import { useSessionGroups } from "./sessionGroups";

export type SessionProjects = ReturnType<typeof useSessionProjects>;

export function useSessionProjects(sessions: Accessor<SessionSummary[]>) {
  const groups = useSessionGroups(sessions);

  return groups;
}
