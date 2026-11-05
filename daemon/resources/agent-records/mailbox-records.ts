import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// The saved form of agent mail, for Pi and the daemon.

export const detailsSchema = Type.Object({ notificationId: Type.String(), mailboxSessionId: Type.String() });

export const objectSchema = Type.Record(Type.String(), Type.Unknown());

export const messageSchema = Type.Object({
  customType: Type.Union([Type.Literal("piop-agent-message"), Type.Literal("piop-subagent-result")]),
  content: Type.Union([Type.String(), Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  ]))]),
  display: Type.Boolean(), details: Type.Intersect([objectSchema, detailsSchema]),
});

export const recordSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), deliveryId: Type.String(), sequence: Type.Integer({ minimum: 0 }), message: messageSchema });

const storedMessageSchema = Type.Object({ type: Type.Literal("message"), message: Type.Object({ details: detailsSchema }) });

const customMessageSchema = Type.Object({ type: Type.Literal("custom_message"), details: detailsSchema });

export type MailboxMessage = Static<typeof messageSchema>;

export type MailboxDetails = Static<typeof detailsSchema>;

export type MailboxRecord = Static<typeof recordSchema>;

// The mail details of a saved transcript entry, if it is agent mail.
export function messageDetails(entry: unknown): MailboxDetails | undefined {
  if (Check(customMessageSchema, entry)) return entry.details;

  if (Check(storedMessageSchema, entry)) return entry.message.details;

  return undefined;
}
