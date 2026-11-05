import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

export type TaskSuccessEvent = Omit<TurnEndEvent, "type"> & { type: "task_success" };
export type TaskSuccessHandler = (event: TaskSuccessEvent, ctx: ExtensionContext) => void | Promise<void>;

export interface SessionRestoreEvent {
  type: "session_restore";
  reason: "start" | "branch_change";
}

export interface SessionAvailableEvent { type: "session_available" }

export interface ExtendedHookEvents {
  session_available: SessionAvailableEvent;
  task_success: TaskSuccessEvent;
  session_restore: SessionRestoreEvent;
}

export type ExtendedHookHandler<K extends keyof ExtendedHookEvents> = (event: ExtendedHookEvents[K], ctx: ExtensionContext) => void | Promise<void>;

export interface ExtendedHooks {
  waitForAvailable(ctx: ExtensionContext): Promise<void>;
  on<K extends keyof ExtendedHookEvents>(name: K, handler: ExtendedHookHandler<K>): () => void;
}

export interface ExtendedHooksRequest { hooks?: ExtendedHooks }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "hooks-extended", handler: (request: ExtendedHooksRequest) => void): () => void;
    emit(channel: "hooks-extended", request: ExtendedHooksRequest): void;
  }
}

export function extendedHooks(pi: ExtensionAPI): ExtendedHooks {
  const request: ExtendedHooksRequest = {};
  pi.events.emit("hooks-extended", request);
  if (!request.hooks) throw new Error("Load hooks-extended before extensions that use its hooks");
  return request.hooks;
}
