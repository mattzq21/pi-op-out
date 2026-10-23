import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { mcpServersSchema } from "./mcp-schema.ts";

export type AgentMcpServerConfig = McpServerConfig & { piopInjectAgentId?: boolean };

export type McpServers = Record<string, AgentMcpServerConfig>;

export const nativeMcpSchema = Type.Record(Type.String(), Type.Unsafe<AgentMcpServerConfig>({ type: "object" }));

export const legacyMcpSchema = Type.Array(Type.Object({
  id: Type.String(), name: Type.String(), enabled: Type.Optional(Type.Boolean()),
  transport: Type.Optional(Type.String()), command: Type.Optional(Type.String()), args: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()), headers: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.String())])),
  startupTimeoutSec: Type.Optional(Type.Number()), injectAgentId: Type.Optional(Type.Boolean()),
}));

export type LegacyMcpServer = Static<typeof legacyMcpSchema>[number];

function splitArgs(input = ""): string[] {
  const result: string[] = [];
  let current = ""; let quote: string | undefined; let escaped = false; let present = false;

  const consume = (char: string) => {
    if (escaped) { current += char; escaped = false; present = true;

    return; }

    if (char === "\\" && quote !== "'") { escaped = true; present = true;

    return; }

    if (quote) { if (char === quote) quote = undefined; else current += char;

    return; }

    if (char === "'" || char === '"') { quote = char; present = true;

    return; }

    if (/\s/.test(char)) { if (present) result.push(current); current = ""; present = false;

    return; }

    current += char; present = true;
  };

  for (const char of input) consume(char);

  if (quote) throw new Error("Unterminated quote in legacy MCP arguments");

  if (escaped) current += "\\";

  if (present) result.push(current);

  return result;
}

function legacyHeaders(server: LegacyMcpServer) {
  const headers = Check(Type.String(), server.headers) ? JSON.parse(server.headers || "{}") : server.headers ?? {};

  if (!Check(Type.Record(Type.String(), Type.String()), headers)) throw new Error(`${server.name}: headers must contain string values`);

  return headers;
}

function legacyConfig(server: LegacyMcpServer): AgentMcpServerConfig {
  const options: Pick<AgentMcpServerConfig, "enabled" | "description" | "timeout" | "piopInjectAgentId"> = { enabled: server.enabled ?? true, description: server.name, timeout: 120 };

  if (server.injectAgentId) options.piopInjectAgentId = true;

  if (server.transport === "http") return { ...options, url: server.url ?? "", headers: legacyHeaders(server) };

  if (server.transport !== undefined && server.transport !== "stdio") throw new Error(`${server.name}: unsupported MCP transport`);

  return { ...options, command: server.command ?? "", args: splitArgs(server.args) };
}

function validatedServers(servers: McpServers): McpServers {
  mcpServersSchema.parse(servers);

  return structuredClone(servers);
}

export function mcpServers(value: McpServers | LegacyMcpServer[] | undefined) {
  if (value === undefined) return {};

  if (Check(nativeMcpSchema, value)) return validatedServers(value);

  if (!Check(legacyMcpSchema, value)) throw new Error("MCP servers must be an object mapping server names to pi MCP configurations");
  const servers = new Map<string, AgentMcpServerConfig>();

  for (const server of value) {
    if (!/^[a-zA-Z0-9_-]+$/.test(server.id) || servers.has(server.id)) throw new Error(`Invalid or duplicate MCP server name: ${server.id}`);
    servers.set(server.id, legacyConfig(server));
  }

  return validatedServers(Object.fromEntries(servers));
}
