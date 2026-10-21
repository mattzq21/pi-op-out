import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtendedHooks, TaskEndHandler } from "./interface.ts";

export default function hooksExtended(pi: ExtensionAPI) {
  const handlers = new Set<TaskEndHandler>();
  const hooks: ExtendedHooks = {
    on(name, handler) {
      if (name !== "task_end") throw new Error(`Unknown extended hook: ${name}`);
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
  const unsubscribe = pi.events.on("hooks-extended", request => { request.hooks = hooks; });
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop" || message.content.some(part => part.type === "toolCall")) return;
    for (const handler of [...handlers]) await handler({ ...event, type: "task_end" }, ctx);
  });
  pi.on("session_shutdown", () => { unsubscribe(); handlers.clear(); });
}
