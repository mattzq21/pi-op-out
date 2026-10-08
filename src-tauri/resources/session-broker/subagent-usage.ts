import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalTokens } from "./goal-state.ts";
import { claimUsageChannel } from "./subagent-usage-channel.ts";
import { subagentParent } from "./subagent-state.ts";

const channelSchema = Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }), token: Type.String(), usageProtocol: Type.Optional(Type.Integer()) });

const usageSchema = Type.Object({ total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) });

export type UsageCheckpoint = { sourceId: string; total: number };

const fileErrorSchema = Type.Object({ code: Type.String() });

const addressSchema = Type.Object({ port: Type.Number() });

type Channel = Static<typeof channelSchema>;

const usageReceipt = (checkpoint: UsageCheckpoint) => createHash("sha256").update(JSON.stringify([checkpoint.sourceId, checkpoint.total])).digest("hex");

const channelPath = (path: string) => `${path}.goal-usage.json`;

async function receiveUsage(request: IncomingMessage, response: ServerResponse, token: string, report: (total: number, sourceId?: string) => void | Promise<void>) {
  if (request.method !== "POST" || request.url !== "/usage" || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(403).end();

    return;
  }

  let body = "";

  for await (const chunk of request) {
    body += String(chunk);

    if (body.length > 1024) { response.writeHead(413).end();

    return; }
  }

  const usage = JSON.parse(body);

  if (!Check(usageSchema, usage)) { response.writeHead(400).end();

  return; }

  await report(usage.total, usage.sourceId);

  if (usage.sourceId) response.setHeader("X-Piop-Usage-Receipt", usageReceipt({ sourceId: usage.sourceId, total: usage.total }));
  response.writeHead(204).end();
}

export async function listenSubagentUsage(path: string, report: (total: number, sourceId?: string) => void | Promise<void>, failed: (cause: unknown) => void) {
  const token = randomUUID();

  const server = createServer((request, response) => {
    void receiveUsage(request, response, token, report).catch(error => { response.writeHead(500).end(); failed(error); });
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  let releaseChannel: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;

  const close = () => closing ??= (async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await releaseChannel?.();
  })();

  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", failed);
    const address = server.address();

    if (!Check(addressSchema, address)) throw new Error("Subagent usage server did not bind a TCP port");
    const port = address.port;
    releaseChannel = await claimUsageChannel(channelPath(path), port, token);

    return close;
  } catch (error) { await close(); throw error; }
}

async function loadChannel(ctx: ExtensionContext): Promise<Channel | undefined> {
  const path = ctx.sessionManager.getSessionFile();

  if (!path || !subagentParent(ctx)) return;

  try {
    const channel = JSON.parse(await readFile(channelPath(path), "utf8"));

    if (!Check(channelSchema, channel)) throw new Error("Invalid subagent usage channel");

    return channel;
  } catch (error) { if (!Check(fileErrorSchema, error) || error.code !== "ENOENT") throw error; }
}

async function usableChannel(ctx: ExtensionContext, checkpoint?: UsageCheckpoint) {
  const target = await loadChannel(ctx);

  if (!target && checkpoint && subagentParent(ctx)) throw new Error("Subagent usage observation is unavailable; usage remains in the saved transcript");

  if (target && checkpoint && target.usageProtocol !== 2) throw new Error("The parent usage observer must be upgraded before cumulative reports can be delivered");

  return target;
}

function confirmUsageReceipt(response: Response, checkpoint?: UsageCheckpoint) {
  if (!response.ok) throw new Error(`Subagent usage delivery failed: HTTP ${response.status}`);

  if (checkpoint && response.headers.get("X-Piop-Usage-Receipt") !== usageReceipt(checkpoint)) throw new Error("The parent usage observer did not acknowledge the cumulative report");
}

const apiCost = (amount: number) => Number.isFinite(amount) ? Math.max(0, amount) : 0;

export function registerSubagentUsage(pi: ExtensionAPI) {
  let channel: Channel | undefined;
  let total = 0;
  let pending = Promise.resolve();
  let lastFailure = "";
  pi.on("session_start", async () => { await pending.catch(() => undefined); channel = undefined; total = 0; });

  const report = (tokens: number, ctx: ExtensionContext, checkpoint?: UsageCheckpoint) => {
    if (!tokens && !checkpoint) return pending;
    pending = pending.catch(() => undefined).then(async () => {
      const target = await usableChannel(ctx, checkpoint);

      if (target?.token !== channel?.token) total = 0;
      channel = target;

      if (!target) return;

      if (!checkpoint) total += tokens;
      const body = JSON.stringify(checkpoint ?? { total });
      const response = await fetch(`http://127.0.0.1:${target.port}/usage`, { method: "POST", headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });

      confirmUsageReceipt(response, checkpoint);
    }).catch(error => { if (!checkpoint) ctx.abort(); throw error; });

    return pending;
  };

  const record = async (tokens: number, apiCost: number, eventId: string, ctx: ExtensionContext) => {
    pi.appendEntry("piop-subagent-self-usage", { eventId, tokens, apiCost });

    try { await report(tokens, ctx, { sourceId: JSON.stringify([ctx.sessionManager.getSessionId(), eventId]), total: tokens }); lastFailure = ""; }
    catch (error) {
      const message = String(error);

      if (message !== lastFailure) ctx.ui.notify(`Subagent usage is saved; parent accounting will reconcile it: ${message}`, "error");
      lastFailure = message;
    }
  };

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !subagentParent(ctx)) return;
    const id = randomUUID();
    await record(goalTokens(event.message.usage), apiCost(event.message.usage.cost.total), `assistant:${id}`, ctx);

    return { message: { ...event.message, piopSubagentUsageId: id } };
  });
  pi.on("session_compact", (event, ctx) => {
    if (!subagentParent(ctx)) return;

    return record(goalTokens(event.compactionEntry.usage), apiCost(event.compactionEntry.usage?.cost.total ?? 0), `entry:${event.compactionEntry.id}`, ctx);
  });
  pi.on("session_shutdown", () => pending);

  return report;
}
