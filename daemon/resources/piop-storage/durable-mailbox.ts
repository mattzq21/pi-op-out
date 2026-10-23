import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { open as openDatabase, register, storageRoot } from "../session-database.cjs";

const detailsSchema = Type.Object({ notificationId: Type.String(), mailboxSessionId: Type.String(), mailboxFingerprint: Type.String() });

const objectSchema = Type.Record(Type.String(), Type.Unknown());

const messageSchema = Type.Object({
  customType: Type.Union([Type.Literal("piop-agent-message"), Type.Literal("piop-subagent-result")]),
  content: Type.Union([Type.String(), Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  ]))]),
  display: Type.Boolean(), details: Type.Intersect([objectSchema, detailsSchema]),
});

const recordSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), deliveryId: Type.String(), sequence: Type.Integer({ minimum: 0 }), message: messageSchema });

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String() });

const storedMessageSchema = Type.Object({ type: Type.Literal("message"), message: Type.Object({ details: detailsSchema }) });

const customMessageSchema = Type.Object({ type: Type.Literal("custom_message"), details: detailsSchema });

export type MailboxMessage = Static<typeof messageSchema>;

export type MailboxDetails = Static<typeof detailsSchema>;

type MailboxRecord = Static<typeof recordSchema>;

type SendMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

function missing(error: Error) { return "code" in error && error.code === "ENOENT"; }

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await directory.sync(); }
  finally { await directory.close(); }
}

function mailboxPath(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  return join(path.slice(0, -6) + ".snapshots", "mailbox");
}

function normalizeMessage(ctx: ExtensionContext, message: SendMessage, deliveryId: string): MailboxMessage {
  const details = Check(objectSchema, message.details) ? message.details : {};
  const fingerprint = createHash("sha256").update(JSON.stringify([message.customType, message.content, details])).digest("hex");

  return Parse(messageSchema, { ...message, details: { ...details, notificationId: deliveryId, mailboxSessionId: ctx.sessionManager.getSessionId(), mailboxFingerprint: fingerprint } });
}

function messageDetails(entry: SessionEntry): MailboxDetails | undefined {
  if (Check(customMessageSchema, entry)) return entry.details;

  if (Check(storedMessageSchema, entry)) return entry.message.details;

  return undefined;
}

async function* transcriptLines(file: FileHandle) {
    let pending = "";

    for await (const chunk of file.createReadStream({ autoClose: false, encoding: "utf8" })) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      yield* lines;
    }
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

function savedMessageDetails(line: string) {
  try { return messageDetails(JSON.parse(line)); }
  catch { return undefined; }
}

const receiptCacheSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));

