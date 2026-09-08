import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ServerConfig = {
  id: string;
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string;
  url?: string;
  headers?: string | Record<string, string>;
  enabled: boolean;
  startupTimeoutSec?: number;
};

const REQUEST_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
const MCP_STATUS_KEY = "pi-desktop-mcp-status";

function splitArgs(input = ""): string[] {
  const result: string[] = []; let current = ""; let quote: "'" | '"' | undefined; let escaped = false; let present = false;
  for (const char of input) {
    if (escaped) { present = true; current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; present = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; present = true; continue; }
    if (/\s/.test(char)) { if (present) { result.push(current); current = ""; present = false; } continue; }
    current += char; present = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in MCP server arguments");
  if (present) result.push(current); return result;
}

function safeName(value: string): string {
  return `${(value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool").slice(0, 12)}_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function parseHeaders(value: ServerConfig["headers"]): Record<string, string> {
  if (!value) return {};
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("HTTP headers must be a JSON object");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") throw new Error(`HTTP header ${name} must be a string`);
    headers[name] = headerValue;
  }
  return headers;
}

async function connectClient(client: Client, config: ServerConfig, instanceId: string, signal: AbortSignal, diagnostic: (text: string) => void): Promise<void> {
  client.onerror = (error) => { diagnostic(`${error.message}\n`); process.stderr.write(`[mcp:${config.name}] ${error.message}\n`); };
  const transport = config.transport === "http"
    ? (() => {
        if (!config.url?.trim()) throw new Error("URL is required for HTTP transport");
        const url = new URL(config.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error("MCP URL must use HTTP or HTTPS");
        return new StreamableHTTPClientTransport(url, { requestInit: { headers: parseHeaders(config.headers) } });
      })()
    : (() => {
        if (!config.command?.trim()) throw new Error("Command is required for stdio transport");
        return new StdioClientTransport({
          command: config.command,
          args: splitArgs(config.args),
          env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PIOP_CUA_INSTANCE_ID: instanceId },
          stderr: "pipe",
          maxBufferSize: MAX_MCP_MESSAGE_BYTES,
        });
      })();
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", (chunk: Buffer) => {
      diagnostic(chunk.toString("utf8"));
      process.stderr.write(chunk);
    });
  }
  try { await client.connect(transport, { timeout: startupTimeoutMs(config), signal }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
}

function resultContent(result: unknown) {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content ?? [];
  const mapped: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") mapped.push({ type: "text", text: part.text });
    else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") mapped.push({ type: "image", data: part.data, mimeType: part.mimeType });
    else mapped.push({ type: "text", text: JSON.stringify(part, null, 2) });
  }
  return mapped.length ? mapped : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

function startupTimeoutMs(server: ServerConfig): number {
  const seconds = server.startupTimeoutSec ?? 10;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error("Startup timeout must be an integer between 1 and 600 seconds");
  return seconds * 1000;
}

type Selection = { serverIds: string[]; agentName: string; sessionId: string; ready?: Promise<string[]> };
type Connection = { client: Client; instanceId: string; tools: string[]; connected: boolean };
const SELECT_EVENT = "piop:mcp:select";

export default async function mcpBridge(pi: ExtensionAPI) {
  const configPath = process.env.PI_DESKTOP_MCP_CONFIG; if (!configPath) return;
  const servers = JSON.parse(await readFile(configPath, "utf8")) as ServerConfig[];
  const allowedServerIds = process.env.PI_DESKTOP_MCP_ALLOWED_SERVER_IDS?.split(",").map((id) => id.trim()).filter(Boolean);
  const allowed = allowedServerIds ? new Set(allowedServerIds) : undefined;
  const desktopSkillPaths = (() => { try { const value = JSON.parse(process.env.PI_DESKTOP_SKILL_PATHS || "[]"); return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : []; } catch { return []; } })();
  pi.on("resources_discover", () => process.env.PI_DEFINE_AGENTS_ACTIVE === "1" || !desktopSkillPaths.length ? undefined : { skillPaths: desktopSkillPaths });
  const connections = new Map<string, Connection>();
  const statuses = new Map(servers.map((server) => [server.id, { id: server.id, status: "stopped" as "stopped" | "starting" | "connected" | "error", error: undefined as string | undefined }]));
  const shutdown = new AbortController();
  let context: ExtensionContext | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const publish = () => {
    context?.ui.setStatus(MCP_STATUS_KEY, `json:${JSON.stringify([...statuses.values()])}`);
    const loading = servers.filter((server) => statuses.get(server.id)?.status === "starting");
    context?.ui.setStatus("pi-desktop-mcp-loading", loading.length ? loading.map((server) => `Loading ${server.name}`).join(" · ") : undefined);
  };
  const close = async (id: string) => {
    const connection = connections.get(id);
    connections.delete(id);
    if (connection) { connection.connected = false; await connection.client.close().catch(() => undefined); }
    statuses.set(id, { id, status: "stopped", error: undefined });
  };
  const select = async (selection: Selection): Promise<string[]> => {
    if (shutdown.signal.aborted) throw new Error("MCP bridge has shut down");
    const wanted = new Set(selection.serverIds);
    const instanceFor = (id: string) => `piop-${createHash("sha256").update(JSON.stringify([selection.sessionId, selection.agentName, id])).digest("hex").slice(0, 32)}`;
    // Close the old lease before requesting a new one, including on agent changes.
    await Promise.all([...connections].filter(([id, connection]) => !wanted.has(id) || connection.instanceId !== instanceFor(id) || !connection.connected).map(([id]) => close(id)));
    for (const id of statuses.keys()) if (!wanted.has(id)) statuses.set(id, { id, status: "stopped", error: undefined });
    const errors: string[] = [];
    await Promise.all([...wanted].map(async (id) => {
      const server = servers.find((item) => item.id === id);
      if (!server || !server.enabled || (allowed && !allowed.has(id))) {
        const error = `MCP server "${id}" is unavailable or disabled`;
        statuses.set(id, { id, status: "error", error }); errors.push(error); return;
      }
      if (connections.get(id)?.connected) return;
      const instanceId = instanceFor(id);
      const client = new Client({ name: "piop", version: "0.1.0" });
      const connection: Connection = { client, instanceId, tools: [], connected: false };
      connections.set(id, connection);
      statuses.set(id, { id, status: "starting", error: undefined }); publish();
      let recentOutput = "";
      const diagnostic = (text: string) => { recentOutput = (recentOutput + text).slice(-8192); };
      const errorDetails = (message: string) => recentOutput.trim() ? `${message}\n\nRecent MCP output (last 8 KB):\n${recentOutput.trim()}` : message;
      try {
        await connectClient(client, server, instanceId, shutdown.signal, diagnostic);
        const discovered = [];
        let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS, signal: shutdown.signal });
          discovered.push(...result.tools); cursor = result.nextCursor;
        } while (cursor);
        if (shutdown.signal.aborted) throw new Error("MCP bridge has shut down");
        for (const tool of discovered) {
          const name = `mcp_${safeName(server.id)}_${safeName(tool.name)}`;
          connection.tools.push(name);
          pi.registerTool({
            name, label: `${server.name} · ${tool.name}`, description: tool.description || `Run ${tool.name} on the ${server.name} MCP server`,
            promptSnippet: `Use ${tool.name} from the ${server.name} MCP server`, parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
            async execute(_toolCallId, params, signal) {
              if (signal?.aborted) throw new Error("MCP tool call aborted");
              if (!connection.connected || connections.get(id) !== connection) throw new Error(`MCP server "${id}" is not connected for this agent`);
              const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, { signal, timeout: TOOL_TIMEOUT_MS });
              if ((result as { isError?: boolean })?.isError) throw new Error(resultContent(result).map((part) => part.type === "text" ? part.text : "MCP image result").join("\n"));
              return { content: resultContent(result), details: { server: server.name, tool: tool.name, result } };
            },
          });
        }
        connection.connected = true;
        client.onclose = () => {
          if (connections.get(id) !== connection || shutdown.signal.aborted) return;
          connection.connected = false;
          statuses.set(id, { id, status: "error", error: errorDetails("MCP server disconnected; send another prompt to reconnect") }); publish();
        };
        statuses.set(id, { id, status: "connected", error: undefined });
      } catch (error) {
        await close(id);
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(id, { id, status: "error", error: errorDetails(message) }); errors.push(`${server.name}: ${message}`);
        process.stderr.write(`[mcp:${server.name}] ${message}\n`);
      } finally {
        publish();
      }
    }));
    publish();
    if (errors.length) throw new Error(errors.join("\n"));
    return [...wanted].flatMap((id) => connections.get(id)?.tools ?? []);
  };
  // The event bus dispatches synchronously; the caller awaits the assigned promise.
  const unsubscribe = pi.events.on(SELECT_EVENT, (value) => {
    const selection = value as Selection;
    selection.ready = pending.then(() => select(selection));
    pending = selection.ready.catch(() => undefined);
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx; publish();
  });
  pi.on("input", async (event, ctx) => {
    if (process.env.PI_DEFINE_AGENTS_ACTIVE !== "1") {
      const selection: Selection = { serverIds: servers.filter((server) => server.enabled && (!allowed || allowed.has(server.id))).map((server) => server.id), agentName: "default", sessionId: ctx.sessionManager.getSessionId() };
      try { await select(selection); }
      catch (error) {
        const message = `Could not connect MCP servers: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error: message }));
        ctx.ui.notify(message, "error");
        return { action: "handled" as const };
      }
    }
    return { action: "continue" as const };
  });
  pi.registerCommand("mcp-status", { description: "Show MCP servers and tools loaded by piop", handler: async () => {
    const loaded = [...connections].filter(([, connection]) => connection.connected);
    pi.sendMessage({ customType: MCP_STATUS_KEY, content: loaded.length ? loaded.map(([id, connection]) => `${id}: ${connection.tools.join(", ") || "no tools"}`).join("\n") : "No MCP servers loaded", display: true }, { triggerTurn: false });
  } });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== MCP_STATUS_KEY) }));
  pi.on("session_shutdown", async () => {
    unsubscribe(); shutdown.abort();
    await pending;
    await Promise.all([...connections.keys()].map(close));
    context?.ui.setStatus(MCP_STATUS_KEY, undefined);
    context?.ui.setStatus("pi-desktop-mcp-loading", undefined); context = undefined;
  });
}
