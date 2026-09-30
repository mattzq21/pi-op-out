import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { Type, type JsonValue } from "@earendil-works/pi-ai";
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
  injectAgentId?: boolean;
};

const REQUEST_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
const MCP_STATUS_KEY = "pi-desktop-mcp-status";

function splitArgs(input = ""): string[] {
  const result: string[] = []; let current = ""; let quote: "'" | '"' | undefined; let escaped = false; let present = false;
  const consume = (char: string) => {
    if (escaped) { present = true; current += char; escaped = false; return; }
    if (char === "\\" && quote !== "'") { escaped = true; present = true; return; }
    if (quote) { if (char === quote) quote = undefined; else current += char; return; }
    if (char === "'" || char === '"') { quote = char; present = true; return; }
    if (/\s/.test(char)) { if (present) { result.push(current); current = ""; present = false; } return; }
    current += char; present = true;
  };
  for (const char of input) consume(char);
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in MCP server arguments");
  if (present) result.push(current); return result;
}

async function discoverTools(client: Client, signal: AbortSignal) {
  const discovered: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS, signal });
    discovered.push(...result.tools); cursor = result.nextCursor;
  } while (cursor);
  return discovered;
}

function isStringSchema(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "string";
}

function toolParameters(inputSchema: Awaited<ReturnType<Client["listTools"]>>["tools"][number]["inputSchema"], inject = false) {
  const schema = inputSchema ?? { type: "object", properties: {} };
  const agentId = schema.properties?.agent_id;
  const injectAgentId = inject && isStringSchema(agentId);
  const parameters = injectAgentId ? {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== "agent_id")),
    required: schema.required?.filter((key) => key !== "agent_id"),
  } : schema;
  return { injectAgentId, parameters };
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

function contentPart(part: Record<string, unknown>): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
  if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return { type: "image", data: part.data, mimeType: part.mimeType };
  return { type: "text", text: JSON.stringify(part, null, 2) };
}

