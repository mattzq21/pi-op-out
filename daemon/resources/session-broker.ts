import type { AppRequest } from "../../extensions/piop-define-agents/contracts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extendedHooks } from "./hooks-extended/interface.ts";
import { registerSubagents } from "./session-broker/subagents.ts";
import { registerSubagentMailbox } from "./session-broker/subagent-mailbox.ts";
import { MESSAGE_TIMEOUT_MS, currentHost, registerConversationClient, request } from "./session-broker/client.ts";
import { registerOrchestration } from "./session-broker/orchestration.ts";
import { registerInputHold } from "./session-broker/input-hold.ts";
import { existsSync } from "node:fs";
import { initialize } from "./session-broker/session-child-index.cjs";

export { writeSessionFile, publicationRetainsDependencies, type PublicationOptions, type SessionPublication } from "./piop-storage/session-file.ts";

export { registerSubagents } from "./session-broker/subagents.ts";

export default function sessionBroker(pi: ExtensionAPI) {
  const key = Symbol.for("piop.runtime-bridge");
  const forward = (request: AppRequest) => pi.events.emit("piop:rpc", request);
  Object.defineProperty(globalThis, key, { value: forward, writable: true, configurable: true });
  pi.on("session_shutdown", () => {
    if (Object.getOwnPropertyDescriptor(globalThis, key)?.value === forward) Reflect.deleteProperty(globalThis, key);
  });
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();

    if (file) await initialize(file, ctx.sessionManager.getSessionId(), !existsSync(file));
  });
  const unsubscribeTaskEnd = extendedHooks(pi).on("task_end", async (event, ctx) => {
    const { type: _type, context: _context, entries: _entries, continue: _continue, toolResults: _toolResults, ...rest } = event as typeof event & Record<string, unknown>;
    const data = { ...rest, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
    // App chats answer over Pi's input. Chats run for one message by another agent have no input channel and use the broker.
    const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as ((name: string, data: unknown) => Promise<void>) | undefined;

    if (send) await send("task_end", data);
    else await request("/runtime-event", { hostId: currentHost(), name: "task_end", data }, undefined, MESSAGE_TIMEOUT_MS);
  });
  pi.on("session_shutdown", unsubscribeTaskEnd);
  registerInputHold(pi);
  registerConversationClient(pi);
  const mailbox = registerSubagentMailbox(pi);
  registerOrchestration(pi);
  registerSubagents(pi, mailbox);
}
