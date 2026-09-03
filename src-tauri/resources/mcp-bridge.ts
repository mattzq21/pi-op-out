import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type McpClient = {
  tools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};

const REQUEST_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 120_000;
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

async function createClient(config: ServerConfig): Promise<McpClient> {
  const client = new Client({ name: "pi-desktop", version: "0.1.0" });
  client.onerror = (error) => process.stderr.write(`[mcp:${config.name}] ${error.message}\n`);
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
          env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          stderr: "inherit",
          maxBufferSize: MAX_MCP_MESSAGE_BYTES,
        });
      })();
  try { await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return {
    async tools() { return (await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })).tools as McpTool[]; },
    callTool(name, args, signal) {
      return client.callTool({ name, arguments: args as Record<string, unknown> }, { signal, timeout: TOOL_TIMEOUT_MS });
    },
    close() { return client.close(); },
  };
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
      const client = await createClient(server); const tools = await client.tools(); clients.push(client);
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
  pi.on("session_shutdown", () => { for (const client of clients) void client.close(); });
}
