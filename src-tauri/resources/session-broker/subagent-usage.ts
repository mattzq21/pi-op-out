import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalTokens } from "./goal-state.ts";

type Channel = { port: number; token: string };

const channelPath = (path: string) => `${path}.goal-usage.json`;

async function claimChannel(path: string) {
  try {
    const { pid } = JSON.parse(await readFile(path, "utf8")) as { pid: number };

    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid existing subagent usage channel");

    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      await rm(path);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  return open(path, "wx", 0o600);
}

async function receiveUsage(request: IncomingMessage, response: ServerResponse, token: string, report: (total: number) => void) {
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

  const { total } = JSON.parse(body) as { total: number };

  if (!Number.isSafeInteger(total) || total < 0) { response.writeHead(400).end();

  return; }

  report(total);
  response.writeHead(204).end();
}

export async function listenSubagentUsage(path: string, report: (total: number) => void, failed: (cause: unknown) => void) {
  const token = randomUUID();

  const server = createServer((request, response) => {
    void receiveUsage(request, response, token, report).catch(error => { response.writeHead(500).end(); failed(error); });
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  let owned = false;

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));

    if (owned) await rm(channelPath(path), { force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", failed);
    const port = (server.address() as AddressInfo).port;
    const file = await claimChannel(channelPath(path));
    owned = true;

    try { await file.writeFile(JSON.stringify({ port, token, pid: process.pid })); }
    finally { await file.close(); }

    return close;
  } catch (error) { await close(); throw error; }
}

async function loadChannel(ctx: ExtensionContext): Promise<Channel | undefined> {
  const path = ctx.sessionManager.getSessionFile();

  if (!path || !ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-subagent-parent")) return;

  try {
    const channel = JSON.parse(await readFile(channelPath(path), "utf8")) as Channel;

    if (!Number.isInteger(channel.port) || channel.port < 1 || channel.port > 65535 || typeof channel.token !== "string") throw new Error("Invalid subagent usage channel");

    return channel;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function registerSubagentUsage(pi: ExtensionAPI) {
  let channel: Channel | undefined;
  let total = 0;
  let pending = Promise.resolve();
  pi.on("session_start", async (_event, ctx) => { await pending.catch(() => undefined); channel = undefined; total = 0; channel = await loadChannel(ctx); });

  const report = (tokens: number, ctx: ExtensionContext) => {
    if (!channel || !tokens) return;
    total += tokens;
    const target = channel;
    const body = JSON.stringify({ total });
    pending = pending.catch(() => undefined).then(async () => {
      const response = await fetch(`http://127.0.0.1:${target.port}/usage`, { method: "POST", headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });

      if (!response.ok) throw new Error(`Subagent usage delivery failed: HTTP ${response.status}`);
    }).catch(error => { ctx.abort(); throw error; });

    return pending;
  };

  pi.on("message_end", (event, ctx) => { if (event.message.role === "assistant") return report(goalTokens(event.message.usage), ctx); });
  pi.on("session_compact", (event, ctx) => report(goalTokens(event.compactionEntry.usage), ctx));
  pi.on("session_shutdown", () => pending);
}
