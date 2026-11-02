import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { skillMcpServerSchema, skillMcpServersSchema } from "../../extensions/piop-define-agents/mcp-schema.ts";
import { subscribeConnections } from "./mcp-connections.cjs";
import type { AppRequest } from "../../extensions/piop-define-agents/contracts.ts";

const ENTRY = "piop-skill-mcp";
const STATUS = "piop-skill-mcp";
const manifestSchema = z.object({ mcpServers: skillMcpServersSchema }).strict();
const savedSchema = z.array(z.object({ file: z.string(), servers: z.array(z.object({ alias: z.string(), name: z.string().regex(/^skill_[a-zA-Z0-9_]+$/), config: skillMcpServerSchema })) }));
type Server = { alias: string; name: string; config: McpServerConfig & { exposure: keyof typeof REACH }; state: "connecting" | "connected" | "failed"; error?: string; connection?: object };
type Connection = { name: string; state: string; error?: string };
const REACH = { direct: "", codemode: " (call from codemode scripts)", deferred: " (find with tool_search)" };
const SKILL_BLOCK = /<skill name="[^"]+" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/y;

function invokedSkillPaths(prompt: string) {
  const paths: string[] = [];
  for (let at = 0, match; at < prompt.length; at = SKILL_BLOCK.lastIndex) {
    SKILL_BLOCK.lastIndex = at;
    match = SKILL_BLOCK.exec(prompt);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

export function skillMcp(pi: ExtensionAPI, ready: (ctx: ExtensionContext) => Promise<void>, wait: () => Promise<void>) {
  const loaded = new Map<string, Map<string, Server>>();
  const registered = new Set<string>();
  const changed = new Set<() => void>();
  let codemode = true, generation = 0;
  let context: ExtensionContext | undefined;
  let statusText: string | undefined;
  const all = () => [...loaded.values()].flatMap(servers => [...servers.values()]);
  const publish = () => {
    const value = JSON.stringify([...loaded].flatMap(([file, servers]) => [...servers.values()].map(server => ({ name: server.name, label: `${basename(dirname(file))}: ${server.alias}`, state: server.state, ...(server.error ? { error: server.error } : {}) }))));
    if (context && value !== statusText) { context.ui.setStatus(STATUS, value === "[]" ? undefined : value); statusText = value; }
    for (const notify of changed) notify();
  };
  const save = () => pi.appendEntry(ENTRY, [...loaded].map(([file, servers]) => ({ file, servers: [...servers.values()].map(({ alias, name, config }) => ({ alias, name, config })) })));
  const failed = (server: Server, error: unknown) => { server.state = "failed"; server.error = error instanceof Error ? error.message : String(error); publish(); };
  const register = (server: Server) => {
    if (registered.has(server.name)) return;
    server.state = "connecting"; delete server.error; delete server.connection;
    publish();
    if (server.config.exposure === "codemode" && !codemode) return failed(server, new Error("This server needs Codemode. Turn on Codemode for the agent"));
    try {
      pi.registerMcpServer(server.name, server.config);
      registered.add(server.name);
    } catch (error) { failed(server, error); }
  };
  const stop = (server: Server) => {
    if (!registered.has(server.name)) return;
    registered.delete(server.name);
    pi.unregisterMcpServer(server.name);
  };
  const clear = () => {
    generation++;
    context = undefined; statusText = undefined;
    for (const server of all()) stop(server);
    loaded.clear();
    publish();
  };
  const unsubscribe = subscribeConnections((connection: Connection) => {
    const server = all().find(server => server.name === connection.name);
    if (!server || connection.state === "closed") return;
    if (connection.state === "connecting") server.connection = connection;
    if (server.connection && server.connection !== connection) return;
    server.connection = connection;
    if (connection.state === "connected") { server.state = "connected"; delete server.error; }
    else if (connection.state === "connecting") { server.state = "connecting"; delete server.error; }
    else { server.state = "failed"; server.error = connection.error || (connection.state === "needs-auth" ? "Sign-in is required." : "The connection closed."); }
    publish();
  });

  const settle = async (ctx: ExtensionContext, current = generation) => {
    if (!all().length) return;
    await ready(ctx);
    await wait();
    if (current !== generation) throw new Error("The session changed while loading skill MCP servers");
    if (all().some(server => server.state === "connecting")) await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (current === generation && !ctx.signal?.aborted && all().some(server => server.state === "connecting")) return;
        changed.delete(finish); ctx.signal?.removeEventListener("abort", finish);
        if (current !== generation || ctx.signal?.aborted) reject(new Error("Skill MCP startup was interrupted")); else resolve();
      };
      changed.add(finish); ctx.signal?.addEventListener("abort", finish, { once: true }); finish();
    });
    const failures = all().filter(server => server.state === "failed");
    if (failures.length) throw new Error(`Required skill MCP servers failed: ${failures.map(server => `${server.alias}: ${server.error}`).join("; ")}. Use Retry or Remove in the chat.`);
  };

  const load = async (path: string, ctx: ExtensionContext): Promise<string | undefined> => {
    const current = generation;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    if (basename(expanded) !== "SKILL.md") return;
    const file = realpathSync(resolve(ctx.cwd, expanded));
    context = ctx;
    let servers = loaded.get(file);
    if (!servers) {
      let content: string;
      try { content = readFileSync(join(dirname(file), "mcp.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const definitions = manifestSchema.parse(JSON.parse(content)).mcpServers;
      const replace = (value: string) => value.replaceAll("${SKILL_DIR}", dirname(file)).replaceAll("${PROJECT_DIR}", ctx.cwd);
      servers = new Map(Object.entries(definitions).filter(([, config]) => config.enabled !== false).map(([alias, supplied]) => {
        const { piopInjectAgentId, ...rest } = supplied;
        if (piopInjectAgentId) throw new Error("Skill MCP servers do not support piopInjectAgentId");
        const config = JSON.parse(JSON.stringify(rest, (_key, value) => typeof value === "string" ? replace(value) : value)) as Server["config"];
        if ("command" in config) {
          config.cwd = resolve(dirname(file), config.cwd ?? ".");
          if (config.command.startsWith("./") || config.command.startsWith("../")) config.command = resolve(dirname(file), config.command);
        }
        return [alias, { alias, name: `skill_${randomUUID().replaceAll("-", "")}_${alias.replaceAll("-", "_")}`, config, state: "connecting" }];
      }));
      if (!servers.size) return;
      loaded.set(file, servers);
      try { save(); } catch (error) { loaded.delete(file); throw error; }
      for (const server of servers.values()) register(server);
    }
    if (!servers.size) return;
    await settle(ctx, current);
    return `Skill MCP tools: ${[...servers.values()].map(({ alias, name, config }) => `${alias}: mcp__${name}__*${REACH[config.exposure]}`).join(", ")}.`;
  };

  const action = async (name: string, action: "retry" | "remove", ctx: ExtensionContext) => {
    const group = [...loaded.values()].find(servers => [...servers.values()].some(server => server.name === name));
    const server = group && [...group.values()].find(server => server.name === name);
    if (!group || !server) throw new Error("This skill MCP server is no longer required");
    context = ctx;
    if (action === "remove") {
      group.delete(server.alias);
      try { save(); } catch (error) { group.set(server.alias, server); throw error; }
      stop(server); publish(); return null;
    }
    stop(server); register(server); await settle(ctx); return null;
  };
  const stopRequests = pi.events.on("piop:rpc", (request: AppRequest) => {
    if (request.command !== "skill_mcp") return;
    request.ready = Promise.resolve().then(() => {
      const payload = z.object({ name: z.string(), action: z.enum(["retry", "remove"]) }).parse(request.payload);
      return action(payload.name, payload.action, request.ctx);
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError || typeof event.input.path !== "string") return;
    try {
      const message = await load(event.input.path, ctx);
      if (message) return { content: [...event.content, { type: "text" as const, text: message }] };
    } catch (error) {
      return { content: [...event.content, { type: "text" as const, text: `Skill MCP loading failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  pi.on("input", async (event, ctx) => {
    try { await settle(ctx); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error: message }));
      ctx.ui.notify(message, "error");
      return { action: "handled" as const };
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await settle(ctx);
      if (!("prompt" in event)) return;
      const contents: string[] = [];
      for (const path of invokedSkillPaths(event.prompt)) {
        const content = await load(path, ctx);
        if (content) contents.push(content);
      }
      if (contents.length) return { message: { customType: "skill-mcp", content: contents.join("\n"), display: false } };
    } catch (error) {
      ctx.abort();
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
  pi.on("session_start", (_event, ctx) => {
    clear(); context = ctx; statusText = undefined;
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === ENTRY);
    if (entry?.type === "custom") {
      const saved = savedSchema.parse(entry.data);
      for (const group of saved) loaded.set(group.file, new Map(group.servers.map(server => [server.alias, { ...server, config: server.config as Server["config"], state: "connecting" }])));
      for (const server of all()) register(server);
    }
    publish();
  });
  pi.on("session_shutdown", (_event, ctx) => { clear(); ctx.ui.setStatus(STATUS, undefined); unsubscribe(); stopRequests(); });

  return {
    select(enabled: boolean) {
      if (codemode === enabled) return;
      codemode = enabled;
      for (const server of all().filter(server => server.config.exposure === "codemode")) { stop(server); register(server); }
    },
  };
}
