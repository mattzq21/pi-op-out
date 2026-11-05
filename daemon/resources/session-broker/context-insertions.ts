import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";

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

    return { messages: event.messages.map(message => message.role === "custom" && systemMessage(message) ? { role: "system" as const, content: message.content as string, timestamp: message.timestamp } : message) };
  });
  pi.on("session_shutdown", () => off());
}
