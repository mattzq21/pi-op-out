import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalTokens } from "./goal-state.ts";
import { persistSubagentResponseUsage, subagentUsageTotal } from "./subagent-results.ts";

const channelSchema = Type.Object({
  port: Type.Integer({ minimum: 1, maximum: 65535 }), token: Type.String(),
  startedAt: Type.Optional(Type.Number()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

const usageSchema = Type.Object({ total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });

const fileErrorSchema = Type.Object({ code: Type.String() });

const addressSchema = Type.Object({ port: Type.Number() });

type Channel = Static<typeof channelSchema>;

const channelPath = (path: string) => `${path}.goal-usage.json`;

const channelUpdateScript = `
  const fs = require("node:fs");
  const http = require("node:http");
  const [path, temporary, action] = process.argv.slice(1);
  const next = JSON.parse(fs.readFileSync(0, "utf8"));
  function readOwner() {
    let content;
    try { content = fs.readFileSync(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try { return JSON.parse(content); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
  }
  function identity(pid) {
    if (process.platform !== "linux") return;
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + started;
  }
  function listening(owner) {
    if (!Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || typeof owner.token !== "string") return false;
    return new Promise((resolve, reject) => {
      const authenticated = owner.protocol === 1;
      const request = http.request({ host: "127.0.0.1", port: owner.port, path: authenticated ? "/owner" : "/usage", method: authenticated ? "GET" : "POST", headers: { Authorization: "Bearer " + owner.token, "Content-Type": "application/json" } }, response => {
        response.resume();
        resolve(authenticated ? response.statusCode === 204 && response.headers["x-piop-usage-token"] === owner.token : response.statusCode === 204 || response.statusCode === 500);
      });
      request.setTimeout(2000, () => request.destroy(new Error("Existing subagent usage listener did not respond")));
      request.on("error", error => { if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") resolve(false); else reject(error); });
      request.end(authenticated ? undefined : '{"total":0}');
    });
  }
  async function claim() {
    const owner = readOwner();
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.pid <= 2147483647) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return publish(); if (error.code !== "EPERM") throw error; }
      let current;
      try { current = identity(owner.pid); }
      catch (error) { if (error.code === "ENOENT") return publish(); throw error; }
      if (owner.identity && current && owner.identity !== current) return publish();
      if (await listening(owner)) throw new Error("Subagent usage channel is already owned by a running process");
    }
    publish();
  }
  function publish() {
    process.kill(next.pid, 0);
    next.identity = identity(next.pid);
    next.protocol = 1;
    fs.rmSync(temporary, { force: true });
    try {
      const file = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(file, JSON.stringify(next)); fs.fsyncSync(file); }
      finally { fs.closeSync(file); }
      fs.renameSync(temporary, path);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  async function update() {
    if (action === "claim") await claim();
    else if (readOwner()?.token === next.token) fs.rmSync(path, { force: true });
  }
  update().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

async function prepareChannelDirectory(path: string, directory: string) {
  const transcript = await lstat(path);

  if (!transcript.isFile() || transcript.isSymbolicLink()) throw new Error("Subagent usage requires a saved session file");
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function channelDirectory(path: string, action: "claim" | "close") {
  if (!path.endsWith(".jsonl")) throw new Error("Subagent usage requires a saved session");

  const directory = path.replace(/\.jsonl$/, ".snapshots");

  if (action === "claim") await prepareChannelDirectory(path, directory);

  const info = await lstat(directory).catch(error => {
    if (action === "close" && Check(fileErrorSchema, error) && error.code === "ENOENT") return;
    throw error;
  });

  if (!info) return;

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Subagent usage storage must be a directory");

  return directory;
}

async function updateChannel(path: string, action: "claim" | "close", channel: Channel & { pid: number }) {
  const directory = await channelDirectory(path, action);

  if (!directory) return;

  return new Promise<void>((resolve, reject) => {
    const child = execFile("flock", ["--exclusive", "--wait", "10", "--no-fork", join(directory, "subagent-usage.lock"), process.execPath, "-e", channelUpdateScript, channelPath(path), join(directory, "subagent-usage.pending"), action], { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8" }, (error, _output, stderr) => {
      if (error) reject(new Error(`Could not ${action} subagent usage channel: ${stderr.trim() || error.message}`));
      else resolve();
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(channel));
  });
}

async function receiveUsage(request: IncomingMessage, response: ServerResponse, token: string, report: (total: number) => void | Promise<void>) {
  if (request.method === "GET" && request.url === "/owner" && request.headers.authorization === `Bearer ${token}`) {
    response.writeHead(204, { "X-Piop-Usage-Token": token }).end();

    return;
  }

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

  await report(usage.total);
  response.writeHead(204).end();
}

export async function listenSubagentUsage(path: string, report: (total: number) => void | Promise<void>, failed: (cause: unknown) => void, scope: { startedAt: number; offset?: number }) {
  const token = randomUUID();

  const server = createServer((request, response) => {
    void receiveUsage(request, response, token, report).catch(error => { response.writeHead(500).end(); failed(error); });
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  let channel: (Channel & { pid: number }) | undefined;

  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));

    if (channel) await updateChannel(path, "close", channel);
  };

  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", failed);
    const address = server.address();

    if (!Check(addressSchema, address)) throw new Error("Subagent usage server did not bind a TCP port");
    channel = { port: address.port, token, pid: process.pid, startedAt: scope.startedAt, offset: scope.offset };
    await updateChannel(path, "claim", channel);

    return close;
  } catch (error) { await close(); throw error; }
}

async function loadChannel(ctx: ExtensionContext): Promise<Channel | undefined> {
  const path = ctx.sessionManager.getSessionFile();

  if (!path || !ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-subagent-parent")) return;

  try {
    const channel = JSON.parse(await readFile(channelPath(path), "utf8"));

    if (!Check(channelSchema, channel)) throw new Error("Invalid subagent usage channel");

    return channel;
  } catch (error) { if (!Check(fileErrorSchema, error) || error.code !== "ENOENT") throw error; }
}

function childSession(ctx: ExtensionContext) {
  return ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-subagent-parent");
}

async function durableUsage(ctx: ExtensionContext, target: Channel) {
  const sessionPath = ctx.sessionManager.getSessionFile();

  if (!sessionPath) throw new Error("Subagent usage requires a saved conversation");

  return subagentUsageTotal({ sessionPath, offset: target.offset, startedAt: target.startedAt ?? 0 });
}

export function registerSubagentUsage(pi: ExtensionAPI) {
  let channel: Channel | undefined;
  let legacyBaseline: number | undefined;
  let pending = Promise.resolve();

  const report = (tokens: number, ctx: ExtensionContext, abortOnFailure = true) => {
    pending = pending.catch(() => undefined).then(async () => {
      const target = await loadChannel(ctx);

      if (target?.token !== channel?.token) legacyBaseline = undefined;
      channel = target;

      if (!target) return;
      const durable = await durableUsage(ctx, target);

      if (target.startedAt === undefined) legacyBaseline ??= Math.max(0, durable - tokens);
      const total = Math.max(0, durable - (legacyBaseline ?? 0));
      const body = JSON.stringify({ total });
      const response = await fetch(`http://127.0.0.1:${target.port}/usage`, { method: "POST", headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });

      if (!response.ok) throw new Error(`Subagent usage delivery failed: HTTP ${response.status}`);
    }).catch(error => { if (abortOnFailure) ctx.abort(); throw error; });

    return pending;
  };

  pi.on("session_start", async (_event, ctx) => {
    await pending.catch(() => undefined); channel = undefined; legacyBaseline = undefined;
    await report(0, ctx, false).catch(() => undefined);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !childSession(ctx)) return;
    const tokens = goalTokens(event.message.usage);

    if (!tokens) return;
    await persistSubagentResponseUsage(pi, ctx, event.message.timestamp, tokens);
    await report(tokens, ctx);
  });
  pi.on("session_compact", (event, ctx) => report(goalTokens(event.compactionEntry.usage), ctx));
  pi.on("session_shutdown", () => pending);

  return report;
}
