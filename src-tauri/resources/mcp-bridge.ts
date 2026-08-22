import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ServerConfig = { id: string; name: string; command: string; args?: string; enabled: boolean };
type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; method?: string; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

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
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private buffer = "";

  constructor(readonly config: ServerConfig) {
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
    for (;;) {
      const newline = this.buffer.indexOf("\n"); if (newline < 0) return;
      const record = this.buffer.slice(0, newline).replace(/\r$/, ""); this.buffer = this.buffer.slice(newline + 1);
      if (!record.trim()) continue;
      let message: JsonRpcMessage; try { message = JSON.parse(record) as JsonRpcMessage; } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id); if (!pending) continue; this.pending.delete(message.id); clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`)); else pending.resolve(message.result);
    }
  }

  private failAll(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); } this.pending.clear(); }
  private write(message: JsonRpcMessage) { this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++; this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage);
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP request timed out: ${method}`)); }, 10_000); this.pending.set(id, { resolve, reject, timeout }); });
  }
  private notify(method: string, params?: unknown) { this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) } as JsonRpcMessage); }

  async initialize() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-desktop", version: "0.1.0" } });
    this.notify("notifications/initialized");
  }
  async tools(): Promise<McpTool[]> { const result = await this.request("tools/list") as { tools?: McpTool[] }; return result.tools ?? []; }
  callTool(name: string, args: unknown) { return this.request("tools/call", { name, arguments: args }); }
  cancel(requestId: number) { this.notify("notifications/cancelled", { requestId, reason: "Pi tool call aborted" }); }
  close() { this.process.kill(); }
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
  const clients: StdioMcpClient[] = []; const loaded: Array<{ server: string; tools: string[] }> = [];
  for (const server of servers.filter((item) => item.enabled && item.command.trim())) {
    try {
      const client = new StdioMcpClient(server); await client.initialize(); const tools = await client.tools(); clients.push(client);
      const registered: string[] = [];
      for (const tool of tools) {
        const name = `mcp_${safeName(server.id || server.name)}_${safeName(tool.name)}`; registered.push(name);
        pi.registerTool({
          name, label: `${server.name} · ${tool.name}`, description: tool.description || `Run ${tool.name} on the ${server.name} MCP server`,
          promptSnippet: `Use ${tool.name} from the ${server.name} MCP server`, parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted) throw new Error("MCP tool call aborted");
            const result = await client.callTool(tool.name, params); const response = result as { isError?: boolean };
            if (response?.isError) throw new Error(resultContent(result).map((part) => part.type === "text" ? part.text : "MCP image result").join("\n"));
            return { content: resultContent(result), details: { server: server.name, tool: tool.name, result } };
          },
        });
      }
      loaded.push({ server: server.name, tools: registered });
    } catch (error) { process.stderr.write(`[mcp:${server.name}] ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  pi.registerCommand("mcp-status", { description: "Show MCP servers and tools loaded by Pi Desktop", handler: async (_args, ctx) => ctx.ui.notify(loaded.length ? loaded.map((entry) => `${entry.server}: ${entry.tools.join(", ") || "no tools"}`).join("\n") : "No MCP servers loaded", loaded.length ? "info" : "warning") });
  pi.on("session_shutdown", () => { for (const client of clients) client.close(); });
}
