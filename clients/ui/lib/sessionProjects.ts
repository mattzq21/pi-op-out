import { useSessionGroups } from "./sessionGroups";

export type SessionProjects = ReturnType<typeof useSessionProjects>;

export function useSessionProjects() {
  return useSessionGroups();
}