function resultContent(result: unknown) {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content ?? [];
  const mapped = content.map(contentPart);
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  if (structured !== undefined) mapped.push({ type: "text", text: JSON.stringify(structured, null, 2) });
  return mapped.length ? mapped : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

function startupTimeoutMs(server: ServerConfig): number {
  const seconds = server.startupTimeoutSec ?? 10;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error("Startup timeout must be an integer between 1 and 600 seconds");
  return seconds * 1000;
}

type Selection = { servers: ServerConfig[]; agentName: string; sessionId: string; ready?: Promise<string[]> };
type Connection = { client: Client; instanceId: string; tools: string[]; connected: boolean };
const SELECT_EVENT = "piop:mcp:select";

export default async function mcpBridge(pi: ExtensionAPI) {
  const structuredResults = typeof pi.registerMcpServer === "function";
  let servers: ServerConfig[] = [];
  const connections = new Map<string, Connection>();
  const selectedTools = () => [...connections.values()].filter((connection) => connection.connected).flatMap((connection) => connection.tools);
  const stopToolList = pi.events.on("piop:mcp:tools", (value) => { (value as { tools?: string[] }).tools = selectedTools(); });
  const toolNames = new Map<string, string>();
  const toolOwners = new Map<string, string>();
  const registeredName = (serverId: string, toolName: string) => {
    const key = JSON.stringify([serverId, toolName]);
    const existing = toolNames.get(key);
    if (existing) return existing;
    const base = `mcp_${safeName(serverId).slice(0, 20)}_${safeName(toolName)}`.slice(0, 64);
    let name = base;
    let attempt = 0;
    while (toolOwners.has(name) || pi.getAllTools().some((tool) => tool.name === name)) {
      const suffix = createHash("sha256").update(JSON.stringify([key, attempt++])).digest("hex").slice(0, 12);
      name = `${base.slice(0, 51)}_${suffix}`;
    }
    toolNames.set(key, name);
    toolOwners.set(name, key);
    return name;
  };
  const statuses = new Map(servers.map((server) => [server.id, { id: server.id, status: "stopped" as "stopped" | "starting" | "connected" | "error", error: undefined as string | undefined }]));
  const shutdown = new AbortController();
  let preparing: AbortController | undefined;
  const cancelPreparation = pi.events.on("piop:cancel-preparation", () => preparing?.abort());
  let context: ExtensionContext | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const publish = () => {
    context?.ui.setStatus(MCP_STATUS_KEY, `json:${JSON.stringify([...statuses.values()])}`);
    const loading = servers.filter((server) => statuses.get(server.id)?.status === "starting");
    context?.ui.setStatus("pi-desktop-mcp-loading", loading.length ? `json:${JSON.stringify(loading.map(({ id, name }) => ({ id, name })))}` : undefined);
  };
  const close = async (id: string) => {
    const connection = connections.get(id);
    connections.delete(id);
    if (connection) { pi.setActiveTools(pi.getActiveTools().filter((name) => !connection.tools.includes(name))); connection.connected = false; await connection.client.close().catch(() => undefined); }
    statuses.set(id, { id, status: "stopped", error: undefined });
  };
  const registerTools = (server: ServerConfig, connection: Connection, discovered: Awaited<ReturnType<Client["listTools"]>>["tools"]) => {
    const id = server.id; const client = connection.client;
    const previous = new Set(connection.tools); connection.tools = [];
        for (const tool of discovered) {
          const name = registeredName(server.id, tool.name);
          const { injectAgentId, parameters } = toolParameters(tool.inputSchema, server.injectAgentId);
          connection.tools.push(name);
          pi.registerTool({
            name, label: `${server.name} · ${tool.name}`, description: tool.description || `Run ${tool.name} on the ${server.name} MCP server`,
            promptSnippet: `Use ${tool.name} from the ${server.name} MCP server`, parameters: Type.Unsafe(parameters),
            exposure: "direct",
            namespace: { name: `piop_mcp_${safeName(server.id)}`, description: server.name },
            annotations: tool.annotations,
            outputSchema: Type.Unsafe({ type: "object", properties: {
              content: { type: "array", items: { type: "object" } },
              ...(tool.outputSchema ? { structuredContent: tool.outputSchema } : {}),
              isError: { type: "boolean" },
            }, required: ["content"] }),
            async execute(_toolCallId, params, signal) {
              if (signal?.aborted) throw new Error("MCP tool call aborted");
              if (!connection.connected || connections.get(id) !== connection || !connection.tools.includes(name)) throw new Error(`MCP tool "${name}" is not available for this agent`);
              const args = injectAgentId ? { ...params as Record<string, unknown>, agent_id: connection.instanceId } : params as Record<string, unknown>;
              const result = await client.callTool({ name: tool.name, arguments: args }, { signal, timeout: TOOL_TIMEOUT_MS });
              if (result.isError && !structuredResults) throw new Error(resultContent(result).map((part) => part.type === "text" ? part.text : "MCP image result").join("\n"));
              const { _meta: _metadata, ...scriptResult } = result;
              return { content: resultContent(result), details: { server: server.name, tool: tool.name, result }, structuredContent: scriptResult as JsonValue, ...(result.isError ? { isError: true } : {}) };
            },
          });
        }
    if (connection.connected) pi.setActiveTools([...pi.getActiveTools().filter((name) => !previous.has(name)), ...connection.tools]);
  };
  const select = async (selection: Selection): Promise<string[]> => {
    const preparation = new AbortController(); preparing = preparation;
    const signal = AbortSignal.any([shutdown.signal, preparation.signal]);
    if (shutdown.signal.aborted) throw new Error("MCP bridge has shut down");
    const next = selection.servers.filter((server) => server.enabled);
    const wanted = new Set(next.map((server) => server.id));
    const instanceFor = (id: string) => `piop-${createHash("sha256").update(JSON.stringify([selection.sessionId, selection.agentName, id])).digest("hex").slice(0, 32)}`;
    await Promise.all([...connections].filter(([id, connection]) => !wanted.has(id) || connection.instanceId !== instanceFor(id) || !connection.connected || JSON.stringify(servers.find((server) => server.id === id)) !== JSON.stringify(next.find((server) => server.id === id))).map(([id]) => close(id)));
    servers = structuredClone(next);
    for (const id of statuses.keys()) if (!wanted.has(id)) statuses.delete(id);
    const errors: string[] = [];
    await Promise.all([...wanted].map(async (id) => {
      const server = servers.find((item) => item.id === id);
      if (!server || !server.enabled) {
        const error = `MCP server "${id}" is unavailable or disabled`;
        statuses.set(id, { id, status: "error", error }); errors.push(error); return;
      }
      if (connections.get(id)?.connected) return;
      const instanceId = instanceFor(id);
      const client = new Client({ name: "piop", version: "0.1.0" }, { listChanged: { tools: { onChanged: (error, tools) => {
        if (error || !tools || connections.get(id) !== connection || !connection.connected) return;
        registerTools(server, connection, tools);
      } } } });
      const connection: Connection = { client, instanceId, tools: [], connected: false };
      connections.set(id, connection);
      statuses.set(id, { id, status: "starting", error: undefined }); publish();
      let recentOutput = "";
      const diagnostic = (text: string) => { recentOutput = (recentOutput + text).slice(-8192); };
      const errorDetails = (message: string) => recentOutput.trim() ? `${message}\n\nRecent MCP output (last 8 KB):\n${recentOutput.trim()}` : message;
      try {
        await connectClient(client, server, instanceId, signal, diagnostic);
        const discovered = await discoverTools(client, signal);
        if (shutdown.signal.aborted) throw new Error("MCP bridge has shut down");
        registerTools(server, connection, discovered);
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
    if (preparing === preparation) preparing = undefined;
    if (errors.length) throw new Error(errors.join("\n"));
    return [...wanted].flatMap((id) => connections.get(id)?.tools ?? []);
  };
  const unsubscribe = pi.events.on(SELECT_EVENT, (value) => {
    const selection = value as Selection;
    selection.ready = pending.then(() => select(selection));
    pending = selection.ready.catch(() => undefined);
  });
  pi.on("session_start", (_event, ctx) => { context = ctx; publish(); });
  const showStatus = async () => {
    const loaded = [...connections].filter(([, connection]) => connection.connected);
    pi.sendMessage({ customType: MCP_STATUS_KEY, content: loaded.length ? loaded.map(([id, connection]) => `${id}: ${connection.tools.join(", ") || "no tools"}`).join("\n") : "No MCP servers loaded", display: true }, { triggerTurn: false });
  };
  pi.registerCommand("mcp", { description: "Show Piop MCP status; configure servers in the agent settings", handler: async (args, ctx) => {
    if (args.trim()) { ctx.ui.notify("Configure MCP servers in Piop's agent settings. /mcp shows the selected agent's connections.", "info"); return; }
    await showStatus();
  } });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== MCP_STATUS_KEY) }));
  pi.on("session_shutdown", async () => {
    unsubscribe(); stopToolList(); cancelPreparation(); preparing?.abort(); shutdown.abort();
    await pending;
    await Promise.all([...connections.keys()].map(close));
    context?.ui.setStatus(MCP_STATUS_KEY, undefined);
    context?.ui.setStatus("pi-desktop-mcp-loading", undefined); context = undefined;
  });
}
