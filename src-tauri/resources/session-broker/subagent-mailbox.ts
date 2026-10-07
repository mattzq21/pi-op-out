import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";

type Activity = "mailbox" | "input" | "cancelled" | "timeout";

const notificationSchema = Schema.Object({ notificationId: Schema.String() });

interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; availableTools?: string[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

function waitForActivity(listeners: Set<(activity: Activity) => void>, timeout: number, signal?: AbortSignal) {
  return new Promise<Activity>((resolve) => {
    const finish = (activity: Activity) => {
      clearTimeout(timer);
      listeners.delete(finish);
      signal?.removeEventListener("abort", abort);
      resolve(activity);
    };

    const abort = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), timeout);
    listeners.add(finish);
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();
  });
}

function waitResult(activity: Activity): AgentToolResult<{ timed_out: boolean }> {
  const messages: Record<Activity, string> = {
    mailbox: "Wait completed. Subagent results are delivered separately in the conversation.",
    input: "Wait interrupted by new input.",
    cancelled: "Wait cancelled.",
    timeout: "Wait timed out.",
  };

  return { content: [{ type: "text", text: messages[activity] }], details: { timed_out: activity === "timeout" } };
}

export function registerSubagentMailbox(pi: ExtensionAPI) {
  const pending = new Set<string>();
  const listeners = new Set<(activity: Activity) => void>();

  const wake = (activity: Activity) => {
    for (const listener of [...listeners]) listener(activity);
  };

  pi.on("session_start", () => { pending.clear(); wake("cancelled"); });

  const unsubscribe = pi.events.on("piop:required-tools", request => {
    if (request.ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-subagent-run")) request.tools.push("wait_agent", "await_subagents");
  });

  pi.on("session_shutdown", unsubscribe);
  const unsubscribeMail = pi.events.on("piop:agent-mail", event => { pending.add(event.notificationId); wake("mailbox"); });
  pi.on("session_shutdown", unsubscribeMail);
  pi.on("input", event => {
    if (event.source !== "extension") wake("input");
  });
  pi.on("context", event => {
    for (const message of event.messages) {
      const delivered = Schema.Object({ customType: Schema.Literal("piop-agent-message"), details: notificationSchema });

      if (Check(delivered, message)) { pending.delete(message.details.notificationId); continue; }

      if (message.role !== "custom" || message.customType !== "piop-subagent-result") continue;
      const details = message.details;

      if (Check(notificationSchema, details) && details.notificationId) pending.delete(details.notificationId);
    }
  });
  pi.registerTool({
    name: "wait_agent", label: "Wait for subagents", exposure: "model-only",
    description: "Wait for a subagent mailbox update, new user input, or timeout. Results arrive separately in the conversation. Use only when there is no independent work to do. Does not start or cancel child agents. Defaults to 30 seconds; timeout_ms is clamped to at least 10000 and must be at most 3600000.",
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const timeout = params.timeout_ms ?? 30_000;

      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 3_600_000) throw new Error("timeout_ms must be an integer between 0 and 3600000");

      if (pending.size) return waitResult("mailbox");

      if (ctx.hasPendingMessages()) return waitResult("input");

      return waitResult(await waitForActivity(listeners, Math.max(10_000, timeout), signal));
    },
  });

  return {
    reset() { pending.clear(); wake("cancelled"); },
  };
}
