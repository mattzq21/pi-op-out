import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import { addMailbox, addMailboxDelivery, hasMailbox, mailboxDeliveries, mailboxDelivery, mailboxReceiptCache, mailboxTranscriptFingerprint, nextMailboxSequence, register,
  removeMailboxDelivery, saveMailboxReceiptCache, storageRoot, transaction } from "../session-database.cjs";
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

function cachedReceipts(root: string, id: string, path: string, fingerprint: string | undefined) {
  if (fingerprint === undefined) return undefined;
  const deliveries = mailboxReceiptCache(root, id, path, fingerprint);

  return deliveries !== undefined ? new Map<string, string>(Parse(receiptCacheSchema, JSON.parse(String(deliveries)))) : undefined;
}

async function readSavedDeliveries(root: string, id: string, path: string, required: boolean) {
  let file;

  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (!required && error instanceof Error && missing(error)) return new Map<string, string>(); throw error; }

  try {
    const before = await file.stat({ bigint: true });

    if (!before.isFile()) throw new Error("Agent mailbox transcript must be a regular file");
    const fingerprint = `${before.mtimeNs}:${before.size}`;
    const cached = cachedReceipts(root, id, path, fingerprint);

    if (cached) return cached;
    const saved = await readDeliveries(file, id);

    await file.sync();
    await syncDirectory(dirname(path));

    const after = await file.stat({ bigint: true });

    if (before.mtimeNs === after.mtimeNs && before.size === after.size) saveMailboxReceiptCache(root, id, path, fingerprint, JSON.stringify([...saved]));

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

// The chat of request, with its mailbox ready.
function mailbox(root: string, request: unknown) {
  const chat = Parse(chatSchema, request);

  if (!isAbsolute(chat.path) || !chat.path.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  if (storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");
  transaction(root, "IMMEDIATE", () => {
    if (hasMailbox(root, chat.sessionId)) return;
    register(root, chat.sessionId, chat.path);
    addMailbox(root, chat.sessionId);
  });

  return chat;
}

function nextRecord(root: string, sessionId: string, deliveryId: string, message: MailboxMessage): MailboxRecord {
  const sequence = Parse(Type.Integer(), nextMailboxSequence(root, sessionId));

  const record: MailboxRecord = { version: 1, sessionId, deliveryId, sequence, message };
  addMailboxDelivery(root, record.sessionId, record.deliveryId, record.sequence, record.message.details.mailboxFingerprint, JSON.stringify(record.message));

  return record;
}

export const OPERATIONS = {
  // The mail that the chat's transcript already holds: delivery ID and fingerprint pairs.
  saved: async (root: string, request: { sessionId: string; path: string; required?: boolean }) => {
    const chat = Parse(chatSchema, request);

    if (storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");
    const cached = cachedReceipts(root, chat.sessionId, chat.path, mailboxTranscriptFingerprint(root, chat.sessionId, chat.path));

    return [...(cached ?? await readSavedDeliveries(root, chat.sessionId, chat.path, request.required === true))];
  },
  pending: (root: string, request: unknown) => {
    const { sessionId } = mailbox(root, request);

    return mailboxDeliveries(root, sessionId).map(row => mailboxRecord(Parse(savedRecordSchema, row)));
  },
  store: (root: string, request: { deliveryId: string; message: unknown }) => {
    const { sessionId } = mailbox(root, request);
    const message = Parse(messageSchema, request.message);
    const deliveryId = String(request.deliveryId);

    if (message.details.mailboxSessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");

    return transaction(root, "IMMEDIATE", () => {
      const existing = mailboxDelivery(root, sessionId, deliveryId);
      const record = existing ? mailboxRecord(Parse(savedRecordSchema, existing)) : nextRecord(root, sessionId, deliveryId, message);
      assertSameDelivery(record.message.details.mailboxFingerprint, message);

      return record;
    });
  },
  remove: (root: string, request: { record: unknown }) => {
    const { sessionId } = mailbox(root, request);
    const record = Parse(recordSchema, request.record);

    if (record.sessionId !== sessionId) throw new Error("Agent mail belongs to another conversation");
    removeMailboxDelivery(root, record.sessionId, record.deliveryId, record.message.details.mailboxFingerprint);

    return null;
  },
};
