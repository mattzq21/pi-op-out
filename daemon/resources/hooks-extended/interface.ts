import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

export type TaskEndEvent = Omit<TurnEndEvent, "type"> & { type: "task_end" };
export type TaskEndHandler = (event: TaskEndEvent, ctx: ExtensionContext) => void | Promise<void>;

export interface ExtendedHooks {
  on(name: "task_end", handler: TaskEndHandler): () => void;
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
