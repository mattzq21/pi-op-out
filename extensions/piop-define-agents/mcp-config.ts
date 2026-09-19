export type McpServer = { id: string; name: string; transport?: "stdio" | "http"; command?: string; args?: string; url?: string; headers?: string | Record<string, string>; enabled: boolean; startupTimeoutSec?: number };

export function mcpServers(value: unknown): McpServer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("An agent may define at most 32 MCP servers");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw new Error("Each agent MCP server requires a unique id");
    ids.add(item.id);
    if (typeof item.name !== "string" || !item.name.trim()) throw new Error("MCP server name is required");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`${item.name}: enabled must be a boolean`);
    if (item.startupTimeoutSec !== undefined && (!Number.isInteger(item.startupTimeoutSec) || item.startupTimeoutSec < 1 || item.startupTimeoutSec > 600)) throw new Error(`${item.name}: startup timeout must be between 1 and 600 seconds`);
    const transport = item.transport ?? "stdio";
    if (transport === "stdio") {
      if (typeof item.command !== "string" || !item.command.trim()) throw new Error(`${item.name}: command is required`);
      if (item.args !== undefined && typeof item.args !== "string") throw new Error(`${item.name}: arguments must be a string`);
    } else if (transport === "http") {
      const url = new URL(item.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${item.name}: URL must use HTTP or HTTPS`);
      const headers = typeof item.headers === "string" ? JSON.parse(item.headers || "{}") : item.headers ?? {};
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) throw new Error(`${item.name}: headers must contain string values`);
    } else throw new Error(`${item.name}: unsupported MCP transport`);
    return { id: item.id, name: item.name, transport, command: item.command ?? "", args: item.args ?? "", url: item.url, headers: typeof item.headers === "object" && item.headers !== null ? JSON.stringify(item.headers) : item.headers, enabled: item.enabled ?? true, startupTimeoutSec: item.startupTimeoutSec };
  });
}
