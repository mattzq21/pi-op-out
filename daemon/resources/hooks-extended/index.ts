import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtendedHooks, ExtendedHookEvents, ExtendedHookHandler } from "./interface.ts";

export default function hooksExtended(pi: ExtensionAPI) {
  const handlers: { [K in keyof ExtendedHookEvents]: Set<ExtendedHookHandler<K>> } = {
    task_end: new Set(),
    session_restore: new Set(),
  };
  const hooks: ExtendedHooks = {
    on(name, handler) {
      if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown extended hook: ${name}`);
      handlers[name].add(handler);
      return () => { handlers[name].delete(handler); };
    },
  };
  const emit = async <K extends keyof ExtendedHookEvents>(name: K, event: ExtendedHookEvents[K], ctx: ExtensionContext) => {
    for (const handler of [...handlers[name]]) await handler(event, ctx);
  };
  const unsubscribe = pi.events.on("hooks-extended", request => { request.hooks = hooks; });
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop" || message.content.some(part => part.type === "toolCall")) return;
    await emit("task_end", { ...event, type: "task_end" }, ctx);
  });
  pi.on("session_start", (_event, ctx) => emit("session_restore", { type: "session_restore", reason: "start" }, ctx));
  pi.on("session_tree", (_event, ctx) => emit("session_restore", { type: "session_restore", reason: "branch_change" }, ctx));
  pi.on("session_shutdown", () => { unsubscribe(); for (const set of Object.values(handlers)) set.clear(); });
}
