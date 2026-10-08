import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

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

async function syncRecord(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await file.sync(); }
  finally { await file.close(); }

  await syncDirectory(dirname(path));
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);

  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Agent mailbox storage must be a directory");
  await syncDirectory(dirname(path));
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

async function writeJson(path: string, value: MailboxRecord | Static<typeof ownerSchema>) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }

    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
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

async function ensureOwner(ctx: ExtensionContext, root: string) {
  const sessionId = ctx.sessionManager.getSessionId();
  await privateDirectory(dirname(root));
  await privateDirectory(root);
  await privateDirectory(join(root, "pending"));
  const path = join(root, "owner.json");
  const previous = await optionalJson(path);

  if (previous) {
    if (Parse(ownerSchema, previous).sessionId !== sessionId) throw new Error("Agent mailbox belongs to another conversation");

    return;
  }

  await writeJson(path, { version: 1, sessionId });
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

async function pendingRecords(ctx: ExtensionContext, root: string) {
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
      await ensureOwner(ctx, root);

      if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed before agent mail was accepted");

      if (saved) { assertSameDelivery(saved, normalized);

        return false; }

      const path = pendingPath(root, deliveryId);
      const existing = await optionalJson(path);

      if (existing) {
        const previous = Parse(recordSchema, existing);
        assertSameDelivery(previous.message.details.mailboxFingerprint, normalized);
        await syncRecord(path);

        return this.submit(ctx, previous, send);
      }

      const sequence = (await pendingRecords(ctx, root)).reduce((latest, record) => Math.max(latest, record.sequence + 1), Date.now());
      const record: MailboxRecord = { version: 1, sessionId, deliveryId, sequence, message: normalized };
      await writeJson(path, record);

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
        await rm(pendingPath(root, record.deliveryId));
      }

      await syncDirectory(join(root, "pending"));
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
