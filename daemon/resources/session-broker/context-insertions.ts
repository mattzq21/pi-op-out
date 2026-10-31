import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";

/**
 * Core: context insertions. Piop adds a message to the conversation context without starting a turn: an insert_context request.
 * The message is a custom message that the daemon builds. While the agent works, Pi adds it at the end of the current turn.
 * A message whose details have contextRole "system" goes to the model as a system message, in its place; other custom messages go as user messages.
 * The daemon's queue gives the insertions that start or continue a turn, such as the goal prompt, through the queue pull.
 */
const insertion = Schema.Object({
  message: Schema.Object({ customType: Schema.String({ minLength: 1 }), content: Schema.String(), display: Schema.Boolean(), details: Schema.Optional(Schema.Record(Schema.String(), Schema.Unknown())) }),
});

const systemMessage = (message: { role: string; details?: unknown }) => message.role === "custom" && (message.details as { contextRole?: unknown } | undefined)?.contextRole === "system";

export function registerContextInsertions(pi: ExtensionAPI) {
  const off = pi.events.on("piop:rpc", request => {
    if (request.command !== "insert_context") return;
    request.ready = Promise.resolve().then(() => {
      const { message } = Parse(insertion, request.payload);
      pi.sendMessage(message, { triggerTurn: false });

      return null;
    });
  });

  pi.on("context", event => {
    if (!event.messages.some(systemMessage)) return;

    return { messages: event.messages.map(message => message.role === "custom" && systemMessage(message) ? { role: "system" as const, content: message.content, timestamp: message.timestamp } : message) };
  });
  pi.on("session_shutdown", () => off());
}
