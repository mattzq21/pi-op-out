import { Type } from "typebox";
import { Check } from "typebox/value";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { mcpServersSchema } from "./mcp-schema.ts";

export type AgentMcpServerConfig = McpServerConfig & { piopInjectAgentId?: boolean };

export type McpServers = Record<string, AgentMcpServerConfig>;

export const nativeMcpSchema = Type.Record(Type.String(), Type.Unsafe<AgentMcpServerConfig>({ type: "object" }));

function validatedServers(servers: McpServers): McpServers {
  mcpServersSchema.parse(servers);

  return structuredClone(servers);
}

export function mcpServers(value: McpServers | undefined) {
  if (value === undefined) return {};

  if (!Check(nativeMcpSchema, value)) throw new Error("MCP servers must be an object mapping server names to pi MCP configurations");

  return validatedServers(value);
}
