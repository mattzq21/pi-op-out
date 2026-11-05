import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { connection, register, storageRoot, transaction } from "../session-database.cjs";
import { assertSameDelivery, messageDetails, messageSchema, recordSchema, type MailboxMessage, type MailboxRecord } from "./mailbox-records.ts";

// Agent mail that waits in the database until its chat saves it. Only the daemon runs these; Pi asks through its storage channel.

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String() });

function missing(error: Error) { return "code" in error && error.code === "ENOENT"; }

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function* transcriptLines(file: FileHandle) {
  let pending = "";

  for await (const chunk of file.createReadStream({ autoClose: false, encoding: "utf8" })) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
}

function savedMessageDetails(line: string) {
  try { return messageDetails(JSON.parse(line)); }
  catch { return undefined; }
}

async function readDeliveries(file: FileHandle, sessionId: string) {
  const saved = new Map<string, string>();
  let header = false;

  for await (const line of transcriptLines(file)) {
    if (!header) {
      if (Parse(headerSchema, JSON.parse(line)).id !== sessionId) throw new Error("Agent mailbox transcript belongs to another conversation");
      header = true;
      continue;
    }

    const details = savedMessageDetails(line);

    if (details?.mailboxSessionId === sessionId) saved.set(details.notificationId, details.mailboxFingerprint);
  }

  if (!header) throw new Error("Agent mailbox transcript has no complete conversation header");

  return saved;
}

const receiptCacheSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));

function cachedReceipts(db: DatabaseSync, id: string, path: string, fingerprint: string | undefined) {
  if (fingerprint === undefined) return undefined;
  const row = db.prepare("SELECT deliveries_json FROM session_mailbox_receipt_cache WHERE session_id=? AND session_path=? AND fingerprint=?").get(id, path, fingerprint);

  return row ? new Map<string, string>(Parse(receiptCacheSchema, JSON.parse(String(row.deliveries_json)))) : undefined;
}

function registeredFingerprint(db: DatabaseSync, id: string, path: string) {
  const row = db.prepare(`SELECT modified_ns, size FROM session_file_metadata WHERE session_id=? AND session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_file_writes WHERE session_id=?)`).get(id, path, id);

  return row ? `${row.modified_ns}:${row.size}` : undefined;
}

function saveReceipts(db: DatabaseSync, id: string, path: string, fingerprint: string, receipts: Map<string, string>) {
  db.prepare(`INSERT INTO session_mailbox_receipt_cache SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, fingerprint=excluded.fingerprint, deliveries_json=excluded.deliveries_json`)
    .run(fingerprint, JSON.stringify([...receipts]), id, path);
}

async function readSavedDeliveries(db: DatabaseSync, id: string, path: string, required: boolean) {
  let file;

  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (!required && error instanceof Error && missing(error)) return new Map<string, string>(); throw error; }

  try {
    const before = await file.stat({ bigint: true });

    if (!before.isFile()) throw new Error("Agent mailbox transcript must be a regular file");
    const fingerprint = `${before.mtimeNs}:${before.size}`;
    const cached = cachedReceipts(db, id, path, fingerprint);

    if (cached) return cached;
    const saved = await readDeliveries(file, id);

    await file.sync();
    await syncDirectory(dirname(path));

    const after = await file.stat({ bigint: true });

    if (before.mtimeNs === after.mtimeNs && before.size === after.size) saveReceipts(db, id, path, fingerprint, saved);

    return saved;
  } finally { await file.close(); }
}

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
  const db = connection(root);

  transaction(db, "IMMEDIATE", () => {
    if (db.prepare("SELECT 1 FROM session_mailbox_state WHERE session_id=?").get(chat.sessionId)) return;
    register(db, chat.sessionId, chat.path);
    db.prepare("INSERT INTO session_mailbox_state VALUES (?)").run(chat.sessionId);
  });

  return { db, ...chat };
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
  saved: async (root: string, request: { sessionId: string; path: string; required?: boolean }) => {
    const chat = Parse(chatSchema, request);

    if (storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");
    const db = connection(root);
    const cached = cachedReceipts(db, chat.sessionId, chat.path, registeredFingerprint(db, chat.sessionId, chat.path));

    return [...(cached ?? await readSavedDeliveries(db, chat.sessionId, chat.path, request.required === true))];
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
