import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { open as openDatabase, register } from "../session-database.cjs";

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

const ownerSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String() });

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

async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    if (!(await file.stat()).isFile()) throw new Error("Agent mailbox record must be a regular file");

    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function optionalJson(path: string) {
  try { return await readJson(path); }
  catch (error) { if (error instanceof Error && missing(error)) return undefined; throw error; }
}

function mailboxPath(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  return join(path.slice(0, -6) + ".snapshots", "mailbox");
}

function pendingPath(root: string, deliveryId: string) {
  return join(root, "pending", `${createHash("sha256").update(deliveryId).digest("hex")}.json`);
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

async function savedDeliveries(ctx: ExtensionContext, required = false) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Durable agent mail requires a saved conversation");
  let file;

  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (!required && error instanceof Error && missing(error)) return new Map<string, string>(); throw error; }

  try {
    if (!(await file.stat()).isFile()) throw new Error("Agent mailbox transcript must be a regular file");
    const saved = await readDeliveries(file, ctx.sessionManager.getSessionId());

    if (required || saved.size) { await file.sync(); await syncDirectory(dirname(path)); }

    return saved;
  } finally { await file.close(); }
}

async function legacyPendingRecords(ctx: ExtensionContext, root: string) {
  const owner = await optionalJson(join(root, "owner.json"));

  if (!owner) return [];

  if (Parse(ownerSchema, owner).sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Agent mailbox belongs to another conversation");
  const files = (await readdir(join(root, "pending"))).filter(name => name.endsWith(".json"));
  const records: MailboxRecord[] = [];

  for (const name of files) {
    const record = Parse(recordSchema, await readJson(join(root, "pending", name)));

    if (record.sessionId !== ctx.sessionManager.getSessionId() || record.message.details.mailboxSessionId !== record.sessionId) throw new Error("Agent mail belongs to another conversation");

    if (record.message.details.notificationId !== record.deliveryId || pendingPath(root, record.deliveryId) !== join(root, "pending", name)) throw new Error("Invalid agent mailbox delivery identity");
    records.push(record);
  }

  return records.sort((left, right) => left.sequence - right.sequence);
}

function assertSameDelivery(fingerprint: string, message: MailboxMessage) {
  if (fingerprint !== message.details.mailboxFingerprint) throw new Error("Agent delivery ID was reused for a different message");
}

function storageRoot(file: string) {
  let directory = dirname(file);

  while (dirname(directory) !== directory) {
    if (["sessions", "archived"].includes(basename(directory))) return dirname(directory);
    directory = dirname(directory);
  }

  throw new Error("Agent mailbox is outside session storage");
}

async function mailboxDatabase(ctx: ExtensionContext, root: string) {
  const sessionId = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();

  if (!file) throw new Error("Durable agent mail requires a saved conversation");
  const db = openDatabase(storageRoot(file));

  try {
    if (!db.prepare("SELECT 1 FROM session_mailbox_state WHERE session_id=?").get(sessionId)) {
      const records = await legacyPendingRecords(ctx, root);

      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Conversation changed while recovering agent mail");
      importPending(db, sessionId, file, records);
    }

    return db;
  } catch (error) { db.close(); throw error; }
}

function importPending(db: DatabaseSync, sessionId: string, file: string, records: MailboxRecord[]) {
  db.exec("BEGIN IMMEDIATE");

  try {
    if (!db.prepare("SELECT 1 FROM session_mailbox_state WHERE session_id=?").get(sessionId)) {
      register(db, sessionId, file);

      for (const record of records) insertPending(db, record);
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
      send(record.message);
      this.queued.add(key);

      return true;
    } catch (error) {
      ctx.ui.notify(`Agent mail was saved and will be retried: ${String(error)}`, "error");

      return false;
    }
  }

  private deliver(message: MailboxMessage) {
    this.pi.sendMessage(message, { triggerTurn: false });
    this.pi.events.emit("piop:agent-mail", { notificationId: message.details.notificationId });
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

          if (branch.has(record.deliveryId)) this.pi.events.emit("piop:agent-mail", { notificationId: record.deliveryId });
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

  consume(ctx: ExtensionContext, notificationId: string) { this.consumed.add(this.key(ctx, notificationId)); }

  reset() { this.queued.clear(); this.consumed.clear(); }
}

const mailboxes = new WeakMap<ExtensionAPI, DurableMailbox>();

export function durableMailbox(pi: ExtensionAPI) {
  let mailbox = mailboxes.get(pi);

  if (!mailbox) { mailbox = new DurableMailbox(pi); mailboxes.set(pi, mailbox); }

  return mailbox;
}
