import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import * as database from "../session-database/index.ts";
import { list as savedReceipts } from "./mailbox-receipts.ts";
import { messageSchema, recordSchema, type MailboxMessage, type MailboxRecord } from "../agent-records/index.ts";

// Agent mail that waits in the database until its chat saves it. Only the daemon runs these; Pi asks through its storage channel.

const savedRecordSchema = Type.Object({ session_id: Type.String(), delivery_id: Type.String(), sequence: Type.Integer(), message_json: Type.String() });

function mailboxRecord(saved: Static<typeof savedRecordSchema>): MailboxRecord {
  const record = Parse(recordSchema, { version: 1, sessionId: saved.session_id, deliveryId: saved.delivery_id,
    sequence: saved.sequence, message: JSON.parse(saved.message_json) });

  if (record.message.details.mailboxSessionId !== record.sessionId || record.message.details.notificationId !== record.deliveryId) throw new Error("Invalid saved agent delivery identity");

  return record;
}

const chatSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) });

// The database of a chat whose mailbox is ready.
function mailbox(root: string, request: unknown): { root: string; sessionId: string; path: string } {
  const chat = Parse(chatSchema, request);

  if (!isAbsolute(chat.path) || !chat.path.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  if (database.storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");

  return { root, ...chat };
}

function nextRecord(root: string, sessionId: string, deliveryId: string, message: MailboxMessage): MailboxRecord {
  const sequence = Parse(Type.Integer(), database.nextMailboxSequence(root, sessionId));

  const record: MailboxRecord = { version: 1, sessionId, deliveryId, sequence, message };
  database.addMailboxDelivery(root, record.sessionId, record.deliveryId, record.sequence, JSON.stringify(record.message));

  return record;
}

export const OPERATIONS = {
  // The delivery IDs of the mail that the chat's transcript already holds.
  saved: (root: string, request: unknown) => {
    const { sessionId } = mailbox(root, request);

    return savedReceipts(root, sessionId);
  },
  pending: (root: string, request: unknown) => {
    const { sessionId } = mailbox(root, request);

    return database.mailboxDeliveries(root, sessionId).map(row => mailboxRecord(Parse(savedRecordSchema, row)));
  },
  store: (root: string, request: { deliveryId: string; message: unknown }) => {
    const { sessionId } = mailbox(root, request);
    const message = Parse(messageSchema, request.message);
    const deliveryId = String(request.deliveryId);

    if (message.details.mailboxSessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");

    return database.transaction(root, "IMMEDIATE", () => {
      const existing = database.mailboxDelivery(root, sessionId, deliveryId);
      return existing ? mailboxRecord(Parse(savedRecordSchema, existing)) : nextRecord(root, sessionId, deliveryId, message);
    });
  },
  remove: (root: string, request: { record: unknown }) => {
    const { sessionId } = mailbox(root, request);
    const record = Parse(recordSchema, request.record);

    if (record.sessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");
    database.removeMailboxDelivery(root, record.sessionId, record.deliveryId);

    return null;
  },
};