function receiptDatabase(path: string) {
  const db = openDatabase(storageRoot(path));

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_mailbox_receipt_cache (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, deliveries_json TEXT NOT NULL)`);

    return db;
  } catch (error) { db.close(); throw error; }
}

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

async function savedDeliveries(ctx: ExtensionContext, required = false) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Durable agent mail requires a saved conversation");
  const id = ctx.sessionManager.getSessionId();
  const db = receiptDatabase(path);

  try {
    const cached = cachedReceipts(db, id, path, registeredFingerprint(db, id, path));

    return cached ?? await readSavedDeliveries(db, id, path, required);
  } finally { db.close(); }
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

function assertSameDelivery(fingerprint: string, message: MailboxMessage) {
  if (fingerprint !== message.details.mailboxFingerprint) throw new Error("Agent delivery ID was reused for a different message");
}

async function mailboxDatabase(ctx: ExtensionContext, _root: string) {
  const sessionId = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();

  if (!file) throw new Error("Durable agent mail requires a saved conversation");
  const db = openDatabase(storageRoot(file));

  try {
    if (!db.prepare("SELECT 1 FROM session_mailbox_state WHERE session_id=?").get(sessionId)) {

      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Conversation changed while recovering agent mail");
      initializeMailbox(db, sessionId, file);
    }

    return db;
  } catch (error) { db.close(); throw error; }
}

function initializeMailbox(db: DatabaseSync, sessionId: string, file: string) {
  db.exec("BEGIN IMMEDIATE");

  try {
    if (!db.prepare("SELECT 1 FROM session_mailbox_state WHERE session_id=?").get(sessionId)) {
      register(db, sessionId, file);

      db.prepare("INSERT INTO session_mailbox_state VALUES (?)").run(sessionId);
    }

    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function insertPending(db: DatabaseSync, record: MailboxRecord) {
  db.prepare("INSERT INTO session_mailbox VALUES (?, ?, ?, ?, ?)").run(record.sessionId, record.deliveryId,
    record.sequence, record.message.details.mailboxFingerprint, JSON.stringify(record.message));
}

const savedRecordSchema = Type.Object({ session_id: Type.String(), delivery_id: Type.String(), sequence: Type.Integer(), fingerprint: Type.String(), message_json: Type.String() });

function mailboxRecord(saved: Static<typeof savedRecordSchema>): MailboxRecord {
  const record = Parse(recordSchema, { version: 1, sessionId: saved.session_id, deliveryId: saved.delivery_id,
    sequence: saved.sequence, message: JSON.parse(saved.message_json) });

  if (record.message.details.mailboxSessionId !== record.sessionId || record.message.details.notificationId !== record.deliveryId) throw new Error("Invalid saved agent delivery identity");
  assertSameDelivery(saved.fingerprint, record.message);

  return record;
}

async function pendingRecords(ctx: ExtensionContext, root: string) {
  const sessionId = ctx.sessionManager.getSessionId();
  const db = await mailboxDatabase(ctx, root);

  try {
    if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed while reading agent mail");

    return db.prepare("SELECT * FROM session_mailbox WHERE session_id=? ORDER BY sequence, delivery_id")
      .all(sessionId).map(row => mailboxRecord(Parse(savedRecordSchema, row)));
  } finally { db.close(); }
}

async function storePending(ctx: ExtensionContext, root: string, deliveryId: string, message: MailboxMessage) {
  const db = await mailboxDatabase(ctx, root);

  try {
    db.exec("BEGIN IMMEDIATE");
    const sessionId = message.details.mailboxSessionId;

    if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed before agent mail was accepted");
    const existing = db.prepare("SELECT * FROM session_mailbox WHERE session_id=? AND delivery_id=?").get(sessionId, deliveryId);
    const record = existing ? mailboxRecord(Parse(savedRecordSchema, existing)) : nextRecord(db, sessionId, deliveryId, message);
    assertSameDelivery(record.message.details.mailboxFingerprint, message);
    db.exec("COMMIT");

    return record;
  } finally { db.close(); }
}

function nextRecord(db: DatabaseSync, sessionId: string, deliveryId: string, message: MailboxMessage): MailboxRecord {
  const row = Parse(Type.Object({ sequence: Type.Integer() }), db.prepare(
    "SELECT max(coalesce(max(sequence)+1, 0), ?) AS sequence FROM session_mailbox WHERE session_id=?").get(Date.now(), sessionId));

  const record: MailboxRecord = { version: 1, sessionId, deliveryId, sequence: row.sequence, message };
  insertPending(db, record);

  return record;
}

async function removePending(ctx: ExtensionContext, root: string, record: MailboxRecord) {
  const db = await mailboxDatabase(ctx, root);

  try {
    db.prepare("DELETE FROM session_mailbox WHERE session_id=? AND delivery_id=? AND fingerprint=?")
      .run(record.sessionId, record.deliveryId, record.message.details.mailboxFingerprint);
  } finally { db.close(); }
}

export class DurableMailbox {
  private queued = new Set<string>();
  private consumed = new Set<string>();
  private work = Promise.resolve();
  constructor(private pi: ExtensionAPI) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.work.then(action);
    this.work = next.then(() => {}, () => {});

    return next;
  }

  private key(ctx: ExtensionContext, id: string) { return `${ctx.sessionManager.getSessionId()}:${id}`; }

  private submit(ctx: ExtensionContext, record: MailboxRecord, send: (message: MailboxMessage) => void) {
    if (record.sessionId !== ctx.sessionManager.getSessionId()) return false;

    const key = this.key(ctx, record.deliveryId);

    if (this.queued.has(key)) return false;

    try {
      this.queued.add(key);
      send(record.message);

      return true;
    } catch (error) {
      this.queued.delete(key);
      this.consumed.delete(key);
      ctx.ui.notify(`Agent mail was saved and will be retried: ${(error instanceof Error ? error.message : String(error))}`, "error");

      return false;
    }
  }

  private deliver(message: MailboxMessage) {
    this.pi.sendMessage(message, { triggerTurn: false });
    this.pi.events.emit("piop:agent-mail", { notificationId: message.details.notificationId, customType: message.customType });
  }

  send(ctx: ExtensionContext, message: SendMessage, deliveryId: string, send = (item: MailboxMessage) => this.deliver(item)) {
    return this.serial(async () => {
      if (!deliveryId.trim()) throw new Error("Agent mail requires a stable delivery ID");
      const root = mailboxPath(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      const normalized = normalizeMessage(ctx, message, deliveryId);
      const saved = (await savedDeliveries(ctx, true)).get(deliveryId);

      if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed before agent mail was accepted");

      if (saved) { assertSameDelivery(saved, normalized);

        return false; }

      const record = await storePending(ctx, root, deliveryId, normalized);

      return this.submit(ctx, record, send);
    });
  }

  reconcile(ctx: ExtensionContext) {
    return this.serial(async () => {
      const root = mailboxPath(ctx);
      const records = await pendingRecords(ctx, root);

      if (!records.length) return;
      const saved = await savedDeliveries(ctx);

      for (const record of records) {
        if (!this.consumed.has(this.key(ctx, record.deliveryId))) continue;
        const fingerprint = saved.get(record.deliveryId);

        if (!fingerprint) continue;
        assertSameDelivery(fingerprint, record.message);
        await removePending(ctx, root, record);
        this.queued.delete(this.key(ctx, record.deliveryId));
        this.consumed.delete(this.key(ctx, record.deliveryId));
      }

    });
  }

  replay(ctx: ExtensionContext, send = (message: MailboxMessage) => this.deliver(message)) {
    return this.serial(async () => {
      const root = mailboxPath(ctx);
      const records = await pendingRecords(ctx, root);

      if (!records.length) return;
      const saved = await savedDeliveries(ctx);
      const live = this.liveDeliveries(ctx, ctx.sessionManager.getEntries());
      const branch = this.liveDeliveries(ctx, ctx.sessionManager.getBranch());

      for (const record of records) {
        const fingerprint = saved.get(record.deliveryId);

        if (fingerprint) {
          assertSameDelivery(fingerprint, record.message);
          this.queued.add(this.key(ctx, record.deliveryId));

          if (branch.has(record.deliveryId)) this.pi.events.emit("piop:agent-mail", { notificationId: record.deliveryId, customType: record.message.customType });
          else this.consumed.add(this.key(ctx, record.deliveryId));
          continue;
        }

        if (live.has(record.deliveryId)) continue;

        if (ctx.isIdle()) this.queued.delete(this.key(ctx, record.deliveryId));
        this.submit(ctx, record, send);
      }
    });
  }

  private liveDeliveries(ctx: ExtensionContext, entries: SessionEntry[]) {
    return new Set(entries.flatMap(entry => {
      const details = messageDetails(entry);

      return details?.mailboxSessionId === ctx.sessionManager.getSessionId() ? [details.notificationId] : [];
    }));
  }

  consume(ctx: ExtensionContext, notificationId: string) {
    const key = this.key(ctx, notificationId);

    if (this.queued.has(key)) this.consumed.add(key);
  }

  reset() { this.queued.clear(); this.consumed.clear(); }
}

const mailboxes = new WeakMap<ExtensionAPI, DurableMailbox>();

export function durableMailbox(pi: ExtensionAPI) {
  let mailbox = mailboxes.get(pi);

  if (!mailbox) { mailbox = new DurableMailbox(pi); mailboxes.set(pi, mailbox); }

  return mailbox;
}
