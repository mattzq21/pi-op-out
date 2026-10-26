import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { auxiliaryParent } from "../piop-storage/session-records.cjs";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { currentHost } from "./client.ts";
import { requireMessageLength, sendSessionMessage } from "./orchestration.ts";

/**
 * Plugins that own an auxiliary kind answer this request on "piop:auxiliary:kind". sendToMain is the one-line description of
 * the send_to_main tool for chats of that kind; without it, those chats do not get the tool.
 */
export interface AuxiliaryKindRequest { kind: string; sendToMain?: string }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:auxiliary:kind", handler: (request: AuxiliaryKindRequest) => void): () => void;
    emit(channel: "piop:auxiliary:kind", request: AuxiliaryKindRequest): void;
  }
}

/** The auxiliary parent of this session and the send_to_main description of its kind, or undefined when the chat does not get send_to_main. */
function mainChat(pi: ExtensionAPI, ctx: ExtensionContext) {
  const parent = auxiliaryParent(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());

  if (!parent) return;
  const request: AuxiliaryKindRequest = { kind: parent.kind };
  pi.events.emit("piop:auxiliary:kind", request);

  return request.sendToMain ? { sessionId: parent.parentSessionId as string, hostId: (parent.parentHostId ?? parent.hostId ?? currentHost()) as string, description: request.sendToMain } : undefined;
}

/** What a client needs to open an auxiliary chat in its side pane. task is a first prompt that the client sends when the chat opens. */
export interface AuxiliaryChatOpening {
  kind: string; name: string; sessionId: string; sessionPath: string; cwd: string; hostId: string; parentSessionId: string;
  task?: string; images?: Array<{ type: "image"; data: string; mimeType: string; name?: string }>;
}

/** The title of the client request that opens an auxiliary chat in the side pane. */
export const OPEN_AUXILIARY_CHAT = "__pi_desktop_auxiliary__";

/** Asks the client to open the auxiliary chat in its side pane and send its task. Reports a failure as an error notice. */
export function openAuxiliaryChat(ctx: ExtensionContext, opening: AuxiliaryChatOpening) {
  void ctx.ui.input(OPEN_AUXILIARY_CHAT, JSON.stringify(opening)).catch(error => {
    ctx.ui.notify(`Could not open the side chat: ${error instanceof Error ? error.message : String(error)}`, "error");
  });
}

const FORK_RETRIES = "piop-fork-retries";

const retriesSchema = Schema.Object({ pending: Schema.Array(Schema.Object({ sessionId: Schema.String(), message: Schema.String(), deliveryId: Schema.String() })) });

/**
 * A fork sends the last prompt again to each copied chat that was working when the fork was made, also to subagents of its
 * side chats, which have no other chat that starts them. A copied subagent's run waits for this delivery ID.
 */
async function sendForkRetries(pi: ExtensionAPI, ctx: ExtensionContext) {
  const entry = ctx.sessionManager.getEntries().findLast(item => item.type === "custom" && item.customType === FORK_RETRIES);

  if (entry?.type !== "custom" || !Check(retriesSchema, entry.data) || !entry.data.pending.length) return;
  const pending = entry.data.pending;
  pi.appendEntry(FORK_RETRIES, { pending: [] });

  for (const retry of pending) {
    try { await sendSessionMessage(ctx, retry.sessionId, currentHost(), retry.message, true, undefined, retry.deliveryId); }
    catch (error) { ctx.ui.notify(`A copied chat could not retry its last prompt: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  }
}

/** Registers send_to_main: an auxiliary chat whose kind asks for it sends a message to the chat that owns it. */
export function registerAuxiliaryChats(pi: ExtensionAPI) {
  let description: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    description = mainChat(pi, ctx)?.description;
    void sendForkRetries(pi, ctx);
  });
  const unsubscribe = pi.events.on("piop:required-tools", ({ ctx, tools }) => { if (mainChat(pi, ctx)) tools.push("send_to_main"); });
  pi.on("session_shutdown", unsubscribe);
  pi.registerTool({
    name: "send_to_main", label: "Send to main chat", exposure: "model-only", defaultActive: false,
    description: "Send a message to the main chat.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    prepareLoadout: () => description ? { descriptions: { send_to_main: description } } : undefined,
    async execute(_id, params, signal, _update, ctx): Promise<AgentToolResult<unknown>> {
      const main = mainChat(pi, ctx);

      if (!main) throw new Error("Only a side chat can send to its main chat");
      requireMessageLength(params.message);
      const data = await sendSessionMessage(ctx, main.sessionId, main.hostId, params.message, true, signal);

      return { content: [{ type: "text", text: "Sent to the main chat." }], details: data };
    },
  });
}
