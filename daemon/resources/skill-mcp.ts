import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { mcpServersSchema } from "../../extensions/piop-define-agents/mcp-schema.ts";

const manifestSchema = z.object({ mcpServers: mcpServersSchema }).strict();

export function skillMcp(pi: ExtensionAPI, ready: (ctx: ExtensionContext) => Promise<void>, wait: () => Promise<void>) {
  const loaded = new Map<string, Map<string, { name: string; config: McpServerConfig }>>();
  let codemode = true;
  let generation = 0;

  const clear = () => {
    generation++;
    for (const servers of loaded.values()) for (const { name } of servers.values()) pi.unregisterMcpServer(name);
    loaded.clear();
  };

  const load = async (path: string, ctx: ExtensionContext): Promise<string | undefined> => {
    const current = generation;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    if (basename(expanded) !== "SKILL.md") return;
    const file = realpathSync(resolve(ctx.cwd, expanded));
    let servers = loaded.get(file);
    if (!servers) {
      let content: string;
      try { content = readFileSync(join(dirname(file), "mcp.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const definitions = manifestSchema.parse(JSON.parse(content)).mcpServers;
      const replace = (value: string) => value.replaceAll("${SKILL_DIR}", dirname(file)).replaceAll("${PROJECT_DIR}", ctx.cwd);
      const prepared = Object.entries(definitions).filter(([, config]) => config.enabled !== false).map(([alias, supplied]) => {
        const { piopInjectAgentId, ...rest } = supplied;
        if (piopInjectAgentId) throw new Error("Skill MCP servers do not support piopInjectAgentId");
        const config = JSON.parse(JSON.stringify(rest, (_key, value) => typeof value === "string" ? replace(value) : value)) as McpServerConfig;
        config.exposure = codemode ? "codemode" : "direct";
        if ("command" in config) {
          config.cwd = resolve(dirname(file), config.cwd ?? ".");
          if (config.command.startsWith("./") || config.command.startsWith("../")) config.command = resolve(dirname(file), config.command);
        }
        return [alias, { name: `skill_${randomUUID().replaceAll("-", "")}_${alias}`, config }] as const;
      });
      if (!prepared.length) return;
      await ready(ctx);
      if (current !== generation) throw new Error("The session changed while loading skill MCP servers");
      // Another read can finish while MCP starts.
      servers = loaded.get(file);
      if (!servers) {
        servers = new Map();
        try {
          for (const [alias, server] of prepared) {
            pi.registerMcpServer(server.name, server.config);
            servers.set(alias, server);
          }
          loaded.set(file, servers);
        } catch (error) {
          for (const { name } of servers.values()) pi.unregisterMcpServer(name);
          throw error;
        }
      }
    }
    await wait();
    if (current !== generation) throw new Error("The session changed while loading skill MCP servers");
    return `Skill MCP tools: ${[...servers].map(([alias, { name }]) => `${alias}: mcp__${name.replaceAll("-", "_")}__*`).join(", ")}.`;
  };

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError || typeof event.input.path !== "string") return;
    try {
      const message = await load(event.input.path, ctx);
      if (message) return { content: [...event.content, { type: "text" as const, text: message }] };
    } catch (error) {
      return { content: [...event.content, { type: "text" as const, text: `Skill MCP loading failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!("prompt" in event)) return;
    const path = /^<skill name="[^"]+" location="([^"]+)">\n/.exec(event.prompt)?.[1];
    if (!path) return;
    try {
      const content = await load(path, ctx);
      if (content) return { message: { customType: "skill-mcp", content, display: false } };
    } catch (error) {
      return { message: { customType: "skill-mcp", content: `Skill MCP loading failed: ${error instanceof Error ? error.message : String(error)}`, display: true } };
    }
  });
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);

  return {
    select(enabled: boolean) {
      codemode = enabled;
      for (const servers of loaded.values()) for (const server of servers.values()) {
        const exposure = enabled ? "codemode" : "direct";
        if (server.config.exposure === exposure) continue;
        const config = { ...server.config, exposure } as McpServerConfig;
        pi.registerMcpServer(server.name, config);
        server.config = config;
      }
    },
  };
}
