import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Check, Parse } from "typebox/value";
import { call } from "../storage-channel.cjs";
import { assertSameDelivery, messageDetails, messageSchema, objectSchema, type MailboxMessage, type MailboxRecord } from "./mailbox-records.ts";

export type { MailboxDetails, MailboxMessage } from "./mailbox-records.ts";

type SendMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

// Agent mail waits in the database until the chat saves it. The daemon keeps it; Pi asks through its storage channel.

function chat(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Durable agent mail requires a saved conversation");

  return { sessionId: ctx.sessionManager.getSessionId(), path };
}

function normalizeMessage(ctx: ExtensionContext, message: SendMessage, deliveryId: string): MailboxMessage {
  const details = Check(objectSchema, message.details) ? message.details : {};
  const fingerprint = createHash("sha256").update(JSON.stringify([message.customType, message.content, details])).digest("hex");

  return Parse(messageSchema, { ...message, details: { ...details, notificationId: deliveryId, mailboxSessionId: ctx.sessionManager.getSessionId(), mailboxFingerprint: fingerprint } });
}

async function savedDeliveries(ctx: ExtensionContext, required = false) {
  return new Map<string, string>(await call("mailbox.saved", { ...chat(ctx), required }) as Array<[string, string]>);
}

async function pendingRecords(ctx: ExtensionContext) {
  const request = chat(ctx);
  const records = await call("mailbox.pending", request) as MailboxRecord[];

  if (request.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed while reading agent mail");

  return records;
}

async function storePending(ctx: ExtensionContext, deliveryId: string, message: MailboxMessage) {
  if (message.details.mailboxSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed before agent mail was accepted");

  return await call("mailbox.store", { ...chat(ctx), deliveryId, message }) as MailboxRecord;
}

async function removePending(ctx: ExtensionContext, record: MailboxRecord) {
  await call("mailbox.remove", { ...chat(ctx), record });
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

  private submit(ctx: ExtensionContext, record: MailboxRecord, send: (message: MailboxMessage) => boolean) {
    if (record.sessionId !== ctx.sessionManager.getSessionId()) return false;

    const key = this.key(ctx, record.deliveryId);

    if (this.queued.has(key)) return false;

    try {
      this.queued.add(key);

      if (send(record.message)) return true;
      this.queued.delete(key);

      return false;
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

    return true;
  }

  send(ctx: ExtensionContext, message: SendMessage, deliveryId: string, send = (item: MailboxMessage) => this.deliver(item)) {
    return this.serial(async () => {
      if (!deliveryId.trim()) throw new Error("Agent mail requires a stable delivery ID");
      const sessionId = ctx.sessionManager.getSessionId();
      const normalized = normalizeMessage(ctx, message, deliveryId);
      const saved = (await savedDeliveries(ctx, true)).get(deliveryId);

      if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Conversation changed before agent mail was accepted");

      if (saved) { assertSameDelivery(saved, normalized);

        return false; }

      const record = await storePending(ctx, deliveryId, normalized);

      return this.submit(ctx, record, send);
    });
  }

  reconcile(ctx: ExtensionContext) {
    return this.serial(async () => {
      const records = await pendingRecords(ctx);

      if (!records.length) return;
      const saved = await savedDeliveries(ctx);

      for (const record of records) {
        if (!this.consumed.has(this.key(ctx, record.deliveryId))) continue;
        const fingerprint = saved.get(record.deliveryId);

        if (!fingerprint) continue;
        assertSameDelivery(fingerprint, record.message);
        await removePending(ctx, record);
        this.queued.delete(this.key(ctx, record.deliveryId));
        this.consumed.delete(this.key(ctx, record.deliveryId));
      }

    });
  }

  replay(ctx: ExtensionContext, send = (message: MailboxMessage) => this.deliver(message)) {
    return this.serial(async () => {
      const records = await pendingRecords(ctx);

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
