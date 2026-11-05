import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { connection, storageRoot, transaction } from "../session-database.cjs";
import { list as savedReceipts } from "./mailbox-receipts.cjs";
import { assertSameDelivery, messageSchema, recordSchema, type MailboxMessage, type MailboxRecord } from "./mailbox-records.ts";

// Agent mail that waits in the database until its chat saves it. Only the daemon runs these; Pi asks through its storage channel.

const savedRecordSchema = Type.Object({ session_id: Type.String(), delivery_id: Type.String(), sequence: Type.Integer(), fingerprint: Type.String(), message_json: Type.String() });

function mailboxRecord(saved: Static<typeof savedRecordSchema>): MailboxRecord {
  const record = Parse(recordSchema, { version: 1, sessionId: saved.session_id, deliveryId: saved.delivery_id,
    sequence: saved.sequence, message: JSON.parse(saved.message_json) });

  if (record.message.details.mailboxSessionId !== record.sessionId || record.message.details.notificationId !== record.deliveryId) throw new Error("Invalid saved agent delivery identity");
  assertSameDelivery(saved.fingerprint, record.message);

  return record;
}

const chatSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) });

// The database of a chat whose mailbox is ready.
function mailbox(root: string, request: unknown) {
  const chat = Parse(chatSchema, request);

  if (!isAbsolute(chat.path) || !chat.path.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  if (storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");
  return { db: connection(root), ...chat };
}

function nextRecord(db: DatabaseSync, sessionId: string, deliveryId: string, message: MailboxMessage): MailboxRecord {
  const row = Parse(Type.Object({ sequence: Type.Integer() }), db.prepare(
    "SELECT max(coalesce(max(sequence)+1, 0), ?) AS sequence FROM session_mailbox WHERE session_id=?").get(Date.now(), sessionId));

  const record: MailboxRecord = { version: 1, sessionId, deliveryId, sequence: row.sequence, message };
  db.prepare("INSERT INTO session_mailbox VALUES (?, ?, ?, ?, ?)").run(record.sessionId, record.deliveryId,
    record.sequence, record.message.details.mailboxFingerprint, JSON.stringify(record.message));

  return record;
}

export const OPERATIONS = {
  // The mail that the chat's transcript already holds: delivery ID and fingerprint pairs.
  saved: (root: string, request: unknown) => {
    const { db, sessionId } = mailbox(root, request);

    return savedReceipts(db, sessionId);
  },
  pending: (root: string, request: unknown) => {
    const { db, sessionId } = mailbox(root, request);

    return db.prepare("SELECT * FROM session_mailbox WHERE session_id=? ORDER BY sequence, delivery_id")
      .all(sessionId).map(row => mailboxRecord(Parse(savedRecordSchema, row)));
  },
  store: (root: string, request: { deliveryId: string; message: unknown }) => {
    const { db, sessionId } = mailbox(root, request);
    const message = Parse(messageSchema, request.message);
    const deliveryId = String(request.deliveryId);

    if (message.details.mailboxSessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");

    return transaction(db, "IMMEDIATE", () => {
      const existing = db.prepare("SELECT * FROM session_mailbox WHERE session_id=? AND delivery_id=?").get(sessionId, deliveryId);
      const record = existing ? mailboxRecord(Parse(savedRecordSchema, existing)) : nextRecord(db, sessionId, deliveryId, message);
      assertSameDelivery(record.message.details.mailboxFingerprint, message);

      return record;
    });
  },
  remove: (root: string, request: { record: unknown }) => {
    const { db, sessionId } = mailbox(root, request);
    const record = Parse(recordSchema, request.record);

    if (record.sessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");
    db.prepare("DELETE FROM session_mailbox WHERE session_id=? AND delivery_id=? AND fingerprint=?")
      .run(record.sessionId, record.deliveryId, record.message.details.mailboxFingerprint);

    return null;
  },
};
