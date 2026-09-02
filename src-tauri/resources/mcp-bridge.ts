import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ServerConfig = {
  id: string;
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string;
  url?: string;
  headers?: string | Record<string, string>;
  enabled: boolean;
};
type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; method?: string; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type McpClient = {
  initialize(): Promise<void>;
  tools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
const MCP_STATUS_KEY = "pi-desktop-mcp-status";

function splitArgs(input = ""): string[] {
  const result: string[] = []; let current = ""; let quote: "'" | '"' | undefined; let escaped = false;
  for (const char of input) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { result.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in MCP server arguments");
  if (current) result.push(current); return result;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout>; abort?: { signal: AbortSignal; listener: () => void } }>();
  private buffer = "";

  constructor(readonly config: ServerConfig) {
    if (!config.command?.trim()) throw new Error("Command is required for stdio transport");
    this.process = spawn(config.command, splitArgs(config.args), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => process.stderr.write(`[mcp:${config.name}] ${chunk}`));
    this.process.once("error", (error) => this.failAll(error));
    this.process.once("exit", (code, signal) => this.failAll(new Error(`MCP server ${config.name} exited (${code ?? signal ?? "unknown"})`)));
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MCP_MESSAGE_BYTES) {
      this.buffer = ""; this.failAll(new Error(`MCP server ${this.config.name} sent an oversized message`)); this.process.kill(); return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n"); if (newline < 0) return;
      const record = this.buffer.slice(0, newline).replace(/\r$/, ""); this.buffer = this.buffer.slice(newline + 1);
      if (!record.trim()) continue;
      let message: JsonRpcMessage; try { message = JSON.parse(record) as JsonRpcMessage; } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id); if (!pending) continue; this.pending.delete(message.id); clearTimeout(pending.timeout);
      if (pending.abort) pending.abort.signal.removeEventListener("abort", pending.abort.listener);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`)); else pending.resolve(message.result);
    }
  }

  private failAll(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timeout); if (pending.abort) pending.abort.signal.removeEventListener("abort", pending.abort.listener); pending.reject(error); } this.pending.clear(); }
  private write(message: JsonRpcMessage) { this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error("MCP tool call aborted")); return; }
      const timeout = setTimeout(() => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); if (pending.abort) pending.abort.signal.removeEventListener("abort", pending.abort.listener); this.cancel(id); reject(new Error(`MCP request timed out: ${method}`)); }, REQUEST_TIMEOUT_MS);
      const pending: NonNullable<ReturnType<typeof this.pending.get>> = { resolve, reject, timeout };
      if (signal) {
        const listener = () => { const active = this.pending.get(id); if (!active) return; this.pending.delete(id); clearTimeout(active.timeout); this.cancel(id); reject(new Error("MCP tool call aborted")); };
        pending.abort = { signal, listener }; signal.addEventListener("abort", listener, { once: true });
      }
      this.pending.set(id, pending);
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage);
    });
  }
  private notify(method: string, params?: unknown) { this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage); }

  async initialize() {
    await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-desktop", version: "0.1.0" } });
    this.notify("notifications/initialized");
  }
  async tools(): Promise<McpTool[]> { const result = await this.request("tools/list") as { tools?: McpTool[] }; return result.tools ?? []; }
  callTool(name: string, args: unknown, signal?: AbortSignal) { return this.request("tools/call", { name, arguments: args }, signal); }
  cancel(requestId: number) { this.notify("notifications/cancelled", { requestId, reason: "Pi tool call aborted" }); }
  close() { this.process.kill(); }
}

class ExpiredMcpSessionError extends Error {}

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

function responseFromPayload(payload: unknown, requestId: number): JsonRpcMessage | undefined {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.find((message): message is JsonRpcMessage => Boolean(message && typeof message === "object" && (message as JsonRpcMessage).id === requestId));
}

async function readTextLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_MCP_MESSAGE_BYTES) { await reader.cancel(); throw new Error("MCP HTTP response was too large"); } text += decoder.decode(value, { stream: true }); }
    text += decoder.decode(); return text;
  } finally { reader.releaseLock(); }
}

async function readSseResponse(response: Response, requestId: number): Promise<JsonRpcMessage> {
  if (!response.body) throw new Error("MCP HTTP server returned an empty SSE stream");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const consumeEvent = (record: string) => {
    const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return undefined;
    try { return responseFromPayload(JSON.parse(data), requestId); } catch { return undefined; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      if (Buffer.byteLength(buffer) > MAX_MCP_MESSAGE_BYTES) { await reader.cancel(); throw new Error("MCP SSE event was too large"); }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
        const message = consumeEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + separator);
        if (message) { await reader.cancel(); return message; }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    const finalMessage = consumeEvent(buffer); if (finalMessage) return finalMessage;
  } finally { reader.releaseLock(); }
  throw new Error(`MCP SSE stream ended without response ${requestId}`);
}

class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private initialized = false;
  private readonly url: URL;
  private readonly configuredHeaders: Record<string, string>;

  constructor(readonly config: ServerConfig) {
    if (!config.url?.trim()) throw new Error("URL is required for HTTP transport");
    this.url = new URL(config.url);
    if (this.url.protocol !== "http:" && this.url.protocol !== "https:") throw new Error("MCP URL must use HTTP or HTTPS");
    this.configuredHeaders = parseHeaders(config.headers);
  }

  private requestHeaders() {
    const headers = new Headers(this.configuredHeaders);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (this.initialized) headers.set("MCP-Protocol-Version", this.protocolVersion);
    return headers;
  }

  private async post(message: JsonRpcMessage, signal?: AbortSignal): Promise<JsonRpcMessage | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`MCP request timed out: ${message.method ?? "notification"}`)), REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(this.url, { method: "POST", headers: this.requestHeaders(), body: JSON.stringify(message), signal: controller.signal });
      if (response.status === 404 && this.sessionId) throw new ExpiredMcpSessionError("MCP HTTP session expired");
      if (!response.ok) { const body = (await readTextLimited(response)).trim(); throw new Error(`MCP HTTP ${response.status}${body ? `: ${body}` : ""}`); }
      const returnedSessionId = response.headers.get("mcp-session-id"); if (returnedSessionId) this.sessionId = returnedSessionId;
      if (message.id === undefined || response.status === 202) return undefined;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType === "application/json") return responseFromPayload(JSON.parse(await readTextLimited(response)), message.id);
      if (contentType === "text/event-stream") return readSseResponse(response, message.id);
      throw new Error(`Unsupported MCP HTTP response type: ${contentType || "missing Content-Type"}`);
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }

  private async request(method: string, params?: unknown, signal?: AbortSignal, recoverSession = true): Promise<unknown> {
    const id = this.nextId++;
    try {
      const response = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage, signal);
      if (!response) throw new Error(`MCP HTTP server returned no response for ${method}`);
      if (response.error) throw new Error(`${response.error.message} (${response.error.code})`);
      return response.result;
    } catch (error) {
      if (!(error instanceof ExpiredMcpSessionError) || !recoverSession || method === "initialize") throw error;
      this.sessionId = undefined; this.initialized = false; await this.initialize();
      return this.request(method, params, signal, false);
    }
  }

  private async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage);
  }

  async initialize() {
    const result = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-desktop", version: "0.1.0" } }, undefined, false) as { protocolVersion?: string };
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.initialized = true; await this.notify("notifications/initialized");
  }
  async tools(): Promise<McpTool[]> { const result = await this.request("tools/list") as { tools?: McpTool[] }; return result.tools ?? []; }
  callTool(name: string, args: unknown, signal?: AbortSignal) { return this.request("tools/call", { name, arguments: args }, signal); }
  close() {
    if (!this.sessionId) return;
    const headers = this.requestHeaders();
    void fetch(this.url, { method: "DELETE", headers }).catch(() => undefined);
    this.sessionId = undefined; this.initialized = false;
  }
}

function createClient(server: ServerConfig): McpClient {
  return server.transport === "http" ? new HttpMcpClient(server) : new StdioMcpClient(server);
}

function resultContent(result: unknown) {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content ?? [];
  const mapped = content.flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text" as const, text: part.text }];
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return [{ type: "image" as const, data: part.data, mimeType: part.mimeType }];
    return [{ type: "text" as const, text: JSON.stringify(part, null, 2) }];
  });
  return mapped.length ? mapped : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

export default async function mcpBridge(pi: ExtensionAPI) {
  const configPath = process.env.PI_DESKTOP_MCP_CONFIG; if (!configPath) return;
  const servers = JSON.parse(await readFile(configPath, "utf8")) as ServerConfig[];
  const allowedServerIds = process.env.PI_DESKTOP_MCP_ALLOWED_SERVER_IDS?.split(",").map((id) => id.trim()).filter(Boolean);
  const allowed = allowedServerIds ? new Set(allowedServerIds) : undefined;
  const desktopSkillPaths = (() => { try { const value = JSON.parse(process.env.PI_DESKTOP_SKILL_PATHS || "[]"); return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : []; } catch { return []; } })();
  pi.on("resources_discover", () => process.env.PI_DESKTOP_ORCHESTRATION_ACTIVE === "1" || !desktopSkillPaths.length ? undefined : { skillPaths: desktopSkillPaths });
  const clients: McpClient[] = []; const loaded: Array<{ server: string; tools: string[] }> = [];
  const statuses = new Map(servers.map((server) => [server.id, { id: server.id, status: "stopped" as "stopped" | "connected" | "error", error: undefined as string | undefined }]));
  await Promise.all(servers.filter((item) => item.enabled && (!allowed || allowed.has(item.id))).map(async (server) => {
    try {
      const client = createClient(server); await client.initialize(); const tools = await client.tools(); clients.push(client);
      const registered: string[] = [];
      for (const tool of tools) {
        const name = `mcp_${safeName(server.id || server.name)}_${safeName(tool.name)}`; registered.push(name);
        pi.registerTool({
          name, label: `${server.name} · ${tool.name}`, description: tool.description || `Run ${tool.name} on the ${server.name} MCP server`,
          promptSnippet: `Use ${tool.name} from the ${server.name} MCP server`, parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted) throw new Error("MCP tool call aborted");
            const result = await client.callTool(tool.name, params, signal); const response = result as { isError?: boolean };
            if (response?.isError) throw new Error(resultContent(result).map((part) => part.type === "text" ? part.text : "MCP image result").join("\n"));
            return { content: resultContent(result), details: { server: server.name, tool: tool.name, result } };
          },
        });
      }
      loaded.push({ server: server.name, tools: registered });
      statuses.set(server.id, { id: server.id, status: "connected", error: undefined });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); statuses.set(server.id, { id: server.id, status: "error", error: message }); process.stderr.write(`[mcp:${server.name}] ${message}\n`); }
  }));
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus(MCP_STATUS_KEY, `json:${JSON.stringify([...statuses.values()])}`));
  pi.registerCommand("mcp-status", { description: "Show MCP servers and tools loaded by Pi Desktop", handler: async (_args, ctx) => ctx.ui.notify(loaded.length ? loaded.map((entry) => `${entry.server}: ${entry.tools.join(", ") || "no tools"}`).join("\n") : "No MCP servers loaded", loaded.length ? "info" : "warning") });
  pi.on("session_shutdown", () => { for (const client of clients) client.close(); });
}
