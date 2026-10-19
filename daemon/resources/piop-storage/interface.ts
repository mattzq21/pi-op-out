import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GoalView } from "../piop-goals/interface.ts";

export interface SessionStorage {
  knownGoal(file: string, sessionId: string, goalId: string): boolean;
  readGoal(file: string, sessionId: string): GoalView | null;
  writeGoal(file: string, sessionId: string, goal: GoalView | null): void;
  append(type: string, data: unknown): void;
}

interface StorageRequest { storage?: SessionStorage }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:storage:session", handler: (request: StorageRequest) => void): () => void;
    emit(channel: "piop:storage:session", request: StorageRequest): void;
  }
}

export function sessionStorage(pi: ExtensionAPI): SessionStorage {
  const request: StorageRequest = {};
  pi.events.emit("piop:storage:session", request);
  if (!request.storage) throw new Error("Session storage extension is unavailable");
  return request.storage;
}
